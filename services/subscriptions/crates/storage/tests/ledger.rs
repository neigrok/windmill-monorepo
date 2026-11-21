use std::env;
use std::panic::{AssertUnwindSafe, resume_unwind};
use std::time::{Duration, Instant as Clock};

use domain::{
    BillingInterval, Environment, Instant, Lineage, Money, NextCharge, Observation, ObservedPeriod,
    Ownership, Plan, ProductId, Renewal, Span, State, Status, Store, StoreSubscriptionId,
    StoreTransactionId, Storefront,
};
use futures_util::FutureExt;
use sqlx::{AssertSqlSafe, Connection, Executor, PgConnection};
use storage::{
    AccountClaim, Applied, DatabaseUrl, Ledger, MalformedDatabaseUrl, Observed, StorageError,
};
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
async fn an_empty_database_is_migrated_and_given_one_epoch_that_opening_again_keeps() {
    with_empty_database(async |url| {
        let first = Ledger::open(&url.parse().unwrap()).await.unwrap();
        let epoch = first.epoch().await.unwrap();
        first.close().await;

        let again = Ledger::open(&url.parse().unwrap()).await.unwrap();

        assert_eq!(again.epoch().await.unwrap(), epoch);
        assert_eq!(epoch.get_version_num(), 4);
        let mut connection = PgConnection::connect(&url).await.unwrap();
        let migrations: Vec<(i64, String, bool)> = sqlx::query_as(
            "select version, description, success from _sqlx_migrations order by version",
        )
        .fetch_all(&mut connection)
        .await
        .unwrap();
        assert_eq!(
            migrations,
            [
                (1, "ledger".to_owned(), true),
                (2, "inbox".to_owned(), true),
                (3, "subscriptions".to_owned(), true),
                (4, "events".to_owned(), true),
                (5, "erased accounts".to_owned(), true),
                (6, "store hints".to_owned(), true),
                (7, "store hint attempts".to_owned(), true),
                (8, "left with no one".to_owned(), true),
            ]
        );
        let second_row = connection
            .execute("insert into ledger (epoch) values (gen_random_uuid())")
            .await
            .unwrap_err();
        let not_the_one_row = connection
            .execute("insert into ledger (one_row, epoch) values (false, gen_random_uuid())")
            .await
            .unwrap_err();
        assert_eq!(
            [
                StorageError::from(second_row),
                StorageError::from(not_the_one_row)
            ],
            [
                StorageError::Database {
                    sqlstate: Some("23505".to_owned())
                },
                StorageError::Database {
                    sqlstate: Some("23514".to_owned())
                },
            ]
        );
    })
    .await;
}

#[tokio::test]
#[cfg_attr(not(postgres_tests), ignore = "needs SUBSCRIPTIONS_TEST_DATABASE_URL")]
async fn a_database_whose_migrations_are_not_this_build_s_is_refused() {
    with_empty_database(async |url| {
        Ledger::open(&url.parse().unwrap())
            .await
            .unwrap()
            .close()
            .await;
        let mut connection = PgConnection::connect(&url).await.unwrap();
        connection
            .execute(
                "insert into _sqlx_migrations (version, description, success, checksum, \
                 execution_time) values (9999, 'from a newer build', true, '\\x00', 0)",
            )
            .await
            .unwrap();
        let newer = Ledger::open(&url.parse().unwrap()).await.err().unwrap();
        connection
            .execute(
                "delete from _sqlx_migrations where version = 9999; \
                 update _sqlx_migrations set checksum = '\\x00' where version = 1",
            )
            .await
            .unwrap();

        let edited = Ledger::open(&url.parse().unwrap()).await.err().unwrap();

        assert_eq!(
            [newer, edited],
            [
                StorageError::Migration { sqlstate: None },
                StorageError::Migration { sqlstate: None }
            ]
        );
    })
    .await;
}

#[tokio::test]
#[cfg_attr(not(postgres_tests), ignore = "needs SUBSCRIPTIONS_TEST_DATABASE_URL")]
async fn a_ledger_answers_its_check_until_it_is_closed() {
    with_empty_database(async |url| {
        let ledger = Ledger::open(&url.parse().unwrap()).await.unwrap();
        let open = ledger.check().await;
        ledger.close().await;

        assert_eq!(
            [open, ledger.check().await],
            [Ok(()), Err(StorageError::Unreachable)]
        );
    })
    .await;
}

