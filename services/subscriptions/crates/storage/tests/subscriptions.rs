use std::env;
use std::panic::{AssertUnwindSafe, resume_unwind};

use domain::{
    BillingInterval, EndReason, Ending, Environment, Instant, Lineage, Money, NextCharge,
    Observation, ObservedPeriod, Offer, OfferKind, Ownership, PeriodChange, Plan, ProductId,
    Renewal, Span, State, Status, Store, StoreSubscriptionId, StoreTransactionId, Storefront,
};
use futures_util::FutureExt;
use sqlx::{AssertSqlSafe, Connection, Executor, PgConnection};
use storage::{AccountClaim, Applied, Ledger, Observed};
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
async fn every_state_and_name_the_domain_has_reads_back_as_written() {
    with_empty_database(async |url| {
        let ledger = Ledger::open(&url.parse().unwrap()).await.unwrap();
        let at = |day: i64| Instant::from_epoch_millis(1_798_761_600_000 + day * 86_400_000);
        let mut cases: Vec<Observed> = Vec::new();
        for store in Store::ALL {
            for environment in Environment::ALL {
                let mut observation = statement(
                    "bought",
                    State::Active {
                        pause_scheduled_for: None,
                    },
                );
                observation.lineage.store = *store;
                observation.lineage.environment = *environment;
                cases.push(unclaimed(observation, Some(Uuid::new_v4())));
            }
        }
        for reason in EndReason::ALL {
            let ending = Ending {
                at: at(30),
                reason: *reason,
            };
            cases.push(unclaimed(
                statement(
                    &format!("expired {}", reason.name()),
                    State::Expired(ending.clone()),
                ),
                None,
            ));
            cases.push(unclaimed(
                statement(
                    &format!("revoked {}", reason.name()),
                    State::Revoked(ending),
                ),
                None,
            ));
        }
        let states = [
            State::Active {
                pause_scheduled_for: Some(at(20)),
            },
            State::Grace {
                payment_failed_at: at(30),
                grace_ends_at: at(46),
            },
            State::OnHold {
                payment_failed_at: at(30),
            },
            State::Paused {
                paused_at: at(30),
                resumes_at: Some(at(60)),
            },
            State::Paused {
                paused_at: at(30),
                resumes_at: None,
            },
        ];
        for (index, state) in states.into_iter().enumerate() {
            cases.push(unclaimed(
                statement(&format!("{} {index}", state.name()), state),
                None,
            ));
        }
        for (index, kind) in OfferKind::ALL.iter().enumerate() {
            let mut observation = statement(
                kind.name(),
                State::Active {
                    pause_scheduled_for: None,
                },
            );
            observation.status.offer = Some(Offer {
                kind: *kind,
                ends_at: (index % 2 == 0).then(|| at(7)),
            });
            observation.periods[0].offer_kind = Some(*kind);
            cases.push(unclaimed(observation, None));
        }
        let mut cancelled = statement(
            "cancelled and refunded",
            State::Active {
                pause_scheduled_for: None,
            },
        );
        cancelled.status.renewal = Renewal {
            auto_renew: false,
            next_charge: None,
            next_product_id: Some(ProductId::new("works.windmill.app.one.yearly")),
            cancel_requested_at: Some(at(3)),
        };
        cancelled.status.price = Money::new("3.990", "KWD").unwrap();
        cancelled.status.storefront = None;
        cancelled.periods[0].price = Money::new("1800", "JPY").unwrap();
        cancelled.periods[0].refunded_at = Some(at(4));
        cases.push(Observed {
            observation: cancelled,
            hint: None,
            claim: Some(AccountClaim {
                account_id: Uuid::new_v4(),
                at: at(2),
            }),
            pulled_at: Some(at(2)),
        });

        let mut written = Vec::new();
        let mut read = Vec::new();
        for observed in cases {
            let lineage = observed.observation.lineage.clone();
            let Applied::Recorded { change, .. } = ledger.apply(observed).await.unwrap() else {
                panic!("an apply recorded nothing")
            };
            let periods = change
                .periods
                .iter()
                .map(|period_change| match period_change {
                    PeriodChange::Written(period) => period.clone(),
                    PeriodChange::Restated(_) => panic!("a new lineage restates nothing"),
                })
                .collect();
            written.push(domain::Ledger {
                subscription: Some(change.subscription),
                periods,
            });
            read.push(ledger.lineage(&lineage).await.unwrap());
        }

        assert_eq!(
            written.len(),
            6 + 2 * EndReason::ALL.len() + 5 + OfferKind::ALL.len() + 1
        );
        assert_eq!(read, written);
        ledger.close().await;
    })
    .await;
}

fn unclaimed(observation: Observation, hint: Option<Uuid>) -> Observed {
    Observed {
        observation,
        hint,
        claim: None,
        pulled_at: None,
    }
}

// A month of Windmill One stated in the given state, on a lineage of its own.
fn statement(lineage: &str, state: State) -> Observation {
    let start = Instant::from_epoch_millis(1_798_761_600_000);
    let end = Instant::from_epoch_millis(1_801_353_600_000);
    let price = Money::new("12.00", "USD").unwrap();
    Observation {
        lineage: Lineage {
            store: Store::AppStore,
            environment: Environment::Production,
            store_subscription_id: StoreSubscriptionId::new(lineage),
        },
        observed_at: Instant::from_epoch_millis(1_798_761_605_000),
        ownership: Ownership::Purchased,
        status: Status {
            plan: Plan::WindmillOne,
            product_id: ProductId::new("works.windmill.app.one.monthly"),
            billing_interval: BillingInterval::new("P1M"),
            started_at: start,
            state,
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
            transaction: StoreTransactionId::new(format!("{lineage} 1")),
            span: Span { start, end },
            price,
            offer_kind: None,
            refunded_at: None,
        }],
    }
}
