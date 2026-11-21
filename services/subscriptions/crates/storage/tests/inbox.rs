use std::env;
use std::panic::{AssertUnwindSafe, resume_unwind};
use std::time::Duration;

use domain::{
    BillingInterval, Environment, Instant, Lineage, Money, NextCharge, Observation, ObservedPeriod,
    Ownership, Plan, ProductId, Renewal, Span, State, Status, Store, StoreSubscriptionId,
    StoreTransactionId, Storefront,
};
use futures_util::FutureExt;
use sqlx::{AssertSqlSafe, Connection, Executor, PgConnection};
use storage::{Applied, Ledger, Notification, Observed, Receipt, StorageError};
use url::Url;
use uuid::Uuid;

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
async fn a_notification_received_twice_is_kept_once() {
    with_empty_database(async |url| {
        let ledger = Ledger::open(&url.parse().unwrap()).await.unwrap();
        let first = notification(Store::AppStore, "n-1", "as first sent");
        let resent = notification(Store::AppStore, "n-1", "as sent again");
        let another_store = notification(Store::Paddle, "n-1", "from Paddle");

        let receipts = [
            ledger.receive(first.clone()).await.unwrap(),
            ledger.receive(resent.clone()).await.unwrap(),
            ledger.receive(another_store.clone()).await.unwrap(),
        ];
        let Receipt::Kept(first_kept) = &receipts[0] else {
            panic!("receipts {receipts:?}")
        };
        ledger.settle(first_kept, "test").await.unwrap();
        let resent_once_settled = ledger.receive(resent).await.unwrap();

        let kept: Vec<Notification> = ledger
            .unsettled(10)
            .await
            .unwrap()
            .iter()
            .map(|kept| kept.notification().clone())
            .collect();
        let [
            Receipt::Kept(_),
            Receipt::Duplicate(Some(redelivered)),
            Receipt::Kept(_),
        ] = &receipts
        else {
            panic!("receipts {receipts:?}")
        };
        assert_eq!(
            (first_kept.notification(), redelivered.notification()),
            (&first, &first)
        );
        assert_eq!(resent_once_settled, Receipt::Duplicate(None));
        assert_eq!(kept, [another_store]);
        assert_eq!(
            format!("{:?}", first_kept.notification()),
            "Notification { store: AppStore, id: \"n-1\", environment: Production, \
             signed_payload: \"(redacted)\" }"
        );
        ledger.close().await;
    })
    .await;
}

#[tokio::test(flavor = "multi_thread")]
#[cfg_attr(not(postgres_tests), ignore = "needs SUBSCRIPTIONS_TEST_DATABASE_URL")]
async fn a_notification_whose_process_died_before_it_applied_is_applied_once_by_the_retries() {
    with_empty_database(async |url| {
        let mut control = PgConnection::connect(&url).await.unwrap();
        let door = Ledger::open(&url.parse().unwrap()).await.unwrap();
        let received = notification(Store::AppStore, "n-died", "a renewal");
        let Receipt::Kept(kept) = door.receive(received.clone()).await.unwrap() else {
            panic!("the notification was not kept")
        };
        hold_events(&mut control).await;
        let applying = tokio::spawn({
            let door = door.clone();
            async move { door.apply_notification(&kept, observed(renewal())).await }
        });
        until("the door's apply holds its events", async || {
            waiting(&mut control).await == 1
        })
        .await;
        control
            .execute(
                "select pg_terminate_backend(pid) from pg_stat_activity \
                 where datname = current_database() and wait_event_type = 'Lock'",
            )
            .await
            .unwrap();
        let died = applying.await.unwrap();
        door.close().await;
        control
            .execute("select pg_advisory_unlock(7)")
            .await
            .unwrap();

        let sweep = Ledger::open(&url.parse().unwrap()).await.unwrap();
        let unsettled = sweep.unsettled(10).await.unwrap();
        let [kept] = unsettled.as_slice() else {
            panic!("unsettled {unsettled:?}")
        };
        let (one, other) = tokio::join!(
            sweep.apply_notification(kept, observed(renewal())),
            sweep.apply_notification(kept, observed(renewal())),
        );
        let once_more = sweep
            .apply_notification(kept, observed(renewal()))
            .await
            .unwrap();
        let feed = sweep.feed(0, 100).await.unwrap();
        let settled: Vec<(String, Option<String>)> =
            sqlx::query_as("select notification_id, outcome from inbox")
                .fetch_all(&mut control)
                .await
                .unwrap();

        assert_eq!(
            died,
            Err(StorageError::Database {
                sqlstate: Some("57P01".to_owned())
            })
        );
        assert_eq!(kept.notification(), &received);
        let mut answers = [one.unwrap(), other.unwrap()];
        answers.sort_by_key(|applied| matches!(applied, Applied::AlreadySettled));
        let [Applied::Recorded { seqs, .. }, Applied::AlreadySettled] = &answers else {
            panic!("the retries answered {answers:?}")
        };
        assert_eq!(seqs, &[1, 2]);
        assert_eq!(once_more, Applied::AlreadySettled);
        assert_eq!(
            feed.entries
                .iter()
                .map(|entry| (entry.seq, entry.event.kind.name()))
                .collect::<Vec<_>>(),
            [(1, "started"), (2, "period_recorded")]
        );
        assert_eq!(sweep.unsettled(10).await.unwrap(), []);
        assert_eq!(settled, [("n-died".to_owned(), Some("applied".to_owned()))]);
        sweep.close().await;
    })
    .await;
}

