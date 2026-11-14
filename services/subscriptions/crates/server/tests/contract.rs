// The internal doors against the wire's golden fixtures, packages/api-contract/subscriptions: each body is the
// fixture's, byte for byte, key order included.

use std::env;
use std::panic::{AssertUnwindSafe, resume_unwind};
use std::path::Path;

use axum::body::{Body, to_bytes};
use axum::http::{Request, StatusCode};
use domain::{
    AccountEntitlement, AccountId, BillingInterval, Binding, BoundBy, EndReason, Ending,
    Environment, Event, EventKind, Instant, Lineage, Money, NextCharge, Observation,
    ObservedPeriod, Offer, OfferKind, Ownership, Period, PeriodChange, PeriodId, Plan, ProductId,
    Renewal, Span, State, Status, Store, StoreSubscriptionId, StoreTransactionId, Subscription,
    SubscriptionId,
};
use futures_util::FutureExt;
use serde_json::{Value, json};
use server::config::Config;
use server::internal::Reads;
use server::listeners::{Bounds, Listener, Readiness};
use sqlx::{AssertSqlSafe, Connection, Executor, PgConnection};
use storage::{
    AccountClaim, AccountRecord, Applied, FeedEntry, FeedPage, Ledger, Observed, StorageError,
    SubscriptionRecord,
};
use tower::ServiceExt;
use url::Url;
use uuid::Uuid;

