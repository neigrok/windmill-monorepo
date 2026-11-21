use std::collections::HashMap;
use std::env;
use std::fs;
use std::panic::{AssertUnwindSafe, resume_unwind};
use std::path::{Path, PathBuf};

use domain::{
    AccountEntitlement, AccountHint, AccountId, Accounts, BillingInterval, Change, Claim, Claimant,
    EndReason, Ending, Environment, Instant, Lineage, Money, NextCharge, Observation,
    ObservedPeriod, Offer, OfferKind, Ownership, PeriodChange, PeriodId, Plan, ProductId, Renewal,
    Span, State, Status, Store, StoreSubscriptionId, StoreTransactionId, Storefront, Subscription,
    SubscriptionId, erase, observe,
};
use futures_util::FutureExt;
use serde_json::Value;
use sqlx::{AssertSqlSafe, Connection, Executor, PgConnection};
use storage::{
    AccountClaim, Applied, ErasedLineage, FeedEntry, Ledger, Notification, Observed, Receipt,
    StoreHint,
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
async fn every_vector_replayed_through_the_ledger_matches_the_pure_domain() {
    let directory = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/vectors");
    let mut stories: Vec<PathBuf> = fs::read_dir(&directory)
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .filter(|path| {
            path.extension()
                .is_some_and(|extension| extension == "json")
        })
        .collect();
    stories.sort();
    assert!(stories.len() >= 30, "{} vectors", stories.len());

    for story in stories {
        with_empty_database(async |url| tell(&story, &url).await).await;
    }
}

// Tells one story twice, through the ledger and through observe on a ledger held in memory, and demands the same
// change at every step, the same records after it, and a feed from zero that carries exactly the events told.
async fn tell(path: &Path, url: &str) {
    let name = path.file_name().unwrap().to_string_lossy();
    let story: Value = serde_json::from_str(&fs::read_to_string(path).unwrap()).unwrap();
    let ledger = Ledger::open(&url.parse().unwrap()).await.unwrap();
    let mut accounts: HashMap<String, Uuid> = HashMap::new();
    let erased = Uuid::new_v4();
    ledger.erase_account(erased).await.unwrap();
    let mut held: HashMap<Lineage, domain::Ledger> = HashMap::new();
    let mut newest: HashMap<SubscriptionId, i64> = HashMap::new();
    let mut told: Vec<FeedEntry> = Vec::new();

    for (index, step) in story["steps"].as_array().unwrap().iter().enumerate() {
        let place = format!("{name} step {}", index + 1);
        if let Some(erasure) = step.get("erasure") {
            let account_id = *accounts
                .entry(text(erasure, "accountId").to_owned())
                .or_insert_with(Uuid::new_v4);
            let erasure = ledger.erase_account(account_id).await.unwrap();
            let erased_id = AccountId::new(account_id.to_string());
            let touched: Vec<&Lineage> = erasure
                .lineages
                .iter()
                .map(|lineage| &lineage.change.subscription.lineage)
                .collect();
            for (lineage, before) in &held {
                if !touched.contains(&lineage) {
                    assert_eq!(
                        erase(before.clone(), &erased_id, erasure.erased_at),
                        None,
                        "{place}"
                    );
                }
            }
            for erased_lineage in &erasure.lineages {
                let change = &erased_lineage.change;
                let lineage = change.subscription.lineage.clone();
                let before = held[&lineage].clone();
                let pure = erase(before.clone(), &erased_id, erasure.erased_at);
                assert_eq!(Some(change), pure.as_ref(), "{place}");
                held.insert(lineage, after(before, change));
                newest.insert(
                    change.subscription.id.clone(),
                    erased_lineage
                        .seqs
                        .last()
                        .copied()
                        .unwrap_or(newest[&change.subscription.id]),
                );
            }
            let subscriptions: Vec<Subscription> = held
                .values()
                .filter_map(|held| held.subscription.clone())
                .collect();
            for erased_lineage in erasure.lineages {
                let ErasedLineage { change, seqs } = erased_lineage;
                let lineage = &change.subscription.lineage;
                assert_eq!(seqs.len(), change.events.len(), "{place}");
                for (seq, event) in seqs.into_iter().zip(change.events) {
                    told.push(FeedEntry {
                        seq,
                        recorded_at: Instant::from_epoch_millis(0),
                        store: lineage.store,
                        environment: lineage.environment,
                        offer_kind: change
                            .subscription
                            .status
                            .offer
                            .as_ref()
                            .map(|offer| offer.kind),
                        entitlement: event.account_id.clone().map(|account_id| {
                            AccountEntitlement::of(account_id, subscriptions.clone())
                        }),
                        event,
                    });
                }
            }
            for (lineage, expected) in &held {
                let mut expected = expected.clone();
                expected.periods.sort_by(|one, other| {
                    (one.span.start, &one.transaction).cmp(&(other.span.start, &other.transaction))
                });
                assert_eq!(ledger.lineage(lineage).await.unwrap(), expected, "{place}");
            }
            continue;
        }
        let observation = observation(&step["observation"]);
        let lineage = observation.lineage.clone();
        let (hint, resolved) = match &step["hint"] {
            Value::String(hint) if hint == "absent" => (None, AccountHint::Absent),
            Value::String(hint) if hint == "erased" => (Some(erased), AccountHint::Erased),
            live => {
                let account_id = *accounts
                    .entry(text(live, "live").to_owned())
                    .or_insert_with(Uuid::new_v4);
                (
                    Some(account_id),
                    AccountHint::Live(AccountId::new(account_id.to_string())),
                )
            }
        };
        let (claim, pure_claim) = match &step["claim"] {
            Value::Null => (None, None),
            claim => {
                let at = instant(&claim["at"]);
                let (account_id, claimant) = match &claim["claimant"] {
                    Value::String(claimant) if claimant == "erased" => (erased, Claimant::Erased),
                    live => {
                        let account_id = *accounts
                            .entry(text(live, "live").to_owned())
                            .or_insert_with(Uuid::new_v4);
                        (
                            account_id,
                            Claimant::Live(AccountId::new(account_id.to_string())),
                        )
                    }
                };
                (
                    Some(AccountClaim { account_id, at }),
                    Some(Claim { claimant, at }),
                )
            }
        };
        let observed = Observed {
            observation: observation.clone(),
            hint,
            claim,
            pulled_at: None,
        };

        let applied = if observed.claim.is_some() {
            ledger.apply(observed).await.unwrap()
        } else {
            let Receipt::Kept(kept) = ledger
                .receive(notification(&format!("{name}-{index}")))
                .await
                .unwrap()
            else {
                panic!("{place}: the notification was not kept")
            };
            ledger.apply_notification(&kept, observed).await.unwrap()
        };
        let (subscription_id, written) = match &applied {
            Applied::Recorded { change, .. } => {
                (change.subscription.id.clone(), written_period_ids(change))
            }
            _ => (SubscriptionId::new("refused"), HashMap::new()),
        };
        let minted = observation.mint_ids(subscription_id, |period| {
            written
                .get(&period.transaction)
                .cloned()
                .unwrap_or_else(|| PeriodId::new("not written"))
        });
        let before = held.get(&lineage).cloned().unwrap_or_default();
        let pure = observe(
            before.clone(),
            minted,
            Accounts {
                hint: resolved,
                claim: pure_claim,
            },
        );

        match (applied, pure) {
            (
                Applied::Recorded {
                    change,
                    seqs,
                    newest_seq,
                },
                Ok(pure),
            ) => {
                assert_eq!(*change, pure, "{place}");
                let subscription_id = change.subscription.id.clone();
                let newest_before = newest.get(&subscription_id).copied().unwrap_or(0);
                assert_eq!(
                    newest_seq,
                    seqs.last().copied().unwrap_or(newest_before),
                    "{place}"
                );
                newest.insert(subscription_id, newest_seq);
                held.insert(lineage.clone(), after(before, &change));
                let subscriptions: Vec<Subscription> = held
                    .values()
                    .filter_map(|held| held.subscription.clone())
                    .collect();
                assert_eq!(seqs.len(), change.events.len(), "{place}");
                for (seq, event) in seqs.into_iter().zip(change.events) {
                    told.push(FeedEntry {
                        seq,
                        recorded_at: Instant::from_epoch_millis(0),
                        store: lineage.store,
                        environment: lineage.environment,
                        offer_kind: change
                            .subscription
                            .status
                            .offer
                            .as_ref()
                            .map(|offer| offer.kind),
                        entitlement: event.account_id.clone().map(|account_id| {
                            AccountEntitlement::of(account_id, subscriptions.clone())
                        }),
                        event,
                    });
                }
            }
            (Applied::Refused(refusal), Err(pure)) => assert_eq!(refusal, pure, "{place}"),
            (applied, pure) => panic!("{place}: the ledger {applied:?}, the domain {pure:?}"),
        }

        let mut expected = held.get(&lineage).cloned().unwrap_or_default();
        expected.periods.sort_by(|one, other| {
            (one.span.start, &one.transaction).cmp(&(other.span.start, &other.transaction))
        });
        assert_eq!(ledger.lineage(&lineage).await.unwrap(), expected, "{place}");
        for entitlement in step["entitlements"].as_array().unwrap() {
            let account_id = *accounts
                .entry(text(entitlement, "accountId").to_owned())
                .or_insert_with(Uuid::new_v4);
            let subscriptions = held
                .values()
                .filter_map(|held| held.subscription.clone())
                .collect();
            assert_eq!(
                ledger.entitlement(account_id).await.unwrap(),
                AccountEntitlement::of(AccountId::new(account_id.to_string()), subscriptions),
                "{place}"
            );
        }
    }

    let epoch = ledger.epoch().await.unwrap();
    let mut read: Vec<FeedEntry> = Vec::new();
    loop {
        let after = read.last().map_or(0, |entry| entry.seq);
        let page = ledger.feed(after, 4).await.unwrap();
        assert_eq!(
            (page.epoch, page.latest_seq),
            (epoch, told.len() as i64),
            "{name}"
        );
        if page.entries.is_empty() {
            break;
        }
        assert!(page.entries.len() <= 4, "{name}");
        read.extend(page.entries);
    }
    assert!(
        read.is_sorted_by_key(|entry| entry.recorded_at),
        "{name}: recordedAt falls as seq rises"
    );
    for entry in &mut read {
        entry.recorded_at = Instant::from_epoch_millis(0);
    }
    assert_eq!(read, told, "{name}");
    ledger.close().await;
}

#[tokio::test]
#[cfg_attr(not(postgres_tests), ignore = "needs SUBSCRIPTIONS_TEST_DATABASE_URL")]
async fn an_observation_applied_again_writes_nothing() {
    with_empty_database(async |url| {
        let ledger = Ledger::open(&url.parse().unwrap()).await.unwrap();
        let first = apply_notified(&ledger, "first", renewing("again", 0)).await;
        let mut connection = PgConnection::connect(&url).await.unwrap();
        let written = row_versions(&mut connection).await;

        let again = apply_notified(&ledger, "again", renewing("again", 0)).await;

        let Applied::Recorded { change, .. } = first else {
            panic!("the first apply recorded nothing: {first:?}")
        };
        assert_eq!(
            again,
            Applied::Recorded {
                change: Box::new(Change {
                    subscription: change.subscription,
                    periods: Vec::new(),
                    events: Vec::new(),
                    hint_for_store: None,
                }),
                seqs: Vec::new(),
                newest_seq: 2,
            }
        );
        assert_eq!(row_versions(&mut connection).await, written);
        ledger.close().await;
    })
    .await;
}

#[tokio::test]
#[cfg_attr(not(postgres_tests), ignore = "needs SUBSCRIPTIONS_TEST_DATABASE_URL")]
async fn a_pull_stamps_the_newest_time_the_service_read_the_store() {
    with_empty_database(async |url| {
        let ledger = Ledger::open(&url.parse().unwrap()).await.unwrap();
        let mut connection = PgConnection::connect(&url).await.unwrap();
        let pulled = |observation: Observation, pulled_at: Option<i64>| Observed {
            observation,
            hint: None,
            claim: None,
            pulled_at: pulled_at.map(Instant::from_epoch_millis),
        };
        let mut verified_at = Vec::new();

        for (month, pulled_at) in [
            (0, Some(1_000)),
            (0, Some(500)),
            (1, None),
            (1, Some(2_000)),
        ] {
            ledger
                .apply(pulled(renewing("pulled", month), pulled_at))
                .await
                .unwrap();
            let stamp: Option<i64> = sqlx::query_scalar("select verified_at from subscriptions")
                .fetch_one(&mut connection)
                .await
                .unwrap();
            verified_at.push(stamp);
        }

        assert_eq!(
            verified_at,
            [Some(1_000), Some(1_000), Some(1_000), Some(2_000)]
        );
        ledger.close().await;
    })
    .await;
}

#[tokio::test]
#[cfg_attr(not(postgres_tests), ignore = "needs SUBSCRIPTIONS_TEST_DATABASE_URL")]
async fn a_claim_retried_after_it_committed_answers_its_seq_and_its_store_hint_stays_owed_until_cleared()
 {
    with_empty_database(async |url| {
        let ledger = Ledger::open(&url.parse().unwrap()).await.unwrap();
        let (claimant, someone_else) = (Uuid::new_v4(), Uuid::new_v4());
        let claim = || Observed {
            observation: renewing("claimed", 0),
            hint: None,
            claim: Some(AccountClaim {
                account_id: claimant,
                at: Instant::from_epoch_millis(1_798_765_200_000),
            }),
            pulled_at: None,
        };
        let purchase = Observed {
            observation: renewing("claimed", 0),
            hint: None,
            claim: None,
            pulled_at: None,
        };

        ledger.apply(purchase).await.unwrap();
        let claimed = ledger.apply(claim()).await.unwrap();
        let retried = ledger.apply(claim()).await.unwrap();
        let owed = ledger.store_hints(10).await.unwrap();
        let mut to_someone_else = owed[0].clone();
        to_someone_else.account_id = AccountId::new(someone_else.to_string());
        ledger.clear_store_hint(&to_someone_else).await.unwrap();
        let still_owed = ledger.store_hints(10).await.unwrap();
        ledger.clear_store_hint(&owed[0]).await.unwrap();
        let cleared = ledger.store_hints(10).await.unwrap();

        let Applied::Recorded {
            change,
            seqs,
            newest_seq,
        } = claimed
        else {
            panic!("the claim answered {claimed:?}")
        };
        let claimant = AccountId::new(claimant.to_string());
        assert_eq!(
            (seqs, newest_seq, change.hint_for_store.clone()),
            (vec![3, 4], 4, Some(claimant.clone()))
        );
        assert_eq!(
            retried,
            Applied::Recorded {
                change: Box::new(Change {
                    subscription: change.subscription.clone(),
                    periods: Vec::new(),
                    events: Vec::new(),
                    hint_for_store: None,
                }),
                seqs: Vec::new(),
                newest_seq: 4,
            }
        );
        assert_eq!(
            owed,
            [StoreHint {
                subscription_id: change.subscription.id.clone(),
                lineage: change.subscription.lineage.clone(),
                account_id: claimant,
            }]
        );
        assert_eq!((still_owed, cleared), (owed, Vec::new()));
        ledger.close().await;
    })
    .await;
}

#[tokio::test]
#[cfg_attr(not(postgres_tests), ignore = "needs SUBSCRIPTIONS_TEST_DATABASE_URL")]
async fn dropping_stale_store_hints_drops_each_hint_whose_subscription_is_bound_elsewhere_and_no_other()
 {
    with_empty_database(async |url| {
        let ledger = Ledger::open(&url.parse().unwrap()).await.unwrap();
        let claimant = Uuid::new_v4();
        for lineage in ["kept", "stale one", "stale two"] {
            for claim in [None, Some(claimant)] {
                ledger
                    .apply(Observed {
                        observation: renewing(lineage, 0),
                        hint: None,
                        claim: claim.map(|account_id| AccountClaim {
                            account_id,
                            at: Instant::from_epoch_millis(1_798_765_200_000),
                        }),
                        pulled_at: None,
                    })
                    .await
                    .unwrap();
            }
        }
        let mut control = PgConnection::connect(&url).await.unwrap();
        control
            .execute(
                "update store_hints set account_id = gen_random_uuid() \
                 where store_subscription_id like 'stale%'",
            )
            .await
            .unwrap();

        let forgotten = ledger.forget_stale_store_hints().await.unwrap();
        let forgotten_again = ledger.forget_stale_store_hints().await.unwrap();
        let left: Vec<String> = sqlx::query_scalar("select store_subscription_id from store_hints")
            .fetch_all(&mut control)
            .await
            .unwrap();

        assert_eq!((forgotten, forgotten_again), (2, 0));
        assert_eq!(left, ["kept"]);
        ledger.close().await;
    })
    .await;
}

// The system column xmin names the transaction that wrote each row's current version.
async fn row_versions(connection: &mut PgConnection) -> (Vec<String>, i64, i64) {
    let versions: Vec<String> = sqlx::query_scalar(
        "select xmin::text from subscriptions union all select xmin::text from periods",
    )
    .fetch_all(&mut *connection)
    .await
    .unwrap();
    let (latest_seq, events): (i64, i64) =
        sqlx::query_as("select latest_seq, (select count(*) from events) from ledger")
            .fetch_one(&mut *connection)
            .await
            .unwrap();
    (versions, latest_seq, events)
}

async fn apply_notified(ledger: &Ledger, id: &str, observation: Observation) -> Applied {
    let Receipt::Kept(kept) = ledger.receive(notification(id)).await.unwrap() else {
        panic!("{id} was not kept")
    };
    ledger
        .apply_notification(
            &kept,
            Observed {
                observation,
                hint: None,
                claim: None,
                pulled_at: None,
            },
        )
        .await
        .unwrap()
}

fn notification(id: &str) -> Notification {
    Notification {
        store: Store::AppStore,
        id: id.to_owned(),
        environment: Environment::Production,
        signed_payload: format!("the signed payload of {id}"),
    }
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

fn written_period_ids(change: &Change) -> HashMap<StoreTransactionId, PeriodId> {
    change
        .periods
        .iter()
        .filter_map(|period_change| match period_change {
            PeriodChange::Written(period) => Some((period.transaction.clone(), period.id.clone())),
            PeriodChange::Restated(_) => None,
        })
        .collect()
}

// What the ledger holds for the lineage once the change is applied to it.
fn after(mut held: domain::Ledger, change: &Change) -> domain::Ledger {
    held.subscription = Some(change.subscription.clone());
    for period_change in &change.periods {
        match period_change {
            PeriodChange::Written(period) => held.periods.push(period.clone()),
            PeriodChange::Restated(period) => {
                let restated = held
                    .periods
                    .iter_mut()
                    .find(|held| held.id == period.id)
                    .unwrap();
                *restated = period.clone();
            }
        }
    }
    held
}

// The vector format is tests/vectors/README.md's; the domain's own harness checks every file against it.
fn observation(value: &Value) -> Observation {
    let lineage = &value["lineage"];
    Observation {
        lineage: Lineage {
            store: Store::from_name(text(lineage, "store")).unwrap(),
            environment: Environment::from_name(text(lineage, "environment")).unwrap(),
            store_subscription_id: StoreSubscriptionId::new(text(lineage, "storeSubscriptionId")),
        },
        observed_at: instant(&value["observedAt"]),
        ownership: Ownership::from_name(text(value, "ownership")).unwrap(),
        status: status(&value["status"]),
        periods: value["periods"]
            .as_array()
            .unwrap()
            .iter()
            .map(|period| ObservedPeriod {
                transaction: StoreTransactionId::new(text(period, "transaction")),
                span: Span {
                    start: instant(&period["start"]),
                    end: instant(&period["end"]),
                },
                price: money(&period["price"]),
                offer_kind: optional_text(period, "offerKind")
                    .map(|kind| OfferKind::from_name(kind).unwrap()),
                refunded_at: optional_instant(&period["refundedAt"]),
            })
            .collect(),
    }
}

fn status(value: &Value) -> Status {
    let ending = || Ending {
        at: instant(&value["endedAt"]),
        reason: EndReason::from_name(text(value, "endReason")).unwrap(),
    };
    let state = match text(value, "state") {
        "active" => State::Active {
            pause_scheduled_for: optional_instant(&value["pauseScheduledFor"]),
        },
        "grace" => State::Grace {
            payment_failed_at: instant(&value["paymentFailedAt"]),
            grace_ends_at: instant(&value["graceEndsAt"]),
        },
        "on_hold" => State::OnHold {
            payment_failed_at: instant(&value["paymentFailedAt"]),
        },
        "paused" => State::Paused {
            paused_at: instant(&value["pausedAt"]),
            resumes_at: optional_instant(&value["resumesAt"]),
        },
        "expired" => State::Expired(ending()),
        "revoked" => State::Revoked(ending()),
        other => panic!("{other} is not a state"),
    };
    Status {
        plan: Plan::from_name(text(value, "plan")).unwrap(),
        product_id: ProductId::new(text(value, "productId")),
        billing_interval: BillingInterval::new(text(value, "billingInterval")),
        started_at: instant(&value["startedAt"]),
        state,
        current_period: Span {
            start: instant(&value["currentPeriod"]["start"]),
            end: instant(&value["currentPeriod"]["end"]),
        },
        renewal: Renewal {
            auto_renew: value["autoRenew"].as_bool().unwrap(),
            next_charge: optional_instant(&value["nextChargeAt"]).map(|at| NextCharge {
                at,
                price: money(&value["nextCharge"]),
            }),
            next_product_id: optional_text(value, "nextProductId").map(ProductId::new),
            cancel_requested_at: optional_instant(&value["cancelRequestedAt"]),
        },
        offer: optional_text(value, "offerKind").map(|kind| Offer {
            kind: OfferKind::from_name(kind).unwrap(),
            ends_at: optional_instant(&value["offerEndsAt"]),
        }),
        price: money(&value["price"]),
        storefront: optional_text(value, "storefront").map(Storefront::new),
    }
}

fn money(value: &Value) -> Money {
    Money::new(text(value, "amount"), text(value, "currency")).unwrap()
}

fn text<'a>(value: &'a Value, key: &str) -> &'a str {
    value[key]
        .as_str()
        .unwrap_or_else(|| panic!("{key} is not text in {value}"))
}

