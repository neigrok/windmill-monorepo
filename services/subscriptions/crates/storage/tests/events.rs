use std::collections::HashMap;
use std::env;
use std::panic::{AssertUnwindSafe, resume_unwind};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use domain::{
    AccountEntitlement, AccountId, BillingInterval, EndReason, Ending, Environment, Instant,
    Lineage, Money, NextCharge, Observation, ObservedPeriod, Ownership, Plan, ProductId, Renewal,
    Span, State, Status, Store, StoreSubscriptionId, StoreTransactionId, Storefront, Subscription,
    SubscriptionId,
};
use futures_util::FutureExt;
use sqlx::{AssertSqlSafe, Connection, Executor, PgConnection};
use storage::{Applied, FeedEntry, Ledger, Observed};
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

#[tokio::test(flavor = "multi_thread")]
#[cfg_attr(not(postgres_tests), ignore = "needs SUBSCRIPTIONS_TEST_DATABASE_URL")]
async fn a_transaction_holding_seqs_holds_back_every_later_one() {
    with_empty_database(async |url| {
        let ledger = Ledger::open(&url.parse().unwrap()).await.unwrap();
        let mut control = PgConnection::connect(&url).await.unwrap();
        hold_events_of(&mut control, "held").await;

        let held = tokio::spawn(apply(ledger.clone(), renewing("held", 0), None));
        until("the held transaction waits", async || {
            waiting(&mut control).await == 1
        })
        .await;
        let later = tokio::spawn(apply(ledger.clone(), renewing("later", 0), None));
        until("the later transaction waits or commits", async || {
            later.is_finished() || waiting(&mut control).await == 2
        })
        .await;
        let while_held = ledger.feed(0, 100).await.unwrap();
        control
            .execute("select pg_advisory_unlock(7)")
            .await
            .unwrap();
        let (held, later) = (seqs_of(held.await.unwrap()), seqs_of(later.await.unwrap()));
        let after = ledger.feed(0, 100).await.unwrap();

        assert_eq!(
            (while_held.latest_seq, seqs(&while_held.entries)),
            (0, Vec::new())
        );
        assert_eq!((held, later), (vec![1, 2], vec![3, 4]));
        assert_eq!(
            (after.latest_seq, seqs(&after.entries)),
            (4, vec![1, 2, 3, 4])
        );
        ledger.close().await;
    })
    .await;
}

#[tokio::test(flavor = "multi_thread")]
#[cfg_attr(not(postgres_tests), ignore = "needs SUBSCRIPTIONS_TEST_DATABASE_URL")]
async fn concurrent_applies_record_every_event_once_in_commit_order() {
    with_empty_database(async |url| {
        let ledger = Ledger::open(&url.parse().unwrap()).await.unwrap();
        let accounts = [Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4()];
        let lineages = ["a", "b", "c", "d", "e", "f"];
        let applied = Arc::new(AtomicBool::new(false));
        let reader = tokio::spawn({
            let (ledger, applied) = (ledger.clone(), applied.clone());
            async move {
                let mut reads = Vec::new();
                while !applied.load(Ordering::Acquire) {
                    reads.push(seqs(&ledger.feed(0, 1000).await.unwrap().entries));
                }
                reads
            }
        });
        let mut applies = Vec::new();
        for month in [3, 0, 4, 1, 2] {
            for (index, lineage) in lineages.iter().enumerate() {
                let observation = renewing(lineage, month);
                let hint = Some(accounts[index % accounts.len()]);
                applies.push(tokio::spawn(apply(ledger.clone(), observation, hint)));
            }
        }
        let mut recorded = Vec::new();
        for apply in applies {
            match tokio::time::timeout(Duration::from_secs(30), apply).await {
                Ok(Ok(Applied::Recorded { change, seqs, .. })) => recorded.push((seqs, *change)),
                other => panic!("an apply answered {other:?}"),
            }
        }
        applied.store(true, Ordering::Release);
        let reads = reader.await.unwrap();
        let feed = ledger.feed(0, 1000).await.unwrap();

        recorded.sort_by_key(|(seqs, _)| seqs[0]);
        let mut subscriptions: HashMap<SubscriptionId, Subscription> = HashMap::new();
        let mut told = Vec::new();
        for (seqs, change) in recorded {
            subscriptions.insert(change.subscription.id.clone(), change.subscription.clone());
            for (seq, event) in seqs.into_iter().zip(change.events) {
                told.push(FeedEntry {
                    seq,
                    recorded_at: Instant::from_epoch_millis(0),
                    store: Store::AppStore,
                    environment: Environment::Production,
                    offer_kind: None,
                    entitlement: event.account_id.clone().map(|account_id| {
                        AccountEntitlement::of(
                            account_id,
                            subscriptions.values().cloned().collect(),
                        )
                    }),
                    event,
                });
            }
        }
        let read_in_full = seqs(&feed.entries);
        for read in reads {
            assert_eq!(
                read,
                read_in_full[..read.len()],
                "a read saw a seq before one below it"
            );
        }
        assert_eq!(read_in_full, (1..=told.len() as i64).collect::<Vec<_>>());
        let mut entries = feed.entries;
        for entry in &mut entries {
            entry.recorded_at = Instant::from_epoch_millis(0);
        }
        assert_eq!(entries, told);
        ledger.close().await;
    })
    .await;
}

