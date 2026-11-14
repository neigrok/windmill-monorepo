use std::io::ErrorKind::{ConnectionAborted, ConnectionRefused, ConnectionReset};
use std::net::SocketAddr;
use std::panic::AssertUnwindSafe;
use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::extract::{MatchedPath, Request, State};
use axum::http::{Method, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use futures_util::FutureExt;
use hyper::server::conn::http1;
use hyper_util::rt::{TokioIo, TokioTimer};
use hyper_util::server::graceful::GracefulShutdown;
use hyper_util::service::TowerToHyperService;
use sentry::{Hub, SentryFutureExt};
use serde_json::json;
use storage::{Ledger, StorageError};
use tokio::net::TcpListener;
use tokio_util::sync::CancellationToken;
use tower_http::limit::RequestBodyLimitLayer;
use tracing::Instrument;
use uuid::Uuid;

use crate::config::Config;

// How long a client may take, and how much it may send, before the listener gives up on it.
#[derive(Clone, Copy, Debug)]
pub struct Bounds {
    pub header_read: Duration,
    pub request: Duration,
    pub body_bytes: usize,
}

// A signed App Store notification is a few kilobytes; 64 KiB leaves it room and nothing more.
impl Default for Bounds {
    fn default() -> Bounds {
        Bounds {
            header_read: Duration::from_secs(5),
            request: Duration::from_secs(5),
            body_bytes: 64 * 1024,
        }
    }
}

// What a health answer asks before it says ready: whether the ledger answers, since every door reads
// or writes it. `Ledger` is the one the service runs on.
pub trait Readiness: Clone + Send + Sync + 'static {
    fn ready(&self) -> impl Future<Output = Result<(), StorageError>> + Send;
}

impl Readiness for Ledger {
    async fn ready(&self) -> Result<(), StorageError> {
        self.check().await
    }
}

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

    pub fn router<R: Readiness>(self, config: &Config, readiness: R, bounds: Bounds) -> Router {
        let routes = Router::new()
            .route("/health", get(health::<R>))
            .with_state(readiness);
        let routes = match self {
            Listener::Public => routes,
            Listener::Internal if config.panic_route_enabled => {
                routes.route("/debug/panic", get(forced_panic))
            }
            Listener::Internal => routes,
        };
        self.boundary(routes, bounds)
    }

    // Every route of this listener answers through here: a bounded body, then `observe`.
    pub fn boundary(self, routes: Router, bounds: Bounds) -> Router {
        routes
            .layer(RequestBodyLimitLayer::new(bounds.body_bytes))
            .layer(middleware::from_fn_with_state(
                (self, bounds.request),
                observe,
            ))
    }

    // Accepts until `stop`, then lets each open connection finish its request and close.
    pub async fn serve(
        self,
        socket: TcpListener,
        router: Router,
        bounds: Bounds,
        stop: CancellationToken,
    ) {
        let mut http = http1::Builder::new();
        http.timer(TokioTimer::new())
            .header_read_timeout(bounds.header_read);
        let connections = GracefulShutdown::new();
        let listener = self.label();
        loop {
            let accepted = tokio::select! {
                accepted = socket.accept() => accepted,
                () = stop.cancelled() => break,
            };
            let stream = match accepted {
                Ok((stream, _)) => stream,
                // One connection failed, not the listening socket: the next accept is fine.
                Err(error)
                    if matches!(
                        error.kind(),
                        ConnectionRefused | ConnectionAborted | ConnectionReset
                    ) =>
                {
                    continue;
                }
                Err(error) => {
                    let kind = error.kind();
                    tracing::warn!(listener, ?kind, "accept refused");
                    tokio::time::sleep(Duration::from_secs(1)).await;
                    continue;
                }
            };
            let service = TowerToHyperService::new(router.clone());
            let connection =
                connections.watch(http.serve_connection(TokioIo::new(stream), service));
            tokio::spawn(async move {
                if let Err(error) = connection.await {
                    tracing::debug!(
                        listener,
                        timed_out = error.is_timeout(),
                        "connection failed"
                    );
                }
            });
        }
        drop(socket);
        connections.shutdown().await;
    }
}

