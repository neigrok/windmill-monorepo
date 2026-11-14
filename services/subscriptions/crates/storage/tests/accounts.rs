use std::env;
use std::panic::{AssertUnwindSafe, resume_unwind};
use std::time::Duration;

use domain::{
    AccountEntitlement, AccountId, BillingInterval, Binding, BoundBy, Environment, Instant,
    Lineage, Money, NextCharge, Observation, ObservedPeriod, Ownership, PeriodChange, Plan,
    ProductId, Renewal, Span, State, Status, Store, StoreSubscriptionId, StoreTransactionId,
    Storefront, Subscription,
};
use futures_util::FutureExt;
use sqlx::{AssertSqlSafe, Connection, Executor, PgConnection};
use storage::{AccountRecord, Applied, Ledger, Observed, RecordedEvent, SubscriptionRecord};
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
async fn a_hint_naming_an_erased_account_binds_no_one() {
    with_empty_database(async |url| {
        let ledger = Ledger::open(&url.parse().unwrap()).await.unwrap();
        let (erased, live) = (Uuid::new_v4(), Uuid::new_v4());

        ledger.record_erasure(erased).await.unwrap();
        ledger.record_erasure(erased).await.unwrap();
        let from_the_erased = subscription_of(apply(&ledger, "from-erased", Some(erased)).await);
        let from_the_live = subscription_of(apply(&ledger, "from-live", Some(live)).await);

        let mut connection = PgConnection::connect(&url).await.unwrap();
        let tombstones: Vec<Uuid> = sqlx::query_scalar("select account_id from erased_accounts")
            .fetch_all(&mut connection)
            .await
            .unwrap();
        assert_eq!(tombstones, [erased]);
        assert_eq!(
            (from_the_erased.binding, from_the_live.binding.clone()),
            (
                None,
                Some(Binding {
                    account_id: AccountId::new(live.to_string()),
                    bound_at: Instant::from_epoch_millis(1_798_761_600_000),
                    bound_by: BoundBy::Purchase,
                })
            )
        );
        assert_eq!(
            ledger.entitlement(erased).await.unwrap(),
            AccountEntitlement::of(AccountId::new(erased.to_string()), Vec::new())
        );
        assert_eq!(
            ledger.entitlement(live).await.unwrap(),
            AccountEntitlement::of(AccountId::new(live.to_string()), vec![from_the_live])
        );
        ledger.close().await;
    })
    .await;
}

#[tokio::test(flavor = "multi_thread")]
#[cfg_attr(not(postgres_tests), ignore = "needs SUBSCRIPTIONS_TEST_DATABASE_URL")]
async fn an_erasure_waits_for_an_apply_that_binds_its_account() {
    with_empty_database(async |url| {
        let ledger = Ledger::open(&url.parse().unwrap()).await.unwrap();
        let mut control = PgConnection::connect(&url).await.unwrap();
        let account = Uuid::new_v4();
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

        let applying = tokio::spawn({
            let ledger = ledger.clone();
            async move { apply(&ledger, "binding", Some(account)).await }
        });
        until("the apply holds its events", async || {
            waiting(&mut control).await == 1
        })
        .await;
        let erasing = tokio::spawn({
            let ledger = ledger.clone();
            async move { ledger.record_erasure(account).await }
        });
        until("the erasure waits or commits", async || {
            erasing.is_finished() || waiting(&mut control).await == 2
        })
        .await;
        let erased_while_applying: i64 = sqlx::query_scalar("select count(*) from erased_accounts")
            .fetch_one(&mut control)
            .await
            .unwrap();
        control
            .execute("select pg_advisory_unlock(7)")
            .await
            .unwrap();
        let bound = subscription_of(applying.await.unwrap());
        erasing.await.unwrap().unwrap();
        let erased_after: i64 = sqlx::query_scalar("select count(*) from erased_accounts")
            .fetch_one(&mut control)
            .await
            .unwrap();

        assert_eq!((erased_while_applying, erased_after), (0, 1));
        assert_eq!(
            bound.binding.map(|binding| binding.account_id),
            Some(AccountId::new(account.to_string()))
        );
        ledger.close().await;
    })
    .await;
}

#[tokio::test]
#[cfg_attr(not(postgres_tests), ignore = "needs SUBSCRIPTIONS_TEST_DATABASE_URL")]
async fn an_account_read_holds_each_subscription_bound_to_it_with_its_periods_and_events() {
    with_empty_database(async |url| {
        let ledger = Ledger::open(&url.parse().unwrap()).await.unwrap();
        let (account, another) = (Uuid::new_v4(), Uuid::new_v4());
        let mut bought = Vec::new();
        for (lineage, hint) in [
            ("first", Some(account)),
            ("theirs", Some(another)),
            ("unbound", None),
            ("second", Some(account)),
        ] {
            bought.push(apply(&ledger, lineage, hint).await);
        }
        let recorded_at: Vec<Instant> = ledger
            .feed(0, 100)
            .await
            .unwrap()
            .entries
            .iter()
            .map(|entry| entry.recorded_at)
            .collect();

        let read = ledger.account(account).await.unwrap();

        let mut held: Vec<SubscriptionRecord> = [&bought[0], &bought[3]]
            .into_iter()
            .map(|applied| {
                let Applied::Recorded { change, seqs, .. } = applied else {
                    panic!("the apply answered {applied:?}");
                };
                SubscriptionRecord {
                    subscription: change.subscription.clone(),
                    periods: change
                        .periods
                        .iter()
                        .map(|written| match written {
                            PeriodChange::Written(period) => period.clone(),
                            PeriodChange::Restated(period) => {
                                panic!("a purchase restated {period:?}")
                            }
                        })
                        .collect(),
                    events: seqs
                        .iter()
                        .zip(&change.events)
                        .map(|(seq, event)| RecordedEvent {
                            seq: *seq,
                            recorded_at: recorded_at[*seq as usize - 1],
                            event: event.clone(),
                        })
                        .collect(),
                }
            })
            .collect();
        held.sort_by(|one, other| one.subscription.id.cmp(&other.subscription.id));
        assert_eq!(
            read,
            AccountRecord {
                entitlement: AccountEntitlement::of(
                    AccountId::new(account.to_string()),
                    held.iter()
                        .map(|record| record.subscription.clone())
                        .collect(),
                ),
                subscriptions: held,
            }
        );
        assert_eq!(
            ledger.account(Uuid::new_v4()).await.unwrap().subscriptions,
            Vec::new()
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

async fn apply(ledger: &Ledger, lineage: &str, hint: Option<Uuid>) -> Applied {
    ledger
        .apply(Observed {
            observation: purchase(lineage),
            hint,
            claim: None,
            pulled_at: None,
        })
        .await
        .unwrap()
}

fn subscription_of(applied: Applied) -> Subscription {
    match applied {
        Applied::Recorded { change, .. } => change.subscription,
        other => panic!("the apply answered {other:?}"),
    }
}

// A first month of Windmill One, bought by its owner.
fn purchase(lineage: &str) -> Observation {
    let start = Instant::from_epoch_millis(1_798_761_600_000);
    let end = Instant::from_epoch_millis(1_801_353_600_000);
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
    }
}
