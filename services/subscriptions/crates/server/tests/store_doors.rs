// The App Store notification door through the public listener's own router, over a ledger of its own, with
// notifications the test signer signs. Every test captures the lines it writes and the Sentry events it reports.

use std::env;
use std::fs;
use std::io;
use std::panic::{AssertUnwindSafe, resume_unwind};
use std::path::Path;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use app_store::verification::SignedDataVerifier;
use app_store_test_signer::TEST_ROOT;
use axum::Router;
use axum::body::{Body, to_bytes};
use axum::http::{Request, StatusCode};
use base64::Engine;
use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use domain::{Environment, Store};
use futures_util::FutureExt;
use rcgen::{
    BasicConstraints, CertificateParams, IsCa, Issuer, KeyPair, PKCS_ECDSA_P256_SHA256,
    PKCS_ECDSA_P384_SHA384,
};
use ring::rand::SystemRandom;
use ring::signature::{ECDSA_P256_SHA256_FIXED_SIGNING, EcdsaKeyPair};
use sentry::protocol::Event;
use serde_json::{Value, json};
use server::config::Config;
use server::listeners::{Bounds, Listener};
use server::store_doors::{self, AppStoreDoor};
use server::telemetry::json_lines;
use sqlx::{AssertSqlSafe, Connection, Executor, PgConnection};
use storage::{Ledger, Notification, Receipt};
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

    fn lines(&self) -> Vec<Value> {
        String::from_utf8(self.0.lock().unwrap().clone())
            .unwrap()
            .lines()
            .map(|line| {
                let mut line: Value = serde_json::from_str(line).unwrap();
                let fields = line.as_object_mut().unwrap();
                assert!(fields.remove("timestamp").unwrap().is_string());
                line
            })
            .collect()
    }

    // The door's own lines, each checked to sit in its request's span and to carry a duration, then without both.
    fn deliveries(&self) -> Vec<Value> {
        self.lines()
            .into_iter()
            .filter(|line| line["message"] == "store.notification")
            .map(|mut line| {
                let fields = line.as_object_mut().unwrap();
                assert!(fields.remove("duration_ms").unwrap().is_f64(), "{fields:?}");
                let mut span = fields.remove("span").unwrap();
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
                assert_eq!(
                    span,
                    json!({
                        "name": "request",
                        "listener": "public",
                        "method": "POST",
                        "route": "/v1/stores/app-store/notifications",
                    })
                );
                line
            })
            .collect()
    }

    // A delivery logs its line once the pipeline behind its answer is done.
    async fn delivered(&self, count: usize) -> Vec<Value> {
        let deadline = Instant::now() + Duration::from_secs(15);
        loop {
            let deliveries = self.deliveries();
            if deliveries.len() >= count {
                return deliveries;
            }
            assert!(
                Instant::now() < deadline,
                "{count} deliveries were not logged within 15 s: {deliveries:#?}"
            );
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
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

fn public_router(ledger: &Ledger, verifier: SignedDataVerifier, clock: &Clock) -> Router {
    let config = Config::from_environment(|variable| match variable {
        "SUBSCRIPTIONS_PUBLIC_ADDRESS" => Some("127.0.0.1:8082".to_owned()),
        "SUBSCRIPTIONS_INTERNAL_ADDRESS" => Some("127.0.0.1:8083".to_owned()),
        "SUBSCRIPTIONS_DATABASE_URL" => Some("postgresql://ledger@127.0.0.1:1/ledger".to_owned()),
        "SENTRY_ENVIRONMENT" => Some("test".to_owned()),
        _ => None,
    })
    .unwrap();
    let door = AppStoreDoor::new(ledger.clone(), verifier, clock.reading());
    Listener::Public.router(
        &config,
        ledger.clone(),
        store_doors::router(door),
        Bounds::default(),
    )
}

fn trusting_the_test_root(clock: &Clock) -> SignedDataVerifier {
    SignedDataVerifier::windmill_also_trusting(TEST_ROOT, clock.reading()).unwrap()
}

fn story(file: &str) -> Value {
    let stories = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../tests/fixtures/app_store/test-payloads")
        .join(file);
    serde_json::from_str(&fs::read_to_string(stories).unwrap()).unwrap()
}

fn signed(description: Value, at: i64) -> String {
    app_store_test_signer::sign(
        serde_json::from_value(description).unwrap(),
        UNIX_EPOCH + Duration::from_millis(at as u64),
    )
    .unwrap()
}

async fn post(router: &Router, body: String) -> (StatusCode, String) {
    let response = router
        .clone()
        .oneshot(
            Request::post("/v1/stores/app-store/notifications")
                .header("content-type", "application/json")
                .body(Body::from(body))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    (status, String::from_utf8(body.to_vec()).unwrap())
}

fn delivery(signed_payload: &str) -> String {
    json!({ "signedPayload": signed_payload }).to_string()
}

// Each row of the inbox: its notification's id, environment and outcome, the longest kept first.
async fn inbox(url: &str) -> Vec<(String, String, Option<String>)> {
    let mut connection = PgConnection::connect(url).await.unwrap();
    sqlx::query_as("select notification_id, environment, outcome from inbox order by received_at, notification_id")
        .fetch_all(&mut connection)
        .await
        .unwrap()
}

// Each event of the feed: its type, when it happened counted from `from`, and the account it names.
async fn feed(ledger: &Ledger, from: i64) -> Vec<(&'static str, i64, Option<String>)> {
    ledger
        .feed(0, 100)
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
                    .as_ref()
                    .map(|account| account.as_str().to_owned()),
            )
        })
        .collect()
}

