use crate::observe::{Change, Event, EventKind, Ledger, PeriodChange};
use crate::subscription::{LeftWith, Period};
use crate::values::{AccountId, Instant};

// §6.4: the domain's step for an account's erasure, beside observe, for one lineage. A subscription bound to the
// account is unbound at the erasure and records `unbound` under it; every period the account held or paid for stays
// with no one, so no later event of it names the account and no claim takes it over (INV-13). None when the lineage
// holds nothing of the account, as on an erasure repeated.
pub fn erase(ledger: Ledger, erased: &AccountId, at: Instant) -> Option<Change> {
    let Ledger {
        subscription,
        periods,
    } = ledger;
    let mut subscription = subscription?;
    let bound_to_erased = subscription.account_id() == Some(erased);
    let periods: Vec<PeriodChange> = periods
        .into_iter()
        .filter(|period| match &period.left_with {
            None => bound_to_erased,
            Some(LeftWith::Account(paid_by)) => paid_by == erased,
            Some(LeftWith::NoOne) => false,
        })
        .map(|period| {
            PeriodChange::Restated(Period {
                left_with: Some(LeftWith::NoOne),
                ..period
            })
        })
        .collect();
    if !bound_to_erased && periods.is_empty() {
        return None;
    }

    let mut events = Vec::new();
    if bound_to_erased {
        subscription.binding = None;
        events.push(Event {
            kind: EventKind::Unbound,
            occurred_at: at,
            subscription_id: subscription.id.clone(),
            account_id: Some(erased.clone()),
        });
    }
    Some(Change {
        subscription,
        periods,
        events,
        hint_for_store: None,
    })
}
