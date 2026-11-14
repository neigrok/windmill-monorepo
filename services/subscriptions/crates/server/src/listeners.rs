use std::net::SocketAddr;
use std::panic::AssertUnwindSafe;
use std::sync::Arc;
use std::time::Instant;

use axum::extract::{MatchedPath, Request, State};
use axum::http::{Method, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use futures_util::FutureExt;
use sentry::{Hub, SentryFutureExt};
use serde_json::{Value, json};
use tracing::Instrument;
use uuid::Uuid;

use crate::config::Config;

// Two ports, so no path rule can expose an internal route (spec §5): one router per listener.
#[derive(Clone, Copy, Debug)]
pub enum Listener {
    Public,
    Internal,
}

impl Listener {
    pub fn label(self) -> &'static str {
        match self {
            Listener::Public => "public",
            Listener::Internal => "internal",
        }
    }

    pub fn address(self, config: &Config) -> SocketAddr {
        match self {
            Listener::Public => config.public_address,
            Listener::Internal => config.internal_address,
        }
    }

    pub fn router(self, config: &Config) -> Router {
        let routes = Router::new().route("/health", get(health));
        let routes = match self {
            Listener::Public => routes,
            Listener::Internal if config.panic_route_enabled => {
                routes.route("/debug/panic", get(forced_panic))
            }
            Listener::Internal => routes,
        };
        routes.layer(middleware::from_fn_with_state(self, observe))
    }
}

async fn health() -> Json<Value> {
    Json(json!({ "status": "ready" }))
}

// Proves that a panic in a handler reaches Sentry; configuration refuses it in production.
async fn forced_panic() {
    panic!("forced through GET /debug/panic");
}

// A method outside this list is caller-chosen text, logged as `other`.
static KNOWN_METHODS: [Method; 9] = [
    Method::GET,
    Method::HEAD,
    Method::POST,
    Method::PUT,
    Method::PATCH,
    Method::DELETE,
    Method::OPTIONS,
    Method::CONNECT,
    Method::TRACE,
];

// Each request: its own Sentry scope and span, a 500 if its handler panics, one line at the end.
async fn observe(State(listener): State<Listener>, request: Request, next: Next) -> Response {
    let started = Instant::now();
    let method = KNOWN_METHODS
        .iter()
        .find(|known| *known == request.method())
        .map_or("other", Method::as_str);
    let route = request
        .extensions()
        .get::<MatchedPath>()
        .map_or("unmatched", MatchedPath::as_str)
        .to_owned();
    let request_id = Uuid::new_v4().simple().to_string();

    let hub = Arc::new(Hub::new_from_top(Hub::current()));
    hub.configure_scope(|scope| {
        scope.set_transaction(Some(&format!("{method} {route}")));
        scope.set_tag("listener", listener.label());
        scope.set_tag("route", &route);
        scope.set_tag("request_id", &request_id);
    });
    let span = tracing::info_span!(
        "request",
        listener = listener.label(),
        method,
        route,
        request_id
    );

    let response = AssertUnwindSafe(next.run(request))
        .catch_unwind()
        .bind_hub(hub)
        .instrument(span)
        .await
        .unwrap_or_else(|_| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": "internal" })),
            )
                .into_response()
        });

    let outcome = response.status();
    let status = outcome.as_u16();
    let duration_ms = (started.elapsed().as_secs_f64() * 100_000.0).round() / 100.0;
    let listener = listener.label();
    // tracing fixes a line's level at the call, so the request line is written once, placed below.
    macro_rules! request_line {
        ($level:ident) => {
            tracing::$level!(
                listener,
                method,
                route,
                status,
                duration_ms,
                request_id,
                "request"
            )
        };
    }
    if outcome.is_server_error() {
        request_line!(error);
    } else if outcome.is_client_error() {
        request_line!(warn);
    } else if route == "/health" {
        // A health probe fires every few seconds forever and says nothing when it is healthy.
        request_line!(debug);
    } else {
        request_line!(info);
    }
    response
}