#[test]
#[cfg_attr(not(postgres_tests), ignore = "needs SUBSCRIPTIONS_TEST_DATABASE_URL")]
fn every_example_story_is_answered_once_kept_and_applied_into_the_feed() {
    let start = 1_793_491_200_000;
    let day = 86_400_000;
    let buyer = Some("6f9d0c2e-4b1a-4c8e-9f3d-2a7b5e1c0d84".to_owned());
    // Apple reverses the refund a day after it: the same transaction, so its dates count from a day further back.
    let mut reversed_a_day_later = story("refund-reversed.json");
    for (payload, field, date) in [
        ("signedTransactionInfo", "purchaseDate", "now-11d"),
        ("signedTransactionInfo", "originalPurchaseDate", "now-41d"),
        ("signedTransactionInfo", "expiresDate", "now+19d"),
        ("signedRenewalInfo", "renewalDate", "now+19d"),
        (
            "signedRenewalInfo",
            "recentSubscriptionStartDate",
            "now-41d",
        ),
    ] {
        reversed_a_day_later["notification"]["data"][payload][field] = json!(date);
    }
    let paths = [
        vec![
            (story("started.json"), 0),
            (story("renewed.json"), 30),
            (story("renewal-turned-off.json"), 40),
            (story("expired.json"), 60),
        ],
        vec![
            (story("started.json"), 0),
            (story("renewed.json"), 30),
            (story("payment-failed-into-grace.json"), 60),
        ],
        vec![
            (story("started.json"), 0),
            (story("renewed.json"), 30),
            (story("refunded.json"), 40),
            (reversed_a_day_later, 41),
        ],
    ];

    let mut stories = Vec::new();
    for path in &paths {
        let (story_told, events) = reported(with_empty_database(async |url| {
            let (captured, _logs) = Captured::start();
            let ledger = Ledger::open(&url.parse().unwrap()).await.unwrap();
            let clock = Clock::at(start);
            let router = public_router(&ledger, trusting_the_test_root(&clock), &clock);

            let mut answers = Vec::new();
            for (description, on_day) in path {
                clock.set(start + on_day * day);
                let signed = signed(description.clone(), start + on_day * day);
                answers.push(post(&router, delivery(&signed)).await);
            }
            let deliveries = captured.delivered(path.len()).await;

            (
                answers,
                deliveries,
                inbox(&url).await,
                feed(&ledger, start).await,
            )
        }));
        assert_eq!(events.len(), 0, "{events:#?}");
        stories.push(story_told);
    }

    let applied = |events: usize| {
        json!({
            "level": "INFO",
            "message": "store.notification",
            "operation": "store.notification",
            "store": "app_store",
            "environment": "sandbox",
            "outcome": "applied",
            "redelivered": false,
            "events": events,
        })
    };
    for ((answers, _, inbox, _), path) in stories.iter().zip(&paths) {
        assert_eq!(answers, &vec![(StatusCode::OK, String::new()); path.len()]);
        assert_eq!(
            inbox
                .iter()
                .map(|(_, environment, outcome)| (environment.as_str(), outcome.as_deref()))
                .collect::<Vec<_>>(),
            vec![("sandbox", Some("applied")); path.len()]
        );
    }
    let [turned_off, into_grace, refunded] = &stories[..] else {
        panic!("{} stories", stories.len())
    };
    assert_eq!(
        (&turned_off.1, &turned_off.3),
        (
            &vec![applied(3), applied(2), applied(1), applied(1)],
            &vec![
                ("started", 0, buyer.clone()),
                ("bound", 0, buyer.clone()),
                ("period_recorded", 0, buyer.clone()),
                ("renewed", 30 * day, buyer.clone()),
                ("period_recorded", 30 * day, buyer.clone()),
                ("renewal_turned_off", 40 * day, buyer.clone()),
                ("expired", 60 * day, buyer.clone()),
            ]
        )
    );
    assert_eq!(
        (&into_grace.1, &into_grace.3),
        (
            &vec![applied(3), applied(2), applied(1)],
            &vec![
                ("started", 0, buyer.clone()),
                ("bound", 0, buyer.clone()),
                ("period_recorded", 0, buyer.clone()),
                ("renewed", 30 * day, buyer.clone()),
                ("period_recorded", 30 * day, buyer.clone()),
                ("payment_failed", 60 * day, buyer.clone()),
            ]
        )
    );
    assert_eq!(
        (&refunded.1, &refunded.3),
        (
            &vec![applied(3), applied(2), applied(3), applied(3)],
            &vec![
                ("started", 0, buyer.clone()),
                ("bound", 0, buyer.clone()),
                ("period_recorded", 0, buyer.clone()),
                ("renewed", 30 * day, buyer.clone()),
                ("period_recorded", 30 * day, buyer.clone()),
                ("renewal_turned_off", 40 * day, buyer.clone()),
                ("period_refunded", 40 * day, buyer.clone()),
                ("revoked", 40 * day, buyer.clone()),
                ("revocation_reversed", 41 * day, buyer.clone()),
                ("renewal_turned_on", 41 * day, buyer.clone()),
                ("period_refund_reversed", 41 * day, buyer.clone()),
            ]
        )
    );
}

