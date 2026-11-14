use std::cmp::Reverse;

use crate::subscription::Subscription;
use crate::values::{AccountId, Environment, Instant, Plan};

// D-8: an account's answer, one block per environment, so a sandbox purchase never stands in for a
// production one.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AccountEntitlement {
    pub account_id: AccountId,
    pub production: Entitlement,
    pub sandbox: Entitlement,
}

impl AccountEntitlement {
    pub fn of(
        account_id: AccountId,
        subscriptions: Vec<Subscription>,
        now: Instant,
    ) -> AccountEntitlement {
        let (production, sandbox) = subscriptions
            .into_iter()
            .filter(|subscription| subscription.account_id() == Some(&account_id))
            .partition(|subscription| subscription.lineage.environment == Environment::Production);
        AccountEntitlement {
            account_id,
            production: Entitlement::of(production, now),
            sandbox: Entitlement::of(sandbox, now),
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
    // Governing: the access-granting subscription with the latest accessUntil, else the one observed
    // last, the smaller id breaking a tie. Others: every other one that has not ended.
    fn of(mut subscriptions: Vec<Subscription>, now: Instant) -> Entitlement {
        let granting_until = |subscription: &Subscription| {
            subscription
                .access_until()
                .filter(|_| subscription.grants_access(now))
        };
        subscriptions.sort_by_key(|subscription| {
            Reverse((
                granting_until(subscription),
                subscription.observed_at,
                Reverse(subscription.id.clone()),
            ))
        });
        let mut ranked = subscriptions.into_iter();
        let governing = ranked.next();
        Entitlement {
            access_until: governing.as_ref().and_then(granting_until),
            others: ranked
                .filter(|subscription| !subscription.status.state.has_ended())
                .collect(),
            governing,
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
