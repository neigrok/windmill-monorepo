// The App Store door's claim and refresh through the internal listener's own router, and the sweep's step that writes
// the hints a claim owes, over a ledger of its own and an Apple of the test's own on a local port, serving what the test
// signer signs. Every test captures the lines it writes and the Sentry events it reports.

use std::collections::HashMap;
use std::env;
use std::fs;
use std::io;
use std::panic::{AssertUnwindSafe, resume_unwind};
use std::path::Path;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use app_store::server_api::{
    ApiFailure, ApiFuture, ApiKey, AppStoreApi, Hosts, NotificationHistoryPage,
    NotificationHistoryRequest, SendAttempt, SendAttemptResult, ServerApi, SignedStatus,
    TestNotificationStatus, TestNotificationToken, TransactionHistoryPage,
};
use app_store::verification::SignedDataVerifier;
use app_store_test_signer::TEST_ROOT;
use axum::Router;
use axum::body::{Body, to_bytes};
use axum::extract::{Path as UrlPath, State};
use axum::http::{Request, StatusCode, Uri};
use axum::routing::{get, put};
use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use domain::{Environment, Store};
use futures_util::FutureExt;
use ring::rand::SystemRandom;
use ring::signature::{ECDSA_P256_SHA256_FIXED_SIGNING, EcdsaKeyPair};
use sentry::protocol::Event;
use serde_json::{Value, json};
use server::config::Config;
use server::internal;
use server::listeners::{Bounds, Listener};
use server::store_doors::{self, AppStoreDoor, TestNotificationOutcome, run_test_notification};
use server::sweep::{HintPass, StoreHintSweep, Sweep};
use server::telemetry::json_lines;
use sqlx::{AssertSqlSafe, Connection, Executor, PgConnection};
use storage::{Ledger, Notification, Receipt};
use tokio::net::TcpListener;
use tokio_util::sync::CancellationToken;
use tower::ServiceExt;
use tracing_subscriber::prelude::*;
use url::Url;
use uuid::Uuid;

// An empty database of its own beside the one SUBSCRIPTIONS_TEST_DATABASE_URL names in its path, dropped
// after the test whether or not it passed. The role there must be allowed to create databases.
async fn with_empty_database<T>(test: impl AsyncFnOnce(String) -> T) -> T {
    let maintenance = env::var("SUBSCRIPTIONS_TEST_DATABASE_URL").expect(
        "SUBSCRIPTIONS_TEST_DATABASE_URL names the database to create test databases beside",
    );
    let name = format!("subscriptions_test_{}", Uuid::new_v4().simple());
    let mut admin = PgConnection::connect(&maintenance).await.unwrap();
    admin
        .execute(AssertSqlSafe(format!("create database {name}")))
        .await
        .unwrap();
    let mut url = Url::parse(&maintenance).unwrap();
    url.set_path(&name);

    let outcome = AssertUnwindSafe(test(url.into())).catch_unwind().await;

    admin
        .execute(AssertSqlSafe(format!("drop database {name} with (force)")))
        .await
        .unwrap();
    match outcome {
        Ok(value) => value,
        Err(panic) => resume_unwind(panic),
    }
}

// Runs a test on one thread under a Sentry client of its own, answering what it returns and the events it reported.
fn reported<T>(test: impl Future<Output = T>) -> (T, Vec<Event<'static>>) {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    let mut returned = None;
    let events = sentry::test::with_captured_events(|| {
        returned = Some(runtime.block_on(test));
    });
    (returned.unwrap(), events)
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

impl Captured {
    fn start() -> (Captured, tracing::subscriber::DefaultGuard) {
        let captured = Captured(Arc::new(Mutex::new(Vec::new())));
        let writer = captured.clone();
        let guard = tracing::subscriber::set_default(
            tracing_subscriber::registry().with(json_lines(move || writer.clone())),
        );
        (captured, guard)
    }

    // The lines of the operations named, each checked to carry a duration and, inside a request, to sit in its span,
    // then without both. Every line written so far is taken.
    fn take(&self, messages: &[&str]) -> Vec<Value> {
        let text = String::from_utf8(std::mem::take(&mut *self.0.lock().unwrap())).unwrap();
        text.lines()
            .map(|line| serde_json::from_str::<Value>(line).unwrap())
            .filter(|line| messages.iter().any(|message| line["message"] == *message))
            .map(|mut line| {
                let fields = line.as_object_mut().unwrap();
                assert!(fields.remove("timestamp").unwrap().is_string());
                if let Some(duration) = fields.remove("duration_ms") {
                    assert!(duration.is_f64(), "{fields:?}");
                }
                if let Some(mut span) = fields.remove("span") {
                    let span_fields = span.as_object_mut().unwrap();
                    assert_eq!(
                        span_fields
                            .remove("request_id")
                            .unwrap()
                            .as_str()
                            .unwrap()
                            .len(),
                        32
                    );
                    assert_eq!(span_fields.remove("listener"), Some(json!("internal")));
                    assert_eq!(span_fields.remove("name"), Some(json!("request")));
                    let route = span_fields.remove("route").unwrap();
                    // Each door writes under one method: the erasure deletes its account, every other door posts.
                    let method = match route.as_str() {
                        Some("/internal/v1/accounts/{accountId}") => "DELETE",
                        _ => "POST",
                    };
                    assert_eq!(span_fields.remove("method"), Some(json!(method)));
                    fields.insert("route".to_owned(), route);
                }
                line
            })
            .collect()
    }
}

// The door's clock and its verifier's, set by the test.
#[derive(Clone)]
struct Clock(Arc<AtomicI64>);

impl Clock {
    fn at(millis: i64) -> Clock {
        Clock(Arc::new(AtomicI64::new(millis)))
    }

    fn set(&self, millis: i64) {
        self.0.store(millis, Ordering::SeqCst);
    }

    fn reading(&self) -> impl Fn() -> SystemTime + Send + Sync + 'static {
        let clock = self.0.clone();
        move || UNIX_EPOCH + Duration::from_millis(clock.load(Ordering::SeqCst) as u64)
    }
}

// An Apple of the test's own: it answers a status pull with what the test set, and records each account token put,
// after a stall the test sets.
#[derive(Clone)]
struct Apple {
    status: Arc<Mutex<(StatusCode, String)>>,
    statuses: Arc<Mutex<HashMap<String, String>>>,
    token_answer: Arc<Mutex<StatusCode>>,
    token_answers: Arc<Mutex<HashMap<String, StatusCode>>>,
    stall: Arc<Mutex<Duration>>,
    pulled: Arc<Mutex<Vec<String>>>,
    tokens: Arc<Mutex<Vec<(String, Value)>>>,
}

impl Apple {
    async fn serve() -> (Apple, Url) {
        let apple = Apple {
            status: Arc::new(Mutex::new((StatusCode::NOT_FOUND, String::new()))),
            statuses: Arc::new(Mutex::new(HashMap::new())),
            token_answer: Arc::new(Mutex::new(StatusCode::OK)),
            token_answers: Arc::new(Mutex::new(HashMap::new())),
            stall: Arc::new(Mutex::new(Duration::ZERO)),
            pulled: Arc::new(Mutex::new(Vec::new())),
            tokens: Arc::new(Mutex::new(Vec::new())),
        };
        let router = Router::new()
            .route("/inApps/v1/subscriptions/{id}", get(pull))
            .route(
                "/inApps/v1/transactions/{id}/appAccountToken",
                put(put_token),
            )
            .with_state(apple.clone());
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = Url::parse(&format!("http://{}", listener.local_addr().unwrap())).unwrap();
        tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        (apple, url)
    }

    fn answers_status(&self, status: StatusCode, body: String) {
        *self.status.lock().unwrap() = (status, body);
    }

    // The status of one lineage, answered 200 for its original transaction id alone.
    fn answers_status_of(&self, original_transaction_id: &str, body: String) {
        self.statuses
            .lock()
            .unwrap()
            .insert(original_transaction_id.to_owned(), body);
    }

    fn answers_token_puts(&self, status: StatusCode) {
        *self.token_answer.lock().unwrap() = status;
    }

    fn answers_token_puts_of(&self, original_transaction_id: &str, status: StatusCode) {
        self.token_answers
            .lock()
            .unwrap()
            .insert(original_transaction_id.to_owned(), status);
    }

    fn stalls(&self, stall: Duration) {
        *self.stall.lock().unwrap() = stall;
    }

    fn pulled(&self) -> Vec<String> {
        std::mem::take(&mut self.pulled.lock().unwrap())
    }

    fn tokens(&self) -> Vec<(String, Value)> {
        std::mem::take(&mut self.tokens.lock().unwrap())
    }
}

async fn pull(
    State(apple): State<Apple>,
    UrlPath(id): UrlPath<String>,
    uri: Uri,
) -> (StatusCode, String) {
    apple.pulled.lock().unwrap().push(uri.path().to_owned());
    let stall = *apple.stall.lock().unwrap();
    tokio::time::sleep(stall).await;
    if let Some(body) = apple.statuses.lock().unwrap().get(&id) {
        return (StatusCode::OK, body.clone());
    }
    apple.status.lock().unwrap().clone()
}