#[tokio::test(flavor = "multi_thread")]
#[cfg_attr(not(postgres_tests), ignore = "needs SUBSCRIPTIONS_TEST_DATABASE_URL")]
async fn a_write_runs_read_committed_whatever_the_database_s_default() {
    with_empty_database(async |url| {
        let mut control = PgConnection::connect(&url).await.unwrap();
        let name = Url::parse(&url)
            .unwrap()
            .path()
            .trim_start_matches('/')
            .to_owned();
        control
            .execute(AssertSqlSafe(format!(
                "alter database {name} set default_transaction_isolation = 'repeatable read'"
            )))
            .await
            .unwrap();
        let ledger = Ledger::open(&url.parse().unwrap()).await.unwrap();
        let mut holder = PgConnection::connect(&url).await.unwrap();
        holder
            .execute("begin; select latest_seq from ledger for update")
            .await
            .unwrap();

        let writer = tokio::spawn({
            let ledger = ledger.clone();
            async move { ledger.apply(purchase("after the holder")).await }
        });
        until("the writer waits for the seq lock", async || {
            waiting(&mut control).await == 1
        })
        .await;
        holder
            .execute("update ledger set latest_seq = latest_seq + 1; commit")
            .await
            .unwrap();
        let written = within("the writer's answer", writer).await.unwrap();

        let Ok(Applied::Recorded { seqs, .. }) = written else {
            panic!("under a repeatable read default the writer answered {written:?}")
        };
        assert_eq!(seqs, [2, 3]);
        ledger.close().await;
    })
    .await;
}

#[tokio::test(flavor = "multi_thread")]
#[cfg_attr(not(postgres_tests), ignore = "needs SUBSCRIPTIONS_TEST_DATABASE_URL")]
async fn a_stalled_seq_lock_costs_its_writers_a_busy_answer_and_never_the_health_check() {
    with_empty_database(async |url| {
        let ledger = Ledger::open(&url.parse().unwrap()).await.unwrap();
        let mut control = PgConnection::connect(&url).await.unwrap();
        let mut holder = PgConnection::connect(&url).await.unwrap();
        holder
            .execute("begin; select latest_seq from ledger for update")
            .await
            .unwrap();

        let writers: Vec<_> = (0..8)
            .map(|index| {
                let ledger = ledger.clone();
                tokio::spawn(async move { ledger.apply(purchase(&format!("w{index}"))).await })
            })
            .collect();
        until(
            "every connection of the pool waits for the seq lock",
            async || waiting(&mut control).await == 8,
        )
        .await;
        let check = within("the health check", ledger.check()).await;
        let ninth = within("a ninth write", ledger.apply(purchase("w9"))).await;
        let mut answers = Vec::new();
        for writer in writers {
            answers.push(within("a stalled writer's answer", writer).await.unwrap());
        }
        holder.execute("rollback").await.unwrap();

        assert_eq!(check, Ok(()));
        assert_eq!(ninth, Err(StorageError::Busy));
        assert_eq!(
            answers,
            (0..8).map(|_| Err(StorageError::Busy)).collect::<Vec<_>>()
        );
        ledger.close().await;
    })
    .await;
}

#[tokio::test(flavor = "multi_thread")]
#[cfg_attr(not(postgres_tests), ignore = "needs SUBSCRIPTIONS_TEST_DATABASE_URL")]
async fn writes_behind_a_stalled_store_hint_row_each_answer_busy_within_five_seconds() {
    with_empty_database(async |url| {
        let ledger = Ledger::open(&url.parse().unwrap()).await.unwrap();
        let claimant = Uuid::new_v4();
        ledger.apply(purchase("claimed")).await.unwrap();
        ledger
            .apply(Observed {
                claim: Some(AccountClaim {
                    account_id: claimant,
                    at: Instant::from_epoch_millis(1_798_765_200_000),
                }),
                ..purchase("claimed")
            })
            .await
            .unwrap();
        let owed = ledger.store_hints(10).await.unwrap();
        assert_eq!(owed.len(), 1);
        let mut control = PgConnection::connect(&url).await.unwrap();
        let mut holder = PgConnection::connect(&url).await.unwrap();
        holder
            .execute("begin; select * from store_hints for update")
            .await
            .unwrap();

        let clearing = tokio::spawn({
            let (ledger, hint) = (ledger.clone(), owed[0].clone());
            async move {
                let started = Clock::now();
                (ledger.clear_store_hint(&hint).await, started.elapsed())
            }
        });
        until("the clear waits behind the stalled row", async || {
            waiting(&mut control).await == 1
        })
        .await;
        tokio::time::sleep(Duration::from_millis(50)).await;
        let erasing = tokio::spawn({
            let ledger = ledger.clone();
            async move {
                let started = Clock::now();
                (ledger.erase_account(claimant).await, started.elapsed())
            }
        });
        let (cleared, cleared_in) = within("the clear's answer", clearing).await.unwrap();
        let (erased, erased_in) = within("the erasure's answer", erasing).await.unwrap();
        holder.execute("rollback").await.unwrap();
        let left: (i64, i64, i64) = sqlx::query_as(
            "select (select count(*) from erased_accounts), (select count(*) from events), \
             (select count(*) from store_hints)",
        )
        .fetch_one(&mut control)
        .await
        .unwrap();

        assert_eq!(cleared, Err(StorageError::Busy));
        assert_eq!(erased, Err(StorageError::Busy));
        assert!(cleared_in < Duration::from_millis(5500), "{cleared_in:?}");
        assert!(erased_in < Duration::from_millis(5500), "{erased_in:?}");
        assert_eq!(left, (0, 4, 1));
        ledger.close().await;
    })
    .await;
}