#[test]
#[cfg_attr(not(postgres_tests), ignore = "needs SUBSCRIPTIONS_TEST_DATABASE_URL")]
fn the_same_delivery_again_answers_200_and_keeps_and_applies_nothing_more() {
    let start = 1_793_491_200_000;
    let ((answers, deliveries, inbox, feed), events) = reported(with_empty_database(async |url| {
        let (captured, _logs) = Captured::start();
        let ledger = Ledger::open(&url.parse().unwrap()).await.unwrap();
        let clock = Clock::at(start);
        let router = public_router(&ledger, trusting_the_test_root(&clock), &clock);
        let signed = signed(story("started.json"), start);

        let first = post(&router, delivery(&signed)).await;
        captured.delivered(1).await;
        let again = post(&router, delivery(&signed)).await;
        let deliveries = captured.delivered(2).await;

        (
            vec![first, again],
            deliveries,
            inbox(&url).await,
            feed(&ledger, start).await,
        )
    }));

    assert_eq!(answers, vec![(StatusCode::OK, String::new()); 2]);
    assert_eq!(
        deliveries,
        [
            json!({
                "level": "INFO",
                "message": "store.notification",
                "operation": "store.notification",
                "store": "app_store",
                "environment": "sandbox",
                "outcome": "applied",
                "redelivered": false,
                "events": 3,
            }),
            json!({
                "level": "INFO",
                "message": "store.notification",
                "operation": "store.notification",
                "store": "app_store",
                "environment": "sandbox",
                "outcome": "duplicate",
                "redelivered": true,
            }),
        ]
    );
    assert_eq!(
        inbox
            .into_iter()
            .map(|(_, environment, outcome)| (environment, outcome))
            .collect::<Vec<_>>(),
        [("sandbox".to_owned(), Some("applied".to_owned()))]
    );
    assert_eq!(
        feed.iter().map(|(kind, ..)| *kind).collect::<Vec<_>>(),
        ["started", "bound", "period_recorded"]
    );
    assert_eq!(events.len(), 0, "{events:#?}");
}

#[test]
#[cfg_attr(not(postgres_tests), ignore = "needs SUBSCRIPTIONS_TEST_DATABASE_URL")]
fn a_notification_kept_but_never_applied_is_applied_when_it_is_delivered_again() {
    let start = 1_793_491_200_000;
    let ((answer, deliveries, inbox, feed), events) = reported(with_empty_database(async |url| {
        let (captured, _logs) = Captured::start();
        let ledger = Ledger::open(&url.parse().unwrap()).await.unwrap();
        let clock = Clock::at(start);
        let router = public_router(&ledger, trusting_the_test_root(&clock), &clock);
        let mut description = story("started.json");
        description["notification"]["notificationUUID"] =
            json!("5b1c3f0e-8d2a-4e6b-9c7f-1a2b3c4d5e6f");
        let signed = signed(description, start);
        let kept = ledger
            .receive(Notification {
                store: Store::AppStore,
                id: "5b1c3f0e-8d2a-4e6b-9c7f-1a2b3c4d5e6f".to_owned(),
                environment: Environment::Sandbox,
                signed_payload: signed.clone(),
            })
            .await
            .unwrap();
        assert!(matches!(kept, Receipt::Kept(_)));

        let answer = post(&router, delivery(&signed)).await;
        let deliveries = captured.delivered(1).await;

        (
            answer,
            deliveries,
            inbox(&url).await,
            feed(&ledger, start).await,
        )
    }));

    assert_eq!(answer, (StatusCode::OK, String::new()));
    assert_eq!(
        deliveries,
        [json!({
            "level": "INFO",
            "message": "store.notification",
            "operation": "store.notification",
            "store": "app_store",
            "environment": "sandbox",
            "outcome": "applied",
            "redelivered": true,
            "events": 3,
        })]
    );
    assert_eq!(
        inbox,
        [(
            "5b1c3f0e-8d2a-4e6b-9c7f-1a2b3c4d5e6f".to_owned(),
            "sandbox".to_owned(),
            Some("applied".to_owned())
        )]
    );
    assert_eq!(
        feed.iter().map(|(kind, ..)| *kind).collect::<Vec<_>>(),
        ["started", "bound", "period_recorded"]
    );
    assert_eq!(events.len(), 0, "{events:#?}");
}