fn optional_text<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    (!value[key].is_null()).then(|| text(value, key))
}

// UTC ISO 8601, `2027-01-01T10:00:00Z` or with milliseconds, as epoch milliseconds.
fn instant(value: &Value) -> Instant {
    let written = value.as_str().unwrap();
    let (date, time) = written
        .strip_suffix('Z')
        .and_then(|rest| rest.split_once('T'))
        .unwrap();
    let numbers = |part: &str, separator: char| -> Vec<i64> {
        part.split(separator)
            .map(|number| number.parse().unwrap())
            .collect()
    };
    let (clock, millis) = time.split_once('.').unwrap_or((time, "0"));
    let (&[year, month, day], &[hours, minutes, seconds]) = (
        numbers(date, '-').as_slice(),
        numbers(clock, ':').as_slice(),
    ) else {
        panic!("{written} is not an instant")
    };
    let year = if month <= 2 { year - 1 } else { year };
    let era = year.div_euclid(400);
    let year_of_era = year - era * 400;
    let day_of_year = (153 * ((month + 9) % 12) + 2) / 5 + day - 1;
    let days = era * 146_097 + year_of_era * 365 + year_of_era / 4 - year_of_era / 100
        + day_of_year
        - 719_468;
    Instant::from_epoch_millis(
        days * 86_400_000
            + ((hours * 60 + minutes) * 60 + seconds) * 1000
            + millis.parse::<i64>().unwrap(),
    )
}

fn optional_instant(value: &Value) -> Option<Instant> {
    (!value.is_null()).then(|| instant(value))
}
