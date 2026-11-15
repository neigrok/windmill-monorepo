// Its own binary: tracing caches a line as off where it first fires; a parallel test would hide it.

use std::io;
use std::sync::{Arc, Mutex};

use axum::Router;
use axum::body::Body;
use axum::http::Request;
use domain::{
    AccountEntitlement, AccountId, Environment, Event, EventKind, Instant, Store, SubscriptionId,
};
use serde_json::{Value, json};
use server::config::Config;
use server::internal::{self, BackendLedger};
use server::listeners::{Bounds, Listener, Readiness};
use server::telemetry::json_lines;
use storage::{AccountRecord, Erasure, FeedEntry, FeedPage, StorageError};
use tower::ServiceExt;
use tracing_subscriber::prelude::*;
use uuid::Uuid;

// A ledger whose feed holds one event after seq 0 and none after it, whose second account read fails, and whose first
// erasure records an account that held nothing, its second finds it erased already and its third fails.
#[derive(Clone, Default)]
struct OneEvent {
    account_reads: Arc<Mutex<u32>>,
    erasures: Arc<Mutex<u32>>,
}

impl Readiness for OneEvent {
    async fn ready(&self) -> Result<(), StorageError> {
        Ok(())
    }
}

impl BackendLedger for OneEvent {
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

    async fn erase_account(&self, _account_id: Uuid) -> Result<Erasure, StorageError> {
        let mut erasures = self.erasures.lock().unwrap();
        *erasures += 1;
        if *erasures > 2 {
            return Err(StorageError::Busy);
        }
        Ok(Erasure {
            newly_erased: *erasures == 1,
            erased_at: Instant::from_epoch_millis(1_806_000_000_000),
            lineages: Vec::new(),
            hints_dropped: 0,
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
async fn each_read_and_erasure_writes_its_route_template_and_its_outcome_and_never_the_account_or_the_secret()
 {
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
        internal::doors(
            config.internal_token.clone(),
            OneEvent::default(),
            Router::new(),
        ),
        Bounds::default(),
    );
    let captured = Captured(Arc::new(Mutex::new(Vec::new())));
    let writer = captured.clone();
    let _logs = tracing::subscriber::set_default(
        tracing_subscriber::registry().with(json_lines(move || writer.clone())),
    );

    let secret = "Bearer secret-5d0c3a9e8f7b6a5d4c3b2a1f0e9d8c7b";
    let account = "/internal/v1/accounts/9387ec65-ab17-4b8c-b145-fd0d622966db";
    for (method, path, authorization) in [
        (
            "GET",
            "/internal/v1/feed?after=0&limit=500",
            "Bearer secret-5d0c3a9e8f7b6a5d4c3b2a1f0e9d8c7b",
        ),
        ("GET", "/internal/v1/feed?after=1&limit=500", secret),
        (
            "GET",
            "/internal/v1/feed?after=1&limit=500",
            "Bearer secret-the-wrong-one",
        ),
        ("GET", "/internal/v1/feed?after=one&limit=500", secret),
        ("GET", account, secret),
        ("GET", account, secret),
        ("DELETE", account, secret),
        ("DELETE", account, secret),
        ("DELETE", account, secret),
        ("DELETE", "/internal/v1/accounts/9387EC65", secret),
    ] {
        internal
            .clone()
            .oneshot(
                Request::builder()
                    .method(method)
                    .uri(path)
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
            // A request's own line carries its id and duration; a line inside it, its span, and a write's line its
            // duration too.
            let duration = fields.remove("duration_ms");
            let timed = !fields.contains_key("span") || fields["message"] == "account.unbind";
            assert_eq!(
                duration.is_some_and(|duration| duration.is_f64()),
                timed,
                "{output}"
            );
            let request_fields = match fields.get_mut("span") {
                Some(span) => span.as_object_mut().unwrap(),
                None => fields,
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
    let erasing = json!({
        "name": "request",
        "listener": "internal",
        "method": "DELETE",
        "route": "/internal/v1/accounts/{accountId}",
    });
    let answered = |level: &str, method: &str, route: &str, status: u16| {
        json!({
            "level": level,
            "message": "request",
            "listener": "internal",
            "method": method,
            "route": route,
            "status": status,
            "outcome": "answered",
        })
    };
    let request = |level: &str, route: &str, status: u16| answered(level, "GET", route, status);
    let erased = |outcome: &str| {
        json!({
            "level": "INFO",
            "message": "account.unbind",
            "operation": "account.unbind",
            "outcome": outcome,
            "answered": 204,
            "unbound": 0,
            "periods": 0,
            "hints_dropped": 0,
            "events": 0,
            "span": erasing,
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
            erased("erased"),
            answered("INFO", "DELETE", "/internal/v1/accounts/{accountId}", 204),
            erased("already_erased"),
            answered("INFO", "DELETE", "/internal/v1/accounts/{accountId}", 204),
            json!({
                "level": "ERROR",
                "message": "account.unbind",
                "operation": "account.unbind",
                "outcome": "ledger_failed",
                "code": "busy",
                "answered": 503,
                "span": erasing,
            }),
            answered("ERROR", "DELETE", "/internal/v1/accounts/{accountId}", 503),
            json!({
                "level": "INFO",
                "message": "account.unbind",
                "operation": "account.unbind",
                "outcome": "refused",
                "code": "invalid_account_id",
                "answered": 400,
                "span": erasing,
            }),
            answered("WARN", "DELETE", "/internal/v1/accounts/{accountId}", 400),
        ]
    );
}
