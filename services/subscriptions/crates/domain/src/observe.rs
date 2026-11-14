use std::error::Error;
use std::fmt;

use crate::subscription::{
    Binding, BoundBy, Lineage, OfferKind, Period, Renewal, State, Status, Subscription,
};
use crate::values::{
    AccountId, Instant, Money, PeriodId, Span, StoreTransactionId, SubscriptionId, closed_names,
};

// D-5: one store's whole statement about one subscription, stamped with the store's own time.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Observation {
    pub lineage: Lineage,
    pub observed_at: Instant,
    pub ownership: Ownership,
    pub status: Status,
    pub periods: Vec<ObservedPeriod>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ObservedPeriod {
    pub transaction: StoreTransactionId,
    pub span: Span,
    pub price: Money,
    pub offer_kind: Option<OfferKind>,
    pub refunded_at: Option<Instant>,
}

// The observation's account hint, which the caller resolves against the erased accounts before observe.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AccountHint {
    Absent,
    Live(AccountId),
    Erased,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Claim {
    pub account_id: AccountId,
    pub at: Instant,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Accounts {
    pub hint: AccountHint,
    pub claim: Option<Claim>,
}

// Ids are minted by the caller, one for each period the observation states, so observe stays deterministic.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NewIds {
    subscription: SubscriptionId,
    periods: Vec<PeriodId>,
}

impl NewIds {
    pub fn for_observation(
        observation: &Observation,
        subscription: SubscriptionId,
        period: impl FnMut(&ObservedPeriod) -> PeriodId,
    ) -> NewIds {
        NewIds {
            subscription,
            periods: observation.periods.iter().map(period).collect(),
        }
    }
}

// What the ledger holds for one lineage.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Ledger {
    pub subscription: Option<Subscription>,
    pub periods: Vec<Period>,
}

// What one observation changes, persisted whole in one transaction.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Change {
    pub subscription: Subscription,
    pub periods: Vec<PeriodChange>,
    pub events: Vec<Event>,
    pub hint_for_store: Option<AccountId>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PeriodChange {
    Written(Period),
    Restated(Period),
}

// D-6. The ledger stamps `seq` and `recordedAt` when it appends the event.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Event {
    pub kind: EventKind,
    pub occurred_at: Instant,
    pub subscription_id: SubscriptionId,
    pub account_id: Option<AccountId>,
}

// INV-13: the period events are the only ones that carry a period.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum EventKind {
    Started,
    Renewed,
    RenewalTurnedOff,
    RenewalTurnedOn,
    PaymentFailed,
    PaymentRecovered,
    PauseScheduled,
    Paused,
    Resumed,
    PlanChangeScheduled,
    PlanChanged,
    PeriodExtended,
    Updated,
    Expired,
    Revoked,
    RevocationReversed,
    Bound,
    Unbound,
    PeriodRecorded(Period),
    PeriodRefunded(Period),
    PeriodRefundReversed(Period),
}

impl EventKind {
    pub fn name(&self) -> &'static str {
        match self {
            EventKind::Started => "started",
            EventKind::Renewed => "renewed",
            EventKind::RenewalTurnedOff => "renewal_turned_off",
            EventKind::RenewalTurnedOn => "renewal_turned_on",
            EventKind::PaymentFailed => "payment_failed",
            EventKind::PaymentRecovered => "payment_recovered",
            EventKind::PauseScheduled => "pause_scheduled",
            EventKind::Paused => "paused",
            EventKind::Resumed => "resumed",
            EventKind::PlanChangeScheduled => "plan_change_scheduled",
            EventKind::PlanChanged => "plan_changed",
            EventKind::PeriodExtended => "period_extended",
            EventKind::Updated => "updated",
            EventKind::Expired => "expired",
            EventKind::Revoked => "revoked",
            EventKind::RevocationReversed => "revocation_reversed",
            EventKind::Bound => "bound",
            EventKind::Unbound => "unbound",
            EventKind::PeriodRecorded(_) => "period_recorded",
            EventKind::PeriodRefunded(_) => "period_refunded",
            EventKind::PeriodRefundReversed(_) => "period_refund_reversed",
        }
    }

    pub fn period(&self) -> Option<&Period> {
        match self {
            EventKind::PeriodRecorded(period)
            | EventKind::PeriodRefunded(period)
            | EventKind::PeriodRefundReversed(period) => Some(period),
            _ => None,
        }
    }
}

closed_names! {
    pub enum Ownership {
        Purchased = "purchased",
        Shared = "shared",
    }

    pub enum Refusal {
        BoundToAnotherAccount = "bound_to_another_account",
    }
}

impl fmt::Display for Refusal {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.name())
    }
}

impl Error for Refusal {}