async fn health<R: Readiness>(State(readiness): State<R>) -> Response {
    match readiness.ready().await {
        Ok(()) => Json(json!({ "status": "ready" })).into_response(),
        Err(failure) => {
            tracing::warn!(
                operation = "ledger.check",
                code = failure.code(),
                sqlstate = failure.sqlstate(),
                "ledger did not answer"
            );
            let body = Json(json!({ "status": "unavailable" }));
            (StatusCode::SERVICE_UNAVAILABLE, body).into_response()
        }
    }
}

// Proves that a handler's panic reaches Sentry; configuration allows it in test deployments only.
async fn forced_panic() {
    panic!("forced through GET /debug/panic");
}

// Each request: its own Sentry scope and span, a 500 if it panics, a 503 if it outlives its bound.
async fn observe(
    State((listener, request_bound)): State<(Listener, Duration)>,
    request: Request,
    next: Next,
) -> Response {
    let mut line = RequestLine::new(listener, &request);

    let hub = Arc::new(Hub::new_from_top(Hub::current()));
    hub.configure_scope(|scope| {
        scope.set_transaction(Some(&format!("{} {}", line.method, line.route)));
        scope.set_tag("listener", line.listener);
        scope.set_tag("route", &line.route);
        scope.set_tag("request_id", &line.request_id);
    });
    let span = tracing::info_span!(
        "request",
        listener = line.listener,
        method = line.method,
        route = line.route,
        request_id = line.request_id
    );

    let handled = tokio::time::timeout(
        request_bound,
        AssertUnwindSafe(next.run(request)).catch_unwind(),
    )
    .bind_hub(hub)
    .instrument(span)
    .await;
    let (response, outcome) = match handled {
        Ok(Ok(response)) => (response, "answered"),
        Ok(Err(_)) => {
            let body = Json(json!({ "error": "internal" }));
            (
                (StatusCode::INTERNAL_SERVER_ERROR, body).into_response(),
                "panicked",
            )
        }
        Err(_) => {
            let body = Json(json!({ "error": "timeout" }));
            (
                (StatusCode::SERVICE_UNAVAILABLE, body).into_response(),
                "timed_out",
            )
        }
    };
    line.answer = Some((response.status(), outcome));
    response
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

// The one line a request ends in, written when dropped: a client that leaves mid-request still gets
// its line, as `cancelled`. It holds the route template, never the raw path, and no header or body.
struct RequestLine {
    listener: &'static str,
    method: &'static str,
    route: String,
    request_id: String,
    started: Instant,
    answer: Option<(StatusCode, &'static str)>,
}

impl RequestLine {
    fn new(listener: Listener, request: &Request) -> RequestLine {
        RequestLine {
            listener: listener.label(),
            method: KNOWN_METHODS
                .iter()
                .find(|known| *known == request.method())
                .map_or("other", Method::as_str),
            route: request
                .extensions()
                .get::<MatchedPath>()
                .map_or("unmatched", MatchedPath::as_str)
                .to_owned(),
            request_id: Uuid::new_v4().simple().to_string(),
            started: Instant::now(),
            answer: None,
        }
    }
}

impl Drop for RequestLine {
    fn drop(&mut self) {
        let RequestLine {
            listener,
            method,
            ref route,
            ref request_id,
            ..
        } = *self;
        let status = self.answer.map(|(status, _)| status.as_u16());
        let outcome = self.answer.map_or("cancelled", |(_, outcome)| outcome);
        let duration_ms = (self.started.elapsed().as_secs_f64() * 100_000.0).round() / 100.0;
        // tracing fixes a line's level at the call, so the line is written once, placed below.
        macro_rules! request_line {
            ($level:ident) => {
                tracing::$level!(
                    listener,
                    method,
                    route,
                    status,
                    outcome,
                    duration_ms,
                    request_id,
                    "request"
                )
            };
        }
        match self.answer {
            None => request_line!(warn),
            Some((status, _)) if status.is_server_error() => request_line!(error),
            Some((status, _)) if status.is_client_error() => request_line!(warn),
            // A health probe fires every few seconds forever and says nothing when it is healthy.
            Some(_) if route == "/health" => request_line!(debug),
            Some(_) => request_line!(info),
        }
    }
}
