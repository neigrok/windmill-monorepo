// Its own binary: the panic hook it installs is process-wide.

use axum::body::Body;
use axum::http::{Request, StatusCode};
use server::config::Config;
use server::listeners::{Bounds, Listener, Readiness};
use server::telemetry::{SERVICE_CRATES, report_panics};
use storage::StorageError;
use tower::ServiceExt;

// Answers ready, as a ledger that answers does.
#[derive(Clone)]
struct Answering;

impl Readiness for Answering {
    async fn ready(&self) -> Result<(), StorageError> {
        Ok(())
    }
}

#[test]
fn a_handler_panic_reaches_sentry_with_its_route_and_without_its_message() {
    let config = Config::from_environment(|variable| match variable {
        "SUBSCRIPTIONS_PUBLIC_ADDRESS" => Some("127.0.0.1:8082".to_owned()),
        "SUBSCRIPTIONS_INTERNAL_ADDRESS" => Some("127.0.0.1:8083".to_owned()),
        "SUBSCRIPTIONS_DATABASE_URL" => Some("postgresql://ledger@127.0.0.1:1/ledger".to_owned()),
        "SENTRY_ENVIRONMENT" => Some("test".to_owned()),
        "SUBSCRIPTIONS_PANIC_ROUTE_ENABLED" => Some("true".to_owned()),
        _ => None,
    })
    .unwrap();
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    let mut status = None;

    report_panics();
    let events = sentry::test::with_captured_events(|| {
        let response = runtime.block_on(
            Listener::Internal
                .router(&config, Answering, Bounds::default())
                .oneshot(Request::get("/debug/panic").body(Body::empty()).unwrap()),
        );
        status = Some(response.unwrap().status());
    });
    // The default hook again, so a failing assertion below prints its message.
    let _ = std::panic::take_hook();

    assert_eq!(status, Some(StatusCode::INTERNAL_SERVER_ERROR));
    assert_eq!(events.len(), 1);
    let event = &events[0];
    assert!(
        !serde_json::to_string(event)
            .unwrap()
            .contains("forced through")
    );
    assert_eq!(event.transaction.as_deref(), Some("GET /debug/panic"));
    assert_eq!(event.tags["listener"], "internal");
    assert_eq!(event.tags["route"], "/debug/panic");
    assert_eq!(event.tags["request_id"].len(), 32);
    let exception = &event.exception.values[0];
    assert_eq!(exception.ty, "panic");
    assert!(
        exception
            .value
            .as_deref()
            .unwrap()
            .starts_with("panicked at crates/server/src/listeners.rs:")
    );
    // A v0 symbol carries its crate's disambiguator: `server[691552063e05c9f]::listeners::…`.
    let functions: Vec<&str> = exception
        .stacktrace
        .as_ref()
        .unwrap()
        .frames
        .iter()
        .filter_map(|frame| frame.function.as_deref())
        .collect();
    let culprit = functions
        .iter()
        .rfind(|function| {
            SERVICE_CRATES.iter().any(|name| {
                function
                    .strip_prefix(name)
                    .is_some_and(|rest| rest.starts_with("::") || rest.starts_with('['))
            })
        })
        .unwrap();
    assert!(
        culprit.starts_with("server")
            && culprit.ends_with("::listeners::forced_panic::{closure#0}"),
        "{functions:#?}"
    );
    assert!(
        !functions
            .iter()
            .any(|function| function.contains("::telemetry::")),
        "{functions:#?}"
    );
}