// §3.4: the domain's one write. Every store, door and sweep reaches the ledger through it.
pub fn observe(
    ledger: Ledger,
    observation: Observation,
    accounts: Accounts,
    ids: NewIds,
) -> Result<Change, Refusal> {
    let Observation {
        lineage,
        observed_at,
        ownership,
        status,
        periods: stated_periods,
    } = observation;
    let Ledger {
        subscription: held,
        periods: held_periods,
    } = ledger;
    assert!(
        held.as_ref().is_none_or(|held| held.lineage == lineage),
        "observe was handed the ledger of another lineage"
    );

    let adopts_status = held
        .as_ref()
        .is_none_or(|held| observed_at > held.observed_at);
    let status = status.charging_only_while_renewing();
    let mut subscription = match held.clone() {
        None => Subscription {
            id: ids.subscription.clone(),
            lineage,
            binding: None,
            status,
            observed_at,
        },
        Some(held) if adopts_status => Subscription {
            status,
            observed_at,
            ..held
        },
        Some(held) => held,
    };

    let held_binding = held.as_ref().and_then(|held| held.binding.clone());
    subscription.binding = bind(
        held_binding.clone(),
        ownership,
        &accounts,
        subscription.status.started_at,
    )?;
    let newly_bound = match (held_binding, &subscription.binding) {
        (None, Some(binding)) => Some(binding.clone()),
        _ => None,
    };

    let (period_changes, period_events) = record_periods(
        &held_periods,
        stated_periods,
        ids,
        observed_at,
        newly_bound.is_some(),
    );

    let lifecycle = if adopts_status {
        lifecycle_events(
            held.as_ref().map(|held| &held.status),
            &subscription.status,
            observed_at,
        )
    } else {
        Vec::new()
    };
    let (ending, going_on): (Vec<_>, Vec<_>) = lifecycle
        .into_iter()
        .partition(|(kind, _)| matches!(kind, EventKind::Expired | EventKind::Revoked));
    let bound = newly_bound
        .as_ref()
        .map(|binding| (EventKind::Bound, binding.bound_at));
    let events = going_on
        .into_iter()
        .chain(bound)
        .chain(period_events)
        .chain(ending)
        .map(|(kind, occurred_at)| Event {
            kind,
            occurred_at,
            subscription_id: subscription.id.clone(),
            account_id: subscription.account_id().cloned(),
        })
        .collect();

    let hint_for_store = newly_bound
        .filter(|binding| binding.bound_by == BoundBy::Claim)
        .map(|binding| binding.account_id);
    Ok(Change {
        subscription,
        periods: period_changes,
        events,
        hint_for_store,
    })
}

// §4. A hint binds only a purchase its buyer owns; a claim binds what no hint has.
fn bind(
    held: Option<Binding>,
    ownership: Ownership,
    accounts: &Accounts,
    purchased_at: Instant,
) -> Result<Option<Binding>, Refusal> {
    let binding = held.or_else(|| match (&accounts.hint, ownership) {
        (AccountHint::Live(account_id), Ownership::Purchased) => Some(Binding {
            account_id: account_id.clone(),
            bound_at: purchased_at,
            bound_by: BoundBy::Purchase,
        }),
        _ => None,
    });
    let Some(claim) = &accounts.claim else {
        return Ok(binding);
    };
    match (binding, &accounts.hint) {
        (Some(binding), _) if binding.account_id == claim.account_id => Ok(Some(binding)),
        (Some(_), _) => Err(Refusal::BoundToAnotherAccount),
        (None, AccountHint::Live(hinted)) if *hinted != claim.account_id => {
            Err(Refusal::BoundToAnotherAccount)
        }
        (None, _) if ownership == Ownership::Shared => Ok(None),
        (None, _) => Ok(Some(Binding {
            account_id: claim.account_id.clone(),
            bound_at: claim.at,
            bound_by: BoundBy::Claim,
        })),
    }
}

// INV-7 and INV-13: a stated period the ledger lacks is written; a newer statement of a held one moves
// its refund time. Each change records its period event, and a binding records every period again.
fn record_periods(
    held: &[Period],
    stated: Vec<ObservedPeriod>,
    ids: NewIds,
    observed_at: Instant,
    binds: bool,
) -> (Vec<PeriodChange>, Vec<(EventKind, Instant)>) {
    assert_eq!(
        ids.periods.len(),
        stated.len(),
        "NewIds was minted for another observation"
    );
    let mut periods = held.to_vec();
    let mut changes = Vec::new();
    for (stated, id) in stated.into_iter().zip(ids.periods) {
        match periods
            .iter_mut()
            .find(|period| period.transaction == stated.transaction)
        {
            None => {
                let period = Period {
                    id,
                    transaction: stated.transaction,
                    span: stated.span,
                    price: stated.price,
                    offer_kind: stated.offer_kind,
                    refunded_at: stated.refunded_at,
                    observed_at,
                };
                changes.push(PeriodChange::Written(period.clone()));
                periods.push(period);
            }
            Some(period) if observed_at > period.observed_at => {
                period.refunded_at = stated.refunded_at;
                period.observed_at = observed_at;
                changes.push(PeriodChange::Restated(period.clone()));
            }
            Some(_) => {}
        }
    }

    let mut events = Vec::new();
    periods.sort_by(|one, other| {
        (one.span.start, &one.transaction).cmp(&(other.span.start, &other.transaction))
    });
    for period in periods {
        let before = held.iter().find(|held| held.id == period.id);
        if before.is_none() || binds {
            events.push((EventKind::PeriodRecorded(period.clone()), observed_at));
        }
        let refunded_before = before.and_then(|before| before.refunded_at);
        let refund_event = match (refunded_before, period.refunded_at) {
            (earlier, Some(refunded_at)) if earlier != Some(refunded_at) => {
                Some((EventKind::PeriodRefunded(period), refunded_at))
            }
            (Some(_), None) => Some((EventKind::PeriodRefundReversed(period), observed_at)),
            _ => None,
        };
        events.extend(refund_event);
    }
    (changes, events)
}

