use domain::{
    AccountId, Environment, Lineage, Store, StoreSubscriptionId, Subscription, SubscriptionId,
};
use sqlx::{FromRow, PgConnection};
use uuid::Uuid;

use crate::ledger::{Ledger, StorageError, commit};
use crate::subscriptions::named;

const OWE: &str = "insert into store_hints (subscription_id, store, environment, store_subscription_id, \
     account_id) values ($1::uuid, $2, $3, $4, $5::uuid) \
     on conflict (subscription_id) do update set account_id = excluded.account_id, owed_since = now_millis(), \
     attempts = 0, next_attempt_at = null, abandoned_at = null";
// A hint is owed while its subscription is bound to the account it names and that account is not erased (§4, §6.4),
// and due unless the store refused it lately or for good.
const SELECT_OWED: &str = "select h.subscription_id, h.store, h.environment, h.store_subscription_id, h.account_id \
     from store_hints h join subscriptions s on s.id = h.subscription_id and s.account_id = h.account_id \
     where not exists (select from erased_accounts e where e.account_id = h.account_id) \
     and h.abandoned_at is null and (h.next_attempt_at is null or h.next_attempt_at <= now_millis()) \
     order by h.owed_since, h.subscription_id limit $1";
const FORGET_STALE: &str = "delete from store_hints h \
     where not exists (select from subscriptions s where s.id = h.subscription_id and s.account_id = h.account_id) \
     or exists (select from erased_accounts e where e.account_id = h.account_id)";
const FORGET_OTHER_ACCOUNTS: &str = "delete from store_hints \
     where subscription_id = $1::uuid and account_id is distinct from $2::uuid";
const CLEAR: &str =
    "delete from store_hints where subscription_id = $1::uuid and account_id = $2::uuid";
// The n-th refusal a retry cannot change makes the hint wait 2^(n-1) hours, 1, 2, 4 and 8, and the fifth settles it
// abandoned.
const COUNT_REFUSAL: &str = "update store_hints set attempts = attempts + 1, \
     next_attempt_at = now_millis() + 3600000 * (1::bigint << attempts), \
     abandoned_at = case when attempts + 1 >= 5 then now_millis() end \
     where subscription_id = $1::uuid and account_id = $2::uuid and abandoned_at is null \
     returning abandoned_at is not null";

// What one more refusal by the store makes of an owed hint.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HintRefusal {
    WaitsToRetry,
    // The fifth: it is never written again.
    Abandoned,
}

// §4: an account the ledger owes a store as one subscription's hint, the App Store's Set App Account Token.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StoreHint {
    pub subscription_id: SubscriptionId,
    pub lineage: Lineage,
    pub account_id: AccountId,
}

impl Ledger {
    // At most `limit` hints owed, the longest owed first: the sweep writes each to its store and clears it. A hint whose
    // subscription is bound to another account since, or whose account was erased, is not one.
    pub async fn store_hints(&self, limit: i64) -> Result<Vec<StoreHint>, StorageError> {
        let rows: Vec<StoreHintRow> = sqlx::query_as(SELECT_OWED)
            .bind(limit)
            .fetch_all(&self.pool)
            .await?;
        rows.into_iter()
            .map(|row| {
                Ok(StoreHint {
                    subscription_id: SubscriptionId::new(row.subscription_id.to_string()),
                    lineage: Lineage {
                        store: named(Store::from_name, &row.store)?,
                        environment: named(Environment::from_name, &row.environment)?,
                        store_subscription_id: StoreSubscriptionId::new(row.store_subscription_id),
                    },
                    account_id: AccountId::new(row.account_id.to_string()),
                })
            })
            .collect()
    }

    // Drops every hint no longer owed: its subscription is bound to another account, or its account was erased. It
    // answers how many it dropped.
    pub async fn forget_stale_store_hints(&self) -> Result<u64, StorageError> {
        let mut transaction = self.begin_write().await?;
        let forgotten = sqlx::query(FORGET_STALE).execute(&mut *transaction).await?;
        commit(transaction).await?;
        Ok(forgotten.rows_affected())
    }

    // The store refused the hint for a reason a retry cannot change. A refusal of a hint no longer owed changes
    // nothing.
    pub async fn count_store_hint_refusal(
        &self,
        hint: &StoreHint,
    ) -> Result<HintRefusal, StorageError> {
        let mut transaction = self.begin_write().await?;
        let abandoned: Option<bool> = sqlx::query_scalar(COUNT_REFUSAL)
            .bind(hint.subscription_id.as_str())
            .bind(hint.account_id.as_str())
            .fetch_optional(&mut *transaction)
            .await?;
        commit(transaction).await?;
        match abandoned {
            Some(true) => Ok(HintRefusal::Abandoned),
            Some(false) | None => Ok(HintRefusal::WaitsToRetry),
        }
    }

    // The store took the hint. A hint owed to another account since stays owed.
    pub async fn clear_store_hint(&self, hint: &StoreHint) -> Result<(), StorageError> {
        let mut transaction = self.begin_write().await?;
        sqlx::query(CLEAR)
            .bind(hint.subscription_id.as_str())
            .bind(hint.account_id.as_str())
            .execute(&mut *transaction)
            .await?;
        commit(transaction).await
    }
}

// Drops the hints owed for the subscription to any account but the one it is bound to now, in the transaction that
// moves its binding, as a new purchase does (R-11).
pub(crate) async fn forget_other_accounts(
    connection: &mut PgConnection,
    subscription: &Subscription,
) -> Result<(), StorageError> {
    sqlx::query(FORGET_OTHER_ACCOUNTS)
        .bind(subscription.id.as_str())
        .bind(subscription.account_id().map(AccountId::as_str))
        .execute(connection)
        .await?;
    Ok(())
}

// Owes the subscription's store the account as its hint, in the transaction that binds the subscription to it.
pub(crate) async fn owe(
    connection: &mut PgConnection,
    subscription: &Subscription,
    account_id: &AccountId,
) -> Result<(), StorageError> {
    let lineage = &subscription.lineage;
    sqlx::query(OWE)
        .bind(subscription.id.as_str())
        .bind(lineage.store.name())
        .bind(lineage.environment.name())
        .bind(lineage.store_subscription_id.as_str())
        .bind(account_id.as_str())
        .execute(connection)
        .await?;
    Ok(())
}

#[derive(FromRow)]
struct StoreHintRow {
    subscription_id: Uuid,
    store: String,
    environment: String,
    store_subscription_id: String,
    account_id: Uuid,
}
