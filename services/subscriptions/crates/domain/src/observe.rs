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

impl Observation {
    pub fn mint_ids(
        self,
        subscription_id: SubscriptionId,
        period_id: impl FnMut(&ObservedPeriod) -> PeriodId,
    ) -> MintedObservation {
        let period_ids = self.periods.iter().map(period_id).collect();
        MintedObservation {
            observation: self,
            subscription_id,
            period_ids,
        }
    }
}

// An observation with the ids its new records take, minted by the caller so observe stays deterministic.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MintedObservation {
    observation: Observation,
    subscription_id: SubscriptionId,
    period_ids: Vec<PeriodId>,
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
    observation: MintedObservation,
    accounts: Accounts,
) -> Result<Change, Refusal> {
    let MintedObservation {
        observation:
            Observation {
                lineage,
                observed_at,
                ownership,
                status,
                periods: stated_periods,
            },
        subscription_id,
        period_ids,
    } = observation;
    let Ledger {
        subscription: held,
        periods: held_periods,
    } = ledger;
    assert!(
        held.as_ref().is_none_or(|held| held.lineage == lineage),
        "observe was handed the ledger of another lineage"
    );

    let status = status.charging_only_while_renewing();
    let supersedes = held
        .as_ref()
        .is_none_or(|held| (observed_at, &status) > (held.observed_at, &held.status));
    let bought_again_at = held
        .as_ref()
        .filter(|held| supersedes && status.is_bought_again_after(&held.status))
        .map(|_| status.current_period.start);
    let mut subscription = match held.clone() {
        None => Subscription {
            id: subscription_id,
            lineage,
            binding: None,
            status,
            observed_at,
        },
        Some(held) if supersedes => Subscription {
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
        bought_again_at,
    )?;
    let first_bound = held_binding.is_none() && subscription.binding.is_some();

    let stated_periods = stated_periods.into_iter().zip(period_ids).collect();
    let (period_changes, period_events) =
        record_periods(&held_periods, stated_periods, observed_at, first_bound);

    let lifecycle = match &held {
        Some(held) if !supersedes => Vec::new(),
        held => lifecycle_events(
            held.as_ref().map(|held| &held.status),
            &subscription.status,
            observed_at,
        ),
    };
    let (ending, going_on): (Vec<_>, Vec<_>) = lifecycle
        .into_iter()
        .partition(|(kind, _)| matches!(kind, EventKind::Expired | EventKind::Revoked));
    let account_id = subscription.account_id().cloned();
    let event = |(kind, occurred_at): (EventKind, Instant), account_id: Option<AccountId>| Event {
        kind,
        occurred_at,
        subscription_id: subscription.id.clone(),
        account_id,
    };
    let binding_events = match (&held_binding, &subscription.binding) {
        (Some(before), Some(after)) if before.account_id != after.account_id => vec![
            event(
                (EventKind::Unbound, after.bound_at),
                Some(before.account_id.clone()),
            ),
            event(
                (EventKind::Bound, after.bound_at),
                Some(after.account_id.clone()),
            ),
        ],
        (None, Some(after)) => vec![event(
            (EventKind::Bound, after.bound_at),
            Some(after.account_id.clone()),
        )],
        _ => Vec::new(),
    };
    let events = going_on
        .into_iter()
        .map(|moment| event(moment, account_id.clone()))
        .chain(binding_events)
        .chain(
            period_events
                .into_iter()
                .chain(ending)
                .map(|moment| event(moment, account_id.clone())),
        )
        .collect();

    let hint_for_store = subscription
        .binding
        .as_ref()
        .filter(|binding| first_bound && binding.bound_by == BoundBy::Claim)
        .map(|binding| binding.account_id.clone());
    Ok(Change {
        subscription,
        periods: period_changes,
        events,
        hint_for_store,
    })
}

// §4: a hint binds a purchase its buyer owns, a new purchase moves an ended lineage (R-11), a claim binds the rest.
fn bind(
    held: Option<Binding>,
    ownership: Ownership,
    accounts: &Accounts,
    started_at: Instant,
    bought_again_at: Option<Instant>,
) -> Result<Option<Binding>, Refusal> {
    let payer = match (&accounts.hint, ownership) {
        (AccountHint::Live(account_id), Ownership::Purchased) => Some(account_id),
        _ => None,
    };
    let binding = match (held, payer, bought_again_at) {
        (Some(held), Some(payer), Some(bought_at)) if held.account_id != *payer => Some(Binding {
            account_id: payer.clone(),
            bound_at: bought_at,
            bound_by: BoundBy::Purchase,
        }),
        (Some(held), _, _) => Some(held),
        (None, Some(payer), _) => Some(Binding {
            account_id: payer.clone(),
            bound_at: started_at,
            bound_by: BoundBy::Purchase,
        }),
        (None, None, _) => None,
    };
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

// INV-7 and INV-13: write what the ledger lacks, restate what a statement supersedes, one event per period.
fn record_periods(
    held: &[Period],
    stated: Vec<(ObservedPeriod, PeriodId)>,
    observed_at: Instant,
    first_bound: bool,
) -> (Vec<PeriodChange>, Vec<(EventKind, Instant)>) {
    let mut periods = held.to_vec();
    let mut changes = Vec::new();
    for (stated, id) in stated {
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
            Some(period)
                if (observed_at, stated.refunded_at) > (period.observed_at, period.refunded_at) =>
            {
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
        let before = held
            .iter()
            .find(|held| held.transaction == period.transaction);
        let event = match (before.map(|before| before.refunded_at), period.refunded_at) {
            (None, _) => Some((EventKind::PeriodRecorded(period), observed_at)),
            _ if first_bound => Some((EventKind::PeriodRecorded(period), observed_at)),
            (Some(earlier), Some(refunded_at)) if earlier != Some(refunded_at) => {
                Some((EventKind::PeriodRefunded(period), refunded_at))
            }
            (Some(Some(_)), None) => Some((EventKind::PeriodRefundReversed(period), observed_at)),
            _ => None,
        };
        events.extend(event);
    }
    (changes, events)
}

// §3.4: the state events of a change of status, in story order; a lineage bought (again) is told from a fresh start.
fn lifecycle_events(
    held: Option<&Status>,
    after: &Status,
    observed_at: Instant,
) -> Vec<(EventKind, Instant)> {
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
        Some(before) if !after.is_bought_again_after(before) => before,
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
    let new_period = after.current_period.start > before.current_period.start;
    let ended_at = is.ending().map_or(observed_at, |ending| ending.at);
    let story = [
        (
            leaves(State::is_revoked),
            EventKind::RevocationReversed,
            observed_at,
        ),
        (
            was.in_payment_trouble() && is.is_active(),
            EventKind::PaymentRecovered,
            observed_at,
        ),
        (
            was.is_paused() && is.is_active(),
            EventKind::Resumed,
            observed_at,
        ),
        (
            was.is_active() && new_period,
            EventKind::Renewed,
            observed_at,
        ),
        (
            after.product_id != before.product_id,
            EventKind::PlanChanged,
            observed_at,
        ),
        (
            after.current_period.start == before.current_period.start
                && after.current_period.end > before.current_period.end,
            EventKind::PeriodExtended,
            observed_at,
        ),
        (
            enters(State::in_payment_trouble),
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
            enters(State::is_paused),
            EventKind::Paused,
            is.paused_at().unwrap_or(observed_at),
        ),
        (enters(State::is_expired), EventKind::Expired, ended_at),
        (enters(State::is_revoked), EventKind::Revoked, ended_at),
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
