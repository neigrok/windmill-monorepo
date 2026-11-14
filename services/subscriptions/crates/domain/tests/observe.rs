use domain::{
    AccountHint, AccountId, Accounts, BillingInterval, Change, EndReason, Ending, Environment,
    Instant, Ledger, Lineage, Money, NewIds, NextCharge, Observation, ObservedPeriod, Offer,
    OfferKind, Ownership, Period, PeriodChange, PeriodId, Plan, ProductId, Renewal, Span, State,
    Status, Store, StoreSubscriptionId, StoreTransactionId, Storefront, SubscriptionId, observe,
};
use proptest::collection::{btree_set, vec};
use proptest::option;
use proptest::prelude::*;
use proptest::sample::select;

// A store's truth about one lineage, stated at several distinct instants, in an arbitrary order.
#[derive(Clone, Debug)]
struct History {
    observations: Vec<Observation>,
    hint: AccountHint,
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(512))]

    #[test]
    fn inv_4_an_observation_applied_twice_changes_nothing_and_records_nothing(history in history()) {
        let mut ledger = Ledger::default();
        for observation in history.observations {
            let change = observe_alone(&ledger, &observation, &history.hint);
            apply(&mut ledger, change);
            let again = observe_alone(&ledger, &observation, &history.hint);
            let unchanged = Change {
                subscription: ledger.subscription.clone().expect("the ledger holds the subscription"),
                periods: Vec::new(),
                events: Vec::new(),
                hint_for_store: None,
            };
            prop_assert_eq!(again, unchanged);
        }
    }

    #[test]
    fn inv_5_an_older_observation_changes_no_field_but_still_writes_and_refunds_periods(history in history()) {
        let newest = newest(&history.observations).clone();
        let mut ledger = Ledger::default();
        let change = observe_alone(&ledger, &newest, &history.hint);
        apply(&mut ledger, change);
        for observation in history.observations.iter().filter(|observation| **observation != newest) {
            let change = observe_alone(&ledger, observation, &history.hint);
            let restated: Vec<PeriodChange> = observation
                .periods
                .iter()
                .filter_map(|stated| match ledger.periods.iter().find(|held| held.transaction == stated.transaction) {
                    None => Some(PeriodChange::Written(Period {
                        id: PeriodId::new(format!("period-{}", stated.transaction.as_str())),
                        transaction: stated.transaction.clone(),
                        span: stated.span,
                        price: stated.price.clone(),
                        offer_kind: stated.offer_kind,
                        refunded_at: stated.refunded_at,
                        observed_at: observation.observed_at,
                    })),
                    Some(held) if observation.observed_at > held.observed_at => Some(PeriodChange::Restated(Period {
                        refunded_at: stated.refunded_at,
                        observed_at: observation.observed_at,
                        ..held.clone()
                    })),
                    Some(_) => None,
                })
                .collect();
            prop_assert_eq!(Some(&change.subscription), ledger.subscription.as_ref());
            prop_assert_eq!(&change.periods, &restated);
            prop_assert!(change.events.iter().all(|event| event.kind.period().is_some()), "a lifecycle event in {:?}", change.events);
            apply(&mut ledger, change);
        }
    }

    #[test]
    fn inv_6_any_order_ends_in_the_newest_observations_subscription_and_the_union_of_periods(history in history()) {
        let mut ledger = Ledger::default();
        for observation in &history.observations {
            let change = observe_alone(&ledger, observation, &history.hint);
            apply(&mut ledger, change);
        }

        let newest = newest(&history.observations);
        let alone = observe_alone(&Ledger::default(), newest, &history.hint).subscription;
        let mut union: Vec<Period> = Vec::new();
        for observation in &history.observations {
            for stated in &observation.periods {
                let period = Period {
                    id: PeriodId::new(format!("period-{}", stated.transaction.as_str())),
                    transaction: stated.transaction.clone(),
                    span: stated.span,
                    price: stated.price.clone(),
                    offer_kind: stated.offer_kind,
                    refunded_at: stated.refunded_at,
                    observed_at: observation.observed_at,
                };
                match union.iter_mut().find(|known| known.transaction == stated.transaction) {
                    None => union.push(period),
                    Some(known) if known.observed_at < period.observed_at => *known = period,
                    Some(_) => {}
                }
            }
        }
        union.sort_by(|one, other| one.transaction.cmp(&other.transaction));
        ledger.periods.sort_by(|one, other| one.transaction.cmp(&other.transaction));

        prop_assert_eq!(ledger.subscription, Some(alone));
        prop_assert_eq!(ledger.periods, union);
    }
}

fn observe_alone(ledger: &Ledger, observation: &Observation, hint: &AccountHint) -> Change {
    let ids = NewIds::for_observation(observation, SubscriptionId::new("sub-lineage"), |period| {
        PeriodId::new(format!("period-{}", period.transaction.as_str()))
    });
    let accounts = Accounts {
        hint: hint.clone(),
        claim: None,
    };
    observe(ledger.clone(), observation.clone(), accounts, ids)
        .expect("an observation without a claim is never refused")
}

