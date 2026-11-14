use axum::body::{Body, to_bytes};
use axum::http::{Request, StatusCode};
use serde_json::{Value, json};
use server::config::Config;
use server::listeners::Listener;
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
            .router(&config)
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
            .router(&config)
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
        .router(&disabled)
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
    let internal = Listener::Internal.router(&config);

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