#[test]
#[cfg_attr(not(postgres_tests), ignore = "needs SUBSCRIPTIONS_TEST_DATABASE_URL")]
fn a_delivery_that_does_not_verify_answers_400_with_its_code_keeps_nothing_and_reports_nothing() {
    let start = 1_793_491_200_000;
    let ((answers, deliveries, inbox), events) = reported(with_empty_database(async |url| {
        let (captured, _logs) = Captured::start();
        let ledger = Ledger::open(&url.parse().unwrap()).await.unwrap();
        let clock = Clock::at(start);
        let router = public_router(&ledger, trusting_the_test_root(&clock), &clock);
        let genuine = signed(story("started.json"), start);

        let mut altered = genuine.clone().into_bytes();
        let in_the_signature = altered.len() - 20;
        altered[in_the_signature] = if altered[in_the_signature] == b'A' {
            b'B'
        } else {
            b'A'
        };
        let altered = String::from_utf8(altered).unwrap();

        let foreign_root_key = KeyPair::generate_for(&PKCS_ECDSA_P384_SHA384).unwrap();
        let mut foreign_root_params = CertificateParams::new(Vec::<String>::new()).unwrap();
        foreign_root_params.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
        let foreign_root = foreign_root_params.self_signed(&foreign_root_key).unwrap();
        let foreign_leaf_key = KeyPair::generate_for(&PKCS_ECDSA_P256_SHA256).unwrap();
        let foreign_leaf = CertificateParams::new(Vec::<String>::new())
            .unwrap()
            .signed_by(
                &foreign_leaf_key,
                &Issuer::new(foreign_root_params, foreign_root_key),
            )
            .unwrap();
        let x5c = [foreign_leaf.der(), foreign_root.der(), foreign_root.der()]
            .map(|der| STANDARD.encode(der));
        let header = URL_SAFE_NO_PAD.encode(json!({ "alg": "ES256", "x5c": x5c }).to_string());
        let payload = genuine.split('.').nth(1).unwrap();
        let signing_input = format!("{header}.{payload}");
        let signature = EcdsaKeyPair::from_pkcs8(
            &ECDSA_P256_SHA256_FIXED_SIGNING,
            &foreign_leaf_key.serialize_der(),
            &SystemRandom::new(),
        )
        .unwrap()
        .sign(&SystemRandom::new(), signing_input.as_bytes())
        .unwrap();
        let foreign = format!(
            "{signing_input}.{}",
            URL_SAFE_NO_PAD.encode(signature.as_ref())
        );

        let mut answers = Vec::new();
        for body in [
            delivery(&altered),
            delivery(&foreign),
            delivery(&signed(story("purchase-transaction.json"), start)),
            "signedPayload=not-json".to_owned(),
            json!({ "payload": genuine }).to_string(),
        ] {
            answers.push(post(&router, body).await);
        }
        let deliveries = captured.delivered(5).await;

        (answers, deliveries, inbox(&url).await)
    }));

    assert_eq!(
        answers,
        ["signature", "untrusted_chain", "malformed", "body", "body"].map(|code| (
            StatusCode::BAD_REQUEST,
            json!({ "error": code }).to_string()
        ))
    );
    assert_eq!(
        deliveries,
        ["signature", "untrusted_chain", "malformed", "body", "body"].map(|code| {
            json!({
                "level": "WARN",
                "message": "store.notification",
                "operation": "store.notification",
                "store": "app_store",
                "outcome": "refused",
                "code": code,
            })
        })
    );
    assert_eq!(inbox, []);
    assert_eq!(events.len(), 0, "{events:#?}");
}