#[tokio::test(flavor = "multi_thread")]
#[cfg_attr(not(postgres_tests), ignore = "needs SUBSCRIPTIONS_TEST_DATABASE_URL")]
async fn a_write_that_waited_already_waits_for_a_lock_only_what_is_left_of_its_five_seconds() {
    with_empty_database(async |url| {
        let ledger = Ledger::open(&url.parse().unwrap()).await.unwrap();
        let mut control = PgConnection::connect(&url).await.unwrap();
        // A period waits to be written for as long as the test holds the advisory lock 7.
        control
            .execute(
                "create function hold_periods() returns trigger language plpgsql as $$ \
                 begin perform pg_advisory_xact_lock_shared(7); return new; end $$; \
                 create trigger hold_periods before insert on periods \
                     for each row execute function hold_periods(); \
                 select pg_advisory_lock(7);",
            )
            .await
            .unwrap();
        let mut holder = PgConnection::connect(&url).await.unwrap();
        holder
            .execute("begin; select latest_seq from ledger for update")
            .await
            .unwrap();

        let writer = tokio::spawn({
            let ledger = ledger.clone();
            async move { ledger.apply(purchase("w")).await }
        });
        until("the writer waits to write its period", async || {
            waiting(&mut control).await == 1
        })
        .await;
        tokio::time::sleep(Duration::from_secs(3)).await;
        control
            .execute("select pg_advisory_unlock(7)")
            .await
            .unwrap();
        let answer = tokio::time::timeout(Duration::from_millis(3500), writer).await;
        holder.execute("rollback").await.unwrap();

        assert_eq!(
            answer
                .expect("the writer waited for the seq lock past what was left of its 5 s")
                .unwrap(),
            Err(StorageError::Busy)
        );
        ledger.close().await;
    })
    .await;
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

async fn within<T>(what: &str, answer: impl Future<Output = T>) -> T {
    tokio::time::timeout(Duration::from_secs(20), answer)
        .await
        .unwrap_or_else(|_| panic!("{what}: not within 20 s"))
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

// A first month of Windmill One, bought with no hint.
fn purchase(lineage: &str) -> Observed {
    let start = Instant::from_epoch_millis(1_798_761_600_000);
    let end = Instant::from_epoch_millis(1_801_353_600_000);
    let price = Money::new("12.00", "USD").unwrap();
    let observation = Observation {
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
            transaction: StoreTransactionId::new(format!("{lineage}-1")),
            span: Span { start, end },
            price,
            offer_kind: None,
            refunded_at: None,
        }],
    };
    Observed {
        observation,
        hint: None,
        claim: None,
        pulled_at: None,
    }
}

#[test]
fn a_database_url_is_postgres_and_carries_no_parameter_that_could_be_logged() {
    for accepted in [
        "postgresql://windmill_subscriptions:secret-password@db:5432/windmill_subscriptions",
        "postgres://ledger@localhost/ledger?sslmode=require&port=5433",
        "postgresql:///windmill_subscriptions?host=/tmp&user=windmill_subscriptions",
        "postgresql:///?host=/tmp&dbname=windmill_subscriptions",
    ] {
        assert!(accepted.parse::<DatabaseUrl>().is_ok(), "{accepted}");
    }
    for refused in [
        "",
        "db:5432/windmill_subscriptions",
        "mysql://ledger:secret-password@db/ledger",
        "postgresql://ledger@db/ledger?passwrod=secret-password",
        "postgresql://ledger@db/ledger?sslmode=sometimes",
    ] {
        assert_eq!(
            refused.parse::<DatabaseUrl>(),
            Err(MalformedDatabaseUrl),
            "{refused}"
        );
    }
}

#[test]
fn a_database_url_never_prints_its_password() {
    let url: DatabaseUrl = "postgresql://ledger:secret-password@db/ledger"
        .parse()
        .unwrap();

    assert_eq!(format!("{url:?}"), "DatabaseUrl(..)");
}
