use domain::{AccountEntitlement, AccountHint, AccountId};
use sqlx::PgConnection;
use uuid::Uuid;

use crate::ledger::{Ledger, StorageError};
use crate::subscriptions;

// Each account has one lock. A write that may bind a subscription to the account holds it shared, and recording
// the account's erasure holds it alone, so no binding to an account commits beside its erasure (§6.4).
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

impl Ledger {
    // §6.4: records the account as erased, so a hint naming it counts as no hint from now on (§4).
    pub async fn record_erasure(&self, account_id: Uuid) -> Result<(), StorageError> {
        let mut transaction = self.pool.begin().await?;
        sqlx::query(HOLD_ACCOUNT_ALONE)
            .bind(account_id)
            .execute(&mut *transaction)
            .await?;
        sqlx::query(RECORD_ERASURE)
            .bind(account_id)
            .execute(&mut *transaction)
            .await?;
        transaction.commit().await?;
        Ok(())
    }

    // D-8: the account's entitlement as the ledger holds it now.
    pub async fn entitlement(&self, account_id: Uuid) -> Result<AccountEntitlement, StorageError> {
        let account_id = AccountId::new(account_id.to_string());
        let mut connection = self.pool.acquire().await?;
        let subscriptions = subscriptions::bound_to(&mut connection, &account_id).await?;
        Ok(AccountEntitlement::of(account_id, subscriptions))
    }
}

// Holds the account's lock shared until the transaction ends.
pub(crate) async fn hold(
    connection: &mut PgConnection,
    account_id: Uuid,
) -> Result<(), StorageError> {
    sqlx::query(HOLD_ACCOUNT)
        .bind(account_id)
        .execute(connection)
        .await?;
    Ok(())
}

// §4: an observation's hint names a live account, an erased one, or none. The account stays held, so the answer
// holds until the transaction ends.
pub(crate) async fn resolve(
    connection: &mut PgConnection,
    hint: Option<Uuid>,
) -> Result<AccountHint, StorageError> {
    let Some(account_id) = hint else {
        return Ok(AccountHint::Absent);
    };
    hold(connection, account_id).await?;
    let erased: bool = sqlx::query_scalar(IS_ERASED)
        .bind(account_id)
        .fetch_one(connection)
        .await?;
    if erased {
        return Ok(AccountHint::Erased);
    }
    Ok(AccountHint::Live(AccountId::new(account_id.to_string())))
}
