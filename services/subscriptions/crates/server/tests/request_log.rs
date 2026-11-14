// Its own binary: tracing caches a line as off where it first fires; a parallel test would hide it.

use std::io;
use std::sync::{Arc, Mutex};

use axum::body::Body;
use axum::http::Request;
use serde_json::{Value, json};
use server::config::Config;
use server::listeners::Listener;
use server::telemetry::json_lines;
use tower::ServiceExt;
use tracing_subscriber::prelude::*;

#[derive(Clone)]
struct Captured(Arc<Mutex<Vec<u8>>>);

impl io::Write for Captured {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

#[tokio::test]
async fn each_request_writes_one_line_naming_its_route_and_nothing_it_carried() {
    let config = Config::from_environment(|variable| match variable {
        "SUBSCRIPTIONS_PUBLIC_ADDRESS" => Some("127.0.0.1:8082".to_owned()),
        "SUBSCRIPTIONS_INTERNAL_ADDRESS" => Some("127.0.0.1:8083".to_owned()),
        "SENTRY_ENVIRONMENT" => Some("test".to_owned()),
        _ => None,
    })
    .unwrap();
    let captured = Captured(Arc::new(Mutex::new(Vec::new())));
    let writer = captured.clone();
    let _logs = tracing::subscriber::set_default(
        tracing_subscriber::registry().with(json_lines(move || writer.clone())),
    );

    Listener::Internal
        .router(&config)
        .oneshot(Request::get("/health").body(Body::empty()).unwrap())
        .await
        .unwrap();
    Listener::Public
        .router(&config)
        .oneshot(
            Request::post("/internal/v1/accounts/acct_secret/claims?token=secret")
                .header("authorization", "Bearer secret")
                .body(Body::from(r#"{"signedTransaction":"secret"}"#))
                .unwrap(),
        )
        .await
        .unwrap();

    let output = String::from_utf8(captured.0.lock().unwrap().clone()).unwrap();
    assert!(!output.contains("secret"), "{output}");
    let lines: Vec<Value> = output
        .lines()
        .map(|line| {
            let mut line: Value = serde_json::from_str(line).unwrap();
            let fields = line.as_object_mut().unwrap();
            assert!(fields.remove("timestamp").unwrap().is_string(), "{output}");
            assert!(fields.remove("duration_ms").unwrap().is_f64(), "{output}");
            assert_eq!(
                fields.remove("request_id").unwrap().as_str().unwrap().len(),
                32,
                "{output}"
            );
            line
        })
        .collect();
    assert_eq!(
        lines,
        [
            json!({
                "level": "DEBUG",
                "message": "request",
                "listener": "internal",
                "method": "GET",
                "route": "/health",
                "status": 200,
            }),
            json!({
                "level": "WARN",
                "message": "request",
                "listener": "public",
                "method": "POST",
                "route": "unmatched",
                "status": 404,
            }),
        ]
    );
}