#[test]
#[cfg_attr(not(postgres_tests), ignore = "needs SUBSCRIPTIONS_TEST_DATABASE_URL")]
fn a_service_that_trusts_apple_s_root_alone_refuses_what_the_test_signer_signs() {
    let start = 1_793_491_200_000;
    let ((answer, deliveries, inbox), events) = reported(with_empty_database(async |url| {
        let (captured, _logs) = Captured::start();
        let ledger = Ledger::open(&url.parse().unwrap()).await.unwrap();
        let clock = Clock::at(start);
        let router = public_router(
            &ledger,
            SignedDataVerifier::windmill(clock.reading()),
            &clock,
        );

        let answer = post(&router, delivery(&signed(story("started.json"), start))).await;
        let deliveries = captured.delivered(1).await;

        (answer, deliveries, inbox(&url).await)
    }));

    assert_eq!(
        answer,
        (
            StatusCode::BAD_REQUEST,
            json!({ "error": "untrusted_chain" }).to_string()
        )
    );
    assert_eq!(
        deliveries,
        [json!({
            "level": "WARN",
            "message": "store.notification",
            "operation": "store.notification",
            "store": "app_store",
            "outcome": "refused",
            "code": "untrusted_chain",
        })]
    );
    assert_eq!(inbox, []);
    assert_eq!(events.len(), 0, "{events:#?}");
}

#[test]
#[cfg_attr(not(postgres_tests), ignore = "needs SUBSCRIPTIONS_TEST_DATABASE_URL")]
fn a_notification_uuid_holding_nul_and_a_signing_older_than_eight_days_are_refused() {
    let start = 1_793_491_200_000;
    let eight_days = 8 * 86_400_000;
    let ((answers, deliveries, inbox), events) = reported(with_empty_database(async |url| {
        let (captured, _logs) = Captured::start();
        let ledger = Ledger::open(&url.parse().unwrap()).await.unwrap();
        let clock = Clock::at(start);
        let router = public_router(&ledger, trusting_the_test_root(&clock), &clock);
        let mut holding_nul = story("started.json");
        holding_nul["notification"]["notificationUUID"] =
            json!("5b1c3f0e-8d2a-4e6b\u{0}-9c7f-1a2b3c4d5e6f");

        let mut answers = vec![post(&router, delivery(&signed(holding_nul, start))).await];
        clock.set(start + eight_days + 1);
        answers.push(post(&router, delivery(&signed(story("started.json"), start))).await);
        clock.set(start + eight_days);
        answers.push(post(&router, delivery(&signed(story("started.json"), start))).await);
        let deliveries = captured.delivered(3).await;

        (answers, deliveries, inbox(&url).await)
    }));

    assert_eq!(
        answers,
        [
            (
                StatusCode::BAD_REQUEST,
                json!({ "error": "notification_uuid" }).to_string()
            ),
            (
                StatusCode::BAD_REQUEST,
                json!({ "error": "signed_too_long_ago" }).to_string()
            ),
            (StatusCode::OK, String::new()),
        ]
    );
    let refused = |code: &str| {
        json!({
            "level": "WARN",
            "message": "store.notification",
            "operation": "store.notification",
            "store": "app_store",
            "outcome": "refused",
            "code": code,
        })
    };
    assert_eq!(
        deliveries,
        [
            refused("notification_uuid"),
            refused("signed_too_long_ago"),
            json!({
                "level": "INFO",
                "message": "store.notification",
                "operation": "store.notification",
                "store": "app_store",
                "environment": "sandbox",
                "outcome": "applied",
                "redelivered": false,
                "events": 3,
            }),
        ]
    );
    assert_eq!(
        inbox
            .into_iter()
            .map(|(_, environment, outcome)| (environment, outcome))
            .collect::<Vec<_>>(),
        [("sandbox".to_owned(), Some("applied".to_owned()))]
    );
    assert_eq!(events.len(), 0, "{events:#?}");
}

