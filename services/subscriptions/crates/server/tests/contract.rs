// The internal doors against the wire's golden fixtures, packages/api-contract/subscriptions: feed.json, entitlement.json
// and account.json. Each body is the fixture's, byte for byte, key order included.

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
use server::internal::{self, Reads};
use server::listeners::{Bounds, Listener, Readiness};
use sqlx::{AssertSqlSafe, Connection, Executor, PgConnection};
use storage::{
    AccountClaim, AccountRecord, Applied, FeedEntry, FeedPage, Ledger, Observed, RecordedEvent,
    StorageError, SubscriptionRecord,
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
        .router(
            &config,
            ledger.clone(),
            internal::doors(config.internal_token.clone(), ledger),
            Bounds::default(),
        )
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
async fn every_entitlement_is_the_contracts() {
    for example in fixture("entitlement.json")["examples"].as_array().unwrap() {
        let body = &example["body"];
        let account_id = body["accountId"].as_str().unwrap();
        let ledger = OneAccount {
            account_id: Uuid::parse_str(account_id).unwrap(),
            record: AccountRecord {
                entitlement: entitlement(body),
                subscriptions: Vec::new(),
            },
        };

        let served = read(ledger, &format!("/internal/v1/accounts/{account_id}")).await;

        assert_eq!(
            served,
            json!({ "entitlement": body, "subscriptions": [] }).to_string(),
            "{}",
            example["name"]
        );
    }
}

#[tokio::test]
async fn every_account_read_is_the_contracts() {
    for example in fixture("account.json")["examples"].as_array().unwrap() {
        let account_id = example["request"]["accountId"].as_str().unwrap();
        let ledger = OneAccount {
            account_id: Uuid::parse_str(account_id).unwrap(),
            record: account_record(&example["body"]),
        };

        let served = read(ledger, &format!("/internal/v1/accounts/{account_id}")).await;

        assert_eq!(served, example["body"].to_string(), "{}", example["name"]);
    }
}

// The feed's story told through Ledger::apply, every transaction of it up to the erasure at seq 27, which has no step
// in the domain yet. Ids are minted at random, so each is read as the fixture's before the bodies are compared; the
// ledger's clock is set to each transaction's recordedAt.
#[tokio::test]
#[cfg_attr(not(postgres_tests), ignore = "needs SUBSCRIPTIONS_TEST_DATABASE_URL")]
async fn the_ledger_tells_the_contracts_story_up_to_the_erasure() {
    let feed = fixture("feed.json");
    let accounts = fixture("account.json");
    let pages = feed["examples"].as_array().unwrap();
    let entry = |seq: i64| {
        pages
            .iter()
            .flat_map(|example| example["body"]["entries"].as_array().unwrap())
            .find(|entry| entry["seq"] == json!(seq))
            .unwrap()
            .clone()
    };
    let account = |seq: i64| Uuid::parse_str(entry(seq)["accountId"].as_str().unwrap()).unwrap();
    let (buyer, claimant, tester) = (account(1), account(6), account(9));
    let epoch = pages[0]["body"]["epoch"].as_str().unwrap().to_owned();
    let (minute, hour) = (60_000, 3_600_000);
    let (t0, end1, end2, end3) = (
        1_796_292_000_000,
        1_798_970_400_000,
        1_801_648_800_000,
        1_805_724_000_000,
    );
    let (grace_ends, recovered) = (1_803_031_200_000, 1_803_304_800_000);
    let (p2_refunded, p2_refund_reversed, turned_off) =
        (1_803_898_800_000, 1_804_608_000_000, 1_804_708_800_000);
    let (unhinted, unhinted_end, claimed, q1_refunded) = (
        1_796_472_000_000,
        1_799_150_400_000,
        1_796_547_600_000,
        1_797_780_600_000,
    );
    let sandbox = 1_796_742_000_000;
    let active = State::Active {
        pause_scheduled_for: None,
    };
    let ended = |at: i64, reason| Ending {
        at: Instant::from_epoch_millis(at),
        reason,
    };
    let bought = Statement {
        lineage: "buyer",
        environment: Environment::Production,
        started_at: t0,
        observed_at: t0,
        state: active.clone(),
        current_period: (t0, end1),
        auto_renew: true,
        cancel_requested_at: None,
        period: ("buyer-1", (t0, end1), None),
    };
    let renewed = Statement {
        observed_at: end1 - hour,
        current_period: (end1, end2),
        period: ("buyer-2", (end1, end2), None),
        ..bought.clone()
    };
    let recovering = Statement {
        observed_at: recovered,
        current_period: (recovered, end3),
        period: ("buyer-3", (recovered, end3), None),
        ..bought.clone()
    };
    let unhinted_bought = Statement {
        lineage: "unhinted",
        started_at: unhinted,
        observed_at: unhinted,
        current_period: (unhinted, unhinted_end),
        period: ("unhinted-1", (unhinted, unhinted_end), None),
        ..bought.clone()
    };
    let sandbox_bought = Statement {
        lineage: "sandbox",
        environment: Environment::Sandbox,
        started_at: sandbox,
        observed_at: sandbox,
        current_period: (sandbox, sandbox + 5 * minute),
        period: ("sandbox-1", (sandbox, sandbox + 5 * minute), None),
        ..bought.clone()
    };

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
        let mut tell = async |recorded_at: i64,
                              statement: Statement<'_>,
                              hint: Option<Uuid>,
                              claim: Option<AccountClaim>,
                              named: &[(i64, &str)]| {
            control
                .execute(AssertSqlSafe(format!("update story_clock set at = {recorded_at}")))
                .await
                .unwrap();
            let observed = Observed {
                observation: statement.into(),
                hint,
                claim,
                pulled_at: None,
            };
            let Applied::Recorded { change, .. } = ledger.apply(observed).await.unwrap() else {
                panic!("the story's apply recorded nothing");
            };
            for (seq, served) in named {
                let told = entry(*seq);
                let (served, told) = match *served {
                    "subscription" => (
                        change.subscription.id.as_str().to_owned(),
                        told["subscriptionId"].clone(),
                    ),
                    transaction => (
                        change
                            .periods
                            .iter()
                            .find_map(|period| match period {
                                PeriodChange::Written(period)
                                    if period.transaction.as_str() == transaction =>
                                {
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

        let buyer_hint = Some(buyer);
        tell(t0 + 4_000, bought.clone(), buyer_hint, None, &[(1, "subscription"), (3, "buyer-1")]).await;
        tell(unhinted + 3_000, unhinted_bought.clone(), None, None, &[(4, "subscription"), (5, "unhinted-1")])
            .await;
        let claim = AccountClaim {
            account_id: claimant,
            at: Instant::from_epoch_millis(claimed),
        };
        let claimed_state = Statement {
            observed_at: claimed,
            ..unhinted_bought.clone()
        };
        tell(claimed, claimed_state, None, Some(claim), &[]).await;
        PgConnection::connect(&url)
            .await
            .unwrap()
            .execute("update ledger set latest_seq = latest_seq + 1")
            .await
            .unwrap();
        let tester_hint = Some(tester);
        tell(sandbox + 2_000, sandbox_bought.clone(), tester_hint, None, &[(9, "subscription"), (11, "sandbox-1")])
            .await;
        let sandbox_renewed = Statement {
            observed_at: sandbox + 5 * minute,
            current_period: (sandbox + 5 * minute, sandbox + 10 * minute),
            period: ("sandbox-2", (sandbox + 5 * minute, sandbox + 10 * minute), None),
            ..sandbox_bought.clone()
        };
        tell(sandbox + 5 * minute + 2_000, sandbox_renewed, tester_hint, None, &[(13, "sandbox-2")]).await;
        let refunded = Statement {
            observed_at: q1_refunded,
            state: State::Revoked(ended(q1_refunded, EndReason::Refunded)),
            auto_renew: false,
            period: ("unhinted-1", (unhinted, unhinted_end), Some(q1_refunded)),
            ..unhinted_bought.clone()
        };
        tell(q1_refunded + 2_000, refunded, None, None, &[]).await;
        tell(end1 - hour + 10_000, renewed.clone(), buyer_hint, None, &[(18, "buyer-2")]).await;
        let grace = Statement {
            observed_at: end2,
            state: State::Grace {
                payment_failed_at: Instant::from_epoch_millis(end2),
                grace_ends_at: Instant::from_epoch_millis(grace_ends),
            },
            ..renewed.clone()
        };
        tell(end2 + 3_000, grace, buyer_hint, None, &[]).await;
        let on_hold = Statement {
            observed_at: grace_ends,
            state: State::OnHold {
                payment_failed_at: Instant::from_epoch_millis(end2),
            },
            ..renewed.clone()
        };
        tell(grace_ends + 3_000, on_hold, buyer_hint, None, &[]).await;
        tell(recovered + 3_000, recovering.clone(), buyer_hint, None, &[(22, "buyer-3")]).await;
        let earlier_refunded = Statement {
            observed_at: p2_refunded,
            period: ("buyer-2", (end1, end2), Some(p2_refunded)),
            ..recovering.clone()
        };
        tell(p2_refunded + 2_000, earlier_refunded, buyer_hint, None, &[]).await;
        let refund_reversed = Statement {
            observed_at: p2_refund_reversed,
            period: ("buyer-2", (end1, end2), None),
            ..recovering.clone()
        };
        tell(p2_refund_reversed + 2_000, refund_reversed, buyer_hint, None, &[]).await;
        let renewal_off = Statement {
            observed_at: turned_off,
            auto_renew: false,
            cancel_requested_at: Some(turned_off),
            ..recovering.clone()
        };
        tell(turned_off + 2_000, renewal_off.clone(), buyer_hint, None, &[]).await;
        let expired = Statement {
            observed_at: end3,
            state: State::Expired(ended(end3, EndReason::Cancelled)),
            ..renewal_off
        };
        tell(end3 + 4_000, expired, buyer_hint, None, &[]).await;
        let as_told = |served: String| {
            renamed
                .iter()
                .fold(served, |text, (served, told)| text.replace(served, told))
        };

        let mut told_pages = Vec::new();
        for name in [
            "from_zero",
            "claimed_then_sandbox",
            "refunded_then_renewed",
            "payment_trouble",
            "older_period_refunded",
        ] {
            let example = pages.iter().find(|example| example["name"] == json!(name)).unwrap();
            let (after, limit) = (&example["request"]["after"], &example["request"]["limit"]);
            let served = read(ledger.clone(), &format!("/internal/v1/feed?after={after}&limit={limit}")).await;
            let mut told: Value = serde_json::from_str(&as_told(served)).unwrap();
            assert_eq!(told["latestSeq"], json!(26), "{name}");
            told["latestSeq"] = example["body"]["latestSeq"].clone();
            told_pages.push((told.to_string(), example["body"].to_string()));
        }
        let mut told_accounts = Vec::new();
        for (name, account) in [("expired", buyer), ("claimed_then_refunded", claimant), ("sandbox", tester)] {
            let served = read(ledger.clone(), &format!("/internal/v1/accounts/{account}")).await;
            let contract = accounts["examples"]
                .as_array()
                .unwrap()
                .iter()
                .find(|example| example["name"] == json!(name))
                .unwrap()["body"]
                .to_string();
            told_accounts.push((as_told(served), contract));
        }

        for (told, contract) in told_pages.into_iter().chain(told_accounts) {
            assert_eq!(told, contract);
        }
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

// What a store states about a lineage at one instant, as the story needs it: one product at $12.00, and the one
// period the statement names.
#[derive(Clone)]
struct Statement<'a> {
    lineage: &'a str,
    environment: Environment,
    started_at: i64,
    observed_at: i64,
    state: State,
    current_period: (i64, i64),
    auto_renew: bool,
    cancel_requested_at: Option<i64>,
    period: (&'a str, (i64, i64), Option<i64>),
}

impl From<Statement<'_>> for Observation {
    fn from(statement: Statement<'_>) -> Observation {
        let span = |(start, end): (i64, i64)| Span {
            start: Instant::from_epoch_millis(start),
            end: Instant::from_epoch_millis(end),
        };
        let current_period = span(statement.current_period);
        let (transaction, stretch, refunded_at) = statement.period;
        let price = Money::new("12.00", "USD").unwrap();
        Observation {
            lineage: Lineage {
                store: Store::AppStore,
                environment: statement.environment,
                store_subscription_id: StoreSubscriptionId::new(statement.lineage),
            },
            observed_at: Instant::from_epoch_millis(statement.observed_at),
            ownership: Ownership::Purchased,
            status: Status {
                plan: Plan::WindmillOne,
                product_id: ProductId::new("works.windmill.app.one.monthly"),
                billing_interval: BillingInterval::new("P1M"),
                started_at: Instant::from_epoch_millis(statement.started_at),
                state: statement.state,
                current_period,
                renewal: Renewal {
                    auto_renew: statement.auto_renew,
                    next_charge: Some(NextCharge {
                        at: current_period.end,
                        price: price.clone(),
                    }),
                    next_product_id: None,
                    cancel_requested_at: statement
                        .cancel_requested_at
                        .map(Instant::from_epoch_millis),
                },
                offer: None,
                price: price.clone(),
                storefront: None,
            },
            periods: vec![ObservedPeriod {
                transaction: StoreTransactionId::new(transaction),
                span: span(stretch),
                price,
                offer_kind: None,
                refunded_at: refunded_at.map(Instant::from_epoch_millis),
            }],
        }
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
    let RecordedEvent {
        seq,
        recorded_at,
        event,
    } = recorded_event(wire, wire["subscriptionId"].as_str().unwrap());
    FeedEntry {
        seq,
        recorded_at,
        event,
        store: Store::from_name(wire["store"].as_str().unwrap()).unwrap(),
        environment: Environment::from_name(wire["environment"].as_str().unwrap()).unwrap(),
        offer_kind: offer_kind(&wire["offerKind"]),
        entitlement: (!wire["entitlement"].is_null()).then(|| entitlement(&wire["entitlement"])),
    }
}

// An event of the feed or of an account read, of the subscription it belongs to.
fn recorded_event(wire: &Value, subscription_id: &str) -> RecordedEvent {
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
        (other, _) => panic!("a fixture tells a {other} this test does not read"),
    };
    RecordedEvent {
        seq: wire["seq"].as_i64().unwrap(),
        recorded_at: instant(&wire["recordedAt"]).unwrap(),
        event: Event {
            kind,
            occurred_at,
            subscription_id: SubscriptionId::new(subscription_id),
            account_id: wire["accountId"].as_str().map(AccountId::new),
        },
    }
}

fn account_record(wire: &Value) -> AccountRecord {
    let account_id = AccountId::new(wire["entitlement"]["accountId"].as_str().unwrap());
    let subscriptions = wire["subscriptions"]
        .as_array()
        .unwrap()
        .iter()
        .map(|listed| {
            let id = listed["subscriptionId"].as_str().unwrap();
            let binding = Binding {
                account_id: account_id.clone(),
                bound_at: instant(&listed["boundAt"]).unwrap(),
                bound_by: BoundBy::from_name(listed["boundBy"].as_str().unwrap()).unwrap(),
            };
            let environment =
                Environment::from_name(listed["environment"].as_str().unwrap()).unwrap();
            SubscriptionRecord {
                subscription: subscription(listed, environment, binding),
                periods: listed["periods"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|shown| period(shown, instant(&shown["start"]).unwrap()))
                    .collect(),
                events: listed["events"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|told| recorded_event(told, id))
                    .collect(),
            }
        })
        .collect();
    AccountRecord {
        entitlement: entitlement(&wire["entitlement"]),
        subscriptions,
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
                .map(|shown| {
                    let binding = Binding {
                        account_id: account_id.clone(),
                        bound_at: instant(&shown["startedAt"]).unwrap(),
                        bound_by: BoundBy::Purchase,
                    };
                    subscription(shown, environment, binding)
                })
                .collect::<Vec<_>>()
        })
        .collect();
    AccountEntitlement::of(account_id, held)
}

fn subscription(wire: &Value, environment: Environment, binding: Binding) -> Subscription {
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
        binding: Some(binding),
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
