use std::fmt;

use domain::{Environment, Store};
use sqlx::{FromRow, PgConnection};

use crate::ledger::{Ledger, StorageError};
use crate::subscriptions::named;

const KEEP: &str = "insert into inbox (store, notification_id, environment, signed_payload) \
     values ($1, $2, $3, $4) on conflict do nothing";
const SELECT_KEPT_UNSETTLED: &str = "select store, notification_id, environment, signed_payload from inbox \
     where store = $1 and notification_id = $2 and settled_at is null";
const SELECT_UNSETTLED: &str = "select store, notification_id, environment, signed_payload from inbox \
     where settled_at is null and (next_attempt_at is null or next_attempt_at <= now_millis()) \
     order by received_at, notification_id limit $1";
const HOLD_UNSETTLED: &str = "select true from inbox \
     where store = $1 and notification_id = $2 and settled_at is null for update";
const SETTLE: &str = "update inbox set settled_at = now_millis(), outcome = $3 \
     where store = $1 and notification_id = $2 and settled_at is null";
// The attempt that fails for the n-th time for a reason a retry cannot change waits 2^(n-1) hours before the next,
// 1, 2, 4 and 8 hours, and the fifth settles the notification `failed`, which the sweep reports.
const COUNT_FAILED_ATTEMPT: &str = "update inbox set attempts = attempts + 1, \
     next_attempt_at = now_millis() + 3600000 * (1::bigint << attempts), \
     settled_at = case when attempts + 1 >= 5 then now_millis() end, \
     outcome = case when attempts + 1 >= 5 then 'failed' end \
     where store = $1 and notification_id = $2 and settled_at is null";

// A store's notification as its door verified it: the store's own id for it, and the signed payload as sent,
// which no log line or panic message may carry (spec §10).
#[derive(Clone, PartialEq, Eq)]
pub struct Notification {
    pub store: Store,
    pub id: String,
    pub environment: Environment,
    pub signed_payload: String,
}

impl fmt::Debug for Notification {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("Notification")
            .field("store", &self.store)
            .field("id", &self.id)
            .field("environment", &self.environment)
            .field("signed_payload", &"(redacted)")
            .finish()
    }
}

// A notification the inbox holds. Only the ledger makes one, so nothing applies a notification it does not keep.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct KeptNotification(Notification);

impl KeptNotification {
    pub fn notification(&self) -> &Notification {
        &self.0
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum Receipt {
    Kept(KeptNotification),
    // The inbox already holds a notification by this store's id, and nothing changed. While it is unsettled it is
    // handed back, so the door can apply a redelivery at once.
    Duplicate(Option<KeptNotification>),
}

impl Ledger {
    // §5.1 step 3: keeps the notification, once.
    pub async fn receive(&self, notification: Notification) -> Result<Receipt, StorageError> {
        let kept = sqlx::query(KEEP)
            .bind(notification.store.name())
            .bind(&notification.id)
            .bind(notification.environment.name())
            .bind(&notification.signed_payload)
            .execute(&self.pool)
            .await?;
        if kept.rows_affected() == 0 {
            let unsettled: Option<NotificationRow> = sqlx::query_as(SELECT_KEPT_UNSETTLED)
                .bind(notification.store.name())
                .bind(&notification.id)
                .fetch_optional(&self.pool)
                .await?;
            return Ok(Receipt::Duplicate(
                unsettled.map(KeptNotification::try_from).transpose()?,
            ));
        }
        Ok(Receipt::Kept(KeptNotification(notification)))
    }

    // §7 step 1: at most `limit` notifications kept and not yet settled, the longest kept first, but for those
    // waiting after a failed attempt.
    pub async fn unsettled(&self, limit: i64) -> Result<Vec<KeptNotification>, StorageError> {
        let rows: Vec<NotificationRow> = sqlx::query_as(SELECT_UNSETTLED)
            .bind(limit)
            .fetch_all(&self.pool)
            .await?;
        rows.into_iter().map(KeptNotification::try_from).collect()
    }

    // Settles a notification there is nothing to apply for, such as Apple's test, with the code of what it was.
    // One settled already keeps its first outcome.
    pub async fn settle(
        &self,
        kept: &KeptNotification,
        outcome: &'static str,
    ) -> Result<(), StorageError> {
        let mut connection = self.pool.acquire().await?;
        settle(&mut connection, kept, outcome).await
    }

    pub(crate) async fn count_failed_attempt(
        &self,
        kept: &KeptNotification,
    ) -> Result<(), StorageError> {
        sqlx::query(COUNT_FAILED_ATTEMPT)
            .bind(kept.0.store.name())
            .bind(&kept.0.id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }
}

// Locks the kept notification until the transaction ends; false when it is settled already.
pub(crate) async fn hold_unsettled(
    connection: &mut PgConnection,
    kept: &KeptNotification,
) -> Result<bool, StorageError> {
    let held: Option<bool> = sqlx::query_scalar(HOLD_UNSETTLED)
        .bind(kept.0.store.name())
        .bind(&kept.0.id)
        .fetch_optional(connection)
        .await?;
    Ok(held.is_some())
}

pub(crate) async fn settle(
    connection: &mut PgConnection,
    kept: &KeptNotification,
    outcome: &'static str,
) -> Result<(), StorageError> {
    sqlx::query(SETTLE)
        .bind(kept.0.store.name())
        .bind(&kept.0.id)
        .bind(outcome)
        .execute(connection)
        .await?;
    Ok(())
}

#[derive(FromRow)]
struct NotificationRow {
    store: String,
    notification_id: String,
    environment: String,
    signed_payload: String,
}

impl TryFrom<NotificationRow> for KeptNotification {
    type Error = StorageError;

    fn try_from(row: NotificationRow) -> Result<KeptNotification, StorageError> {
        Ok(KeptNotification(Notification {
            store: named(Store::from_name, &row.store)?,
            id: row.notification_id,
            environment: named(Environment::from_name, &row.environment)?,
            signed_payload: row.signed_payload,
        }))
    }
}