#[test]
#[cfg_attr(not(postgres_tests), ignore = "needs SUBSCRIPTIONS_TEST_DATABASE_URL")]
fn what_the_adapter_does_not_map_is_settled_with_its_code_and_reported_and_apple_s_test_is_settled_quietly()
 {
    let start = 1_793_491_200_000;
    let ((answers, deliveries, inbox), events) = reported(with_empty_database(async |url| {
        let (captured, _logs) = Captured::start();
        let ledger = Ledger::open(&url.parse().unwrap()).await.unwrap();
        let clock = Clock::at(start);
        let router = public_router(&ledger, trusting_the_test_root(&clock), &clock);
        let invented = json!({ "notification": {
            "notificationType": "INVENTED_TYPE",
            "notificationUUID": "00000000-0000-4000-8000-000000000001",
            "data": {},
        }});
        let test = json!({ "notification": {
            "notificationType": "TEST",
            "notificationUUID": "00000000-0000-4000-8000-000000000002",
            "data": {},
        }});

        let mut answers = Vec::new();
        for description in [invented, test] {
            answers.push(post(&router, delivery(&signed(description, start))).await);
            captured.delivered(answers.len()).await;
        }

        (answers, captured.deliveries(), inbox(&url).await)
    }));

    assert_eq!(answers, vec![(StatusCode::OK, String::new()); 2]);
    assert_eq!(events.len(), 1, "{events:#?}");
    let event = &events[0];
    assert_eq!(
        (
            event.level,
            event.message.as_deref(),
            &event.fingerprint[..]
        ),
        (
            sentry::Level::Error,
            Some("store.notification"),
            &["store.notification".into(), "unknown_type".into()][..]
        )
    );
    assert_eq!(
        [
            &event.tags["operation"],
            &event.tags["code"],
            &event.tags["listener"],
            &event.tags["route"]
        ],
        [
            "store.notification",
            "unknown_type",
            "public",
            "/v1/stores/app-store/notifications"
        ]
    );
    assert_eq!(
        deliveries,
        [
            json!({
                "level": "ERROR",
                "message": "store.notification",
                "operation": "store.notification",
                "store": "app_store",
                "environment": "sandbox",
                "outcome": "unsupported",
                "code": "unknown_type",
                "redelivered": false,
                "sentry_event_id": event.event_id.simple().to_string(),
            }),
            json!({
                "level": "INFO",
                "message": "store.notification",
                "operation": "store.notification",
                "store": "app_store",
                "environment": "sandbox",
                "outcome": "settled",
                "code": "test",
                "redelivered": false,
            }),
        ]
    );
    assert_eq!(
        inbox,
        [
            (
                "00000000-0000-4000-8000-000000000001".to_owned(),
                "sandbox".to_owned(),
                Some("unknown_type".to_owned())
            ),
            (
                "00000000-0000-4000-8000-000000000002".to_owned(),
                "sandbox".to_owned(),
                Some("test".to_owned())
            ),
        ]
    );
}

#[test]
#[cfg_attr(not(postgres_tests), ignore = "needs SUBSCRIPTIONS_TEST_DATABASE_URL")]
fn a_notification_waiting_on_its_status_stays_unsettled_and_an_unconfirmed_latest_is_reported() {
    let start = 1_793_491_200_000;
    let ((answers, deliveries, inbox, feed), events) = reported(with_empty_database(async |url| {
        let (captured, _logs) = Captured::start();
        let ledger = Ledger::open(&url.parse().unwrap()).await.unwrap();
        let clock = Clock::at(start);
        let router = public_router(&ledger, trusting_the_test_root(&clock), &clock);
        let mut unconfirmed = story("started.json");
        unconfirmed["notification"]["notificationUUID"] =
            json!("00000000-0000-4000-8000-000000000001");
        unconfirmed["notification"]["data"]["signedRenewalInfo"]["renewalDate"] = json!("now+31d");
        let mut of_an_earlier_month = story("refunded.json");
        of_an_earlier_month["notification"]["notificationUUID"] =
            json!("00000000-0000-4000-8000-000000000002");
        of_an_earlier_month["notification"]["data"]["signedRenewalInfo"]["renewalDate"] =
            json!("now+50d");

        let mut answers = Vec::new();
        for description in [unconfirmed, of_an_earlier_month] {
            answers.push(post(&router, delivery(&signed(description, start))).await);
            captured.delivered(answers.len()).await;
        }

        (
            answers,
            captured.deliveries(),
            inbox(&url).await,
            feed(&ledger, start).await,
        )
    }));

    assert_eq!(answers, vec![(StatusCode::OK, String::new()); 2]);
    assert_eq!(events.len(), 1, "{events:#?}");
    let event = &events[0];
    assert_eq!(
        (
            event.message.as_deref(),
            &event.fingerprint[..],
            event.tags["code"].as_str()
        ),
        (
            Some("store.notification"),
            &["store.notification".into(), "latest_unconfirmed".into()][..],
            "latest_unconfirmed"
        )
    );
    assert_eq!(
        deliveries,
        [
            json!({
                "level": "ERROR",
                "message": "store.notification",
                "operation": "store.notification",
                "store": "app_store",
                "environment": "sandbox",
                "outcome": "awaits_status",
                "code": "latest_unconfirmed",
                "redelivered": false,
                "sentry_event_id": event.event_id.simple().to_string(),
            }),
            json!({
                "level": "WARN",
                "message": "store.notification",
                "operation": "store.notification",
                "store": "app_store",
                "environment": "sandbox",
                "outcome": "awaits_status",
                "code": "earlier_transaction",
                "redelivered": false,
            }),
        ]
    );
    assert_eq!(
        inbox,
        [
            (
                "00000000-0000-4000-8000-000000000001".to_owned(),
                "sandbox".to_owned(),
                None
            ),
            (
                "00000000-0000-4000-8000-000000000002".to_owned(),
                "sandbox".to_owned(),
                None
            ),
        ]
    );
    assert_eq!(feed, []);
}