#[tokio::test]
#[cfg_attr(not(postgres_tests), ignore = "needs SUBSCRIPTIONS_TEST_DATABASE_URL")]
async fn an_event_keeps_the_subscriptions_its_entitlement_carries_and_none_its_account_held_before()
{
    with_empty_database(async |url| {
        let ledger = Ledger::open(&url.parse().unwrap()).await.unwrap();
        let buyer = Uuid::new_v4();
        let mut held: HashMap<SubscriptionId, Subscription> = HashMap::new();
        let mut carried: Vec<(i64, Vec<String>)> = Vec::new();
        // Thirty subscriptions bought and ended one after another, then two in force at once.
        let story = (0..30)
            .map(|month| ended(&format!("ended {month:02}"), month))
            .chain([renewing("in force a", 30), renewing("in force b", 30)]);
        for observation in story {
            let Applied::Recorded { change, seqs, .. } =
                apply(ledger.clone(), observation, Some(buyer)).await
            else {
                panic!("the apply recorded nothing");
            };
            held.insert(change.subscription.id.clone(), change.subscription.clone());
            let entitlement = AccountEntitlement::of(
                AccountId::new(buyer.to_string()),
                held.values().cloned().collect(),
            );
            let mut ids: Vec<String> = entitlement
                .subscriptions()
                .map(|subscription| subscription.id.as_str().to_owned())
                .collect();
            ids.sort();
            carried.extend(seqs.into_iter().map(|seq| (seq, ids.clone())));
        }
        let mut connection = PgConnection::connect(&url).await.unwrap();
        let stored: Vec<(i64, Vec<String>)> = sqlx::query_as(
            "select seq, array_agg(id::text order by id::text) from entitlement_subscriptions \
             group by seq order by seq",
        )
        .fetch_all(&mut connection)
        .await
        .unwrap();

        assert_eq!(stored, carried);
        assert_eq!(
            stored.iter().map(|(_, ids)| ids.len()).max(),
            Some(2),
            "an event keeps each subscription in force and one governing one, whatever its account held"
        );
        ledger.close().await;
    })
    .await;
}

#[tokio::test]
#[cfg_attr(not(postgres_tests), ignore = "needs SUBSCRIPTIONS_TEST_DATABASE_URL")]
async fn an_event_kept_with_every_subscription_its_account_held_reads_the_same_entitlement() {
    with_empty_database(async |url| {
        let ledger = Ledger::open(&url.parse().unwrap()).await.unwrap();
        let buyer = Uuid::new_v4();
        for observation in [
            ended("ended 0", 0),
            ended("ended 1", 1),
            renewing("in force", 2),
        ] {
            apply(ledger.clone(), observation, Some(buyer)).await;
        }
        let as_kept = ledger.feed(0, 100).await.unwrap();
        // Each lineage is written once, so its row now is the one every event since its first held of it.
        let mut connection = PgConnection::connect(&url).await.unwrap();
        let added = sqlx::query(
            "insert into entitlement_subscriptions \
             select (jsonb_populate_record(null::entitlement_subscriptions, \
                                           to_jsonb(s) || jsonb_build_object('seq', e.seq))).* \
             from events e join subscriptions s on s.account_id = e.account_id \
             where (select min(seq) from events f where f.subscription_id = s.id) <= e.seq \
             and not exists (select from entitlement_subscriptions k where k.seq = e.seq and k.id = s.id)",
        )
        .execute(&mut connection)
        .await
        .unwrap();

        assert!(added.rows_affected() > 0);
        assert_eq!(ledger.feed(0, 100).await.unwrap(), as_kept);
        ledger.close().await;
    })
    .await;
}