#[tokio::test]
#[cfg_attr(not(postgres_tests), ignore = "needs SUBSCRIPTIONS_TEST_DATABASE_URL")]
async fn a_notification_with_nothing_to_apply_is_settled_with_what_it_was() {
    with_empty_database(async |url| {
        let ledger = Ledger::open(&url.parse().unwrap()).await.unwrap();
        let Receipt::Kept(kept) = ledger
            .receive(notification(Store::AppStore, "n-test", "Apple's test"))
            .await
            .unwrap()
        else {
            panic!("the notification was not kept")
        };

        ledger.settle(&kept, "test").await.unwrap();
        ledger.settle(&kept, "unsupported").await.unwrap();
        let applied = ledger
            .apply_notification(&kept, observed(renewal()))
            .await
            .unwrap();

        let mut connection = PgConnection::connect(&url).await.unwrap();
        let settled: Vec<(String, Option<String>)> =
            sqlx::query_as("select notification_id, outcome from inbox")
                .fetch_all(&mut connection)
                .await
                .unwrap();
        assert_eq!(applied, Applied::AlreadySettled);
        assert_eq!(settled, [("n-test".to_owned(), Some("test".to_owned()))]);
        assert_eq!(ledger.unsettled(10).await.unwrap(), []);
        assert_eq!(ledger.feed(0, 100).await.unwrap().latest_seq, 0);
        ledger.close().await;
    })
    .await;
}

#[tokio::test(flavor = "multi_thread")]
#[cfg_attr(not(postgres_tests), ignore = "needs SUBSCRIPTIONS_TEST_DATABASE_URL")]
async fn a_settlement_beside_an_apply_of_its_notification_waits_for_the_apply_and_keeps_its_outcome()
 {
    with_empty_database(async |url| {
        let mut control = PgConnection::connect(&url).await.unwrap();
        let ledger = Ledger::open(&url.parse().unwrap()).await.unwrap();
        let Receipt::Kept(kept) = ledger
            .receive(notification(Store::AppStore, "n-beside", "a renewal"))
            .await
            .unwrap()
        else {
            panic!("the notification was not kept")
        };
        hold_events(&mut control).await;

        let applying = tokio::spawn({
            let (ledger, kept) = (ledger.clone(), kept.clone());
            async move { ledger.apply_notification(&kept, observed(renewal())).await }
        });
        until("the apply holds its events", async || {
            waiting(&mut control).await == 1
        })
        .await;
        let settling = tokio::spawn({
            let (ledger, kept) = (ledger.clone(), kept.clone());
            async move { ledger.settle(&kept, "unsupported").await }
        });
        until("the settlement waits for the apply", async || {
            waiting(&mut control).await == 2
        })
        .await;
        control
            .execute("select pg_advisory_unlock(7)")
            .await
            .unwrap();
        let (applied, settled) = (applying.await.unwrap(), settling.await.unwrap());
        let outcomes: Vec<(String, Option<String>)> =
            sqlx::query_as("select notification_id, outcome from inbox")
                .fetch_all(&mut control)
                .await
                .unwrap();

        let Ok(Applied::Recorded { seqs, .. }) = applied else {
            panic!("the apply answered {applied:?}")
        };
        assert_eq!(seqs, [1, 2]);
        assert_eq!(settled, Ok(()));
        assert_eq!(
            outcomes,
            [("n-beside".to_owned(), Some("applied".to_owned()))]
        );
        ledger.close().await;
    })
    .await;
}