#[test]
#[cfg_attr(not(postgres_tests), ignore = "needs SUBSCRIPTIONS_TEST_DATABASE_URL")]
fn an_account_token_that_is_not_a_uuid_names_no_account() {
    let start = 1_793_491_200_000;
    let ((answer, deliveries, feed), events) = reported(with_empty_database(async |url| {
        let (captured, _logs) = Captured::start();
        let ledger = Ledger::open(&url.parse().unwrap()).await.unwrap();
        let clock = Clock::at(start);
        let router = public_router(&ledger, trusting_the_test_root(&clock), &clock);
        let mut description = story("started.json");
        description["notification"]["data"]["signedTransactionInfo"]["appAccountToken"] =
            json!("6f9d0c2e-not-a-uuid");

        let answer = post(&router, delivery(&signed(description, start))).await;
        let deliveries = captured.delivered(1).await;

        (answer, deliveries, feed(&ledger, start).await)
    }));

    assert_eq!(answer, (StatusCode::OK, String::new()));
    assert_eq!(deliveries[0]["outcome"], "applied");
    assert_eq!(feed, [("started", 0, None), ("period_recorded", 0, None)]);
    assert_eq!(events.len(), 0, "{events:#?}");
}

#[test]
#[cfg_attr(not(postgres_tests), ignore = "needs SUBSCRIPTIONS_TEST_DATABASE_URL")]
fn a_delivery_whose_client_leaves_before_its_answer_is_still_kept_and_applied() {
    let start = 1_793_491_200_000;
    let ((request_lines, deliveries, inbox, feed), events) =
        reported(with_empty_database(async |url| {
            let (captured, _logs) = Captured::start();
            let ledger = Ledger::open(&url.parse().unwrap()).await.unwrap();
            let clock = Clock::at(start);
            let router = public_router(&ledger, trusting_the_test_root(&clock), &clock);
            let signed = signed(story("started.json"), start);
            // The inbox's lock holds the delivery between its verification and its keeping.
            let mut holder = PgConnection::connect(&url).await.unwrap();
            let mut held = holder.begin().await.unwrap();
            held.execute("lock table inbox in exclusive mode")
                .await
                .unwrap();

            let abandoned =
                tokio::time::timeout(Duration::from_millis(300), post(&router, delivery(&signed)))
                    .await;
            assert!(abandoned.is_err());
            held.rollback().await.unwrap();
            let deliveries = captured.delivered(1).await;

            let request_lines: Vec<Value> = captured
                .lines()
                .into_iter()
                .filter(|line| line["message"] == "request")
                .map(|mut line| {
                    let fields = line.as_object_mut().unwrap();
                    assert!(fields.remove("duration_ms").unwrap().is_f64());
                    assert_eq!(
                        fields.remove("request_id").unwrap().as_str().unwrap().len(),
                        32
                    );
                    line
                })
                .collect();
            (
                request_lines,
                deliveries,
                inbox(&url).await,
                feed(&ledger, start).await,
            )
        }));

    assert_eq!(
        request_lines,
        [json!({
            "level": "WARN",
            "message": "request",
            "listener": "public",
            "method": "POST",
            "route": "/v1/stores/app-store/notifications",
            "outcome": "cancelled",
        })]
    );
    assert_eq!(deliveries[0]["outcome"], "applied");
    assert_eq!(
        inbox
            .into_iter()
            .map(|(_, environment, outcome)| (environment, outcome))
            .collect::<Vec<_>>(),
        [("sandbox".to_owned(), Some("applied".to_owned()))]
    );
    assert_eq!(
        feed.iter().map(|(kind, ..)| *kind).collect::<Vec<_>>(),
        ["started", "bound", "period_recorded"]
    );
    assert_eq!(events.len(), 0, "{events:#?}");
}