async fn put_token(
    State(apple): State<Apple>,
    UrlPath(id): UrlPath<String>,
    uri: Uri,
    body: String,
) -> StatusCode {
    apple
        .tokens
        .lock()
        .unwrap()
        .push((uri.path().to_owned(), serde_json::from_str(&body).unwrap()));
    let stall = *apple.stall.lock().unwrap();
    tokio::time::sleep(stall).await;
    if let Some(status) = apple.token_answers.lock().unwrap().get(&id) {
        return *status;
    }
    *apple.token_answer.lock().unwrap()
}

// The door with an in-app purchase key of the test's own, calling the test's Apple for both environments, or with none.
fn door(ledger: &Ledger, clock: &Clock, apple: Option<&Url>) -> AppStoreDoor {
    let api: Option<Arc<dyn AppStoreApi>> = apple.map(|url| {
        let pkcs8 =
            EcdsaKeyPair::generate_pkcs8(&ECDSA_P256_SHA256_FIXED_SIGNING, &SystemRandom::new())
                .unwrap();
        let p8 = format!(
            "-----BEGIN PRIVATE KEY-----\n{}\n-----END PRIVATE KEY-----\n",
            STANDARD.encode(pkcs8.as_ref())
        );
        let key = ApiKey {
            issuer_id: "57246542-96fe-1a63-e053-0824d011072a".to_owned(),
            key_id: "2X9R4HXF34".to_owned(),
            private_key: p8.parse().unwrap(),
        };
        let hosts = Hosts {
            production: url.clone(),
            sandbox: url.clone(),
        };
        Arc::new(ServerApi::new(key, hosts, clock.reading())) as Arc<dyn AppStoreApi>
    });
    let verifier = SignedDataVerifier::windmill_also_trusting(TEST_ROOT, clock.reading()).unwrap();
    AppStoreDoor::new(ledger.clone(), verifier, api, clock.reading())
}

// The public listener's router, for the notifications a story starts with, and the internal one's behind the secret.
fn routers(ledger: &Ledger, door: &AppStoreDoor) -> (Router, Router) {
    let config = Config::from_environment(|variable| match variable {
        "SUBSCRIPTIONS_PUBLIC_ADDRESS" => Some("127.0.0.1:8082".to_owned()),
        "SUBSCRIPTIONS_INTERNAL_ADDRESS" => Some("127.0.0.1:8083".to_owned()),
        "SUBSCRIPTIONS_DATABASE_URL" => Some("postgresql://ledger@127.0.0.1:1/ledger".to_owned()),
        "SENTRY_ENVIRONMENT" => Some("test".to_owned()),
        "SUBSCRIPTIONS_INTERNAL_TOKEN" => Some("5d0c3a9e8f7b6a5d4c3b2a1f0e9d8c7b".to_owned()),
        _ => None,
    })
    .unwrap();
    let public = Listener::Public.router(
        &config,
        ledger.clone(),
        store_doors::router(door.clone()),
        Bounds::default(),
    );
    let internal = Listener::Internal.router(
        &config,
        ledger.clone(),
        internal::doors(
            config.internal_token.clone(),
            ledger.clone(),
            store_doors::internal_router(door.clone()),
        ),
        Bounds::default(),
    );
    (public, internal)
}

fn story(file: &str) -> Value {
    let stories = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../tests/fixtures/app_store/test-payloads")
        .join(file);
    serde_json::from_str(&fs::read_to_string(stories).unwrap()).unwrap()
}

// A description whose every payload states the account hint given, or none: a purchase made without the app setting
// one.
fn with_hint(mut description: Value, account: Option<&str>) -> Value {
    let holders = [
        "/notification/data/signedTransactionInfo",
        "/notification/data/signedRenewalInfo",
        "/transaction",
        "/statusResponse/data/0/lastTransactions/0/signedTransactionInfo",
        "/statusResponse/data/0/lastTransactions/0/signedRenewalInfo",
    ];
    for holder in holders {
        if let Some(Value::Object(payload)) = description.pointer_mut(holder) {
            match account {
                Some(account) => payload.insert("appAccountToken".to_owned(), json!(account)),
                None => payload.remove("appAccountToken"),
            };
        }
    }
    description
}

fn without_hint(description: Value) -> Value {
    with_hint(description, None)
}

fn signed(description: Value, at: i64) -> String {
    app_store_test_signer::sign(
        serde_json::from_value(description).unwrap(),
        UNIX_EPOCH + Duration::from_millis(at as u64),
    )
    .unwrap()
}

