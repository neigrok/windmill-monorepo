use domain::{
    AccountId, Accounts, Change, Claim, Instant, Observation, PeriodId, Refusal, SubscriptionId,
    observe,
};
use sqlx::PgConnection;
use uuid::Uuid;

use crate::inbox::{self, KeptNotification};
use crate::ledger::{Ledger, StorageError};
use crate::{accounts, events, subscriptions};

// What a door hands the ledger to apply: an observation, the accounts it names, and when the service pulled it.
pub struct Observed {
    pub observation: Observation,
    // The account the store's hint names, Apple's appAccountToken; the ledger resolves it against the erased
    // accounts (§4).
    pub hint: Option<Uuid>,
    pub claim: Option<AccountClaim>,
    // When the service read this state from the store's API, which becomes the subscription's verifiedAt.
    pub pulled_at: Option<Instant>,
}

// A claim door's call (§4): the account claiming the subscription, and when.
pub struct AccountClaim {
    pub account_id: Uuid,
    pub at: Instant,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Applied {
    // Committed: what the observation changed, and the seq of each of its events in order. A replay changes
    // nothing and records no event (INV-4).
    Recorded { change: Box<Change>, seqs: Vec<i64> },
    // The domain refused it (§4); nothing changed.
    Refused(Refusal),
    // The notification was settled already; nothing changed.
    AlreadySettled,
}

impl Ledger {
    // §3.4: applies the observation of a claim or a pull with its periods, events and binding, in one transaction.
    pub async fn apply(&self, observed: Observed) -> Result<Applied, StorageError> {
        let mut transaction = self.pool.begin().await?;
        let applied = apply_in(&mut transaction, observed).await?;
        transaction.commit().await?;
        Ok(applied)
    }

    // §5.1 step 4: applies the observation a kept notification states and settles the notification in the same
    // transaction, so the door and every retry of the sweep together apply it once.
    pub async fn apply_notification(
        &self,
        kept: &KeptNotification,
        observed: Observed,
    ) -> Result<Applied, StorageError> {
        let mut transaction = self.pool.begin().await?;
        if !inbox::hold_unsettled(&mut transaction, kept).await? {
            return Ok(Applied::AlreadySettled);
        }
        let applied = apply_in(&mut transaction, observed).await?;
        let outcome = match &applied {
            Applied::Refused(refusal) => refusal.name(),
            _ => "applied",
        };
        inbox::settle(&mut transaction, kept, outcome).await?;
        transaction.commit().await?;
        Ok(applied)
    }
}

// The accounts the observation names are held first, then its lineage, so an erasure, which holds its account and
// then the rows bound to it, never waits on an apply that waits on it. The events go last, under the seq lock.
async fn apply_in(
    connection: &mut PgConnection,
    observed: Observed,
) -> Result<Applied, StorageError> {
    let Observed {
        observation,
        hint,
        claim,
        pulled_at,
    } = observed;
    if let Some(claim) = &claim {
        accounts::hold(connection, claim.account_id).await?;
    }
    let hint = accounts::resolve(connection, hint).await?;
    let ledger = subscriptions::lock(connection, &observation.lineage).await?;
    let held = ledger.subscription.clone();

    let observation = observation.mint_ids(SubscriptionId::new(Uuid::new_v4().to_string()), |_| {
        PeriodId::new(Uuid::new_v4().to_string())
    });
    let claim = claim.map(|claim| Claim {
        account_id: AccountId::new(claim.account_id.to_string()),
        at: claim.at,
    });
    let change = match observe(ledger, observation, Accounts { hint, claim }) {
        Ok(change) => change,
        Err(refusal) => return Ok(Applied::Refused(refusal)),
    };

    subscriptions::save(connection, held.as_ref(), &change).await?;
    if let Some(pulled_at) = pulled_at {
        subscriptions::stamp_verified(connection, &change.subscription.id, pulled_at).await?;
    }
    let seqs = events::append(connection, &change).await?;
    Ok(Applied::Recorded {
        change: Box::new(change),
        seqs,
    })
}
