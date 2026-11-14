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
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Entitlement {
    pub access_until: Option<Instant>,
    pub governing: Option<Subscription>,
    pub others: Vec<Subscription>,
}

impl Entitlement {
    // §5.2: governing grants access the longest, else was observed last, ties to the smaller id; others by id.
    fn of(mut subscriptions: Vec<Subscription>) -> Entitlement {
        let precedence = |subscription: &Subscription| match subscription.access_until() {
            Some(access_until) => (true, access_until, Reverse(subscription.id.clone())),
            None => (
                false,
                subscription.observed_at,
                Reverse(subscription.id.clone()),
            ),
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