// Posts a notification as Apple does and waits until the door has applied it, which it does after answering.
async fn notify(public: &Router, ledger: &Ledger, description: Value, at: i64) {
    let events_before = ledger.feed(0, 500).await.unwrap().entries.len();
    let body = json!({ "signedPayload": signed(description, at) }).to_string();
    let response = public
        .clone()
        .oneshot(
            Request::post("/v1/stores/app-store/notifications")
                .header("content-type", "application/json")
                .body(Body::from(body))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let deadline = Instant::now() + Duration::from_secs(15);
    while ledger.feed(0, 500).await.unwrap().entries.len() == events_before {
        assert!(
            Instant::now() < deadline,
            "the notification was not applied"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

// Posts to an internal door with the bearer secret, or without one.
async fn post(
    internal: &Router,
    path: &str,
    body: Value,
    with_secret: bool,
) -> (StatusCode, Value) {
    let (status, body) = post_as_sent(internal, path, body, with_secret).await;
    (status, serde_json::from_str(&body).unwrap())
}

// The answer as the door wrote it, key order included.
async fn post_as_sent(
    internal: &Router,
    path: &str,
    body: Value,
    with_secret: bool,
) -> (StatusCode, String) {
    let mut request = Request::post(path).header("content-type", "application/json");
    if with_secret {
        request = request.header("authorization", "Bearer 5d0c3a9e8f7b6a5d4c3b2a1f0e9d8c7b");
    }
    let response = internal
        .clone()
        .oneshot(request.body(Body::from(body.to_string())).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    (status, String::from_utf8(body.to_vec()).unwrap())
}

fn claim(account_id: &str, signed_transaction: &str) -> Value {
    json!({ "accountId": account_id, "signedTransaction": signed_transaction })
}

// Each event of the feed: its type, when it happened counted from `from`, and the account it names.
async fn feed(ledger: &Ledger, from: i64) -> Vec<(&'static str, i64, Option<String>)> {
    ledger
        .feed(0, 500)
        .await
        .unwrap()
        .entries
        .into_iter()
        .map(|entry| {
            (
                entry.event.kind.name(),
                entry.event.occurred_at.epoch_millis() - from,
                entry
                    .event
                    .account_id
                    .map(|account| account.as_str().to_owned()),
            )
        })
        .collect()
}

// What the ledger owes the stores: each hint's original transaction and account.
async fn owed(url: &str) -> Vec<(String, String)> {
    let mut connection = PgConnection::connect(url).await.unwrap();
    sqlx::query_as(
        "select store_subscription_id, account_id::text from store_hints order by owed_since",
    )
    .fetch_all(&mut connection)
    .await
    .unwrap()
}

fn reported_as(events: &[Event<'static>]) -> Vec<(String, String, String)> {
    events
        .iter()
        .map(|event| {
            (
                format!("{:?}", event.level),
                event.tags["operation"].clone(),
                event.tags["code"].clone(),
            )
        })
        .collect()
}

#[test]
#[cfg_attr(not(postgres_tests), ignore = "needs SUBSCRIPTIONS_TEST_DATABASE_URL")]
fn a_claim_binds_an_unbound_purchase_by_the_state_it_pulls_and_a_repeat_changes_nothing() {
    let start = 1_793_491_200_000_i64;
    let day = 86_400_000;
    let ada = "9387ec65-ab17-4b8c-b145-fd0d622966db";
    let bo = "2c5e8f1a-7d3b-4c9e-a6f2-0b8d4e1c7a95";
    let ((answers, lines, feed, owed, pulled, subscription_id), events) =
        reported(with_empty_database(async |url| {
            let (captured, _logs) = Captured::start();
            let ledger = Ledger::open(&url.parse().unwrap()).await.unwrap();
            let clock = Clock::at(start);
            let (apple, apple_url) = Apple::serve().await;
            let door = door(&ledger, &clock, Some(&apple_url));
            let (public, internal) = routers(&ledger, &door);

            notify(&public, &ledger, without_hint(story("started.json")), start).await;
            apple.answers_status(
                StatusCode::OK,
                signed(without_hint(story("subscription-status.json")), start),
            );
            let transaction = signed(without_hint(story("purchase-transaction.json")), start);
            clock.set(start + 60_000);
            let mut answers = Vec::new();
            for account in [ada, ada, bo] {
                answers.push(
                    post_as_sent(
                        &internal,
                        "/internal/v1/app-store/claims",
                        claim(account, &transaction),
                        true,
                    )
                    .await,
                );
            }
            let feed = feed(&ledger, start).await;
            let subscription_id = ledger.feed(0, 1).await.unwrap().entries[0]
                .event
                .subscription_id
                .as_str()
                .to_owned();
            (
                answers,
                captured.take(&["store.claim"]),
                feed,
                owed(&url).await,
                apple.pulled(),
                subscription_id,
            )
        }));

    let entitlement = json!({
        "accountId": ada,
        "production": {"plan": null, "accessUntil": null, "governing": null, "others": []},
        "sandbox": {
            "plan": "windmill_one",
            "accessUntil": start + 30 * day,
            "governing": {
                "subscriptionId": subscription_id,
                "store": "app_store",
                "state": "active",
                "startedAt": start,
                "currentPeriod": {"start": start, "end": start + 30 * day},
                "accessUntil": start + 30 * day,
                "autoRenew": true,
                "nextChargeAt": start + 30 * day,
                "nextCharge": {"amount": "12.00", "currency": "USD"},
                "nextProductId": null,
                "cancelRequestedAt": null,
                "paymentFailedAt": null,
                "graceEndsAt": null,
                "pauseScheduledFor": null,
                "pausedAt": null,
                "resumesAt": null,
                "offerKind": null,
                "offerEndsAt": null,
                "endedAt": null,
                "endReason": null
            },
            "others": []
        }
    });
    let line = |outcome: &str, code: Option<&str>, answered: u16, events: Option<usize>| {
        let mut line = json!({
            "level": "INFO",
            "message": "store.claim",
            "operation": "store.claim",
            "store": "app_store",
            "environment": "sandbox",
            "outcome": outcome,
            "answered": answered,
            "route": "/internal/v1/app-store/claims",
        });
        if let Some(code) = code {
            line["code"] = json!(code);
        }
        if let Some(events) = events {
            line["events"] = json!(events);
        }
        line
    };
    // Byte for byte, key order included, as the contract writes each answer.
    assert_eq!(
        answers,
        vec![
            (
                StatusCode::OK,
                json!({"seq": 4, "entitlement": entitlement}).to_string()
            ),
            (
                StatusCode::OK,
                json!({"seq": 4, "entitlement": entitlement}).to_string()
            ),
            (
                StatusCode::CONFLICT,
                json!({"code": "bound_to_another_account"}).to_string()
            ),
        ]
    );
    assert_eq!(
        lines,
        vec![
            line("applied", None, 200, Some(2)),
            line("applied", None, 200, Some(0)),
            line("refused", Some("bound_to_another_account"), 409, None),
        ]
    );
    assert_eq!(
        feed,
        vec![
            ("started", 0, None),
            ("period_recorded", 0, None),
            ("bound", 60_000, Some(ada.to_owned())),
            ("period_recorded", 0, Some(ada.to_owned())),
        ]
    );
    assert_eq!(owed, vec![("2000000000000001".to_owned(), ada.to_owned())]);
    assert_eq!(
        pulled,
        vec!["/inApps/v1/subscriptions/2000000000000001".to_owned(); 3]
    );
    assert_eq!(events.len(), 0, "{events:#?}");
}

#[test]
#[cfg_attr(not(postgres_tests), ignore = "needs SUBSCRIPTIONS_TEST_DATABASE_URL")]
fn the_sweep_writes_the_hint_a_claim_owes_keeps_one_apple_did_not_take_and_clears_it_once_taken() {
    let start = 1_793_491_200_000_i64;
    let ada = "9387ec65-ab17-4b8c-b145-fd0d622966db";
    let ((passes, tokens, owed_between, owed_after, lines), events) =
        reported(with_empty_database(async |url| {
            let (captured, _logs) = Captured::start();
            let ledger = Ledger::open(&url.parse().unwrap()).await.unwrap();
            let clock = Clock::at(start);
            let (apple, apple_url) = Apple::serve().await;
            let door = door(&ledger, &clock, Some(&apple_url));
            let (public, internal) = routers(&ledger, &door);
            notify(&public, &ledger, without_hint(story("started.json")), start).await;
            apple.answers_status(
                StatusCode::OK,
                signed(without_hint(story("subscription-status.json")), start),
            );
            let transaction = signed(without_hint(story("purchase-transaction.json")), start);
            let (claimed, _) = post(
                &internal,
                "/internal/v1/app-store/claims",
                claim(ada, &transaction),
                true,
            )
            .await;
            assert_eq!(claimed, StatusCode::OK);
            captured.take(&["store.claim"]);

            let sweep = StoreHintSweep::new(door.clone());
            let stop = CancellationToken::new();
            apple.answers_token_puts(StatusCode::INTERNAL_SERVER_ERROR);
            let mut passes = vec![sweep.pass(&stop).await, sweep.pass(&stop).await];
            let owed_between = owed(&url).await;
            let mut connection = PgConnection::connect(&url).await.unwrap();
            let attempts: i32 = sqlx::query_scalar("select attempts from store_hints")
                .fetch_one(&mut connection)
                .await
                .unwrap();
            assert_eq!(
                attempts, 0,
                "a failure of Apple's API counts against no hint"
            );
            apple.answers_token_puts(StatusCode::OK);
            passes.push(sweep.pass(&stop).await);
            passes.push(sweep.pass(&stop).await);
            (
                passes,
                apple.tokens(),
                owed_between,
                owed(&url).await,
                captured.take(&["store.hint"]),
            )
        }));

    let put = (
        "/inApps/v1/transactions/2000000000000001/appAccountToken".to_owned(),
        json!({"appAccountToken": ada}),
    );
    let failed = HintPass {
        written: 0,
        failed: 1,
        ..HintPass::default()
    };
    assert_eq!(
        passes,
        vec![
            failed,
            HintPass {
                written: 0,
                failed: 1,
                ..HintPass::default()
            },
            HintPass {
                written: 1,
                failed: 0,
                ..HintPass::default()
            },
            HintPass::default(),
        ]
    );
    assert_eq!(tokens, vec![put.clone(), put.clone(), put]);
    assert_eq!(
        owed_between,
        vec![("2000000000000001".to_owned(), ada.to_owned())]
    );
    assert_eq!(owed_after, Vec::new());
    let sentry_event_id = lines[0]["sentry_event_id"].clone();
    assert_eq!(sentry_event_id.as_str().map(str::len), Some(32));
    let write_failed = |sentry_event_id: Option<Value>| {
        let mut line = json!({
            "level": "ERROR",
            "message": "store.hint",
            "operation": "store.hint",
            "store": "app_store",
            "environment": "sandbox",
            "outcome": "write_failed",
            "code": "api_server_error",
        });
        if let Some(id) = sentry_event_id {
            line["sentry_event_id"] = id;
        }
        line
    };
    assert_eq!(
        lines,
        vec![
            write_failed(Some(sentry_event_id)),
            write_failed(None),
            json!({
                "level": "INFO",
                "message": "store.hint",
                "operation": "store.hint",
                "store": "app_store",
                "environment": "sandbox",
                "outcome": "written",
            }),
        ]
    );
    assert_eq!(
        reported_as(&events),
        vec![(
            "Error".to_owned(),
            "store.hint".to_owned(),
            "api_server_error".to_owned()
        )]
    );
}

#[test]
#[cfg_attr(not(postgres_tests), ignore = "needs SUBSCRIPTIONS_TEST_DATABASE_URL")]
fn a_refresh_applies_the_state_apple_states_now_and_binds_by_its_hint_alone() {
    let start = 1_793_491_200_000_i64;
    let day = 86_400_000;
    let buyer = "6f9d0c2e-4b1a-4c8e-9f3d-2a7b5e1c0d84";
    let ((answers, lines, feed, verified_at), events) =
        reported(with_empty_database(async |url| {
            let (captured, _logs) = Captured::start();
            let ledger = Ledger::open(&url.parse().unwrap()).await.unwrap();
            let clock = Clock::at(start);
            let (apple, apple_url) = Apple::serve().await;
            let door = door(&ledger, &clock, Some(&apple_url));
            let (public, internal) = routers(&ledger, &door);
            notify(&public, &ledger, without_hint(story("started.json")), start).await;
            let subscription_id = ledger.feed(0, 1).await.unwrap().entries[0]
                .event
                .subscription_id
                .as_str()
                .to_owned();

            // Ten days in, Apple states renewal off, and the purchase's hint its renewals carry.
            let mut status = story("subscription-status.json");
            let entry = &mut status["statusResponse"]["data"][0]["lastTransactions"][0];
            for (field, date) in [
                ("purchaseDate", "now-10d"),
                ("originalPurchaseDate", "now-10d"),
                ("expiresDate", "now+20d"),
            ] {
                entry["signedTransactionInfo"][field] = json!(date);
            }
            entry["signedRenewalInfo"]["renewalDate"] = json!("now+20d");
            entry["signedRenewalInfo"]["recentSubscriptionStartDate"] = json!("now-10d");
            entry["signedRenewalInfo"]["autoRenewStatus"] = json!(0);
            apple.answers_status(StatusCode::OK, signed(status, start + 10 * day));
            clock.set(start + 10 * day + 60_000);

            let refresh = format!("/internal/v1/subscriptions/{subscription_id}/refresh");
            let answers = vec![
                post(&internal, &refresh, json!({}), true).await,
                post(&internal, &refresh, json!({}), true).await,
                post(
                    &internal,
                    "/internal/v1/subscriptions/3f6c2a1e-9b7d-4e2a-8c51-0d4f7b2e9a61/refresh",
                    json!({}),
                    true,
                )
                .await,
                post(
                    &internal,
                    &format!(
                        "/internal/v1/subscriptions/{}/refresh",
                        subscription_id.to_uppercase()
                    ),
                    json!({}),
                    true,
                )
                .await,
            ];
            let mut connection = PgConnection::connect(&url).await.unwrap();
            let verified_at: Option<i64> =
                sqlx::query_scalar("select verified_at from subscriptions")
                    .fetch_one(&mut connection)
                    .await
                    .unwrap();
            (
                answers,
                captured.take(&["store.refresh"]),
                feed(&ledger, start).await,
                verified_at,
            )
        }));

    let route = "/internal/v1/subscriptions/{subscriptionId}/refresh";
    assert_eq!(
        answers,
        vec![
            (StatusCode::OK, json!({"seq": 5})),
            (StatusCode::OK, json!({"seq": 5})),
            (
                StatusCode::NOT_FOUND,
                json!({"code": "unknown_subscription"})
            ),
            (
                StatusCode::BAD_REQUEST,
                json!({"code": "invalid_subscription_id"})
            ),
        ]
    );
    assert_eq!(
        feed,
        vec![
            ("started", 0, None),
            ("period_recorded", 0, None),
            ("renewal_turned_off", 10 * day, Some(buyer.to_owned())),
            ("bound", 0, Some(buyer.to_owned())),
            ("period_recorded", 10 * day, Some(buyer.to_owned())),
        ]
    );
    assert_eq!(verified_at, Some(start + 10 * day + 60_000));
    let applied = |events: usize| {
        json!({
            "level": "INFO",
            "message": "store.refresh",
            "operation": "store.refresh",
            "store": "app_store",
            "environment": "sandbox",
            "outcome": "applied",
            "answered": 200,
            "events": events,
            "route": route,
        })
    };
    assert_eq!(
        lines,
        vec![
            applied(3),
            applied(0),
            json!({
                "level": "INFO",
                "message": "store.refresh",
                "operation": "store.refresh",
                "store": "app_store",
                "outcome": "refused",
                "code": "unknown_subscription",
                "answered": 404,
                "route": route,
            }),
            json!({
                "level": "WARN",
                "message": "store.refresh",
                "operation": "store.refresh",
                "store": "app_store",
                "outcome": "refused",
                "code": "invalid_subscription_id",
                "answered": 400,
                "route": route,
            }),
        ]
    );
    assert_eq!(events.len(), 0, "{events:#?}");
}

#[test]
#[cfg_attr(not(postgres_tests), ignore = "needs SUBSCRIPTIONS_TEST_DATABASE_URL")]
fn without_a_key_for_apple_s_api_a_claim_and_a_refresh_answer_503_and_an_owed_hint_stays_owed() {
    let start = 1_793_491_200_000_i64;
    let ada = "9387ec65-ab17-4b8c-b145-fd0d622966db";
    let ((answers, pass, owed, lines), events) = reported(with_empty_database(async |url| {
        let (captured, _logs) = Captured::start();
        let ledger = Ledger::open(&url.parse().unwrap()).await.unwrap();
        let clock = Clock::at(start);
        let (apple, apple_url) = Apple::serve().await;
        let (public, internal) = routers(&ledger, &door(&ledger, &clock, Some(&apple_url)));
        notify(&public, &ledger, without_hint(story("started.json")), start).await;
        apple.answers_status(
            StatusCode::OK,
            signed(without_hint(story("subscription-status.json")), start),
        );
        let transaction = signed(without_hint(story("purchase-transaction.json")), start);
        let (claimed, _) = post(
            &internal,
            "/internal/v1/app-store/claims",
            claim(ada, &transaction),
            true,
        )
        .await;
        assert_eq!(claimed, StatusCode::OK);
        let subscription_id = ledger.feed(0, 1).await.unwrap().entries[0]
            .event
            .subscription_id
            .as_str()
            .to_owned();
        captured.take(&["store.claim"]);

        // The same deployment started again without the key.
        let keyless = door(&ledger, &clock, None);
        let (_, internal) = routers(&ledger, &keyless);
        let answers = vec![
            post(
                &internal,
                "/internal/v1/app-store/claims",
                claim(ada, &transaction),
                true,
            )
            .await,
            post(
                &internal,
                &format!("/internal/v1/subscriptions/{subscription_id}/refresh"),
                json!({}),
                true,
            )
            .await,
        ];
        let pass = StoreHintSweep::new(keyless)
            .pass(&CancellationToken::new())
            .await;
        let lines = captured.take(&["store.claim", "store.refresh"]);
        (answers, pass, owed(&url).await, lines)
    }));

    assert_eq!(
        answers,
        vec![
            (
                StatusCode::SERVICE_UNAVAILABLE,
                json!({"code": "store_api_unavailable"})
            ),
            (
                StatusCode::SERVICE_UNAVAILABLE,
                json!({"code": "store_api_unavailable"})
            ),
        ]
    );
    assert_eq!(pass, HintPass::default());
    assert_eq!(owed, vec![("2000000000000001".to_owned(), ada.to_owned())]);
    assert_eq!(
        lines,
        vec![
            json!({
                "level": "WARN",
                "message": "store.claim",
                "operation": "store.claim",
                "store": "app_store",
                "environment": "sandbox",
                "outcome": "store_api_unavailable",
                "answered": 503,
                "route": "/internal/v1/app-store/claims",
            }),
            json!({
                "level": "WARN",
                "message": "store.refresh",
                "operation": "store.refresh",
                "store": "app_store",
                "environment": "sandbox",
                "outcome": "store_api_unavailable",
                "answered": 503,
                "route": "/internal/v1/subscriptions/{subscriptionId}/refresh",
            }),
        ]
    );
    assert_eq!(events.len(), 0, "{events:#?}");
}

#[test]
#[cfg_attr(not(postgres_tests), ignore = "needs SUBSCRIPTIONS_TEST_DATABASE_URL")]
fn a_claim_the_service_cannot_take_is_refused_and_its_line_says_why() {
    let start = 1_793_491_200_000_i64;
    let ada = "9387ec65-ab17-4b8c-b145-fd0d622966db";
    let erased = "4b7e2d9c-1f3a-4e8b-9c6d-5a0f2e7b1c84";
    let ((answers, lines, feed), events) = reported(with_empty_database(async |url| {
        let (captured, _logs) = Captured::start();
        let ledger = Ledger::open(&url.parse().unwrap()).await.unwrap();
        let clock = Clock::at(start);
        let (apple, apple_url) = Apple::serve().await;
        let (_, internal) = routers(&ledger, &door(&ledger, &clock, Some(&apple_url)));
        ledger
            .erase_account(Uuid::parse_str(erased).unwrap())
            .await
            .unwrap();
        apple.answers_status(
            StatusCode::OK,
            signed(without_hint(story("subscription-status.json")), start),
        );
        let transaction = signed(without_hint(story("purchase-transaction.json")), start);
        let mut another_product = without_hint(story("purchase-transaction.json"));
        another_product["transaction"]["productId"] = json!("works.windmill.app.one.yearly");
        let another_product = signed(another_product, start);

        let claims = "/internal/v1/app-store/claims";
        let answers = vec![
            post(
                &internal,
                claims,
                json!({"signedTransaction": transaction}),
                true,
            )
            .await,
            post(
                &internal,
                claims,
                claim(&ada.to_uppercase(), &transaction),
                true,
            )
            .await,
            post(&internal, claims, claim(ada, "not.a.jws"), true).await,
            post(&internal, claims, claim(ada, &another_product), true).await,
            post(&internal, claims, claim(erased, &transaction), true).await,
            post(&internal, claims, claim(ada, &transaction), false).await,
        ];
        (
            answers,
            captured.take(&["store.claim"]),
            feed(&ledger, start).await,
        )
    }));

    let invalid_transaction = (
        StatusCode::BAD_REQUEST,
        json!({"code": "invalid_transaction"}),
    );
    assert_eq!(
        answers,
        vec![
            (StatusCode::BAD_REQUEST, json!({"code": "invalid_request"})),
            (
                StatusCode::BAD_REQUEST,
                json!({"code": "invalid_account_id"})
            ),
            invalid_transaction.clone(),
            invalid_transaction,
            (StatusCode::CONFLICT, json!({"code": "account_erased"})),
            (StatusCode::UNAUTHORIZED, json!({"code": "unauthorized"})),
        ]
    );
    let refused = |level: &str, environment: Option<&str>, code: &str, answered: u16| {
        let mut line = json!({
            "level": level,
            "message": "store.claim",
            "operation": "store.claim",
            "store": "app_store",
            "outcome": "refused",
            "code": code,
            "answered": answered,
            "route": "/internal/v1/app-store/claims",
        });
        if let Some(environment) = environment {
            line["environment"] = json!(environment);
        }
        line
    };
    assert_eq!(
        lines,
        vec![
            refused("WARN", None, "invalid_request", 400),
            refused("WARN", None, "invalid_account_id", 400),
            refused("INFO", None, "malformed", 400),
            refused("WARN", Some("sandbox"), "unknown_product", 400),
            refused("INFO", Some("sandbox"), "account_erased", 409),
        ]
    );
    assert_eq!(feed, Vec::new());
    assert_eq!(events.len(), 0, "{events:#?}");
}

#[test]
#[cfg_attr(not(postgres_tests), ignore = "needs SUBSCRIPTIONS_TEST_DATABASE_URL")]
fn a_pull_that_gives_no_state_to_apply_answers_503_and_is_an_issue_at_most_once_a_while() {
    let start = 1_793_491_200_000_i64;
    let ada = "9387ec65-ab17-4b8c-b145-fd0d622966db";
    let ((answers, lines, feed), events) = reported(with_empty_database(async |url| {
        let (captured, _logs) = Captured::start();
        let ledger = Ledger::open(&url.parse().unwrap()).await.unwrap();
        let clock = Clock::at(start);
        let (apple, apple_url) = Apple::serve().await;
        let (_, internal) = routers(&ledger, &door(&ledger, &clock, Some(&apple_url)));
        let transaction = signed(without_hint(story("purchase-transaction.json")), start);
        // Apple lists the entry under the lineage asked for, and signs another lineage's transaction in it.
        let mut another_lineage = without_hint(story("subscription-status.json"));
        let entry = &mut another_lineage["statusResponse"]["data"][0]["lastTransactions"][0];
        entry["signedTransactionInfo"]["originalTransactionId"] = json!("2000000000000009");
        entry["signedRenewalInfo"]["originalTransactionId"] = json!("2000000000000009");
        let unsigned = json!({"data": [{"lastTransactions": [{
            "originalTransactionId": "2000000000000001",
            "status": 1,
            "signedTransactionInfo": "not.a.jws",
            "signedRenewalInfo": "not.a.jws"
        }]}]});

        let mut answers = Vec::new();
        for (status, body) in [
            (StatusCode::INTERNAL_SERVER_ERROR, String::new()),
            (StatusCode::INTERNAL_SERVER_ERROR, String::new()),
            (StatusCode::OK, signed(another_lineage, start)),
            (StatusCode::OK, unsigned.to_string()),
        ] {
            apple.answers_status(status, body);
            answers.push(
                post(
                    &internal,
                    "/internal/v1/app-store/claims",
                    claim(ada, &transaction),
                    true,
                )
                .await,
            );
        }
        (
            answers,
            captured.take(&["store.claim"]),
            feed(&ledger, start).await,
        )
    }));

    assert_eq!(
        answers,
        vec![
            (
                StatusCode::SERVICE_UNAVAILABLE,
                json!({"code": "store_unavailable"})
            );
            4
        ]
    );
    let ids: Vec<Option<&str>> = lines
        .iter()
        .map(|line| line["sentry_event_id"].as_str())
        .collect();
    assert!(
        ids[0].is_some() && ids[1].is_none() && ids[2].is_some() && ids[3].is_some(),
        "{ids:?}"
    );
    let failed = |code: &str, sentry_event_id: Option<&str>| {
        let mut line = json!({
            "level": "ERROR",
            "message": "store.claim",
            "operation": "store.claim",
            "store": "app_store",
            "environment": "sandbox",
            "outcome": "pull_failed",
            "code": code,
            "answered": 503,
            "route": "/internal/v1/app-store/claims",
        });
        if let Some(id) = sentry_event_id {
            line["sentry_event_id"] = json!(id);
        }
        line
    };
    assert_eq!(
        lines,
        vec![
            failed("api_server_error", ids[0]),
            failed("api_server_error", None),
            failed("inconsistent", ids[2]),
            failed("malformed", ids[3]),
        ]
    );
    assert_eq!(feed, Vec::new());
    assert_eq!(
        reported_as(&events),
        ["api_server_error", "inconsistent", "malformed"]
            .map(|code| (
                "Error".to_owned(),
                "store.claim".to_owned(),
                code.to_owned()
            ))
            .to_vec()
    );
}

#[test]
#[cfg_attr(not(postgres_tests), ignore = "needs SUBSCRIPTIONS_TEST_DATABASE_URL")]
fn apple_down_and_the_ledger_down_are_two_issues_each_reported_in_its_own_slot() {
    let start = 1_793_491_200_000_i64;
    let ada = "9387ec65-ab17-4b8c-b145-fd0d622966db";
    let ((claims, hints), events) = reported(with_empty_database(async |url| {
        let (captured, _logs) = Captured::start();
        let ledger = Ledger::open(&url.parse().unwrap()).await.unwrap();
        let clock = Clock::at(start);
        let (apple, apple_url) = Apple::serve().await;
        let door = door(&ledger, &clock, Some(&apple_url));
        let (public, internal) = routers(&ledger, &door);
        notify(&public, &ledger, without_hint(story("started.json")), start).await;
        apple.answers_status(
            StatusCode::OK,
            signed(without_hint(story("subscription-status.json")), start),
        );
        let transaction = signed(without_hint(story("purchase-transaction.json")), start);
        let claims = "/internal/v1/app-store/claims";
        let sweep = StoreHintSweep::new(door.clone());
        let stop = CancellationToken::new();
        assert_eq!(
            post(&internal, claims, claim(ada, &transaction), true)
                .await
                .0,
            StatusCode::OK
        );

        // Apple stalls past the client's bound: a claim's pull and a hint's write each meet it.
        apple.stalls(Duration::from_secs(4));
        post(&internal, claims, claim(ada, &transaction), true).await;
        sweep.pass(&stop).await;
        // Apple answers again and the ledger stops answering.
        apple.stalls(Duration::ZERO);
        ledger.close().await;
        post(&internal, claims, claim(ada, &transaction), true).await;
        sweep.pass(&stop).await;

        let outcomes = |lines: Vec<Value>| -> Vec<(String, String, bool)> {
            lines
                .iter()
                .map(|line| {
                    (
                        line["outcome"].as_str().unwrap().to_owned(),
                        line["code"].as_str().unwrap_or_default().to_owned(),
                        line["sentry_event_id"].is_string(),
                    )
                })
                .collect()
        };
        let lines = captured.take(&["store.claim", "store.hint"]);
        let (claim_lines, hint_lines): (Vec<Value>, Vec<Value>) = lines
            .into_iter()
            .partition(|line| line["message"] == "store.claim");
        (outcomes(claim_lines), outcomes(hint_lines))
    }));

    let row =
        |outcome: &str, code: &str, reported: bool| (outcome.to_owned(), code.to_owned(), reported);
    assert_eq!(
        claims,
        vec![
            row("applied", "", false),
            row("pull_failed", "api_unreachable", true),
            row("apply_failed", "ledger_unreachable", true),
        ]
    );
    assert_eq!(
        hints,
        vec![
            row("write_failed", "api_unreachable", true),
            row("unread", "ledger_unreachable", true),
        ]
    );
    let filed: Vec<Vec<String>> = events
        .iter()
        .map(|event| {
            event
                .fingerprint
                .to_vec()
                .into_iter()
                .map(|part| part.into_owned())
                .collect()
        })
        .collect();
    assert_eq!(
        filed,
        [
            ["store.claim", "api_unreachable"],
            ["store.hint", "api_unreachable"],
            ["store.claim", "ledger_unreachable"],
            ["store.hint", "ledger_unreachable"],
        ]
        .map(|fingerprint| fingerprint.map(str::to_owned).to_vec())
        .to_vec()
    );
}

// Each subscription the ledger holds: its original transaction, the account it is bound to, and how.
async fn bindings(url: &str) -> Vec<(String, Option<String>, Option<String>)> {
    let mut connection = PgConnection::connect(url).await.unwrap();
    sqlx::query_as(
        "select store_subscription_id, account_id::text, bound_by from subscriptions order by store_subscription_id",
    )
    .fetch_all(&mut connection)
    .await
    .unwrap()
}

// R-11: Ada claims a purchase made without a hint, so the ledger owes Apple her id. Before the sweep writes it the
// lineage ends and Bo, on the same Apple Account, buys it again with his own: the move to Bo drops Ada's hint in its
// own transaction, and the sweep writes nothing.
#[test]
#[cfg_attr(not(postgres_tests), ignore = "needs SUBSCRIPTIONS_TEST_DATABASE_URL")]
fn a_rebuy_that_moves_the_lineage_drops_the_hint_owed_for_the_account_it_left() {
    let start = 1_793_491_200_000_i64;
    let day = 86_400_000;
    let ada = "9387ec65-ab17-4b8c-b145-fd0d622966db";
    let bo = "2c5e8f1a-7d3b-4c9e-a6f2-0b8d4e1c7a95";
    let ((owed_after_the_claim, bound, owed_after_the_rebuy, pass, tokens), events) =
        reported(with_empty_database(async |url| {
            let ledger = Ledger::open(&url.parse().unwrap()).await.unwrap();
            let clock = Clock::at(start);
            let (apple, apple_url) = Apple::serve().await;
            let door = door(&ledger, &clock, Some(&apple_url));
            let (public, internal) = routers(&ledger, &door);
            notify(&public, &ledger, without_hint(story("started.json")), start).await;
            apple.answers_status(
                StatusCode::OK,
                signed(without_hint(story("subscription-status.json")), start),
            );
            let transaction = signed(without_hint(story("purchase-transaction.json")), start);
            let (claimed, _) = post(
                &internal,
                "/internal/v1/app-store/claims",
                claim(ada, &transaction),
                true,
            )
            .await;
            assert_eq!(claimed, StatusCode::OK);
            let owed_after_the_claim = owed(&url).await;

            // Thirty days on it expires; ten days later Bo resubscribes with his own hint.
            clock.set(start + 30 * day);
            notify(
                &public,
                &ledger,
                without_hint(story("expired.json")),
                start + 30 * day,
            )
            .await;
            let mut rebuy = with_hint(story("started.json"), Some(bo));
            rebuy["notification"]["subtype"] = json!("RESUBSCRIBE");
            let transaction = &mut rebuy["notification"]["data"]["signedTransactionInfo"];
            transaction["transactionId"] = json!("2000000000000003");
            transaction["webOrderLineItemId"] = json!("2000000000000103");
            transaction["originalPurchaseDate"] = json!("now-40d");
            rebuy["notification"]["data"]["signedRenewalInfo"]["recentSubscriptionStartDate"] =
                json!("now");
            clock.set(start + 40 * day);
            notify(&public, &ledger, rebuy, start + 40 * day).await;
            let bound = bindings(&url).await;
            let owed_after_the_rebuy = owed(&url).await;
            let pass = StoreHintSweep::new(door.clone())
                .pass(&CancellationToken::new())
                .await;
            (
                owed_after_the_claim,
                bound,
                owed_after_the_rebuy,
                pass,
                apple.tokens(),
            )
        }));

    assert_eq!(
        owed_after_the_claim,
        vec![("2000000000000001".to_owned(), ada.to_owned())]
    );
    assert_eq!(
        bound,
        vec![(
            "2000000000000001".to_owned(),
            Some(bo.to_owned()),
            Some("purchase".to_owned())
        )]
    );
    assert_eq!(owed_after_the_rebuy, Vec::new());
    assert_eq!(pass, HintPass::default());
    assert_eq!(tokens, Vec::new());
    assert_eq!(events.len(), 0, "{events:#?}");
}

// The backend erases Ada while her claim's hint is still owed: the erasure drops the hint with her binding, so the sweep
// never writes her id. The erasure repeated answers the same and changes nothing.
#[test]
#[cfg_attr(not(postgres_tests), ignore = "needs SUBSCRIPTIONS_TEST_DATABASE_URL")]
fn an_erased_account_s_owed_hint_is_dropped_with_its_binding_and_never_written_to_apple() {
    let start = 1_793_491_200_000_i64;
    let ada = "9387ec65-ab17-4b8c-b145-fd0d622966db";
    let ((erased, owed_after_the_erasure, pass, owed_after_the_pass, tokens, lines), events) =
        reported(with_empty_database(async |url| {
            let (captured, _logs) = Captured::start();
            let ledger = Ledger::open(&url.parse().unwrap()).await.unwrap();
            let clock = Clock::at(start);
            let (apple, apple_url) = Apple::serve().await;
            let door = door(&ledger, &clock, Some(&apple_url));
            let (public, internal) = routers(&ledger, &door);
            notify(&public, &ledger, without_hint(story("started.json")), start).await;
            apple.answers_status(
                StatusCode::OK,
                signed(without_hint(story("subscription-status.json")), start),
            );
            let transaction = signed(without_hint(story("purchase-transaction.json")), start);
            let (claimed, _) = post(
                &internal,
                "/internal/v1/app-store/claims",
                claim(ada, &transaction),
                true,
            )
            .await;
            assert_eq!(claimed, StatusCode::OK);
            captured.take(&[]);
            let mut erased = Vec::new();
            for _ in 0..2 {
                let response = internal
                    .clone()
                    .oneshot(
                        Request::delete(format!("/internal/v1/accounts/{ada}"))
                            .header("authorization", "Bearer 5d0c3a9e8f7b6a5d4c3b2a1f0e9d8c7b")
                            .body(Body::empty())
                            .unwrap(),
                    )
                    .await
                    .unwrap();
                let status = response.status();
                let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
                erased.push((status, body.len()));
            }
            let owed_after_the_erasure = owed(&url).await;
            let pass = StoreHintSweep::new(door.clone())
                .pass(&CancellationToken::new())
                .await;
            (
                erased,
                owed_after_the_erasure,
                pass,
                owed(&url).await,
                apple.tokens(),
                captured.take(&["store.hint", "account.unbind"]),
            )
        }));

    assert_eq!(erased, [(StatusCode::NO_CONTENT, 0); 2]);
    assert_eq!(owed_after_the_erasure, Vec::new());
    assert_eq!(pass, HintPass::default());
    assert_eq!(owed_after_the_pass, Vec::new());
    assert_eq!(tokens, Vec::new());
    let unbind = |outcome: &str, unbound: u64, hints_dropped: u64| {
        json!({
            "level": "INFO",
            "message": "account.unbind",
            "operation": "account.unbind",
            "outcome": outcome,
            "answered": 204,
            "unbound": unbound,
            "periods": unbound,
            "hints_dropped": hints_dropped,
            "events": unbound,
            "route": "/internal/v1/accounts/{accountId}",
        })
    };
    assert_eq!(
        lines,
        vec![unbind("erased", 1, 1), unbind("already_erased", 0, 0)]
    );
    assert_eq!(events.len(), 0, "{events:#?}");
}

// A description of another lineage: its original transaction, its transaction, and the status entry's id, all `id`.
fn of_lineage(mut description: Value, id: &str) -> Value {
    let transactions = [
        "/notification/data/signedTransactionInfo",
        "/transaction",
        "/statusResponse/data/0/lastTransactions/0/signedTransactionInfo",
    ];
    for holder in transactions {
        if let Some(Value::Object(payload)) = description.pointer_mut(holder) {
            payload.insert("originalTransactionId".to_owned(), json!(id));
            payload.insert("transactionId".to_owned(), json!(id));
        }
    }
    for holder in [
        "/notification/data/signedRenewalInfo",
        "/statusResponse/data/0/lastTransactions/0/signedRenewalInfo",
        "/statusResponse/data/0/lastTransactions/0",
    ] {
        if let Some(Value::Object(payload)) = description.pointer_mut(holder) {
            payload.insert("originalTransactionId".to_owned(), json!(id));
        }
    }
    description
}

// A purchase made without a hint on lineage `id`, claimed by a new account: the ledger owes Apple that account.
async fn owe_a_hint(
    public: &Router,
    internal: &Router,
    ledger: &Ledger,
    apple: &Apple,
    id: &str,
    at: i64,
) {
    notify(
        public,
        ledger,
        of_lineage(without_hint(story("started.json")), id),
        at,
    )
    .await;
    apple.answers_status_of(
        id,
        signed(
            of_lineage(without_hint(story("subscription-status.json")), id),
            at,
        ),
    );
    let transaction = signed(
        of_lineage(without_hint(story("purchase-transaction.json")), id),
        at,
    );
    let account = Uuid::new_v4().to_string();
    let (claimed, _) = post(
        internal,
        "/internal/v1/app-store/claims",
        claim(&account, &transaction),
        true,
    )
    .await;
    assert_eq!(claimed, StatusCode::OK);
}

// More hints than a pass reads that Apple refuses for good, a 400 as for a transaction it takes no token for: each
// waits after its refusal, so the next pass reaches the hint behind them.
#[test]
#[cfg_attr(not(postgres_tests), ignore = "needs SUBSCRIPTIONS_TEST_DATABASE_URL")]
fn a_page_of_hints_apple_refuses_waits_and_holds_up_none_behind_it() {
    let start = 1_793_491_200_000_i64;
    let ((passes, puts, lines), events) = reported(with_empty_database(async |url| {
        let (captured, _logs) = Captured::start();
        let ledger = Ledger::open(&url.parse().unwrap()).await.unwrap();
        let clock = Clock::at(start);
        let (apple, apple_url) = Apple::serve().await;
        let door = door(&ledger, &clock, Some(&apple_url));
        let (public, internal) = routers(&ledger, &door);
        for index in 0..101 {
            let id = format!("30000000000{index:05}");
            owe_a_hint(&public, &internal, &ledger, &apple, &id, start).await;
            if index < 100 {
                apple.answers_token_puts_of(&id, StatusCode::BAD_REQUEST);
            }
        }
        captured.take(&["store.hint"]);
        let sweep = StoreHintSweep::new(door.clone());
        let stop = CancellationToken::new();
        let passes = vec![
            sweep.pass(&stop).await,
            sweep.pass(&stop).await,
            sweep.pass(&stop).await,
        ];
        let puts: Vec<String> = apple.tokens().into_iter().map(|(path, _)| path).collect();
        (passes, puts, captured.take(&["store.hint"]))
    }));

    assert_eq!(
        passes,
        vec![
            HintPass {
                refused: 100,
                ..HintPass::default()
            },
            HintPass {
                written: 1,
                ..HintPass::default()
            },
            HintPass::default(),
        ]
    );
    let put_of =
        |index: usize| format!("/inApps/v1/transactions/30000000000{index:05}/appAccountToken");
    assert_eq!(puts, (0..101).map(put_of).collect::<Vec<_>>());
    let outcome_of = |line: &Value| {
        (
            line["level"].clone(),
            line["outcome"].clone(),
            line["code"].clone(),
        )
    };
    let mut expected = vec![(json!("WARN"), json!("refused"), json!("api_bad_request")); 100];
    expected.push((json!("INFO"), json!("written"), Value::Null));
    assert_eq!(lines.iter().map(outcome_of).collect::<Vec<_>>(), expected);
    assert_eq!(events.len(), 0, "{events:#?}");
}

// Apple answers a hint 404 for good: it waits 1, 2, 4 and 8 hours after each refusal, and the fifth abandons it with
// one report; it is never read again.
#[test]
#[cfg_attr(not(postgres_tests), ignore = "needs SUBSCRIPTIONS_TEST_DATABASE_URL")]
fn a_hint_apple_refuses_five_times_is_abandoned_with_one_report() {
    let start = 1_793_491_200_000_i64;
    let hour = 3_600_000_i64;
    let ((passes, waits, settled, lines), events) = reported(with_empty_database(async |url| {
        let (captured, _logs) = Captured::start();
        let ledger = Ledger::open(&url.parse().unwrap()).await.unwrap();
        let clock = Clock::at(start);
        let (apple, apple_url) = Apple::serve().await;
        let door = door(&ledger, &clock, Some(&apple_url));
        let (public, internal) = routers(&ledger, &door);
        owe_a_hint(
            &public,
            &internal,
            &ledger,
            &apple,
            "2000000000000001",
            start,
        )
        .await;
        apple.answers_token_puts(StatusCode::NOT_FOUND);
        captured.take(&["store.hint"]);
        let sweep = StoreHintSweep::new(door.clone());
        let stop = CancellationToken::new();
        let mut connection = PgConnection::connect(&url).await.unwrap();
        let mut passes = Vec::new();
        let mut waits = Vec::new();
        for _ in 0..5 {
            passes.push(sweep.pass(&stop).await);
            let wait: Option<i64> = sqlx::query_scalar(
                "select next_attempt_at - now_millis() from store_hints where abandoned_at is null",
            )
            .fetch_optional(&mut connection)
            .await
            .unwrap();
            waits.push(wait);
            // The wait passes.
            connection
                .execute("update store_hints set next_attempt_at = 0 where abandoned_at is null")
                .await
                .unwrap();
        }
        passes.push(sweep.pass(&stop).await);
        let settled: (i32, bool) =
            sqlx::query_as("select attempts, abandoned_at is not null from store_hints")
                .fetch_one(&mut connection)
                .await
                .unwrap();
        (passes, waits, settled, captured.take(&["store.hint"]))
    }));

    let refused = || HintPass {
        refused: 1,
        ..HintPass::default()
    };
    assert_eq!(
        passes,
        vec![
            refused(),
            refused(),
            refused(),
            refused(),
            HintPass {
                abandoned: 1,
                ..HintPass::default()
            },
            HintPass::default(),
        ]
    );
    for (refusal, wait) in waits[..4].iter().enumerate() {
        let wait = wait.expect("a refused hint waits");
        let due = hour << refusal;
        assert!(
            wait > due - 60_000 && wait <= due,
            "refusal {}: {wait}",
            refusal + 1
        );
    }
    assert_eq!(waits[4], None);
    assert_eq!(settled, (5, true));
    let sentry_event_id = lines[4]["sentry_event_id"].clone();
    assert_eq!(sentry_event_id.as_str().map(str::len), Some(32));
    let line = |level: &str, outcome: &str| {
        json!({
            "level": level,
            "message": "store.hint",
            "operation": "store.hint",
            "store": "app_store",
            "environment": "sandbox",
            "outcome": outcome,
            "code": "api_not_found",
        })
    };
    let mut abandoned = line("ERROR", "abandoned");
    abandoned["sentry_event_id"] = sentry_event_id;
    assert_eq!(
        lines,
        vec![
            line("WARN", "refused"),
            line("WARN", "refused"),
            line("WARN", "refused"),
            line("WARN", "refused"),
            abandoned,
        ]
    );
    assert_eq!(
        reported_as(&events),
        vec![(
            "Error".to_owned(),
            "store.hint".to_owned(),
            "api_not_found".to_owned()
        )]
    );
}

// The hint step runs beside the inbox's: an Apple that takes seconds to refuse each hint holds up no notification the
// inbox's step meets while the hint step waits on it.
#[test]
#[cfg_attr(not(postgres_tests), ignore = "needs SUBSCRIPTIONS_TEST_DATABASE_URL")]
fn the_inbox_step_applies_what_it_holds_while_apple_stalls_every_hint() {
    let start = 1_793_491_200_000_i64;
    let ((applied_within, puts_answered_meanwhile, stopped_within), events) =
        reported(with_empty_database(async |url| {
            let ledger = Ledger::open(&url.parse().unwrap()).await.unwrap();
            let clock = Clock::at(start);
            let (apple, apple_url) = Apple::serve().await;
            let door = door(&ledger, &clock, Some(&apple_url));
            let (public, internal) = routers(&ledger, &door);
            for index in 0..5 {
                let id = format!("40000000000{index:05}");
                owe_a_hint(&public, &internal, &ledger, &apple, &id, start).await;
            }
            apple.answers_token_puts(StatusCode::NOT_FOUND);
            apple.stalls(Duration::from_millis(2_500));
            apple.tokens();

            // Both steps pass every 200 ms; the hint step's first pass takes 12.5 s, one refusal after another.
            let stop = CancellationToken::new();
            let sweep = Sweep::new(ledger.clone(), door.clone(), Duration::from_millis(200));
            let sweep = tokio::spawn(sweep.run(stop.clone()));
            let deadline = Instant::now() + Duration::from_secs(5);
            while apple.tokens.lock().unwrap().is_empty() {
                assert!(Instant::now() < deadline, "the hint step wrote nothing");
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            // A notification kept and not applied yet, as one whose apply failed, while Apple holds the first hint.
            let kept = ledger
                .receive(Notification {
                    store: Store::AppStore,
                    id: Uuid::new_v4().to_string(),
                    environment: Environment::Sandbox,
                    signed_payload: signed(
                        of_lineage(without_hint(story("started.json")), "5000000000000001"),
                        start,
                    ),
                })
                .await
                .unwrap();
            assert!(matches!(kept, Receipt::Kept(_)));
            let events_before = ledger.feed(0, 500).await.unwrap().entries.len();
            let kept_at = Instant::now();
            while ledger.feed(0, 500).await.unwrap().entries.len() == events_before {
                assert!(
                    kept_at.elapsed() < Duration::from_secs(10),
                    "the inbox's step waited on Apple"
                );
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            let applied_within = kept_at.elapsed();
            let puts_answered_meanwhile = apple.tokens.lock().unwrap().len() - 1;
            stop.cancel();
            let stopping = Instant::now();
            sweep.await.unwrap();
            (applied_within, puts_answered_meanwhile, stopping.elapsed())
        }));

    assert!(
        applied_within < Duration::from_secs(1),
        "{applied_within:?}"
    );
    assert_eq!(puts_answered_meanwhile, 0);
    assert!(
        stopped_within < Duration::from_secs(4),
        "{stopped_within:?}"
    );
    assert_eq!(events.len(), 0, "{events:#?}");
}

struct FakeApi {
    request_answer: Mutex<Result<TestNotificationToken, ApiFailure>>,
    status_answers: Mutex<std::collections::VecDeque<Result<TestNotificationStatus, ApiFailure>>>,
    status_entry: Mutex<Option<Result<SignedStatus, ApiFailure>>>,
    hints_written: Mutex<Vec<(Environment, String, String)>>,
}

impl FakeApi {
    fn for_test_notification(
        request_answer: Result<TestNotificationToken, ApiFailure>,
        status_answers: Vec<Result<TestNotificationStatus, ApiFailure>>,
    ) -> FakeApi {
        FakeApi {
            request_answer: Mutex::new(request_answer),
            status_answers: Mutex::new(status_answers.into()),
            status_entry: Mutex::new(None),
            hints_written: Mutex::new(Vec::new()),
        }
    }
}

impl AppStoreApi for FakeApi {
    fn subscription_status<'a>(
        &'a self,
        _environment: Environment,
        _original_transaction_id: &'a str,
    ) -> ApiFuture<'a, SignedStatus> {
        let answer = self
            .status_entry
            .lock()
            .unwrap()
            .clone()
            .unwrap_or(Err(ApiFailure::NotFound));
        Box::pin(async move { answer })
    }

    fn set_app_account_token<'a>(
        &'a self,
        environment: Environment,
        original_transaction_id: &'a str,
        app_account_token: &'a str,
    ) -> ApiFuture<'a, ()> {
        self.hints_written.lock().unwrap().push((
            environment,
            original_transaction_id.to_owned(),
            app_account_token.to_owned(),
        ));
        Box::pin(async { Ok(()) })
    }

    fn transaction_history<'a>(
        &'a self,
        _environment: Environment,
        _transaction_id: &'a str,
        _revision: Option<&'a str>,
    ) -> ApiFuture<'a, TransactionHistoryPage> {
        Box::pin(async {
            Ok(TransactionHistoryPage {
                signed_transactions: Vec::new(),
                revision: None,
                has_more: false,
            })
        })
    }

    fn notification_history<'a>(
        &'a self,
        _environment: Environment,
        _request: &'a NotificationHistoryRequest,
        _pagination_token: Option<&'a str>,
    ) -> ApiFuture<'a, NotificationHistoryPage> {
        Box::pin(async {
            Ok(NotificationHistoryPage {
                entries: Vec::new(),
                pagination_token: None,
                has_more: false,
            })
        })
    }

    fn request_test_notification<'a>(
        &'a self,
        _environment: Environment,
    ) -> ApiFuture<'a, TestNotificationToken> {
        let answer = self.request_answer.lock().unwrap().clone();
        Box::pin(async move { answer })
    }

    fn test_notification_status<'a>(
        &'a self,
        _environment: Environment,
        _token: &'a TestNotificationToken,
    ) -> ApiFuture<'a, TestNotificationStatus> {
        let answer = self
            .status_answers
            .lock()
            .unwrap()
            .pop_front()
            .unwrap_or(Err(ApiFailure::NotFound));
        Box::pin(async move { answer })
    }
}