#[tokio::test]
#[cfg_attr(not(postgres_tests), ignore = "needs SUBSCRIPTIONS_TEST_DATABASE_URL")]
async fn an_entitlement_row_is_held_to_every_check_a_subscription_is() {
    with_empty_database(async |url| {
        Ledger::open(&url.parse().unwrap())
            .await
            .unwrap()
            .close()
            .await;
        let mut connection = PgConnection::connect(&url).await.unwrap();
        let mut held_to = async |table: &str| -> (Vec<String>, Vec<(String, String, String)>) {
            let checks = sqlx::query_scalar(
                "select pg_get_constraintdef(oid) from pg_constraint \
                 where conrelid = $1::regclass and contype = 'c' order by 1",
            )
            .bind(table)
            .fetch_all(&mut connection)
            .await
            .unwrap();
            let columns = sqlx::query_as(
                "select column_name::text, data_type::text, is_nullable::text \
                 from information_schema.columns \
                 where table_name = $1 and column_name not in ('seq', 'verified_at') \
                 order by ordinal_position",
            )
            .bind(table)
            .fetch_all(&mut connection)
            .await
            .unwrap();
            (checks, columns)
        };

        let subscriptions = held_to("subscriptions").await;
        let entitlement_subscriptions = held_to("entitlement_subscriptions").await;

        assert_eq!(subscriptions.0.len(), 15);
        assert_eq!(entitlement_subscriptions, subscriptions);
    })
    .await;
}

// Makes a transaction that appends an event of the lineage wait, once it holds its seqs, for as long as the
// test holds the advisory lock 7. Returns holding it.
async fn hold_events_of(control: &mut PgConnection, lineage: &str) {
    control
        .execute(AssertSqlSafe(format!(
            "create function hold_events() returns trigger language plpgsql as $$ \
             begin \
                 if exists (select from subscriptions where id = new.subscription_id \
                            and store_subscription_id = '{lineage}') then \
                     perform pg_advisory_xact_lock_shared(7); \
                 end if; \
                 return new; \
             end $$; \
             create trigger hold_events before insert on events \
                 for each row execute function hold_events(); \
             select pg_advisory_lock(7);"
        )))
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

async fn apply(ledger: Ledger, observation: Observation, hint: Option<Uuid>) -> Applied {
    ledger
        .apply(Observed {
            observation,
            hint,
            claim: None,
            pulled_at: None,
        })
        .await
        .unwrap()
}

fn seqs_of(applied: Applied) -> Vec<i64> {
    match applied {
        Applied::Recorded { seqs, .. } => seqs,
        other => panic!("the apply answered {other:?}"),
    }
}

fn seqs(entries: &[FeedEntry]) -> Vec<i64> {
    entries.iter().map(|entry| entry.seq).collect()
}

// A subscription first heard of as its `month`-th month ended with renewal off.
fn ended(lineage: &str, month: i64) -> Observation {
    let mut observation = renewing(lineage, month);
    let end = observation.status.current_period.end;
    observation.observed_at = end;
    observation.status.state = State::Expired(Ending {
        at: end,
        reason: EndReason::Cancelled,
    });
    observation.status.renewal = Renewal {
        auto_renew: false,
        next_charge: None,
        next_product_id: None,
        cancel_requested_at: None,
    };
    observation
}

// An active, renewing subscription in its `month`-th month, stating that month's period.
fn renewing(lineage: &str, month: i64) -> Observation {
    let day = 86_400_000;
    let started_at = 1_798_761_600_000;
    let start = Instant::from_epoch_millis(started_at + month * 30 * day);
    let end = Instant::from_epoch_millis(started_at + (month + 1) * 30 * day);
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
            started_at: Instant::from_epoch_millis(started_at),
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