// The events a change of status records, in story order. A lineage that starts, or starts again
// after it ended, is told as a fresh renewing subscription that moved to what the store states. A new
// period in force records the one event that names how it came: started, renewed, payment_recovered
// or resumed.
fn lifecycle_events(
    held: Option<&Status>,
    after: &Status,
    observed_at: Instant,
) -> Vec<(EventKind, Instant)> {
    let active: fn(&State) -> bool = |state| matches!(state, State::Active { .. });
    let paused: fn(&State) -> bool = |state| matches!(state, State::Paused { .. });
    let expired: fn(&State) -> bool = |state| matches!(state, State::Expired(_));
    let revoked: fn(&State) -> bool = |state| matches!(state, State::Revoked(_));
    let in_trouble: fn(&State) -> bool = State::in_payment_trouble;

    let starts_again = |before: &Status| match before.state {
        State::Expired(_) => !after.state.has_ended(),
        State::Revoked(_) => {
            !after.state.has_ended() && after.current_period.start != before.current_period.start
        }
        _ => false,
    };
    let freshly_started = Status {
        state: State::Active {
            pause_scheduled_for: None,
        },
        renewal: Renewal {
            auto_renew: true,
            next_product_id: None,
            cancel_requested_at: None,
            ..after.renewal.clone()
        },
        ..after.clone()
    };
    let mut events = Vec::new();
    let before = match held {
        Some(before) if !starts_again(before) => before,
        _ => {
            let purchased_at = match held {
                None => after.started_at,
                Some(_) => after.current_period.start,
            };
            events.push((EventKind::Started, purchased_at));
            &freshly_started
        }
    };

    let (was, is) = (&before.state, &after.state);
    let enters = |kind: fn(&State) -> bool| kind(is) && !kind(was);
    let leaves = |kind: fn(&State) -> bool| kind(was) && !kind(is);
    let new_period = after.current_period.start != before.current_period.start;
    let ended_at = is.ending().map_or(observed_at, |ending| ending.at);
    let story = [
        (leaves(revoked), EventKind::RevocationReversed, observed_at),
        (
            in_trouble(was) && active(is),
            EventKind::PaymentRecovered,
            observed_at,
        ),
        (paused(was) && active(is), EventKind::Resumed, observed_at),
        (active(was) && new_period, EventKind::Renewed, observed_at),
        (
            after.product_id != before.product_id,
            EventKind::PlanChanged,
            observed_at,
        ),
        (
            !new_period && after.current_period.end > before.current_period.end,
            EventKind::PeriodExtended,
            observed_at,
        ),
        (
            enters(in_trouble),
            EventKind::PaymentFailed,
            is.payment_failed_at().unwrap_or(observed_at),
        ),
        (
            before.renewal.auto_renew && !after.renewal.auto_renew,
            EventKind::RenewalTurnedOff,
            after.renewal.cancel_requested_at.unwrap_or(observed_at),
        ),
        (
            !before.renewal.auto_renew && after.renewal.auto_renew,
            EventKind::RenewalTurnedOn,
            observed_at,
        ),
        (
            after.renewal.next_product_id.is_some()
                && after.renewal.next_product_id != before.renewal.next_product_id,
            EventKind::PlanChangeScheduled,
            observed_at,
        ),
        (
            is.pause_scheduled_for().is_some()
                && is.pause_scheduled_for() != was.pause_scheduled_for(),
            EventKind::PauseScheduled,
            observed_at,
        ),
        (
            enters(paused),
            EventKind::Paused,
            is.paused_at().unwrap_or(observed_at),
        ),
        (enters(expired), EventKind::Expired, ended_at),
        (enters(revoked), EventKind::Revoked, ended_at),
    ];
    events.extend(
        story
            .into_iter()
            .filter(|(happened, ..)| *happened)
            .map(|(_, kind, at)| (kind, at)),
    );

    let shown = |status: &Status| {
        (
            status.state.clone(),
            status.started_at,
            status.current_period,
            status.renewal.clone(),
            status.offer.clone(),
        )
    };
    if events.is_empty() && shown(before) != shown(after) {
        events.push((EventKind::Updated, observed_at));
    }
    events
}