#[tokio::test]
async fn test_notification_runner_polls_and_logs_only_non_secret_outcomes() {
    let (captured, _logs) = Captured::start();
    let token = TestNotificationToken::new("secret-token-never-logged");

    let delivered_api = FakeApi::for_test_notification(
        Ok(token.clone()),
        vec![
            Err(ApiFailure::NotFound),
            Err(ApiFailure::ServerError),
            Ok(TestNotificationStatus {
                signed_payload: "secret-payload-never-logged".to_owned(),
                send_attempts: vec![],
            }),
            Ok(TestNotificationStatus {
                signed_payload: "secret-payload-never-logged".to_owned(),
                send_attempts: vec![
                    SendAttempt {
                        attempt_date: Some(1_000),
                        result: Some(SendAttemptResult::TimedOut),
                    },
                    SendAttempt {
                        attempt_date: Some(2_000),
                        result: Some(SendAttemptResult::Success),
                    },
                ],
            }),
        ],
    );
    let delivered = run_test_notification(
        &delivered_api,
        Environment::Sandbox,
        5,
        Duration::from_millis(1),
    )
    .await;
    delivered.log(Environment::Sandbox, Duration::from_millis(12));

    let failed_delivery_api = FakeApi::for_test_notification(
        Ok(token.clone()),
        vec![Ok(TestNotificationStatus {
            signed_payload: "secret-payload-never-logged".to_owned(),
            send_attempts: vec![SendAttempt {
                attempt_date: Some(1_000),
                result: Some(SendAttemptResult::UnsuccessfulHttpResponseCode),
            }],
        })],
    );
    let delivery_failed = run_test_notification(
        &failed_delivery_api,
        Environment::Production,
        2,
        Duration::from_millis(1),
    )
    .await;
    delivery_failed.log(Environment::Production, Duration::from_millis(5));

    let pending_api =
        FakeApi::for_test_notification(Ok(token.clone()), vec![Err(ApiFailure::NotFound)]);
    let pending = run_test_notification(
        &pending_api,
        Environment::Sandbox,
        2,
        Duration::from_millis(1),
    )
    .await;
    pending.log(Environment::Sandbox, Duration::from_millis(8));

    let request_failed_api = FakeApi::for_test_notification(Err(ApiFailure::Unauthorized), vec![]);
    let request_failed = run_test_notification(
        &request_failed_api,
        Environment::Production,
        1,
        Duration::from_millis(1),
    )
    .await;
    request_failed.log(Environment::Production, Duration::from_millis(3));

    let status_failed_api =
        FakeApi::for_test_notification(Ok(token.clone()), vec![Err(ApiFailure::RateLimited)]);
    let status_failed = run_test_notification(
        &status_failed_api,
        Environment::Sandbox,
        3,
        Duration::from_millis(1),
    )
    .await;
    status_failed.log(Environment::Sandbox, Duration::from_millis(4));

    let persistent_server_error_api = FakeApi::for_test_notification(
        Ok(token),
        vec![Err(ApiFailure::ServerError), Err(ApiFailure::ServerError)],
    );
    let persistent_server_error = run_test_notification(
        &persistent_server_error_api,
        Environment::Sandbox,
        2,
        Duration::from_millis(1),
    )
    .await;
    assert_eq!(
        persistent_server_error,
        TestNotificationOutcome::StatusFailed(ApiFailure::ServerError)
    );

    assert_eq!(
        (
            delivered,
            delivered.succeeded(),
            delivery_failed,
            delivery_failed.succeeded(),
            pending,
            request_failed,
            status_failed,
        ),
        (
            TestNotificationOutcome::Delivered { attempts: 2 },
            true,
            TestNotificationOutcome::DeliveryFailed {
                attempts: 1,
                result: Some(SendAttemptResult::UnsuccessfulHttpResponseCode),
            },
            false,
            TestNotificationOutcome::Pending,
            TestNotificationOutcome::RequestFailed(ApiFailure::Unauthorized),
            TestNotificationOutcome::StatusFailed(ApiFailure::RateLimited),
        )
    );

    let raw = String::from_utf8(captured.0.lock().unwrap().clone()).unwrap();
    assert!(!raw.contains("secret-token"), "{raw}");
    assert!(!raw.contains("secret-payload"), "{raw}");
    let lines = captured.take(&["store.test_notification"]);
    assert_eq!(
        lines,
        vec![
            json!({
                "level": "INFO",
                "message": "store.test_notification",
                "operation": "store.test_notification",
                "store": "app_store",
                "environment": "sandbox",
                "outcome": "delivered",
                "send_attempt_result": "success",
                "attempts": 2,
            }),
            json!({
                "level": "ERROR",
                "message": "store.test_notification",
                "operation": "store.test_notification",
                "store": "app_store",
                "environment": "production",
                "outcome": "delivery_failed",
                "send_attempt_result": "unsuccessful_http_response_code",
                "attempts": 1,
            }),
            json!({
                "level": "WARN",
                "message": "store.test_notification",
                "operation": "store.test_notification",
                "store": "app_store",
                "environment": "sandbox",
                "outcome": "pending",
                "attempts": 0,
            }),
            json!({
                "level": "ERROR",
                "message": "store.test_notification",
                "operation": "store.test_notification",
                "store": "app_store",
                "environment": "production",
                "outcome": "request_failed",
                "code": "api_unauthorized",
            }),
            json!({
                "level": "ERROR",
                "message": "store.test_notification",
                "operation": "store.test_notification",
                "store": "app_store",
                "environment": "sandbox",
                "outcome": "status_failed",
                "code": "api_rate_limited",
            }),
        ]
    );
}

