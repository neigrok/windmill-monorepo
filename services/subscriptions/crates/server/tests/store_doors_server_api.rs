// The App Store door's claim and refresh through the internal listener's own router, and the sweep's step that writes
// the hints a claim owes, over a ledger of its own and an Apple of the test's own on a local port, serving what the test
// signer signs. Every test captures the lines it writes and the Sentry events it reports.

use std::env;
use std::fs;
use std::io;
use std::panic::{AssertUnwindSafe, resume_unwind};
use std::path::Path;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use app_store::server_api::{ApiKey, Hosts, ServerApi};
use app_store::verification::SignedDataVerifier;
use app_store_test_signer::TEST_ROOT;
use axum::Router;
use axum::body::{Body, to_bytes};
use axum::extract::State;
use axum::http::{Request, StatusCode, Uri};
use axum::routing::{get, put};
use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use futures_util::FutureExt;
use ring::rand::SystemRandom;
use ring::signature::{ECDSA_P256_SHA256_FIXED_SIGNING, EcdsaKeyPair};
use sentry::protocol::Event;
use serde_json::{Value, json};
use server::config::Config;
use server::internal;
use server::listeners::{Bounds, Listener};
use server::store_doors::{self, AppStoreDoor};
use server::sweep::{HintPass, StoreHintSweep};
use server::telemetry::json_lines;
use sqlx::{AssertSqlSafe, Connection, Executor, PgConnection};
use storage::Ledger;
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
                    assert_eq!(span_fields.remove("method"), Some(json!("POST")));
                    assert_eq!(span_fields.remove("name"), Some(json!("request")));
                    fields.insert("route".to_owned(), span_fields.remove("route").unwrap());
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

// An Apple of the test's own: it answers a status pull with what the test set, and records each account token put.
#[derive(Clone)]
struct Apple {
    status: Arc<Mutex<(StatusCode, String)>>,
    token_answer: Arc<Mutex<StatusCode>>,
    pulled: Arc<Mutex<Vec<String>>>,
    tokens: Arc<Mutex<Vec<(String, Value)>>>,
}

impl Apple {
    async fn serve() -> (Apple, Url) {
        let apple = Apple {
            status: Arc::new(Mutex::new((StatusCode::NOT_FOUND, String::new()))),
            token_answer: Arc::new(Mutex::new(StatusCode::OK)),
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

    fn answers_token_puts(&self, status: StatusCode) {
        *self.token_answer.lock().unwrap() = status;
    }

    fn pulled(&self) -> Vec<String> {
        std::mem::take(&mut self.pulled.lock().unwrap())
    }

    fn tokens(&self) -> Vec<(String, Value)> {
        std::mem::take(&mut self.tokens.lock().unwrap())
    }
}

async fn pull(State(apple): State<Apple>, uri: Uri) -> (StatusCode, String) {
    apple.pulled.lock().unwrap().push(uri.path().to_owned());
    apple.status.lock().unwrap().clone()
}

async fn put_token(State(apple): State<Apple>, uri: Uri, body: String) -> StatusCode {
    apple
        .tokens
        .lock()
        .unwrap()
        .push((uri.path().to_owned(), serde_json::from_str(&body).unwrap()));
    *apple.token_answer.lock().unwrap()
}

// The door with an in-app purchase key of the test's own, calling the test's Apple for both environments, or with none.
fn door(ledger: &Ledger, clock: &Clock, apple: Option<&Url>) -> AppStoreDoor {
    let api = apple.map(|url| {
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
        ServerApi::new(key, hosts, clock.reading())
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

// A description with no account hint anywhere: a purchase made without the app setting one.
fn without_hint(mut description: Value) -> Value {
    let holders = [
        "/notification/data/signedTransactionInfo",
        "/notification/data/signedRenewalInfo",
        "/transaction",
        "/statusResponse/data/0/lastTransactions/0/signedTransactionInfo",
        "/statusResponse/data/0/lastTransactions/0/signedRenewalInfo",
    ];
    for holder in holders {
        if let Some(Value::Object(payload)) = description.pointer_mut(holder) {
            payload.remove("appAccountToken");
        }
    }
    description
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

            let sweep = StoreHintSweep::new(ledger.clone(), door.clone());
            let stop = CancellationToken::new();
            apple.answers_token_puts(StatusCode::INTERNAL_SERVER_ERROR);
            let mut passes = vec![sweep.pass(&stop).await, sweep.pass(&stop).await];
            let owed_between = owed(&url).await;
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
        unread: None,
    };
    assert_eq!(
        passes,
        vec![
            failed,
            HintPass {
                written: 0,
                failed: 1,
                unread: None
            },
            HintPass {
                written: 1,
                failed: 0,
                unread: None
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
            "code": "store_error",
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
            "store_error".to_owned()
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
        let pass = StoreHintSweep::new(ledger.clone(), keyless)
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
            .record_erasure(Uuid::parse_str(erased).unwrap())
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
            failed("store_error", ids[0]),
            failed("store_error", None),
            failed("inconsistent", ids[2]),
            failed("malformed", ids[3]),
        ]
    );
    assert_eq!(feed, Vec::new());
    assert_eq!(
        reported_as(&events),
        ["store_error", "inconsistent", "malformed"]
            .map(|code| (
                "Error".to_owned(),
                "store.claim".to_owned(),
                code.to_owned()
            ))
            .to_vec()
    );
}
