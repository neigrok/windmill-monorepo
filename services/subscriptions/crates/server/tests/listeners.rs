use std::time::{Duration, Instant};

use axum::Router;
use axum::body::{Body, to_bytes};
use axum::http::{Request, StatusCode};
use axum::routing::get;
use serde_json::{Value, json};
use server::config::Config;
use server::listeners::{Bounds, Listener};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio_util::sync::CancellationToken;
use tower::ServiceExt;

#[tokio::test]
async fn both_listeners_answer_ready() {
    let config = Config::from_environment(|variable| match variable {
        "SUBSCRIPTIONS_PUBLIC_ADDRESS" => Some("127.0.0.1:8082".to_owned()),
        "SUBSCRIPTIONS_INTERNAL_ADDRESS" => Some("127.0.0.1:8083".to_owned()),
        "SENTRY_ENVIRONMENT" => Some("test".to_owned()),
        _ => None,
    })
    .unwrap();

    for listener in [Listener::Public, Listener::Internal] {
        let response = listener
            .router(&config, Bounds::default())
            .oneshot(Request::get("/health").body(Body::empty()).unwrap())
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK, "{listener:?}");
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        assert_eq!(
            serde_json::from_slice::<Value>(&body).unwrap(),
            json!({ "status": "ready" })
        );
    }
}

#[tokio::test]
async fn the_public_listener_answers_no_internal_path() {
    let config = Config::from_environment(|variable| match variable {
        "SUBSCRIPTIONS_PUBLIC_ADDRESS" => Some("127.0.0.1:8082".to_owned()),
        "SUBSCRIPTIONS_INTERNAL_ADDRESS" => Some("127.0.0.1:8083".to_owned()),
        "SENTRY_ENVIRONMENT" => Some("test".to_owned()),
        "SUBSCRIPTIONS_PANIC_ROUTE_ENABLED" => Some("true".to_owned()),
        _ => None,
    })
    .unwrap();

    for path in ["/internal/v1/feed?after=0&limit=10", "/debug/panic"] {
        let response = Listener::Public
            .router(&config, Bounds::default())
            .oneshot(Request::get(path).body(Body::empty()).unwrap())
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::NOT_FOUND, "{path}");
    }
}

#[tokio::test]
async fn the_panic_route_exists_only_when_enabled() {
    let disabled = Config::from_environment(|variable| match variable {
        "SUBSCRIPTIONS_PUBLIC_ADDRESS" => Some("127.0.0.1:8082".to_owned()),
        "SUBSCRIPTIONS_INTERNAL_ADDRESS" => Some("127.0.0.1:8083".to_owned()),
        "SENTRY_ENVIRONMENT" => Some("test".to_owned()),
        _ => None,
    })
    .unwrap();

    let response = Listener::Internal
        .router(&disabled, Bounds::default())
        .oneshot(Request::get("/debug/panic").body(Body::empty()).unwrap())
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn a_panicking_handler_answers_500_and_its_listener_keeps_answering() {
    let config = Config::from_environment(|variable| match variable {
        "SUBSCRIPTIONS_PUBLIC_ADDRESS" => Some("127.0.0.1:8082".to_owned()),
        "SUBSCRIPTIONS_INTERNAL_ADDRESS" => Some("127.0.0.1:8083".to_owned()),
        "SENTRY_ENVIRONMENT" => Some("test".to_owned()),
        "SUBSCRIPTIONS_PANIC_ROUTE_ENABLED" => Some("true".to_owned()),
        _ => None,
    })
    .unwrap();
    let internal = Listener::Internal.router(&config, Bounds::default());

    let panicked = internal
        .clone()
        .oneshot(Request::get("/debug/panic").body(Body::empty()).unwrap())
        .await
        .unwrap();
    let after = internal
        .oneshot(Request::get("/health").body(Body::empty()).unwrap())
        .await
        .unwrap();

    assert_eq!(panicked.status(), StatusCode::INTERNAL_SERVER_ERROR);
    let body = to_bytes(panicked.into_body(), usize::MAX).await.unwrap();
    assert_eq!(
        serde_json::from_slice::<Value>(&body).unwrap(),
        json!({ "error": "internal" })
    );
    assert_eq!(after.status(), StatusCode::OK);
}

#[tokio::test]
async fn a_body_over_its_bound_is_refused_before_any_handler() {
    let config = Config::from_environment(|variable| match variable {
        "SUBSCRIPTIONS_PUBLIC_ADDRESS" => Some("127.0.0.1:8082".to_owned()),
        "SUBSCRIPTIONS_INTERNAL_ADDRESS" => Some("127.0.0.1:8083".to_owned()),
        "SENTRY_ENVIRONMENT" => Some("test".to_owned()),
        _ => None,
    })
    .unwrap();
    let public = Listener::Public.router(&config, Bounds::default());

    let mut answers = Vec::new();
    for length in [64 * 1024, 64 * 1024 + 1] {
        let response = public
            .clone()
            .oneshot(
                Request::get("/health")
                    .header("content-length", length)
                    .body(Body::from(vec![b'a'; length]))
                    .unwrap(),
            )
            .await
            .unwrap();
        answers.push(response.status());
    }

    assert_eq!(answers, [StatusCode::OK, StatusCode::PAYLOAD_TOO_LARGE]);
}

#[tokio::test]
async fn a_request_that_outlives_its_bound_answers_503() {
    let bounds = Bounds {
        request: Duration::from_millis(50),
        ..Bounds::default()
    };
    let stalled = Router::new().route("/stall", get(std::future::pending::<()>));

    let response = Listener::Internal
        .boundary(stalled, bounds)
        .oneshot(Request::get("/stall").body(Body::empty()).unwrap())
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    assert_eq!(
        serde_json::from_slice::<Value>(&body).unwrap(),
        json!({ "error": "timeout" })
    );
}

#[tokio::test]
async fn a_request_head_that_stalls_is_dropped_at_its_bound() {
    let config = Config::from_environment(|variable| match variable {
        "SUBSCRIPTIONS_PUBLIC_ADDRESS" => Some("127.0.0.1:0".to_owned()),
        "SUBSCRIPTIONS_INTERNAL_ADDRESS" => Some("127.0.0.1:0".to_owned()),
        "SENTRY_ENVIRONMENT" => Some("test".to_owned()),
        _ => None,
    })
    .unwrap();
    let bounds = Bounds {
        header_read: Duration::from_millis(300),
        ..Bounds::default()
    };
    let socket = TcpListener::bind(config.public_address).await.unwrap();
    let address = socket.local_addr().unwrap();
    let stop = CancellationToken::new();
    let router = Listener::Public.router(&config, bounds);
    let server = tokio::spawn(Listener::Public.serve(socket, router, bounds, stop.clone()));

    let mut client = TcpStream::connect(address).await.unwrap();
    client
        .write_all(b"GET /health HTTP/1.1\r\nHost: x\r\n")
        .await
        .unwrap();
    let started = Instant::now();
    let mut answer = Vec::new();
    tokio::time::timeout(Duration::from_secs(10), client.read_to_end(&mut answer))
        .await
        .expect("the listener closes the connection")
        .unwrap();
    let held = started.elapsed();
    stop.cancel();
    tokio::time::timeout(Duration::from_secs(10), server)
        .await
        .expect("the listener stops")
        .unwrap();

    assert!(
        held >= Duration::from_millis(250) && held < Duration::from_secs(2),
        "{held:?}"
    );
    assert_eq!(String::from_utf8(answer).unwrap(), "");
}