#[test]
#[cfg_attr(not(postgres_tests), ignore = "needs SUBSCRIPTIONS_TEST_DATABASE_URL")]
fn app_store_door_accepts_a_fake_app_store_api_without_http() {
    let start = 1_793_491_200_000;
    let account_id = Uuid::new_v4().to_string();
    let ((claimed, hints_written), events) = reported(with_empty_database(async |url| {
        let ledger = Ledger::open(&url.parse().unwrap()).await.unwrap();
        let clock = Clock::at(start);
        let status_json: Value = serde_json::from_str(&signed(
            without_hint(story("subscription-status.json")),
            start,
        ))
        .unwrap();
        let last = &status_json["data"][0]["lastTransactions"][0];
        let fake = Arc::new(FakeApi {
            request_answer: Mutex::new(Err(ApiFailure::NotFound)),
            status_answers: Mutex::new(std::collections::VecDeque::new()),
            status_entry: Mutex::new(Some(Ok(SignedStatus {
                status: last["status"].as_i64().map(|v| v as i32),
                signed_transaction_info: last["signedTransactionInfo"].as_str().unwrap().to_owned(),
                signed_renewal_info: last["signedRenewalInfo"].as_str().map(str::to_owned),
            }))),
            hints_written: Mutex::new(Vec::new()),
        });
        let verifier =
            SignedDataVerifier::windmill_also_trusting(TEST_ROOT, clock.reading()).unwrap();
        let door = AppStoreDoor::new(
            ledger.clone(),
            verifier,
            Some(fake.clone() as Arc<dyn AppStoreApi>),
            clock.reading(),
        );
        let (_, internal) = routers(&ledger, &door);
        let tx_jws = signed(without_hint(story("purchase-transaction.json")), start);
        let claimed = post(
            &internal,
            "/internal/v1/app-store/claims",
            claim(&account_id, &tx_jws),
            true,
        )
        .await;
        let stop = CancellationToken::new();
        let pass = StoreHintSweep::new(door).pass(&stop).await;
        assert_eq!(
            pass,
            HintPass {
                written: 1,
                ..HintPass::default()
            }
        );
        let written = fake.hints_written.lock().unwrap().clone();
        (claimed, written)
    }));
    assert_eq!(claimed.0, StatusCode::OK);
    assert_eq!(hints_written.len(), 1);
    assert_eq!(hints_written[0].0, Environment::Sandbox);
    assert_eq!(hints_written[0].2, account_id);
    assert_eq!(events.len(), 0);
}
