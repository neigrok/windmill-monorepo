use std::env;
use std::panic::{AssertUnwindSafe, resume_unwind};
use std::sync::{Arc, Mutex};

use axum::Router;
use axum::body::{Body, to_bytes};
use axum::http::{Request, StatusCode};
use domain::{
    AccountEntitlement, AccountId, BillingInterval, Environment, Instant, Lineage, Money,
    NextCharge, Observation, ObservedPeriod, Ownership, Plan, ProductId, Renewal, Span, State,
    Status, Store, StoreSubscriptionId, StoreTransactionId, Storefront,
};
use futures_util::FutureExt;
use serde_json::{Value, json};
use server::config::Config;
use server::internal::Reads;
use server::listeners::{Bounds, Listener, Readiness};
use sqlx::{AssertSqlSafe, Connection, Executor, PgConnection};
use storage::{AccountClaim, AccountRecord, Applied, FeedPage, Ledger, Observed, StorageError};
use tower::ServiceExt;
use url::Url;
use uuid::Uuid;

// A ledger no door may reach: every test that holds it expects a refusal before any read.
#[derive(Clone)]
struct Unread;

impl Readiness for Unread {
    async fn ready(&self) -> Result<(), StorageError> {
        Ok(())
    }
}

impl Reads for Unread {
    async fn feed(&self, _after: i64, _limit: i64) -> Result<FeedPage, StorageError> {
        panic!("a refused request read the feed")
    }

    async fn account(&self, _account_id: Uuid) -> Result<AccountRecord, StorageError> {
        panic!("a refused request read an account")
    }
}

// An empty ledger that remembers what each read asked for.
#[derive(Clone, Default)]
struct Empty {
    reads: Arc<Mutex<Vec<String>>>,
}

impl Readiness for Empty {
    async fn ready(&self) -> Result<(), StorageError> {
        Ok(())
    }
}

impl Reads for Empty {
    async fn feed(&self, after: i64, limit: i64) -> Result<FeedPage, StorageError> {
        self.reads
            .lock()
            .unwrap()
            .push(format!("feed after {after} limit {limit}"));
        Ok(FeedPage {
            epoch: Uuid::parse_str("c09a3ab3-2732-4415-ba88-825ff868cf13").unwrap(),
            entries: Vec::new(),
            latest_seq: 0,
        })
    }

    async fn account(&self, account_id: Uuid) -> Result<AccountRecord, StorageError> {
        self.reads
            .lock()
            .unwrap()
            .push(format!("account {account_id}"));
        Ok(AccountRecord {
            entitlement: AccountEntitlement::of(AccountId::new(account_id.to_string()), Vec::new()),
            subscriptions: Vec::new(),
        })
    }
}

async fn answer(router: Router, request: Request<Body>) -> (StatusCode, Option<String>, Value) {
    let response = router.oneshot(request).await.unwrap();
    let status = response.status();
    let challenge = response
        .headers()
        .get("www-authenticate")
        .map(|value| value.to_str().unwrap().to_owned());
    let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    (status, challenge, serde_json::from_slice(&body).unwrap())
}

#[tokio::test]
async fn every_door_refuses_a_caller_without_the_secret_and_says_nothing_of_why() {
    let config = Config::from_environment(|variable| match variable {
        "SUBSCRIPTIONS_PUBLIC_ADDRESS" => Some("127.0.0.1:8082".to_owned()),
        "SUBSCRIPTIONS_INTERNAL_ADDRESS" => Some("127.0.0.1:8083".to_owned()),
        "SUBSCRIPTIONS_DATABASE_URL" => Some("postgresql://ledger@127.0.0.1:1/ledger".to_owned()),
        "SENTRY_ENVIRONMENT" => Some("test".to_owned()),
        "SUBSCRIPTIONS_INTERNAL_TOKEN" => Some("5d0c3a9e8f7b6a5d4c3b2a1f0e9d8c7b".to_owned()),
        _ => None,
    })
    .unwrap();
    let internal = Listener::Internal.router(&config, Unread, Bounds::default());

    for path in [
        "/internal/v1/feed?after=0&limit=500",
        "/internal/v1/accounts/3f6c2a1e-9b7d-4e2a-8c51-0d4f7b2e9a61",
    ] {
        for authorization in [
            None,
            Some("Bearer"),
            Some("Bearer "),
            Some("Bearer 5d0c3a9e8f7b6a5d4c3b2a1f0e9d8c7"),
            Some("Bearer 5d0c3a9e8f7b6a5d4c3b2a1f0e9d8c7bb"),
            Some("Bearer 5D0C3A9E8F7B6A5D4C3B2A1F0E9D8C7B"),
            Some("Basic 5d0c3a9e8f7b6a5d4c3b2a1f0e9d8c7b"),
            Some("5d0c3a9e8f7b6a5d4c3b2a1f0e9d8c7b"),
        ] {
            let mut request = Request::get(path);
            if let Some(authorization) = authorization {
                request = request.header("authorization", authorization);
            }

            let answered = answer(internal.clone(), request.body(Body::empty()).unwrap()).await;

            assert_eq!(
                answered,
                (
                    StatusCode::UNAUTHORIZED,
                    Some("Bearer".to_owned()),
                    json!({ "code": "unauthorized" })
                ),
                "{path} {authorization:?}"
            );
        }
    }
}

