// Its own binary: tracing caches a line as off where it first fires; a parallel test would hide it.

use std::io;
use std::sync::{Arc, Mutex};

use axum::body::Body;
use axum::http::Request;
use domain::{
    AccountEntitlement, AccountId, Environment, Event, EventKind, Instant, Store, SubscriptionId,
};
use serde_json::{Value, json};
use server::config::Config;
use server::internal::{self, Reads};
use server::listeners::{Bounds, Listener, Readiness};
use server::telemetry::json_lines;
use storage::{AccountRecord, FeedEntry, FeedPage, StorageError};
use tower::ServiceExt;
use tracing_subscriber::prelude::*;
use uuid::Uuid;

// A ledger whose feed holds one event after seq 0 and none after it, and whose second account read fails.
#[derive(Clone, Default)]
struct OneEvent {
    account_reads: Arc<Mutex<u32>>,
}

impl Readiness for OneEvent {
    async fn ready(&self) -> Result<(), StorageError> {
        Ok(())
    }
}

impl Reads for OneEvent {
    async fn feed(&self, after: i64, _limit: i64) -> Result<FeedPage, StorageError> {
        let started = FeedEntry {
            seq: 1,
            recorded_at: Instant::from_epoch_millis(1_796_292_004_000),
            event: Event {
                kind: EventKind::Started,
                occurred_at: Instant::from_epoch_millis(1_796_292_000_000),
                subscription_id: SubscriptionId::new("77f866f6-f995-40d1-b179-345ae244fcc3"),
                account_id: None,
            },
            store: Store::AppStore,
            environment: Environment::Production,
            offer_kind: None,
            entitlement: None,
        };
        Ok(FeedPage {
            epoch: Uuid::parse_str("c09a3ab3-2732-4415-ba88-825ff868cf13").unwrap(),
            entries: if after == 0 {
                vec![started]
            } else {
                Vec::new()
            },
            latest_seq: 1,
        })
    }

    async fn account(&self, account_id: Uuid) -> Result<AccountRecord, StorageError> {
        let mut reads = self.account_reads.lock().unwrap();
        *reads += 1;
        if *reads > 1 {
            return Err(StorageError::Unreadable);
        }
        Ok(AccountRecord {
            entitlement: AccountEntitlement::of(AccountId::new(account_id.to_string()), Vec::new()),
            subscriptions: Vec::new(),
        })
    }
}

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
async fn each_read_writes_its_route_template_and_its_outcome_and_never_the_account_or_the_secret() {
    let config = Config::from_environment(|variable| match variable {
        "SUBSCRIPTIONS_PUBLIC_ADDRESS" => Some("127.0.0.1:8082".to_owned()),
        "SUBSCRIPTIONS_INTERNAL_ADDRESS" => Some("127.0.0.1:8083".to_owned()),
        "SUBSCRIPTIONS_DATABASE_URL" => Some("postgresql://ledger@127.0.0.1:1/ledger".to_owned()),
        "SENTRY_ENVIRONMENT" => Some("test".to_owned()),
        "SUBSCRIPTIONS_INTERNAL_TOKEN" => {
            Some("secret-5d0c3a9e8f7b6a5d4c3b2a1f0e9d8c7b".to_owned())
        }
        _ => None,
    })
    .unwrap();
    let internal = Listener::Internal.router(
        &config,
        OneEvent::default(),
        internal::doors(config.internal_token.clone(), OneEvent::default()),
        Bounds::default(),
    );
    let captured = Captured(Arc::new(Mutex::new(Vec::new())));
    let writer = captured.clone();
    let _logs = tracing::subscriber::set_default(
        tracing_subscriber::registry().with(json_lines(move || writer.clone())),
    );

    for (path, authorization) in [
        (
            "/internal/v1/feed?after=0&limit=500",
            "Bearer secret-5d0c3a9e8f7b6a5d4c3b2a1f0e9d8c7b",
        ),
        (
            "/internal/v1/feed?after=1&limit=500",
            "Bearer secret-5d0c3a9e8f7b6a5d4c3b2a1f0e9d8c7b",
        ),
        (
            "/internal/v1/feed?after=1&limit=500",
            "Bearer secret-the-wrong-one",
        ),
        (
            "/internal/v1/feed?after=one&limit=500",
            "Bearer secret-5d0c3a9e8f7b6a5d4c3b2a1f0e9d8c7b",
        ),
        (
            "/internal/v1/accounts/9387ec65-ab17-4b8c-b145-fd0d622966db",
            "Bearer secret-5d0c3a9e8f7b6a5d4c3b2a1f0e9d8c7b",
        ),
        (
            "/internal/v1/accounts/9387ec65-ab17-4b8c-b145-fd0d622966db",
            "Bearer secret-5d0c3a9e8f7b6a5d4c3b2a1f0e9d8c7b",
        ),
    ] {
        internal
            .clone()
            .oneshot(
                Request::get(path)
                    .header("authorization", authorization)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
    }

    let output = String::from_utf8(captured.0.lock().unwrap().clone()).unwrap();
    assert!(!output.contains("secret"), "{output}");
    assert!(!output.contains("9387ec65"), "{output}");
    let lines: Vec<Value> = output
        .lines()
        .map(|line| {
            let mut line: Value = serde_json::from_str(line).unwrap();
            let fields = line.as_object_mut().unwrap();
            assert!(fields.remove("timestamp").unwrap().is_string(), "{output}");
            // A request's own line carries its id and duration; a line inside it, its span.
            let request_fields = match fields.get_mut("span") {
                Some(span) => span.as_object_mut().unwrap(),
                None => {
                    assert!(fields.remove("duration_ms").unwrap().is_f64(), "{output}");
                    fields
                }
            };
            assert_eq!(
                request_fields
                    .remove("request_id")
                    .unwrap()
                    .as_str()
                    .unwrap()
                    .len(),
                32,
                "{output}"
            );
            line
        })
        .collect();
    let span = |route: &str| json!({ "name": "request", "listener": "internal", "method": "GET", "route": route });
    let request = |level: &str, route: &str, status: u16| {
        json!({
            "level": level,
            "message": "request",
            "listener": "internal",
            "method": "GET",
            "route": route,
            "status": status,
            "outcome": "answered",
        })
    };
    assert_eq!(
        lines,
        [
            json!({
                "level": "INFO",
                "message": "feed.read",
                "operation": "feed.read",
                "outcome": "ok",
                "entries": 1,
                "span": span("/internal/v1/feed"),
            }),
            request("DEBUG", "/internal/v1/feed", 200),
            json!({
                "level": "DEBUG",
                "message": "feed.read",
                "operation": "feed.read",
                "outcome": "ok",
                "entries": 0,
                "span": span("/internal/v1/feed"),
            }),
            request("DEBUG", "/internal/v1/feed", 200),
            request("WARN", "/internal/v1/feed", 401),
            request("WARN", "/internal/v1/feed", 400),
            json!({
                "level": "INFO",
                "message": "account.read",
                "operation": "account.read",
                "outcome": "ok",
                "subscriptions": 0,
                "span": span("/internal/v1/accounts/{accountId}"),
            }),
            request("INFO", "/internal/v1/accounts/{accountId}", 200),
            json!({
                "level": "ERROR",
                "message": "account.read failed",
                "operation": "account.read",
                "code": "unreadable",
                "span": span("/internal/v1/accounts/{accountId}"),
            }),
            request("ERROR", "/internal/v1/accounts/{accountId}", 503),
        ]
    );
}
