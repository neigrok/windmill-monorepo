use std::cmp::Reverse;

use crate::subscription::Subscription;
use crate::values::{AccountId, Environment, Instant, Plan};

// D-8: one block per environment, folded from the ledger alone; whoever reads it applies the clock (INV-1).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AccountEntitlement {
    pub account_id: AccountId,
    pub production: Entitlement,
    pub sandbox: Entitlement,
}

impl AccountEntitlement {
    pub fn of(account_id: AccountId, subscriptions: Vec<Subscription>) -> AccountEntitlement {
        let (production, sandbox) = subscriptions
            .into_iter()
            .filter(|subscription| subscription.account_id() == Some(&account_id))
            .partition(|subscription| subscription.lineage.environment == Environment::Production);
        AccountEntitlement {
            account_id,
            production: Entitlement::of(production),
            sandbox: Entitlement::of(sandbox),
        }
    }

    // Each environment's governing subscription and its others: at most one ended subscription for each, whatever the
    // account ever held. Folded again they make this same entitlement, so they are all a copy of it has to keep.
    pub fn subscriptions(&self) -> impl Iterator<Item = &Subscription> {
        [&self.production, &self.sandbox]
            .into_iter()
            .flat_map(|entitlement| entitlement.governing.iter().chain(&entitlement.others))
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Entitlement {
    pub access_until: Option<Instant>,
    pub governing: Option<Subscription>,
    pub others: Vec<Subscription>,
}

impl Entitlement {
    // §5.2: governing grants access the longest, else last started, failed a payment, paused or ended, ties to the
    // smaller id; others by id. Each of those instants changes only with an event, so governing moves only with one.
    fn of(mut subscriptions: Vec<Subscription>) -> Entitlement {
        let precedence = |subscription: &Subscription| match subscription.access_until() {
            Some(access_until) => (true, access_until, Reverse(subscription.id.clone())),
            None => {
                let state = &subscription.status.state;
                let last_told = [
                    state.payment_failed_at(),
                    state.paused_at(),
                    state.ending().map(|ending| ending.at),
                ]
                .into_iter()
                .flatten()
                .fold(subscription.status.started_at, Instant::max);
                (false, last_told, Reverse(subscription.id.clone()))
            }
        };
        let governing = (0..subscriptions.len())
            .max_by_key(|index| precedence(&subscriptions[*index]))
            .map(|index| subscriptions.swap_remove(index));
        let mut others: Vec<Subscription> = subscriptions
            .into_iter()
            .filter(|subscription| !subscription.status.state.has_ended())
            .collect();
        others.sort_by(|one, other| one.id.cmp(&other.id));
        Entitlement {
            access_until: governing.as_ref().and_then(Subscription::access_until),
            governing,
            others,
        }
    }

    pub fn plan(&self) -> Option<Plan> {
        self.access_until.and(
            self.governing
                .as_ref()
                .map(|governing| governing.status.plan),
        )
    }
}