fn apply(ledger: &mut Ledger, change: Change) {
    ledger.subscription = Some(change.subscription);
    for period_change in change.periods {
        match period_change {
            PeriodChange::Written(period) => ledger.periods.push(period),
            PeriodChange::Restated(period) => {
                let held = ledger
                    .periods
                    .iter_mut()
                    .find(|held| held.id == period.id)
                    .expect("a restated period is held");
                *held = period;
            }
        }
    }
}

fn newest(observations: &[Observation]) -> &Observation {
    observations
        .iter()
        .max_by_key(|observation| observation.observed_at)
        .expect("a history states at least once")
}

fn at(minute: i64) -> Instant {
    Instant::from_epoch_millis(1_798_761_600_000 + minute * 60_000)
}

fn usd(amount: &str) -> Money {
    Money::new(amount, "USD").expect("a price")
}

// Four monthly transactions; each may be refunded at some minute, and that refund reversed later.
fn transaction_span(index: usize) -> Span {
    let month = 43_200 * i64::try_from(index).expect("a small index");
    Span {
        start: at(month),
        end: at(month + 43_200),
    }
}

fn history() -> impl Strategy<Value = History> {
    let refund = option::of((0..200_000i64, option::of(1..100_000i64)));
    (
        vec(refund, 4),
        btree_set(0..200_000i64, 1..=6),
        prop_oneof![
            Just(AccountHint::Absent),
            Just(AccountHint::Live(AccountId::new("account-ada")))
        ],
        prop_oneof![Just(Ownership::Purchased), Just(Ownership::Shared)],
    )
        .prop_flat_map(|(refunds, minutes, hint, ownership)| {
            let count = minutes.len();
            (
                Just(refunds),
                Just(minutes.into_iter().collect::<Vec<_>>()),
                Just(hint),
                Just(ownership),
                vec(status(), count),
                vec(vec(any::<bool>(), 4), count),
            )
        })
        .prop_flat_map(|(refunds, minutes, hint, ownership, statuses, stated)| {
            let observations: Vec<Observation> = minutes
                .iter()
                .zip(statuses)
                .zip(stated)
                .map(|((minute, status), stated)| Observation {
                    lineage: Lineage {
                        store: Store::AppStore,
                        environment: Environment::Production,
                        store_subscription_id: StoreSubscriptionId::new("lineage"),
                    },
                    observed_at: at(*minute),
                    ownership,
                    status,
                    periods: (0..4)
                        .filter(|index| stated[*index])
                        .map(|index| ObservedPeriod {
                            transaction: StoreTransactionId::new(format!("t{index}")),
                            span: transaction_span(index),
                            price: usd("11.99"),
                            offer_kind: (index == 0).then_some(OfferKind::Introductory),
                            refunded_at: match refunds[index] {
                                Some((refunded, reversal))
                                    if refunded <= *minute
                                        && reversal
                                            .is_none_or(|after| *minute < refunded + after) =>
                                {
                                    Some(at(refunded))
                                }
                                _ => None,
                            },
                        })
                        .collect(),
                })
                .collect();
            (Just(observations).prop_shuffle(), Just(hint))
        })
        .prop_map(|(observations, hint)| History { observations, hint })
}

fn status() -> impl Strategy<Value = Status> {
    let minute = || (0..200_000i64).prop_map(at);
    let state = prop_oneof![
        option::of(minute()).prop_map(|pause_scheduled_for| State::Active {
            pause_scheduled_for
        }),
        (minute(), minute()).prop_map(|(payment_failed_at, grace_ends_at)| State::Grace {
            payment_failed_at,
            grace_ends_at
        }),
        minute().prop_map(|payment_failed_at| State::OnHold { payment_failed_at }),
        (minute(), option::of(minute())).prop_map(|(paused_at, resumes_at)| State::Paused {
            paused_at,
            resumes_at
        }),
        (minute(), select(EndReason::ALL))
            .prop_map(|(at, reason)| State::Expired(Ending { at, reason })),
        (minute(), select(EndReason::ALL))
            .prop_map(|(at, reason)| State::Revoked(Ending { at, reason })),
    ];
    let renewal = (
        any::<bool>(),
        option::of((minute(), select(vec!["11.99", "14.99"]))),
        option::of(Just("one.monthly.plus")),
        option::of(minute()),
    )
        .prop_map(
            |(auto_renew, next_charge, next_product_id, cancel_requested_at)| Renewal {
                auto_renew,
                next_charge: next_charge.map(|(at, amount)| NextCharge {
                    at,
                    price: usd(amount),
                }),
                next_product_id: next_product_id.map(ProductId::new),
                cancel_requested_at,
            },
        );
    let offer = option::of((select(OfferKind::ALL), option::of(minute())))
        .prop_map(|offer| offer.map(|(kind, ends_at)| Offer { kind, ends_at }));
    (
        state,
        0..4usize,
        renewal,
        offer,
        select(vec!["one.monthly", "one.monthly.plus"]),
    )
        .prop_map(|(state, in_force, renewal, offer, product)| Status {
            plan: Plan::WindmillOne,
            product_id: ProductId::new(product),
            billing_interval: BillingInterval::new("P1M"),
            started_at: at(0),
            state,
            current_period: transaction_span(in_force),
            renewal,
            offer,
            price: usd("11.99"),
            storefront: Storefront::new("USA"),
        })
}
