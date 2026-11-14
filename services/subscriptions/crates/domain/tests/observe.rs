use std::collections::BTreeMap;

use domain::{
    AccountHint, AccountId, Accounts, BillingInterval, Binding, BoundBy, Change, EndReason, Ending,
    Environment, Event, EventKind, Instant, Ledger, Lineage, Money, NextCharge, Observation,
    ObservedPeriod, Offer, OfferKind, Ownership, Period, PeriodChange, PeriodId, Plan, ProductId,
    Renewal, Span, State, Status, Store, StoreSubscriptionId, StoreTransactionId, Storefront,
    Subscription, SubscriptionId, observe,
};
use proptest::collection::vec;
use proptest::option;
use proptest::prelude::*;
use proptest::sample::select;

// A store's truth about one lineage, stated at instants that may tie, each with the hint it carried.
#[derive(Clone, Debug)]
struct History {
    observations: Vec<(Observation, AccountHint)>,
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(2000))]

    #[test]
    fn inv_4_an_observation_applied_twice_changes_nothing_and_records_nothing(history in history()) {
        let mut ledger = Ledger::default();
        for (observation, hint) in &history.observations {
            let change = observe_alone(&ledger, observation, hint);
            apply(&mut ledger, change);
            let again = observe_alone(&ledger, observation, hint);
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
    fn inv_5_a_superseded_observation_changes_no_field_but_still_binds_writes_and_refunds(history in history()) {
        let newest = newest(&history);
        let mut ledger = Ledger::default();
        let change = observe_alone(&ledger, &history.observations[newest].0, &history.observations[newest].1);
        apply(&mut ledger, change);
        for (observation, hint) in history.observations.iter().enumerate().filter(|(index, _)| *index != newest).map(|(_, step)| step) {
            let held = ledger.subscription.clone().expect("the newest observation wrote the subscription");
            let change = observe_alone(&ledger, observation, hint);
            let binding = held.binding.clone().or_else(|| bound_by_hint(observation.ownership, hint));
            let cancellation = held
                .cancellation_observed_at
                .map(|observed_at| (observed_at, held.status.renewal.cancel_requested_at.is_none(), held.status.renewal.cancel_requested_at))
                .max(stated_cancellation(observation));
            let mut expected = Subscription { binding, ..held.clone() };
            expected.status.renewal.cancel_requested_at = cancellation.and_then(|(_, _, requested_at)| requested_at);
            expected.cancellation_observed_at = cancellation.map(|(observed_at, _, _)| observed_at);
            let cancel_time_changed = expected.status != held.status;
            let restated: Vec<PeriodChange> = observation
                .periods
                .iter()
                .filter_map(|stated| match ledger.periods.iter().find(|period| period.transaction == stated.transaction) {
                    None => Some(PeriodChange::Written(written(stated, observation.observed_at))),
                    Some(period)
                        if (observation.observed_at, stated.refunded_at) > (period.observed_at, period.refunded_at) =>
                    {
                        Some(PeriodChange::Restated(Period {
                            refunded_at: stated.refunded_at,
                            observed_at: observation.observed_at,
                            ..period.clone()
                        }))
                    }
                    Some(_) => None,
                })
                .collect();
            prop_assert_eq!(&change.subscription, &expected);
            prop_assert_eq!(&change.periods, &restated);
            prop_assert!(
                change.events.iter().all(|event| event.kind.period().is_some()
                    || event.kind == EventKind::Bound
                    || (event.kind == EventKind::Updated && cancel_time_changed)),
                "a state event in {:?}",
                change.events
            );
            apply(&mut ledger, change);
        }
    }

    #[test]
    fn inv_6_any_order_ends_in_the_newest_statement_and_the_union_of_periods_ties_and_hints_included(history in history()) {
        let ledger = replay(&history.observations);

        let alone = history
            .observations
            .iter()
            .map(|(observation, _)| observe_alone(&Ledger::default(), observation, &AccountHint::Absent).subscription)
            .max_by_key(statement_order)
            .expect("a history states at least once");
        let cancellation = history.observations.iter().filter_map(|(observation, _)| stated_cancellation(observation)).max();
        let mut status = alone.status.clone();
        status.renewal.cancel_requested_at = cancellation.and_then(|(_, _, requested_at)| requested_at);
        let binding = history
            .observations
            .iter()
            .find_map(|(observation, hint)| bound_by_hint(observation.ownership, hint));
        let mut union: BTreeMap<StoreTransactionId, Period> = BTreeMap::new();
        for (observation, _) in &history.observations {
            for stated in &observation.periods {
                let period = written(stated, observation.observed_at);
                let supersedes = union.get(&stated.transaction).is_none_or(|known| {
                    (period.observed_at, period.refunded_at) > (known.observed_at, known.refunded_at)
                });
                if supersedes {
                    union.insert(stated.transaction.clone(), period);
                }
            }
        }
        let mut periods = ledger.periods.clone();
        periods.sort_by(|one, other| one.transaction.cmp(&other.transaction));

        prop_assert_eq!(
            ledger.subscription,
            Some(Subscription {
                binding,
                status,
                cancellation_observed_at: cancellation.map(|(observed_at, _, _)| observed_at),
                ..alone
            })
        );
        prop_assert_eq!(periods, union.into_values().collect::<Vec<_>>());
    }

    #[test]
    fn funding_from_the_feed_converges_under_any_order(history in history()) {
        let mut in_stamp_order = history.observations.clone();
        in_stamp_order.sort_by_key(|(observation, _)| observation.observed_at);
        prop_assert_eq!(open_grants(&history.observations), open_grants(&in_stamp_order));
    }
}

fn observe_alone(ledger: &Ledger, observation: &Observation, hint: &AccountHint) -> Change {
    let observation = observation
        .clone()
        .mint_ids(SubscriptionId::new("sub-lineage"), |period| {
            PeriodId::new(format!("period-{}", period.transaction.as_str()))
        });
    let accounts = Accounts {
        hint: hint.clone(),
        claim: None,
    };
    observe(ledger.clone(), observation, accounts)
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

fn replay(observations: &[(Observation, AccountHint)]) -> Ledger {
    let mut ledger = Ledger::default();
    for (observation, hint) in observations {
        let change = observe_alone(&ledger, observation, hint);
        apply(&mut ledger, change);
    }
    ledger
}

fn newest(history: &History) -> usize {
    (0..history.observations.len())
        .max_by_key(|index| {
            let observation = &history.observations[*index].0;
            statement_order(
                &observe_alone(&Ledger::default(), observation, &AccountHint::Absent).subscription,
            )
        })
        .expect("a history states at least once")
}

// INV-6's order of statements; the cancel time follows its own (§3.1), so it takes no part.
fn statement_order(subscription: &Subscription) -> (Instant, Status) {
    let mut status = subscription.status.clone();
    status.renewal.cancel_requested_at = None;
    (subscription.observed_at, status)
}

// A statement of the cancellation as cancelRequestedAt orders them: by stamp, renewal on above off, then the time stated.
fn stated_cancellation(observation: &Observation) -> Option<(Instant, bool, Option<Instant>)> {
    let renewal = &observation.status.renewal;
    match (renewal.auto_renew, renewal.cancel_requested_at) {
        (true, _) => Some((observation.observed_at, true, None)),
        (false, Some(requested_at)) => Some((observation.observed_at, false, Some(requested_at))),
        (false, None) => None,
    }
}

fn bound_by_hint(ownership: Ownership, hint: &AccountHint) -> Option<Binding> {
    match (ownership, hint) {
        (Ownership::Purchased, AccountHint::Live(account_id)) => Some(Binding {
            account_id: account_id.clone(),
            bound_at: at(0),
            bound_by: BoundBy::Purchase,
        }),
        _ => None,
    }
}

fn written(stated: &ObservedPeriod, observed_at: Instant) -> Period {
    Period {
        id: PeriodId::new(format!("period-{}", stated.transaction.as_str())),
        transaction: stated.transaction.clone(),
        span: stated.span,
        price: stated.price.clone(),
        offer_kind: stated.offer_kind,
        refunded_at: stated.refunded_at,
        observed_at,
    }
}

// §6.3 as the backend's follower applies the feed, over one production lineage: the open grants it ends with.
fn open_grants(observations: &[(Observation, AccountHint)]) -> BTreeMap<PeriodId, AccountId> {
    let mut ledger = Ledger::default();
    let mut feed: Vec<Event> = Vec::new();
    for (observation, hint) in observations {
        let change = observe_alone(&ledger, observation, hint);
        feed.extend(change.events.clone());
        apply(&mut ledger, change);
    }

    let mut grants: BTreeMap<PeriodId, (AccountId, Span, Option<Instant>)> = BTreeMap::new();
    let overlaps = |grants: &BTreeMap<PeriodId, (AccountId, Span, Option<Instant>)>,
                    period: &Period,
                    account: &AccountId| {
        grants.iter().any(|(id, (holder, span, closed_at))| {
            *id != period.id
                && holder == account
                && period.span.start
                    < closed_at.map_or(span.end, |closed_at| closed_at.min(span.end))
                && span.start < period.span.end
        })
    };
    let fund = |grants: &mut BTreeMap<PeriodId, (AccountId, Span, Option<Instant>)>,
                period: &Period,
                account: &AccountId| {
        let paid = period
            .price
            .amount()
            .bytes()
            .any(|digit| (b'1'..=b'9').contains(&digit));
        if paid && !grants.contains_key(&period.id) && !overlaps(grants, period, account) {
            grants.insert(period.id.clone(), (account.clone(), period.span, None));
        }
    };
    for event in &feed {
        let Some(account) = &event.account_id else {
            continue;
        };
        match &event.kind {
            EventKind::PeriodRecorded(period) if period.refunded_at.is_none() => {
                fund(&mut grants, period, account)
            }
            EventKind::PeriodRefunded(period) => {
                if let Some((_, span, closed_at)) = grants.get_mut(&period.id) {
                    *closed_at = period
                        .refunded_at
                        .map(|refunded_at| refunded_at.min(span.end));
                }
            }
            EventKind::PeriodRefundReversed(period) => match grants.get(&period.id).cloned() {
                Some((holder, _, _)) if !overlaps(&grants, period, &holder) => {
                    grants
                        .entry(period.id.clone())
                        .and_modify(|(_, _, closed_at)| *closed_at = None);
                }
                Some(_) => {}
                None => fund(&mut grants, period, account),
            },
            _ => {}
        }
    }
    grants
        .into_iter()
        .filter(|(_, (_, _, closed_at))| closed_at.is_none())
        .map(|(id, (account, _, _))| (id, account))
        .collect()
}

fn at(minute: i64) -> Instant {
    Instant::from_epoch_millis(1_798_761_600_000 + minute * 60_000)
}

fn usd(amount: &str) -> Money {
    Money::new(amount, "USD").expect("a price")
}

fn transaction_span(index: usize) -> Span {
    let month = 43_200 * i64::try_from(index).expect("a small index");
    Span {
        start: at(month),
        end: at(month + 43_200),
    }
}

fn history() -> impl Strategy<Value = History> {
    let refund = option::of((0..200_000i64, option::of(1..100_000i64)));
    let stamp = (0..40i64).prop_map(|slot| slot * 5_000);
    let hint = prop_oneof![
        Just(AccountHint::Absent),
        Just(AccountHint::Live(AccountId::new("account-ada"))),
        Just(AccountHint::Erased),
    ];
    (
        vec(refund, 4),
        vec(stamp, 1..=6),
        prop_oneof![Just(Ownership::Purchased), Just(Ownership::Shared)],
    )
        .prop_flat_map(move |(refunds, minutes, ownership)| {
            let count = minutes.len();
            (
                Just(refunds),
                Just(minutes),
                Just(ownership),
                vec(status(), count),
                vec(vec(any::<bool>(), 4), count),
                vec(hint.clone(), count),
            )
        })
        .prop_flat_map(|(refunds, minutes, ownership, statuses, stated, hints)| {
            let observations: Vec<(Observation, AccountHint)> = minutes
                .iter()
                .zip(statuses)
                .zip(stated)
                .zip(hints)
                .map(|(((minute, status), stated), hint)| {
                    let observation = Observation {
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
                    };
                    (observation, hint)
                })
                .collect();
            Just(observations).prop_shuffle()
        })
        .prop_map(|observations| History { observations })
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
            storefront: Some(Storefront::new("USA")),
        })
}