#[tokio::test]
#[cfg_attr(not(postgres_tests), ignore = "needs SUBSCRIPTIONS_TEST_DATABASE_URL")]
async fn a_notification_no_retry_can_apply_waits_behind_the_rest_and_is_settled_failed_at_its_fifth_attempt()
 {
    with_empty_database(async |url| {
        let ledger = Ledger::open(&url.parse().unwrap()).await.unwrap();
        let mut connection = PgConnection::connect(&url).await.unwrap();
        let Receipt::Kept(poisoned) = ledger
            .receive(notification(
                Store::AppStore,
                "a-poison",
                "a storefront Postgres refuses",
            ))
            .await
            .unwrap()
        else {
            panic!("the poisoned notification was not kept")
        };
        let Receipt::Kept(good) = ledger
            .receive(notification(Store::AppStore, "b-good", "a renewal"))
            .await
            .unwrap()
        else {
            panic!("the good notification was not kept")
        };
        let mut poison = renewal();
        poison.status.storefront = Some(Storefront::new("US\u{0}"));

        let first = ledger
            .apply_notification(&poisoned, observed(poison.clone()))
            .await;
        let waits_for: i64 = sqlx::query_scalar(
            "select next_attempt_at - now_millis() from inbox where notification_id = 'a-poison'",
        )
        .fetch_one(&mut connection)
        .await
        .unwrap();
        let head = ledger.unsettled(1).await.unwrap();
        let mut later = Vec::new();
        for _ in 0..4 {
            later.push(
                ledger
                    .apply_notification(&poisoned, observed(poison.clone()))
                    .await,
            );
        }
        let once_more = ledger
            .apply_notification(&poisoned, observed(poison.clone()))
            .await
            .unwrap();
        let rows: Vec<(String, i32, Option<String>)> = sqlx::query_as(
            "select notification_id, attempts, outcome from inbox order by notification_id",
        )
        .fetch_all(&mut connection)
        .await
        .unwrap();

        let refused = || -> Result<Applied, StorageError> {
            Err(StorageError::Database {
                sqlstate: Some("22021".to_owned()),
            })
        };
        assert_eq!(first, refused());
        assert!(
            (3_590_000..=3_600_000).contains(&waits_for),
            "waits {waits_for} ms"
        );
        assert_eq!(head, [good]);
        assert_eq!(later, (0..4).map(|_| refused()).collect::<Vec<_>>());
        assert_eq!(once_more, Applied::AlreadySettled);
        assert_eq!(
            rows,
            [
                ("a-poison".to_owned(), 5, Some("failed".to_owned())),
                ("b-good".to_owned(), 0, None),
            ]
        );
        ledger.close().await;
    })
    .await;
}

// Makes every transaction that appends an event wait, once it holds its seqs, for as long as the test holds the
// advisory lock 7. Returns holding it.
async fn hold_events(control: &mut PgConnection) {
    control
        .execute(
            "create function hold_events() returns trigger language plpgsql as $$ \
             begin perform pg_advisory_xact_lock_shared(7); return new; end $$; \
             create trigger hold_events before insert on events \
                 for each row execute function hold_events(); \
             select pg_advisory_lock(7);",
        )
        .await
        .unwrap();
}

// How many of the database's connections wait on a lock.
async fn waiting(control: &mut PgConnection) -> i64 {
    sqlx::query_scalar(
        "select count(*) from pg_stat_activity \
         where datname = current_database() and wait_event_type = 'Lock'",
    )
    .fetch_one(control)
    .await
    .unwrap()
}

async fn until(what: &str, mut ready: impl AsyncFnMut() -> bool) {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    while !ready().await {
        assert!(
            tokio::time::Instant::now() < deadline,
            "{what}: not within 10 s"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

fn notification(store: Store, id: &str, payload: &str) -> Notification {
    Notification {
        store,
        id: id.to_owned(),
        environment: Environment::Production,
        signed_payload: payload.to_owned(),
    }
}

fn observed(observation: Observation) -> Observed {
    Observed {
        observation,
        hint: None,
        claim: None,
        pulled_at: None,
    }
}

// A first month of Windmill One, active and renewing.
fn renewal() -> Observation {
    let start = Instant::from_epoch_millis(1_798_761_600_000);
    let end = Instant::from_epoch_millis(1_801_353_600_000);
    let price = Money::new("12.00", "USD").unwrap();
    Observation {
        lineage: Lineage {
            store: Store::AppStore,
            environment: Environment::Production,
            store_subscription_id: StoreSubscriptionId::new("2000000000000001"),
        },
        observed_at: start,
        ownership: Ownership::Purchased,
        status: Status {
            plan: Plan::WindmillOne,
            product_id: ProductId::new("works.windmill.app.one.monthly"),
            billing_interval: BillingInterval::new("P1M"),
            started_at: start,
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
            transaction: StoreTransactionId::new("2000000000000001"),
            span: Span { start, end },
            price,
            offer_kind: None,
            refunded_at: None,
        }],
    }
}