#[tokio::test]
async fn without_a_secret_every_door_stays_shut() {
    let config = Config::from_environment(|variable| match variable {
        "SUBSCRIPTIONS_PUBLIC_ADDRESS" => Some("127.0.0.1:8082".to_owned()),
        "SUBSCRIPTIONS_INTERNAL_ADDRESS" => Some("127.0.0.1:8083".to_owned()),
        "SUBSCRIPTIONS_DATABASE_URL" => Some("postgresql://ledger@127.0.0.1:1/ledger".to_owned()),
        "SENTRY_ENVIRONMENT" => Some("test".to_owned()),
        "SUBSCRIPTIONS_INTERNAL_TOKEN" => Some(String::new()),
        _ => None,
    })
    .unwrap();
    let internal = Listener::Internal.router(&config, Unread, Bounds::default());

    for path in [
        "/internal/v1/feed?after=0&limit=500",
        "/internal/v1/accounts/3f6c2a1e-9b7d-4e2a-8c51-0d4f7b2e9a61",
    ] {
        for authorization in [
            None,
            Some("Bearer "),
            Some("Bearer 5d0c3a9e8f7b6a5d4c3b2a1f0e9d8c7b"),
        ] {
            let mut request = Request::get(path);
            if let Some(authorization) = authorization {
                request = request.header("authorization", authorization);
            }

            let answered = answer(internal.clone(), request.body(Body::empty()).unwrap()).await;

            assert_eq!(
                answered,
                (
                    StatusCode::UNAUTHORIZED,
                    Some("Bearer".to_owned()),
                    json!({ "code": "unauthorized" })
                ),
                "{path} {authorization:?}"
            );
        }
    }
    let health = Listener::Internal
        .router(&config, Unread, Bounds::default())
        .oneshot(Request::get("/health").body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(health.status(), StatusCode::OK);
}

#[tokio::test]
async fn the_secret_opens_both_doors_and_each_reads_what_it_was_asked() {
    let config = Config::from_environment(|variable| match variable {
        "SUBSCRIPTIONS_PUBLIC_ADDRESS" => Some("127.0.0.1:8082".to_owned()),
        "SUBSCRIPTIONS_INTERNAL_ADDRESS" => Some("127.0.0.1:8083".to_owned()),
        "SUBSCRIPTIONS_DATABASE_URL" => Some("postgresql://ledger@127.0.0.1:1/ledger".to_owned()),
        "SENTRY_ENVIRONMENT" => Some("test".to_owned()),
        "SUBSCRIPTIONS_INTERNAL_TOKEN" => Some("5d0c3a9e8f7b6a5d4c3b2a1f0e9d8c7b".to_owned()),
        _ => None,
    })
    .unwrap();
    let ledger = Empty::default();
    let internal = Listener::Internal.router(&config, ledger.clone(), Bounds::default());

    let feed = answer(
        internal.clone(),
        Request::get("/internal/v1/feed?after=26&limit=500")
            .header("authorization", "Bearer 5d0c3a9e8f7b6a5d4c3b2a1f0e9d8c7b")
            .body(Body::empty())
            .unwrap(),
    )
    .await;
    let account = answer(
        internal,
        Request::get("/internal/v1/accounts/3f6c2a1e-9b7d-4e2a-8c51-0d4f7b2e9a61")
            .header("authorization", "bearer 5d0c3a9e8f7b6a5d4c3b2a1f0e9d8c7b")
            .body(Body::empty())
            .unwrap(),
    )
    .await;

    assert_eq!(
        feed,
        (
            StatusCode::OK,
            None,
            json!({
                "epoch": "c09a3ab3-2732-4415-ba88-825ff868cf13",
                "entries": [],
                "latestSeq": 0,
            })
        )
    );
    let nothing = json!({ "plan": null, "accessUntil": null, "governing": null, "others": [] });
    assert_eq!(
        account,
        (
            StatusCode::OK,
            None,
            json!({
                "entitlement": {
                    "accountId": "3f6c2a1e-9b7d-4e2a-8c51-0d4f7b2e9a61",
                    "production": nothing,
                    "sandbox": nothing,
                },
                "subscriptions": [],
            })
        )
    );
    assert_eq!(
        *ledger.reads.lock().unwrap(),
        [
            "feed after 26 limit 500",
            "account 3f6c2a1e-9b7d-4e2a-8c51-0d4f7b2e9a61"
        ]
    );
}

#[tokio::test]
async fn a_query_or_an_account_id_outside_its_bounds_is_refused_before_the_ledger_is_read() {
    let config = Config::from_environment(|variable| match variable {
        "SUBSCRIPTIONS_PUBLIC_ADDRESS" => Some("127.0.0.1:8082".to_owned()),
        "SUBSCRIPTIONS_INTERNAL_ADDRESS" => Some("127.0.0.1:8083".to_owned()),
        "SUBSCRIPTIONS_DATABASE_URL" => Some("postgresql://ledger@127.0.0.1:1/ledger".to_owned()),
        "SENTRY_ENVIRONMENT" => Some("test".to_owned()),
        "SUBSCRIPTIONS_INTERNAL_TOKEN" => Some("5d0c3a9e8f7b6a5d4c3b2a1f0e9d8c7b".to_owned()),
        _ => None,
    })
    .unwrap();
    let ledger = Empty::default();
    let internal = Listener::Internal.router(&config, ledger.clone(), Bounds::default());

    let mut answers = Vec::new();
    for query in [
        "",
        "?after=0",
        "?limit=500",
        "?after=-1&limit=500",
        "?after=0&limit=0",
        "?after=0&limit=501",
        "?after=seven&limit=500",
        "?after=0&limit=1.5",
        "?after=0&limit=1",
        "?after=0&limit=500&cursor=ignored",
    ] {
        let (status, _, body) = answer(
            internal.clone(),
            Request::get(format!("/internal/v1/feed{query}"))
                .header("authorization", "Bearer 5d0c3a9e8f7b6a5d4c3b2a1f0e9d8c7b")
                .body(Body::empty())
                .unwrap(),
        )
        .await;
        answers.push((query, status, body["code"].clone()));
    }
    let mut refusals = Vec::new();
    for path in [
        "/internal/v1/accounts/acct_3f6c2a1e",
        "/internal/v1/accounts/%FF3f6c2a1e",
        "/internal/v1/accounts/3F6C2A1E-9B7D-4E2A-8C51-0D4F7B2E9A61",
        "/internal/v1/accounts/%7B3f6c2a1e-9b7d-4e2a-8c51-0d4f7b2e9a61%7D",
        "/internal/v1/accounts/3f6c2a1e9b7d4e2a8c510d4f7b2e9a61",
        "/internal/v1/accounts/urn:uuid:3f6c2a1e-9b7d-4e2a-8c51-0d4f7b2e9a61",
    ] {
        let (status, _, body) = answer(
            internal.clone(),
            Request::get(path)
                .header("authorization", "Bearer 5d0c3a9e8f7b6a5d4c3b2a1f0e9d8c7b")
                .body(Body::empty())
                .unwrap(),
        )
        .await;
        refusals.push((status, body));
    }

    let invalid = json!("invalid_query");
    assert_eq!(
        answers,
        [
            ("", StatusCode::BAD_REQUEST, invalid.clone()),
            ("?after=0", StatusCode::BAD_REQUEST, invalid.clone()),
            ("?limit=500", StatusCode::BAD_REQUEST, invalid.clone()),
            (
                "?after=-1&limit=500",
                StatusCode::BAD_REQUEST,
                invalid.clone()
            ),
            ("?after=0&limit=0", StatusCode::BAD_REQUEST, invalid.clone()),
            (
                "?after=0&limit=501",
                StatusCode::BAD_REQUEST,
                invalid.clone()
            ),
            (
                "?after=seven&limit=500",
                StatusCode::BAD_REQUEST,
                invalid.clone()
            ),
            ("?after=0&limit=1.5", StatusCode::BAD_REQUEST, invalid),
            ("?after=0&limit=1", StatusCode::OK, Value::Null),
            (
                "?after=0&limit=500&cursor=ignored",
                StatusCode::OK,
                Value::Null
            ),
        ]
    );
    let invalid_account = (
        StatusCode::BAD_REQUEST,
        json!({ "code": "invalid_account_id" }),
    );
    assert_eq!(refusals, vec![invalid_account; 6]);
    assert_eq!(
        *ledger.reads.lock().unwrap(),
        ["feed after 0 limit 1", "feed after 0 limit 500"]
    );
}

#[test]
fn a_read_the_ledger_does_not_answer_is_an_issue_under_its_operation() {
    #[derive(Clone)]
    struct Failing;

    impl Readiness for Failing {
        async fn ready(&self) -> Result<(), StorageError> {
            Ok(())
        }
    }

    impl Reads for Failing {
        async fn feed(&self, _after: i64, _limit: i64) -> Result<FeedPage, StorageError> {
            Err(StorageError::Busy)
        }

        async fn account(&self, _account_id: Uuid) -> Result<AccountRecord, StorageError> {
            Err(StorageError::Database {
                sqlstate: Some("57P01".to_owned()),
            })
        }
    }

    let config = Config::from_environment(|variable| match variable {
        "SUBSCRIPTIONS_PUBLIC_ADDRESS" => Some("127.0.0.1:8082".to_owned()),
        "SUBSCRIPTIONS_INTERNAL_ADDRESS" => Some("127.0.0.1:8083".to_owned()),
        "SUBSCRIPTIONS_DATABASE_URL" => Some("postgresql://ledger@127.0.0.1:1/ledger".to_owned()),
        "SENTRY_ENVIRONMENT" => Some("test".to_owned()),
        "SUBSCRIPTIONS_INTERNAL_TOKEN" => Some("5d0c3a9e8f7b6a5d4c3b2a1f0e9d8c7b".to_owned()),
        _ => None,
    })
    .unwrap();
    let internal = Listener::Internal.router(&config, Failing, Bounds::default());
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    let mut answers = Vec::new();

    let events = sentry::test::with_captured_events(|| {
        for path in [
            "/internal/v1/feed?after=0&limit=500",
            "/internal/v1/accounts/3f6c2a1e-9b7d-4e2a-8c51-0d4f7b2e9a61",
        ] {
            let answered = runtime.block_on(answer(
                internal.clone(),
                Request::get(path)
                    .header("authorization", "Bearer 5d0c3a9e8f7b6a5d4c3b2a1f0e9d8c7b")
                    .body(Body::empty())
                    .unwrap(),
            ));
            answers.push(answered);
        }
    });

    let unavailable = (
        StatusCode::SERVICE_UNAVAILABLE,
        None,
        json!({ "code": "unavailable" }),
    );
    assert_eq!(answers, [unavailable.clone(), unavailable]);
    let reported: Vec<Value> = events
        .iter()
        .map(|event| {
            let tags: serde_json::Map<String, Value> = event
                .tags
                .iter()
                .filter(|(name, _)| ["operation", "code", "sqlstate"].contains(&name.as_str()))
                .map(|(name, value)| (name.clone(), json!(value)))
                .collect();
            json!({ "message": event.message, "tags": tags })
        })
        .collect();
    assert_eq!(
        reported,
        [
            json!({
                "message": "feed.read",
                "tags": { "operation": "feed.read", "code": "busy" },
            }),
            json!({
                "message": "account.read",
                "tags": { "operation": "account.read", "code": "database", "sqlstate": "57P01" },
            }),
        ]
    );
    assert!(
        !serde_json::to_string(&events)
            .unwrap()
            .contains("3f6c2a1e-9b7d-4e2a-8c51-0d4f7b2e9a61")
    );
}

// An empty database of its own beside the one SUBSCRIPTIONS_TEST_DATABASE_URL names in its path, dropped
// after the test whether or not it passed. The role there must be allowed to create databases.
async fn with_empty_database(test: impl AsyncFnOnce(String)) {
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
    if let Err(panic) = outcome {
        resume_unwind(panic);
    }
}

#[tokio::test]
#[cfg_attr(not(postgres_tests), ignore = "needs SUBSCRIPTIONS_TEST_DATABASE_URL")]
async fn a_feed_read_from_zero_returns_every_event_in_seq_order_across_pages() {
    with_empty_database(async |url| {
        let ledger = Ledger::open(&url.parse().unwrap()).await.unwrap();
        let (buyer, claimant) = (Uuid::new_v4(), Uuid::new_v4());
        let mut recorded = Vec::new();
        for month in 0..4 {
            for (lineage, hint) in [("bought", Some(buyer)), ("unhinted", None)] {
                let applied = ledger
                    .apply(Observed {
                        observation: renewing(lineage, month),
                        hint,
                        claim: None,
                        pulled_at: None,
                    })
                    .await
                    .unwrap();
                recorded.push(applied);
            }
        }
        let claimed = ledger
            .apply(Observed {
                observation: renewing("unhinted", 3),
                hint: None,
                claim: Some(AccountClaim {
                    account_id: claimant,
                    at: Instant::from_epoch_millis(1_806_537_600_000),
                }),
                pulled_at: Some(Instant::from_epoch_millis(1_806_537_600_000)),
            })
            .await
            .unwrap();
        recorded.push(claimed);
        let seqs: Vec<i64> = recorded
            .into_iter()
            .flat_map(|applied| match applied {
                Applied::Recorded { seqs, .. } => seqs,
                other => panic!("an apply answered {other:?}"),
            })
            .collect();
        let config = Config::from_environment(|variable| match variable {
            "SUBSCRIPTIONS_PUBLIC_ADDRESS" => Some("127.0.0.1:8082".to_owned()),
            "SUBSCRIPTIONS_INTERNAL_ADDRESS" => Some("127.0.0.1:8083".to_owned()),
            "SUBSCRIPTIONS_DATABASE_URL" => Some(url.clone()),
            "SENTRY_ENVIRONMENT" => Some("test".to_owned()),
            "SUBSCRIPTIONS_INTERNAL_TOKEN" => Some("5d0c3a9e8f7b6a5d4c3b2a1f0e9d8c7b".to_owned()),
            _ => None,
        })
        .unwrap();
        let internal = Listener::Internal.router(&config, ledger.clone(), Bounds::default());
        let read = async |after: i64, limit: i64| {
            let (status, _, page) = answer(
                internal.clone(),
                Request::get(format!("/internal/v1/feed?after={after}&limit={limit}"))
                    .header("authorization", "Bearer 5d0c3a9e8f7b6a5d4c3b2a1f0e9d8c7b")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await;
            assert_eq!(status, StatusCode::OK);
            page
        };

        let whole = read(0, 500).await;
        let mut read_in_pages = Vec::new();
        for limit in [1, 2, 3, 7, 500] {
            let mut entries: Vec<Value> = Vec::new();
            let mut after = 0;
            for _ in 0..=seqs.len() {
                let page = read(after, limit).await;
                let listed = page["entries"].as_array().unwrap();
                assert!(listed.len() <= limit as usize, "{limit}: {page}");
                assert_eq!(page["latestSeq"], json!(seqs.last()), "{limit}");
                assert_eq!(page["epoch"], whole["epoch"], "{limit}");
                let Some(last) = listed.last() else {
                    break;
                };
                after = last["seq"].as_i64().unwrap();
                entries.extend(listed.iter().cloned());
            }
            read_in_pages.push((limit, after, entries));
        }

        assert_eq!(seqs, (1..=seqs.len() as i64).collect::<Vec<_>>());
        let entries = whole["entries"].as_array().unwrap();
        assert_eq!(
            entries
                .iter()
                .map(|entry| entry["seq"].as_i64().unwrap())
                .collect::<Vec<_>>(),
            seqs
        );
        for (limit, after, chained) in read_in_pages {
            assert_eq!(
                (after, &chained),
                (*seqs.last().unwrap(), entries),
                "{limit}"
            );
        }
        ledger.close().await;
    })
    .await;
}

// One month of Windmill One on the lineage, renewing: month 0 is its purchase, each later month a renewal.
fn renewing(lineage: &str, month: i64) -> Observation {
    let day = 86_400_000;
    let started = Instant::from_epoch_millis(1_798_761_600_000);
    let start = Instant::from_epoch_millis(started.epoch_millis() + month * 30 * day);
    let end = Instant::from_epoch_millis(start.epoch_millis() + 30 * day);
    let price = Money::new("12.00", "USD").unwrap();
    Observation {
        lineage: Lineage {
            store: Store::AppStore,
            environment: Environment::Production,
            store_subscription_id: StoreSubscriptionId::new(lineage),
        },
        observed_at: start,
        ownership: Ownership::Purchased,
        status: Status {
            plan: Plan::WindmillOne,
            product_id: ProductId::new("works.windmill.app.one.monthly"),
            billing_interval: BillingInterval::new("P1M"),
            started_at: started,
            state: State::Active {
                pause_scheduled_for: None,
            },
            current_period: Span { start, end },
            renewal: Renewal {
                auto_renew: true,
                next_charge: Some(NextCharge {
                    at: end,
                    price: price.clone(),
                }),
                next_product_id: None,
                cancel_requested_at: None,
            },
            offer: None,
            price: price.clone(),
            storefront: Some(Storefront::new("USA")),
        },
        periods: vec![ObservedPeriod {
            transaction: StoreTransactionId::new(format!("{lineage}-{month}")),
            span: Span { start, end },
            price,
            offer_kind: None,
            refunded_at: None,
        }],
    }
}