fn fixture(name: &str) -> Value {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../../packages/api-contract/subscriptions")
        .join(name);
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

// A ledger that holds one page of the feed, the one a fixture's request asks for.
#[derive(Clone)]
struct OnePage {
    request: (i64, i64),
    page: FeedPage,
}

impl Readiness for OnePage {
    async fn ready(&self) -> Result<(), StorageError> {
        Ok(())
    }
}

impl Reads for OnePage {
    async fn feed(&self, after: i64, limit: i64) -> Result<FeedPage, StorageError> {
        assert_eq!((after, limit), self.request);
        Ok(self.page.clone())
    }

    async fn account(&self, _account_id: Uuid) -> Result<AccountRecord, StorageError> {
        panic!("a feed read reads no account")
    }
}

// A ledger that holds one account.
#[derive(Clone)]
struct OneAccount {
    account_id: Uuid,
    record: AccountRecord,
}

impl Readiness for OneAccount {
    async fn ready(&self) -> Result<(), StorageError> {
        Ok(())
    }
}

impl Reads for OneAccount {
    async fn feed(&self, _after: i64, _limit: i64) -> Result<FeedPage, StorageError> {
        panic!("an account read reads no feed")
    }

    async fn account(&self, account_id: Uuid) -> Result<AccountRecord, StorageError> {
        assert_eq!(account_id, self.account_id);
        Ok(self.record.clone())
    }
}

async fn read<L: Readiness + Reads>(ledger: L, path: &str) -> String {
    let config = Config::from_environment(|variable| match variable {
        "SUBSCRIPTIONS_PUBLIC_ADDRESS" => Some("127.0.0.1:8082".to_owned()),
        "SUBSCRIPTIONS_INTERNAL_ADDRESS" => Some("127.0.0.1:8083".to_owned()),
        "SUBSCRIPTIONS_DATABASE_URL" => Some("postgresql://ledger@127.0.0.1:1/ledger".to_owned()),
        "SENTRY_ENVIRONMENT" => Some("test".to_owned()),
        "SUBSCRIPTIONS_INTERNAL_TOKEN" => Some("5d0c3a9e8f7b6a5d4c3b2a1f0e9d8c7b".to_owned()),
        _ => None,
    })
    .unwrap();
    let response = Listener::Internal
        .router(&config, ledger, Bounds::default())
        .oneshot(
            Request::get(path)
                .header("authorization", "Bearer 5d0c3a9e8f7b6a5d4c3b2a1f0e9d8c7b")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK, "{path}");
    let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    String::from_utf8(body.to_vec()).unwrap()
}

#[tokio::test]
async fn every_page_of_the_feed_is_the_contracts() {
    for example in fixture("feed.json")["examples"].as_array().unwrap() {
        let request = &example["request"];
        let (after, limit) = (
            request["after"].as_i64().unwrap(),
            request["limit"].as_i64().unwrap(),
        );
        let ledger = OnePage {
            request: (after, limit),
            page: page(&example["body"]),
        };

        let served = read(
            ledger,
            &format!("/internal/v1/feed?after={after}&limit={limit}"),
        )
        .await;

        assert_eq!(served, example["body"].to_string(), "{}", example["name"]);
    }
}

#[tokio::test]
async fn every_entitlement_is_the_contracts_and_the_account_read_lists_what_it_folds() {
    for example in fixture("entitlement.json")["examples"].as_array().unwrap() {
        let body = &example["body"];
        let entitlement = entitlement(body);
        let mut held: Vec<Subscription> = [&entitlement.production, &entitlement.sandbox]
            .into_iter()
            .flat_map(|block| block.governing.iter().chain(&block.others))
            .cloned()
            .collect();
        held.sort_by(|one, other| one.id.cmp(&other.id));
        let ledger = OneAccount {
            account_id: Uuid::parse_str(body["accountId"].as_str().unwrap()).unwrap(),
            record: AccountRecord {
                entitlement,
                subscriptions: held
                    .iter()
                    .map(|subscription| SubscriptionRecord {
                        subscription: subscription.clone(),
                        periods: Vec::new(),
                        events: Vec::new(),
                    })
                    .collect(),
            },
        };
        let mut listed: Vec<(&str, Value)> = ["production", "sandbox"]
            .into_iter()
            .flat_map(|environment| {
                let block = &body[environment];
                [&block["governing"]]
                    .into_iter()
                    .chain(block["others"].as_array().unwrap())
                    .filter(|shown| !shown.is_null())
                    .map(move |shown| {
                        let mut bound = shown.clone();
                        let fields = bound.as_object_mut().unwrap();
                        fields.insert("environment".to_owned(), json!(environment));
                        fields.insert("boundAt".to_owned(), shown["startedAt"].clone());
                        fields.insert("boundBy".to_owned(), json!("purchase"));
                        fields.insert("periods".to_owned(), json!([]));
                        fields.insert("events".to_owned(), json!([]));
                        (shown["subscriptionId"].as_str().unwrap(), bound)
                    })
            })
            .collect();
        listed.sort_by_key(|(id, _)| *id);
        let subscriptions: Vec<Value> = listed.into_iter().map(|(_, bound)| bound).collect();

        let served = read(
            ledger,
            &format!(
                "/internal/v1/accounts/{}",
                body["accountId"].as_str().unwrap()
            ),
        )
        .await;

        assert_eq!(
            served,
            json!({ "entitlement": body, "subscriptions": subscriptions }).to_string(),
            "{}",
            example["name"]
        );
    }
}

// The feed's story told through Ledger::apply up to seq 13, where it parts from the domain's: the fixture's refund turns
// renewal off without the renewal_turned_off observe records. Ids are minted at random, so each is read as the
// fixture's before the bodies are compared; the ledger's clock is set to each transaction's recordedAt.
#[tokio::test]
#[cfg_attr(not(postgres_tests), ignore = "needs SUBSCRIPTIONS_TEST_DATABASE_URL")]
async fn the_ledger_tells_the_contracts_story_through_the_sandbox_renewal() {
    let feed = fixture("feed.json");
    let entitlements = fixture("entitlement.json");
    let pages = feed["examples"].as_array().unwrap();
    let entry = |seq: i64| {
        pages
            .iter()
            .flat_map(|example| example["body"]["entries"].as_array().unwrap())
            .find(|entry| entry["seq"] == json!(seq))
            .unwrap()
            .clone()
    };
    let example = |name: &str| {
        entitlements["examples"]
            .as_array()
            .unwrap()
            .iter()
            .find(|example| example["name"] == json!(name))
            .unwrap()["body"]
            .clone()
    };
    let account = |seq: i64| Uuid::parse_str(entry(seq)["accountId"].as_str().unwrap()).unwrap();
    let (buyer, claimant, tester) = (account(1), account(6), account(9));
    let epoch = feed["examples"][0]["body"]["epoch"]
        .as_str()
        .unwrap()
        .to_owned();
    let minute = 60_000;
    let (t0, end1) = (1_796_292_000_000, 1_798_970_400_000);
    let (unhinted, unhinted_end, claimed) =
        (1_796_472_000_000, 1_799_150_400_000, 1_796_547_600_000);
    let sandbox = 1_796_742_000_000;

    with_empty_database(async |url| {
        let ledger = Ledger::open(&url.parse().unwrap()).await.unwrap();
        let mut control = PgConnection::connect(&url).await.unwrap();
        control
            .execute(AssertSqlSafe(format!(
                "create table story_clock (at bigint not null); insert into story_clock values (0); \
                 create or replace function now_millis() returns bigint language sql volatile \
                 return (select at from story_clock); update ledger set epoch = '{epoch}'"
            )))
            .await
            .unwrap();
        let mut renamed: Vec<(String, String)> = Vec::new();
        let mut tell = async |recorded_at: i64, observed: Observed, named: &[(i64, &str)]| {
            control
                .execute(AssertSqlSafe(format!("update story_clock set at = {recorded_at}")))
                .await
                .unwrap();
            let Applied::Recorded { change, .. } = ledger.apply(observed).await.unwrap() else {
                panic!("the story's apply recorded nothing");
            };
            for (seq, served) in named {
                let told = entry(*seq);
                let (served, told) = match *served {
                    "subscription" => (change.subscription.id.as_str().to_owned(), told["subscriptionId"].clone()),
                    transaction => (
                        change
                            .periods
                            .iter()
                            .find_map(|period| match period {
                                PeriodChange::Written(period) if period.transaction.as_str() == transaction => {
                                    Some(period.id.as_str().to_owned())
                                }
                                _ => None,
                            })
                            .unwrap(),
                        told["period"]["id"].clone(),
                    ),
                };
                renamed.push((served, told.as_str().unwrap().to_owned()));
            }
        };

        tell(
            t0 + 4_000,
            Observed {
                observation: month("buyer", Environment::Production, "buyer-1", t0, t0, (t0, end1)),
                hint: Some(buyer),
                claim: None,
                pulled_at: None,
            },
            &[(1, "subscription"), (3, "buyer-1")],
        )
        .await;
        tell(
            unhinted + 3_000,
            Observed {
                observation: month(
                    "unhinted",
                    Environment::Production,
                    "unhinted-1",
                    unhinted,
                    unhinted,
                    (unhinted, unhinted_end),
                ),
                hint: None,
                claim: None,
                pulled_at: None,
            },
            &[(4, "subscription"), (5, "unhinted-1")],
        )
        .await;
        tell(
            claimed,
            Observed {
                observation: month(
                    "unhinted",
                    Environment::Production,
                    "unhinted-1",
                    claimed,
                    unhinted,
                    (unhinted, unhinted_end),
                ),
                hint: None,
                claim: Some(AccountClaim {
                    account_id: claimant,
                    at: Instant::from_epoch_millis(claimed),
                }),
                pulled_at: Some(Instant::from_epoch_millis(claimed)),
            },
            &[],
        )
        .await;
        PgConnection::connect(&url)
            .await
            .unwrap()
            .execute("update ledger set latest_seq = latest_seq + 1")
            .await
            .unwrap();
        tell(
            sandbox + 2_000,
            Observed {
                observation: month(
                    "sandbox",
                    Environment::Sandbox,
                    "sandbox-1",
                    sandbox,
                    sandbox,
                    (sandbox, sandbox + 5 * minute),
                ),
                hint: Some(tester),
                claim: None,
                pulled_at: None,
            },
            &[(9, "subscription"), (11, "sandbox-1")],
        )
        .await;
        tell(
            sandbox + 5 * minute + 2_000,
            Observed {
                observation: month(
                    "sandbox",
                    Environment::Sandbox,
                    "sandbox-2",
                    sandbox + 5 * minute,
                    sandbox,
                    (sandbox + 5 * minute, sandbox + 10 * minute),
                ),
                hint: Some(tester),
                claim: None,
                pulled_at: None,
            },
            &[(13, "sandbox-2")],
        )
        .await;
        let as_told = |served: String| {
            renamed
                .iter()
                .fold(served, |text, (served, told)| text.replace(served, told))
        };

        let mut told_pages = Vec::new();
        for name in ["from_zero", "claimed_then_sandbox"] {
            let example = pages.iter().find(|example| example["name"] == json!(name)).unwrap();
            let (after, limit) = (example["request"]["after"].clone(), example["request"]["limit"].clone());
            let served = read(ledger.clone(), &format!("/internal/v1/feed?after={after}&limit={limit}")).await;
            let mut told: Value = serde_json::from_str(&as_told(served)).unwrap();
            assert_eq!(told["latestSeq"], json!(13), "{name}");
            told["latestSeq"] = example["body"]["latestSeq"].clone();
            told_pages.push((name, told.to_string(), example["body"].to_string()));
        }
        let mut told_accounts = Vec::new();
        for account in [buyer, claimant, tester] {
            let served = read(ledger.clone(), &format!("/internal/v1/accounts/{account}")).await;
            told_accounts.push(as_told(served));
        }

        for (name, told, contract) in told_pages {
            assert_eq!(told, contract, "{name}");
        }
        let events = |seqs: &[i64]| -> Value {
            seqs.iter()
                .map(|seq| {
                    let entry = entry(*seq);
                    json!({
                        "seq": entry["seq"],
                        "type": entry["type"],
                        "occurredAt": entry["occurredAt"],
                        "recordedAt": entry["recordedAt"],
                        "accountId": entry["accountId"],
                        "period": entry["period"],
                    })
                })
                .collect()
        };
        let bound = |entitlement: &Value, environment: &str, binding: (i64, &str), periods: &[i64], seqs: &[i64]| {
            let mut bound = entitlement[environment]["governing"].clone();
            let fields = bound.as_object_mut().unwrap();
            fields.insert("environment".to_owned(), json!(environment));
            fields.insert("boundAt".to_owned(), json!(binding.0));
            fields.insert("boundBy".to_owned(), json!(binding.1));
            fields.insert(
                "periods".to_owned(),
                periods.iter().map(|seq| entry(*seq)["period"].clone()).collect(),
            );
            fields.insert("events".to_owned(), events(seqs));
            json!({ "entitlement": entitlement, "subscriptions": [bound] }).to_string()
        };
        assert_eq!(
            told_accounts,
            [
                bound(&example("active"), "production", (t0, "purchase"), &[3], &[1, 2, 3]),
                bound(&entry(7)["entitlement"], "production", (claimed, "claim"), &[7], &[4, 5, 6, 7]),
                bound(&example("sandbox_active"), "sandbox", (sandbox, "purchase"), &[11, 13], &[9, 10, 11, 12, 13]),
            ]
        );
        ledger.close().await;
    })
    .await;
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

// A month of Windmill One, active and renewing at $12.00, as the store states it at `observed_at`: its one period is
// the one in force, paid by `transaction`.
fn month(
    lineage: &str,
    environment: Environment,
    transaction: &str,
    observed_at: i64,
    started_at: i64,
    (start, end): (i64, i64),
) -> Observation {
    let span = Span {
        start: Instant::from_epoch_millis(start),
        end: Instant::from_epoch_millis(end),
    };
    let price = Money::new("12.00", "USD").unwrap();
    Observation {
        lineage: Lineage {
            store: Store::AppStore,
            environment,
            store_subscription_id: StoreSubscriptionId::new(lineage),
        },
        observed_at: Instant::from_epoch_millis(observed_at),
        ownership: Ownership::Purchased,
        status: Status {
            plan: Plan::WindmillOne,
            product_id: ProductId::new("works.windmill.app.one.monthly"),
            billing_interval: BillingInterval::new("P1M"),
            started_at: Instant::from_epoch_millis(started_at),
            state: State::Active {
                pause_scheduled_for: None,
            },
            current_period: span,
            renewal: Renewal {
                auto_renew: true,
                next_charge: Some(NextCharge {
                    at: span.end,
                    price: price.clone(),
                }),
                next_product_id: None,
                cancel_requested_at: None,
            },
            offer: None,
            price: price.clone(),
            storefront: None,
        },
        periods: vec![ObservedPeriod {
            transaction: StoreTransactionId::new(transaction),
            span,
            price,
            offer_kind: None,
            refunded_at: None,
        }],
    }
}

// The ledger's types, read from what the fixtures show of them. What the wire does not carry, as a store's ids or a
// subscription's price, is filled with a value of its own; the domain folds the entitlement again from what it holds.
fn page(wire: &Value) -> FeedPage {
    FeedPage {
        epoch: Uuid::parse_str(wire["epoch"].as_str().unwrap()).unwrap(),
        entries: wire["entries"]
            .as_array()
            .unwrap()
            .iter()
            .map(feed_entry)
            .collect(),
        latest_seq: wire["latestSeq"].as_i64().unwrap(),
    }
}

fn feed_entry(wire: &Value) -> FeedEntry {
    let occurred_at = instant(&wire["occurredAt"]).unwrap();
    let period = (!wire["period"].is_null()).then(|| period(&wire["period"], occurred_at));
    let kind = match (wire["type"].as_str().unwrap(), period) {
        ("period_recorded", Some(period)) => EventKind::PeriodRecorded(period),
        ("period_refunded", Some(period)) => EventKind::PeriodRefunded(period),
        ("period_refund_reversed", Some(period)) => EventKind::PeriodRefundReversed(period),
        ("started", None) => EventKind::Started,
        ("renewed", None) => EventKind::Renewed,
        ("renewal_turned_off", None) => EventKind::RenewalTurnedOff,
        ("payment_failed", None) => EventKind::PaymentFailed,
        ("payment_recovered", None) => EventKind::PaymentRecovered,
        ("updated", None) => EventKind::Updated,
        ("expired", None) => EventKind::Expired,
        ("revoked", None) => EventKind::Revoked,
        ("bound", None) => EventKind::Bound,
        ("unbound", None) => EventKind::Unbound,
        (other, _) => panic!("the feed fixture tells a {other} this test does not read"),
    };
    FeedEntry {
        seq: wire["seq"].as_i64().unwrap(),
        recorded_at: instant(&wire["recordedAt"]).unwrap(),
        event: Event {
            kind,
            occurred_at,
            subscription_id: SubscriptionId::new(wire["subscriptionId"].as_str().unwrap()),
            account_id: wire["accountId"].as_str().map(AccountId::new),
        },
        store: Store::from_name(wire["store"].as_str().unwrap()).unwrap(),
        environment: Environment::from_name(wire["environment"].as_str().unwrap()).unwrap(),
        offer_kind: offer_kind(&wire["offerKind"]),
        entitlement: (!wire["entitlement"].is_null()).then(|| entitlement(&wire["entitlement"])),
    }
}

fn entitlement(wire: &Value) -> AccountEntitlement {
    let account_id = AccountId::new(wire["accountId"].as_str().unwrap());
    let held = [Environment::Production, Environment::Sandbox]
        .into_iter()
        .flat_map(|environment| {
            let block = &wire[environment.name()];
            [&block["governing"]]
                .into_iter()
                .chain(block["others"].as_array().unwrap())
                .filter(|shown| !shown.is_null())
                .map(|shown| subscription(shown, environment, &account_id))
                .collect::<Vec<_>>()
        })
        .collect();
    AccountEntitlement::of(account_id, held)
}

fn subscription(wire: &Value, environment: Environment, account_id: &AccountId) -> Subscription {
    let id = wire["subscriptionId"].as_str().unwrap();
    let started_at = instant(&wire["startedAt"]).unwrap();
    let next_charge = instant(&wire["nextChargeAt"]).map(|at| NextCharge {
        at,
        price: money(&wire["nextCharge"]),
    });
    let ending = || Ending {
        at: instant(&wire["endedAt"]).unwrap(),
        reason: EndReason::from_name(wire["endReason"].as_str().unwrap()).unwrap(),
    };
    let state = match wire["state"].as_str().unwrap() {
        "active" => State::Active {
            pause_scheduled_for: instant(&wire["pauseScheduledFor"]),
        },
        "grace" => State::Grace {
            payment_failed_at: instant(&wire["paymentFailedAt"]).unwrap(),
            grace_ends_at: instant(&wire["graceEndsAt"]).unwrap(),
        },
        "on_hold" => State::OnHold {
            payment_failed_at: instant(&wire["paymentFailedAt"]).unwrap(),
        },
        "paused" => State::Paused {
            paused_at: instant(&wire["pausedAt"]).unwrap(),
            resumes_at: instant(&wire["resumesAt"]),
        },
        "expired" => State::Expired(ending()),
        "revoked" => State::Revoked(ending()),
        other => panic!("no state {other}"),
    };
    Subscription {
        id: SubscriptionId::new(id),
        lineage: Lineage {
            store: Store::from_name(wire["store"].as_str().unwrap()).unwrap(),
            environment,
            store_subscription_id: StoreSubscriptionId::new(id),
        },
        binding: Some(Binding {
            account_id: account_id.clone(),
            bound_at: started_at,
            bound_by: BoundBy::Purchase,
        }),
        status: Status {
            plan: Plan::WindmillOne,
            product_id: ProductId::new("works.windmill.app.one.monthly"),
            billing_interval: BillingInterval::new("P1M"),
            started_at,
            state,
            current_period: Span {
                start: instant(&wire["currentPeriod"]["start"]).unwrap(),
                end: instant(&wire["currentPeriod"]["end"]).unwrap(),
            },
            renewal: Renewal {
                auto_renew: wire["autoRenew"].as_bool().unwrap(),
                next_charge,
                next_product_id: wire["nextProductId"].as_str().map(ProductId::new),
                cancel_requested_at: instant(&wire["cancelRequestedAt"]),
            },
            offer: offer_kind(&wire["offerKind"]).map(|kind| Offer {
                kind,
                ends_at: instant(&wire["offerEndsAt"]),
            }),
            price: Money::new("12.00", "USD").unwrap(),
            storefront: None,
        },
        observed_at: started_at,
        cancellation_observed_at: None,
    }
}

fn period(wire: &Value, observed_at: Instant) -> Period {
    let id = wire["id"].as_str().unwrap();
    Period {
        id: PeriodId::new(id),
        transaction: StoreTransactionId::new(id),
        span: Span {
            start: instant(&wire["start"]).unwrap(),
            end: instant(&wire["end"]).unwrap(),
        },
        price: money(&wire["price"]),
        offer_kind: offer_kind(&wire["offerKind"]),
        refunded_at: instant(&wire["refundedAt"]),
        observed_at,
        left_with: None,
    }
}

fn money(wire: &Value) -> Money {
    Money::new(
        wire["amount"].as_str().unwrap(),
        wire["currency"].as_str().unwrap(),
    )
    .unwrap()
}

fn offer_kind(wire: &Value) -> Option<OfferKind> {
    wire.as_str()
        .map(|kind| OfferKind::from_name(kind).unwrap())
}

fn instant(wire: &Value) -> Option<Instant> {
    wire.as_i64().map(Instant::from_epoch_millis)
}
