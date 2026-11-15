use std::env;
use std::panic::{AssertUnwindSafe, resume_unwind};
use std::pin::Pin;
use std::time::Duration;

use domain::{
    AccountEntitlement, AccountId, BillingInterval, Binding, BoundBy, EndReason, Ending,
    Environment, Instant, LeftWith, Lineage, Money, NextCharge, Observation, ObservedPeriod,
    Ownership, PeriodChange, Plan, ProductId, Renewal, Span, State, Status, Store,
    StoreSubscriptionId, StoreTransactionId, Storefront, Subscription,
};
use futures_util::FutureExt;
use sqlx::{AssertSqlSafe, Connection, Executor, PgConnection};
use storage::{
    AccountClaim, AccountRecord, Applied, ErasedLineage, Erasure, Ledger, Observed, RecordedEvent,
    StorageError, SubscriptionRecord,
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
async fn a_hint_naming_an_erased_account_binds_no_one() {
    with_empty_database(async |url| {
        let ledger = Ledger::open(&url.parse().unwrap()).await.unwrap();
        let (erased, live) = (Uuid::new_v4(), Uuid::new_v4());

        let first = ledger.erase_account(erased).await.unwrap();
        let again = ledger.erase_account(erased).await.unwrap();
        let from_the_erased = subscription_of(apply(&ledger, "from-erased", Some(erased)).await);
        let from_the_live = subscription_of(apply(&ledger, "from-live", Some(live)).await);

        let mut connection = PgConnection::connect(&url).await.unwrap();
        let tombstones: Vec<Uuid> = sqlx::query_scalar("select account_id from erased_accounts")
            .fetch_all(&mut connection)
            .await
            .unwrap();
        assert_eq!(tombstones, [erased]);
        assert_eq!(
            again,
            Erasure {
                newly_erased: false,
                ..first.clone()
            }
        );
        assert_eq!(
            (first.newly_erased, first.lineages, first.hints_dropped),
            (true, Vec::new(), 0)
        );
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
async fn an_erasure_waits_for_an_apply_that_binds_its_account_then_unbinds_what_it_bound() {
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
            async move { ledger.erase_account(account).await }
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
        let erasure = erasing.await.unwrap().unwrap();
        let erased_after: i64 = sqlx::query_scalar("select count(*) from erased_accounts")
            .fetch_one(&mut control)
            .await
            .unwrap();

        assert_eq!((erased_while_applying, erased_after), (0, 1));
        assert_eq!(
            bound.binding.as_ref().map(|binding| &binding.account_id),
            Some(&AccountId::new(account.to_string()))
        );
        let unbound: Vec<Option<AccountId>> = erasure
            .lineages
            .iter()
            .map(|lineage| lineage.change.subscription.account_id().cloned())
            .collect();
        assert_eq!(unbound, [None]);
        assert_eq!(
            ledger.entitlement(account).await.unwrap(),
            AccountEntitlement::of(AccountId::new(account.to_string()), Vec::new())
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

#[tokio::test]
#[cfg_attr(not(postgres_tests), ignore = "needs SUBSCRIPTIONS_TEST_DATABASE_URL")]
async fn an_erasure_unbinds_the_account_s_subscriptions_drops_its_owed_hints_and_tells_the_feed() {
    with_empty_database(async |url| {
        let ledger = Ledger::open(&url.parse().unwrap()).await.unwrap();
        let (account, another) = (Uuid::new_v4(), Uuid::new_v4());
        apply(&ledger, "bought", Some(account)).await;
        apply(&ledger, "theirs", Some(another)).await;
        apply(&ledger, "claimed", None).await;
        let claimed = ledger
            .apply(Observed {
                observation: purchase("claimed"),
                hint: None,
                claim: Some(AccountClaim {
                    account_id: account,
                    at: Instant::from_epoch_millis(1_798_765_200_000),
                }),
                pulled_at: None,
            })
            .await
            .unwrap();
        let owed_before = ledger.store_hints(10).await.unwrap().len();
        let newest_before = ledger.feed(0, 500).await.unwrap().latest_seq;

        let erasure = ledger.erase_account(account).await.unwrap();

        let erased = AccountId::new(account.to_string());
        let mut lineages: Vec<&str> = erasure
            .lineages
            .iter()
            .map(|ErasedLineage { change, .. }| {
                change.subscription.lineage.store_subscription_id.as_str()
            })
            .collect();
        lineages.sort_unstable();
        assert_eq!(lineages, ["bought", "claimed"]);
        assert_eq!((owed_before, erasure.hints_dropped), (1, 1));
        assert_eq!(ledger.store_hints(10).await.unwrap(), Vec::new());
        let told = ledger.feed(newest_before, 500).await.unwrap().entries;
        let told: Vec<_> = told
            .iter()
            .map(|entry| {
                (
                    entry.event.kind.name(),
                    entry.event.account_id.clone(),
                    entry.event.occurred_at,
                    entry.entitlement.clone(),
                )
            })
            .collect();
        let unbound = (
            "unbound",
            Some(erased.clone()),
            erasure.erased_at,
            Some(AccountEntitlement::of(erased.clone(), Vec::new())),
        );
        assert_eq!(told, [unbound.clone(), unbound]);
        let Applied::Recorded { change, .. } = claimed else {
            panic!("the claim answered {claimed:?}");
        };
        for lineage in ["bought", "claimed"] {
            let held = ledger
                .lineage(&Lineage {
                    store: Store::AppStore,
                    environment: Environment::Production,
                    store_subscription_id: StoreSubscriptionId::new(lineage),
                })
                .await
                .unwrap();
            assert_eq!(held.subscription.unwrap().binding, None, "{lineage}");
            let left_with: Vec<_> = held
                .periods
                .iter()
                .map(|period| period.left_with.clone())
                .collect();
            assert_eq!(left_with, [Some(LeftWith::NoOne)], "{lineage}");
        }
        assert_eq!(
            ledger
                .entitlement(another)
                .await
                .unwrap()
                .production
                .governing
                .map(|governing| governing.lineage),
            Some(Lineage {
                store: Store::AppStore,
                environment: Environment::Production,
                store_subscription_id: StoreSubscriptionId::new("theirs"),
            })
        );
        assert_eq!(change.hint_for_store, Some(erased));
        ledger.close().await;
    })
    .await;
}

// Every writer at once, round after round of fresh accounts: each erasure twice over, a renewal naming the erased
// account, a claim by it and one by a third over its subscription, a purchase moving a lineage to it and one moving a
// lineage it paid for away, the hint sweep's statements and a feed read. No write fails, none deadlocks, nothing stays
// bound to or left with an erased account or owed to a store for it, and no event names it after its last `unbound`.
#[tokio::test(flavor = "multi_thread", worker_threads = 8)]
#[cfg_attr(not(postgres_tests), ignore = "needs SUBSCRIPTIONS_TEST_DATABASE_URL")]
async fn every_writer_beside_erasures_at_once_never_deadlocks_and_leaves_nothing_of_the_erased() {
    with_empty_database(async |url| {
        let ledger = Ledger::open(&url.parse().unwrap()).await.unwrap();
        let mut control = PgConnection::connect(&url).await.unwrap();
        let mut failures: Vec<String> = Vec::new();
        for round in 0..20 {
            let (a, b, c) = (Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4());
            let (own, moved, open, cross) = (
                format!("own{round}"),
                format!("moved{round}"),
                format!("open{round}"),
                format!("cross{round}"),
            );
            put(&ledger, months(&own, T0, 1, false, &[1]), Some(a), None).await.unwrap();
            put(&ledger, months(&open, T0, 1, false, &[1]), None, None).await.unwrap();
            put(&ledger, months(&cross, T0, 1, false, &[1]), Some(b), None).await.unwrap();
            put(&ledger, months(&cross, T0 + 30 * DAY, 1, true, &[1]), Some(b), None).await.unwrap();
            put(&ledger, months(&moved, T0, 1, false, &[1]), Some(a), None).await.unwrap();
            put(&ledger, months(&moved, T0 + 30 * DAY, 1, true, &[1]), Some(a), None).await.unwrap();
            type Write = Pin<Box<dyn Future<Output = Result<(), StorageError>> + Send>>;
            let applied = |write: Pin<Box<dyn Future<Output = Result<Applied, StorageError>> + Send>>| -> Write {
                Box::pin(async move { write.await.map(|_| ()) })
            };
            let mut writes: Vec<(&str, Write)> = Vec::new();
            for _ in 0..2 {
                let ledger = ledger.clone();
                writes.push(("erase a", Box::pin(async move { ledger.erase_account(a).await.map(|_| ()) })));
            }
            let erasing_b = ledger.clone();
            writes.push(("erase b", Box::pin(async move { erasing_b.erase_account(b).await.map(|_| ()) })));
            for (label, observation, hint, claim) in [
                ("renew own", months(&own, T0 + 30 * DAY, 2, false, &[1, 2]), Some(a), None),
                ("claim open by a", months(&open, T0 + DAY, 1, false, &[1]), None, Some(a)),
                ("claim own by c", months(&own, T0 + 2 * DAY, 1, false, &[1]), Some(a), Some(c)),
                ("rebuy cross by a", months(&cross, T0 + 60 * DAY, 3, false, &[1, 3]), Some(a), None),
                ("rebuy moved by b", months(&moved, T0 + 60 * DAY, 3, false, &[1, 3]), Some(b), None),
            ] {
                let ledger = ledger.clone();
                writes.push((label, applied(Box::pin(async move { put(&ledger, observation, hint, claim).await }))));
            }
            let hints = ledger.clone();
            writes.push((
                "hints",
                Box::pin(async move {
                    hints.forget_stale_store_hints().await?;
                    for hint in hints.store_hints(100).await? {
                        hints.clear_store_hint(&hint).await?;
                    }
                    Ok(())
                }),
            ));
            let reader = ledger.clone();
            writes.push(("feed", Box::pin(async move { reader.feed(0, 500).await.map(|_| ()) })));
            let running: Vec<_> = writes
                .into_iter()
                .map(|(label, write)| tokio::spawn(async move { (label, write.await) }))
                .collect();
            for task in running {
                let (label, written) = task.await.unwrap();
                if let Err(failure) = written {
                    failures.push(format!("round {round} {label}: {} {:?}", failure.code(), failure.sqlstate()));
                }
            }
            for (who, account) in [("a", a), ("b", b)] {
                let held: i64 = sqlx::query_scalar(
                    "select (select count(*) from subscriptions where account_id = $1) \
                     + (select count(*) from periods where left_with = $1) \
                     + (select count(*) from store_hints where account_id = $1)",
                )
                .bind(account)
                .fetch_one(&mut control)
                .await
                .unwrap();
                if held != 0 {
                    failures.push(format!("round {round}: {held} rows still hold {who}"));
                }
            }
            let told_after_unbound: i64 = sqlx::query_scalar(
                "select count(*) from events where (account_id = $1 or period_left_with = $1) \
                 and seq > (select max(seq) from events where type = 'unbound' and account_id = $1)",
            )
            .bind(a)
            .fetch_one(&mut control)
            .await
            .unwrap();
            if told_after_unbound != 0 {
                failures.push(format!("round {round}: {told_after_unbound} events name a after its unbound"));
            }
        }
        assert_eq!(failures, Vec::<String>::new());
        ledger.close().await;
    })
    .await;
}

// The ledger holds data written before migration 0008 existed: a ledger migrated in full is written to, 0008 taken out
// and the ledger opened again, which applies 0008 over the data; the erasure then leaves the account nothing.
#[tokio::test]
#[cfg_attr(not(postgres_tests), ignore = "needs SUBSCRIPTIONS_TEST_DATABASE_URL")]
async fn an_erasure_over_a_ledger_that_held_data_before_periods_could_stay_with_no_one_leaves_the_account_nothing()
 {
    with_empty_database(async |url| {
        let ledger = Ledger::open(&url.parse().unwrap()).await.unwrap();
        let (account, payer) = (Uuid::new_v4(), Uuid::new_v4());
        for lineage in 0..20 {
            put(
                &ledger,
                months(&format!("own{lineage:02}"), T0, 2, false, &[1, 2]),
                Some(account),
                None,
            )
            .await
            .unwrap();
        }
        put(
            &ledger,
            months("moved", T0, 1, false, &[1]),
            Some(account),
            None,
        )
        .await
        .unwrap();
        put(
            &ledger,
            months("moved", T0 + 30 * DAY, 1, true, &[1]),
            Some(account),
            None,
        )
        .await
        .unwrap();
        put(
            &ledger,
            months("moved", T0 + 60 * DAY, 3, false, &[1, 3]),
            Some(payer),
            None,
        )
        .await
        .unwrap();
        ledger.close().await;
        let mut control = PgConnection::connect(&url).await.unwrap();
        control
            .execute(
                "alter table periods drop column left_with_no_one; \
                 alter table events drop column period_left_with_no_one; \
                 drop index periods_left_with; \
                 delete from _sqlx_migrations where version = 8",
            )
            .await
            .unwrap();
        let rows = "select (select count(*) from periods), (select count(*) from events)";
        let before: (i64, i64) = sqlx::query_as(rows).fetch_one(&mut control).await.unwrap();

        let ledger = Ledger::open(&url.parse().unwrap()).await.unwrap();
        let after: (i64, i64) = sqlx::query_as(rows).fetch_one(&mut control).await.unwrap();
        let flagged: i64 = sqlx::query_scalar(
            "select (select count(*) from periods where left_with_no_one) \
             + (select count(*) from events where period_left_with_no_one)",
        )
        .fetch_one(&mut control)
        .await
        .unwrap();
        let erasure = ledger.erase_account(account).await.unwrap();
        let held: i64 = sqlx::query_scalar(
            "select (select count(*) from subscriptions where account_id = $1) \
             + (select count(*) from periods where left_with = $1)",
        )
        .bind(account)
        .fetch_one(&mut control)
        .await
        .unwrap();
        let with_no_one: i64 =
            sqlx::query_scalar("select count(*) from periods where left_with_no_one")
                .fetch_one(&mut control)
                .await
                .unwrap();

        assert_eq!((before, flagged), (after, 0));
        assert_eq!((erasure.lineages.len(), held, with_no_one), (21, 0, 41));
        ledger.close().await;
    })
    .await;
}

const DAY: i64 = 86_400_000;
const T0: i64 = 1_798_761_600_000;

// A lineage's statement with the period in force as the `current`-th month, ended or not, stating the months `listed`.
fn months(lineage: &str, observed: i64, current: i64, ended: bool, listed: &[i64]) -> Observation {
    let price = Money::new("12.00", "USD").unwrap();
    let month = |n: i64| Span {
        start: Instant::from_epoch_millis(T0 + (n - 1) * 30 * DAY),
        end: Instant::from_epoch_millis(T0 + n * 30 * DAY),
    };
    let in_force = month(current);
    let state = if ended {
        State::Expired(Ending {
            at: in_force.end,
            reason: EndReason::Cancelled,
        })
    } else {
        State::Active {
            pause_scheduled_for: None,
        }
    };
    Observation {
        lineage: Lineage {
            store: Store::AppStore,
            environment: Environment::Production,
            store_subscription_id: StoreSubscriptionId::new(lineage),
        },
        observed_at: Instant::from_epoch_millis(observed),
        ownership: Ownership::Purchased,
        status: Status {
            plan: Plan::WindmillOne,
            product_id: ProductId::new("works.windmill.app.one.monthly"),
            billing_interval: BillingInterval::new("P1M"),
            started_at: Instant::from_epoch_millis(T0),
            state,
            current_period: in_force,
            renewal: Renewal {
                auto_renew: !ended,
                next_charge: (!ended).then(|| NextCharge {
                    at: in_force.end,
                    price: price.clone(),
                }),
                next_product_id: None,
                cancel_requested_at: None,
            },
            offer: None,
            price: price.clone(),
            storefront: Some(Storefront::new("USA")),
        },
        periods: listed
            .iter()
            .map(|&n| ObservedPeriod {
                transaction: StoreTransactionId::new(format!("{lineage}-{n}")),
                span: month(n),
                price: price.clone(),
                offer_kind: None,
                refunded_at: None,
            })
            .collect(),
    }
}

async fn put(
    ledger: &Ledger,
    observation: Observation,
    hint: Option<Uuid>,
    claim: Option<Uuid>,
) -> Result<Applied, StorageError> {
    let at = observation.observed_at;
    ledger
        .apply(Observed {
            observation,
            hint,
            claim: claim.map(|account_id| AccountClaim { account_id, at }),
            pulled_at: None,
        })
        .await
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
