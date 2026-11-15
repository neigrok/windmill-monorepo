use domain::{
    AccountHint, Accounts, Change, Claim, Claimant, Instant, Observation, PeriodId, Refusal,
    SubscriptionId, observe,
};
use sqlx::PgConnection;
use uuid::Uuid;

use crate::inbox::{self, KeptNotification};
use crate::ledger::{Ledger, StorageError, commit};
use crate::{accounts, events, store_hints, subscriptions};

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
    // Committed: what the observation changed, the seq of each of its events in order, and the seq of the
    // subscription's newest event once it committed. A replay changes nothing and records no event (INV-4), and
    // answers the same newest seq, so a claim retried after its answer was lost still answers {seq, entitlement}.
    Recorded {
        change: Box<Change>,
        seqs: Vec<i64>,
        newest_seq: i64,
    },
    // The domain refused it (§4); nothing changed.
    Refused(Refusal),
    // The notification was settled already; nothing changed.
    AlreadySettled,
}

impl Ledger {
    // §3.4: applies the observation of a claim or a pull with its periods, events and binding, in one transaction.
    pub async fn apply(&self, observed: Observed) -> Result<Applied, StorageError> {
        let mut transaction = self.begin_write().await?;
        let applied = apply_in(&mut transaction, observed).await?;
        commit(transaction).await?;
        Ok(applied)
    }

    // §5.1 step 4: applies the observation a kept notification states and settles the notification in the same
    // transaction, so the door and every retry of the sweep together apply it once. An apply that fails for a reason
    // a retry cannot change counts against the notification, which waits before the sweep tries it again and is
    // settled `failed` at the last attempt.
    pub async fn apply_notification(
        &self,
        kept: &KeptNotification,
        observed: Observed,
    ) -> Result<Applied, StorageError> {
        let mut transaction = self.begin_write().await?;
        match apply_and_settle(&mut transaction, kept, observed).await {
            Ok(applied) => {
                commit(transaction).await?;
                Ok(applied)
            }
            Err(failure) => {
                // A rollback fails only on a connection that is gone, and the server rolls back with it.
                let rolled_back = transaction.rollback().await.is_ok();
                if rolled_back && failure.repeats() {
                    self.count_failed_attempt(kept).await?;
                }
                Err(failure)
            }
        }
    }
}

async fn apply_and_settle(
    connection: &mut PgConnection,
    kept: &KeptNotification,
    observed: Observed,
) -> Result<Applied, StorageError> {
    if !inbox::hold_unsettled(connection, kept).await? {
        return Ok(Applied::AlreadySettled);
    }
    let applied = apply_in(connection, observed).await?;
    let outcome = match &applied {
        Applied::Refused(refusal) => refusal.name(),
        _ => "applied",
    };
    inbox::settle(connection, kept, outcome).await?;
    Ok(applied)
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
    let claim = match claim {
        None => None,
        Some(claim) => Some(Claim {
            claimant: accounts::live(connection, claim.account_id)
                .await?
                .map_or(Claimant::Erased, Claimant::Live),
            at: claim.at,
        }),
    };
    let hint = match hint {
        None => AccountHint::Absent,
        Some(account_id) => accounts::live(connection, account_id)
            .await?
            .map_or(AccountHint::Erased, AccountHint::Live),
    };
    let ledger = subscriptions::lock(connection, &observation.lineage).await?;
    let held = ledger.subscription.clone();

    let observation = observation.mint_ids(SubscriptionId::new(Uuid::new_v4().to_string()), |_| {
        PeriodId::new(Uuid::new_v4().to_string())
    });
    let change = match observe(ledger, observation, Accounts { hint, claim }) {
        Ok(change) => change,
        Err(refusal) => return Ok(Applied::Refused(refusal)),
    };

    subscriptions::save(connection, held.as_ref(), &change).await?;
    if let Some(pulled_at) = pulled_at {
        subscriptions::stamp_verified(connection, &change.subscription.id, pulled_at).await?;
    }
    if let Some(account_id) = &change.hint_for_store {
        store_hints::owe(connection, &change.subscription, account_id).await?;
    }
    let seqs = events::append(connection, &change).await?;
    let newest_seq = match seqs.last() {
        Some(seq) => *seq,
        None => events::newest_seq(connection, &change.subscription.id).await?,
    };
    Ok(Applied::Recorded {
        change: Box::new(change),
        seqs,
        newest_seq,
    })
}
