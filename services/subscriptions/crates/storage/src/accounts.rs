use domain::{AccountEntitlement, AccountId, Change, Instant, Period, Subscription, erase};
use sqlx::PgConnection;
use uuid::Uuid;

use crate::events::{self, RecordedEvent};
use crate::ledger::{self, Ledger, StorageError, commit};
use crate::{store_hints, subscriptions};

// Each account has one lock. A write that may bind a subscription to the account holds it shared, and the account's
// erasure holds it alone, so no binding to an account commits beside its erasure (§6.4).
macro_rules! account_lock {
    () => {
        "hashtextextended(format('account %s', $1::uuid), 0)"
    };
}

const HOLD_ACCOUNT: &str = concat!("select pg_advisory_xact_lock_shared(", account_lock!(), ")");
const HOLD_ACCOUNT_ALONE: &str = concat!("select pg_advisory_xact_lock(", account_lock!(), ")");
const IS_ERASED: &str = "select exists (select from erased_accounts where account_id = $1::uuid)";
const RECORD_ERASURE: &str =
    "insert into erased_accounts (account_id) values ($1::uuid) on conflict do nothing";
const ERASED_AT: &str = "select erased_at from erased_accounts where account_id = $1::uuid";

// What an account's erasure recorded (§6.4): whether this call recorded it first, when the ledger first recorded it, each
// lineage it changed, and how many hints owed to the stores for the account it dropped. An erasure repeated changes no
// lineage and drops no hint.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Erasure {
    pub newly_erased: bool,
    pub erased_at: Instant,
    pub lineages: Vec<ErasedLineage>,
    pub hints_dropped: u64,
}

// One lineage's change, and the seq of each event it recorded, in order.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ErasedLineage {
    pub change: Change,
    pub seqs: Vec<i64>,
}

// §5.2: what the ledger holds for one account: its entitlement, and every subscription bound to it with its periods
// and events.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AccountRecord {
    pub entitlement: AccountEntitlement,
    pub subscriptions: Vec<SubscriptionRecord>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SubscriptionRecord {
    pub subscription: Subscription,
    pub periods: Vec<Period>,
    pub events: Vec<RecordedEvent>,
}

impl Ledger {
    // §6.4 in one transaction: the account recorded as erased, so a hint naming it counts as no hint from now on (§4),
    // then every lineage holding anything of it locked in one order and changed by the domain's erasure, the hints
    // owed for it dropped, and the events appended last, under the seq lock, so no apply waits on the erasure for a
    // lock the erasure waits on.
    pub async fn erase_account(&self, account_id: Uuid) -> Result<Erasure, StorageError> {
        let erased = AccountId::new(account_id.to_string());
        let mut transaction = self.begin_write().await?;
        ledger::hold(
            &mut transaction,
            sqlx::query(HOLD_ACCOUNT_ALONE).bind(account_id),
        )
        .await?;
        let recorded = sqlx::query(RECORD_ERASURE)
            .bind(account_id)
            .execute(&mut *transaction)
            .await?;
        let erased_at: i64 = sqlx::query_scalar(ERASED_AT)
            .bind(account_id)
            .fetch_one(&mut *transaction)
            .await?;
        let erased_at = Instant::from_epoch_millis(erased_at);

        let mut changes = Vec::new();
        for lineage in subscriptions::of_account(&mut transaction, &erased).await? {
            let ledger = subscriptions::lock(&mut transaction, &lineage).await?;
            let held = ledger.subscription.clone();
            if let Some(change) = erase(ledger, &erased, erased_at) {
                subscriptions::save(&mut transaction, held.as_ref(), &change).await?;
                changes.push(change);
            }
        }
        let hints_dropped = store_hints::forget_account(&mut transaction, &erased).await?;
        let mut lineages = Vec::new();
        for change in changes {
            let seqs = events::append(&mut transaction, &change).await?;
            lineages.push(ErasedLineage { change, seqs });
        }
        commit(transaction).await?;
        Ok(Erasure {
            newly_erased: recorded.rows_affected() == 1,
            erased_at,
            lineages,
            hints_dropped,
        })
    }

    // D-8: the account's entitlement as the ledger holds it now.
    pub async fn entitlement(&self, account_id: Uuid) -> Result<AccountEntitlement, StorageError> {
        let account_id = AccountId::new(account_id.to_string());
        let mut connection = self.pool.acquire().await?;
        let subscriptions = subscriptions::bound_to(&mut connection, &account_id).await?;
        Ok(AccountEntitlement::of(account_id, subscriptions))
    }

    // The account as the ledger holds it now, read in one snapshot: its subscriptions ordered by id, each with its
    // periods by start and its events in seq order, and the entitlement folded over them.
    pub async fn account(&self, account_id: Uuid) -> Result<AccountRecord, StorageError> {
        let account_id = AccountId::new(account_id.to_string());
        let mut transaction = self
            .pool
            .begin_with("begin isolation level repeatable read, read only")
            .await?;
        let mut held = subscriptions::bound_to(&mut transaction, &account_id).await?;
        held.sort_by(|one, other| one.id.cmp(&other.id));
        let mut records = Vec::new();
        for subscription in &held {
            records.push(SubscriptionRecord {
                subscription: subscription.clone(),
                periods: subscriptions::periods_of(&mut transaction, &subscription.id).await?,
                events: events::recorded_for(&mut transaction, &subscription.id).await?,
            });
        }
        transaction.commit().await?;
        Ok(AccountRecord {
            entitlement: AccountEntitlement::of(account_id, held),
            subscriptions: records,
        })
    }
}

// §4: the account an observation's hint or a claim names, unless the backend erased it. Its lock stays held shared
// until the transaction ends, so the answer holds as long.
pub(crate) async fn live(
    connection: &mut PgConnection,
    account_id: Uuid,
) -> Result<Option<AccountId>, StorageError> {
    ledger::hold(connection, sqlx::query(HOLD_ACCOUNT).bind(account_id)).await?;
    let erased: bool = sqlx::query_scalar(IS_ERASED)
        .bind(account_id)
        .fetch_one(connection)
        .await?;
    if erased {
        return Ok(None);
    }
    Ok(Some(AccountId::new(account_id.to_string())))
}