#[test]
#[cfg_attr(not(postgres_tests), ignore = "needs SUBSCRIPTIONS_TEST_DATABASE_URL")]
fn an_apply_that_fails_answers_200_leaves_the_notification_unsettled_and_is_reported() {
    let start = 1_793_491_200_000;
    let ((answers, deliveries, unsettled_after_failure, inbox), events) =
        reported(with_empty_database(async |url| {
            let (captured, _logs) = Captured::start();
            let ledger = Ledger::open(&url.parse().unwrap()).await.unwrap();
            let clock = Clock::at(start);
            let router = public_router(&ledger, trusting_the_test_root(&clock), &clock);
            let signed = signed(story("started.json"), start);
            // The lineage's lock outlasts the apply's 5 s wait for it.
            let mut holder = PgConnection::connect(&url).await.unwrap();
            let mut held = holder.begin().await.unwrap();
            held.execute(
                "select pg_advisory_xact_lock(hashtextextended(\
                 format('lineage %s %s %s', 'app_store', 'sandbox', '2000000000000001'), 0))",
            )
            .await
            .unwrap();

            let mut answers = vec![post(&router, delivery(&signed)).await];
            captured.delivered(1).await;
            let unsettled_after_failure = inbox(&url).await;
            held.rollback().await.unwrap();
            answers.push(post(&router, delivery(&signed)).await);
            let deliveries = captured.delivered(2).await;

            (
                answers,
                deliveries,
                unsettled_after_failure,
                inbox(&url).await,
            )
        }));

    assert_eq!(answers, vec![(StatusCode::OK, String::new()); 2]);
    assert_eq!(events.len(), 1, "{events:#?}");
    let event = &events[0];
    assert_eq!(
        (&event.fingerprint[..], event.tags["code"].as_str()),
        (&["store.notification".into(), "busy".into()][..], "busy")
    );
    assert_eq!(
        deliveries,
        [
            json!({
                "level": "ERROR",
                "message": "store.notification",
                "operation": "store.notification",
                "store": "app_store",
                "environment": "sandbox",
                "outcome": "apply_failed",
                "code": "busy",
                "redelivered": false,
                "sentry_event_id": event.event_id.simple().to_string(),
            }),
            json!({
                "level": "INFO",
                "message": "store.notification",
                "operation": "store.notification",
                "store": "app_store",
                "environment": "sandbox",
                "outcome": "applied",
                "redelivered": true,
                "events": 3,
            }),
        ]
    );
    assert_eq!(
        (
            unsettled_after_failure
                .into_iter()
                .map(|(_, _, outcome)| outcome)
                .collect::<Vec<_>>(),
            inbox
                .into_iter()
                .map(|(_, _, outcome)| outcome)
                .collect::<Vec<_>>()
        ),
        (vec![None], vec![Some("applied".to_owned())])
    );
}

#[test]
#[cfg_attr(not(postgres_tests), ignore = "needs SUBSCRIPTIONS_TEST_DATABASE_URL")]
fn draining_the_door_waits_for_the_delivery_it_is_applying() {
    let start = 1_793_491_200_000;
    let ((answer, drained_while_held, deliveries, inbox), events) =
        reported(with_empty_database(async |url| {
            let (captured, _logs) = Captured::start();
            let ledger = Ledger::open(&url.parse().unwrap()).await.unwrap();
            let clock = Clock::at(start);
            let door = AppStoreDoor::new(
                ledger.clone(),
                SignedDataVerifier::windmill_also_trusting(TEST_ROOT, clock.reading()).unwrap(),
                clock.reading(),
            );
            let config = Config::from_environment(|variable| match variable {
                "SUBSCRIPTIONS_PUBLIC_ADDRESS" => Some("127.0.0.1:8082".to_owned()),
                "SUBSCRIPTIONS_INTERNAL_ADDRESS" => Some("127.0.0.1:8083".to_owned()),
                "SUBSCRIPTIONS_DATABASE_URL" => {
                    Some("postgresql://ledger@127.0.0.1:1/ledger".to_owned())
                }
                "SENTRY_ENVIRONMENT" => Some("test".to_owned()),
                _ => None,
            })
            .unwrap();
            let router = Listener::Public.router(
                &config,
                ledger.clone(),
                store_doors::router(door.clone()),
                Bounds::default(),
            );
            // The lineage's lock holds the apply after the answer, for less than the apply's 5 s wait for it.
            let mut holder = PgConnection::connect(&url).await.unwrap();
            let mut held = holder.begin().await.unwrap();
            held.execute(
                "select pg_advisory_xact_lock(hashtextextended(\
                 format('lineage %s %s %s', 'app_store', 'sandbox', '2000000000000001'), 0))",
            )
            .await
            .unwrap();

            let answer = post(&router, delivery(&signed(story("started.json"), start))).await;
            let drained_while_held = tokio::time::timeout(Duration::from_millis(300), door.drain())
                .await
                .is_ok();
            held.rollback().await.unwrap();
            tokio::time::timeout(Duration::from_secs(10), door.drain())
                .await
                .expect("the door drains once the apply is done");

            (
                answer,
                drained_while_held,
                captured.deliveries(),
                inbox(&url).await,
            )
        }));

    assert_eq!(
        (answer, drained_while_held),
        ((StatusCode::OK, String::new()), false)
    );
    assert_eq!(
        deliveries
            .iter()
            .map(|line| &line["outcome"])
            .collect::<Vec<_>>(),
        ["applied"]
    );
    assert_eq!(
        inbox
            .into_iter()
            .map(|(_, _, outcome)| outcome)
            .collect::<Vec<_>>(),
        [Some("applied".to_owned())]
    );
    assert_eq!(events.len(), 0, "{events:#?}");
}
