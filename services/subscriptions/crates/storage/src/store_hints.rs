use domain::{
    AccountId, Environment, Lineage, Store, StoreSubscriptionId, Subscription, SubscriptionId,
};
use sqlx::{FromRow, PgConnection};
use uuid::Uuid;

use crate::ledger::{Ledger, StorageError};
use crate::subscriptions::named;

const OWE: &str = "insert into store_hints (subscription_id, store, environment, store_subscription_id, \
     account_id) values ($1::uuid, $2, $3, $4, $5::uuid) \
     on conflict (subscription_id) do update set account_id = excluded.account_id, owed_since = now_millis()";
const SELECT_OWED: &str = "select subscription_id, store, environment, store_subscription_id, account_id \
     from store_hints order by owed_since, subscription_id limit $1";
const CLEAR: &str =
    "delete from store_hints where subscription_id = $1::uuid and account_id = $2::uuid";

// §4: an account the ledger owes a store as one subscription's hint, the App Store's Set App Account Token.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StoreHint {
    pub subscription_id: SubscriptionId,
    pub lineage: Lineage,
    pub account_id: AccountId,
}

impl Ledger {
    // At most `limit` hints owed, the longest owed first: the sweep writes each to its store and clears it.
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

    // The store took the hint. A hint owed to another account since stays owed.
    pub async fn clear_store_hint(&self, hint: &StoreHint) -> Result<(), StorageError> {
        sqlx::query(CLEAR)
            .bind(hint.subscription_id.as_str())
            .bind(hint.account_id.as_str())
            .execute(&self.pool)
            .await?;
        Ok(())
    }
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
