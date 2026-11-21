use std::fmt;

use domain::{Environment, Store};
use sqlx::{FromRow, PgConnection};

use crate::ledger::{self, Ledger, PgQuery, StorageError, commit};
use crate::subscriptions::named;

const KEEP: &str = "insert into inbox (store, notification_id, environment, signed_payload) \
     values ($1, $2, $3, $4) on conflict do nothing";
const SELECT_KEPT_UNSETTLED: &str = "select store, notification_id, environment, signed_payload from inbox \
     where store = $1 and notification_id = $2 and settled_at is null";
const SELECT_UNSETTLED: &str = "select store, notification_id, environment, signed_payload from inbox \
     where settled_at is null and (next_attempt_at is null or next_attempt_at <= now_millis()) \
     order by received_at, notification_id limit $1";
// A kept notification's lock. Every write that changes its inbox row holds it first, so the door, a redelivery and the
// sweep apply it once, and a settle, a postponement or a failed attempt counted beside an apply waits for the apply to
// end. `receive` only inserts the row.
const HOLD_NOTIFICATION: &str = "select pg_advisory_xact_lock(hashtextextended(\
     format('notification %s %s', $1::text, $2::text), 0))";
const IS_UNSETTLED: &str = "select exists (select from inbox \
     where store = $1 and notification_id = $2 and settled_at is null)";
const SETTLE: &str = "update inbox set settled_at = now_millis(), outcome = $3 \
     where store = $1 and notification_id = $2 and settled_at is null";
const POSTPONE: &str = "update inbox set next_attempt_at = now_millis() + $3 \
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

    fn lock(&self) -> PgQuery<'_> {
        sqlx::query(HOLD_NOTIFICATION)
            .bind(self.0.store.name())
            .bind(&self.0.id)
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
    // §5.1 step 3: keeps the notification, once, within the bounds of every write.
    pub async fn receive(&self, notification: Notification) -> Result<Receipt, StorageError> {
        let mut transaction = self.begin_write().await?;
        let kept = sqlx::query(KEEP)
            .bind(notification.store.name())
            .bind(&notification.id)
            .bind(notification.environment.name())
            .bind(&notification.signed_payload)
            .execute(&mut *transaction)
            .await?;
        let receipt = if kept.rows_affected() == 0 {
            let unsettled: Option<NotificationRow> = sqlx::query_as(SELECT_KEPT_UNSETTLED)
                .bind(notification.store.name())
                .bind(&notification.id)
                .fetch_optional(&mut *transaction)
                .await?;
            Receipt::Duplicate(unsettled.map(KeptNotification::try_from).transpose()?)
        } else {
            Receipt::Kept(KeptNotification(notification))
        };
        commit(transaction).await?;
        Ok(receipt)
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
        let mut transaction = self.begin_write().await?;
        ledger::hold(&mut transaction, kept.lock()).await?;
        settle(&mut transaction, kept, outcome).await?;
        commit(transaction).await
    }

    // Leaves a kept notification unsettled and out of `unsettled` for `by_millis`: one that waits on what no retry
    // brings sooner, such as its subscription's status. A redelivery still hands it back.
    pub async fn postpone(
        &self,
        kept: &KeptNotification,
        by_millis: i64,
    ) -> Result<(), StorageError> {
        let mut transaction = self.begin_write().await?;
        ledger::hold(&mut transaction, kept.lock()).await?;
        sqlx::query(POSTPONE)
            .bind(kept.0.store.name())
            .bind(&kept.0.id)
            .bind(by_millis)
            .execute(&mut *transaction)
            .await?;
        commit(transaction).await
    }

    pub(crate) async fn count_failed_attempt(
        &self,
        kept: &KeptNotification,
    ) -> Result<(), StorageError> {
        let mut transaction = self.begin_write().await?;
        ledger::hold(&mut transaction, kept.lock()).await?;
        sqlx::query(COUNT_FAILED_ATTEMPT)
            .bind(kept.0.store.name())
            .bind(&kept.0.id)
            .execute(&mut *transaction)
            .await?;
        commit(transaction).await
    }
}

// Holds the kept notification's lock until the transaction ends; false when it is settled already.
pub(crate) async fn hold_unsettled(
    connection: &mut PgConnection,
    kept: &KeptNotification,
) -> Result<bool, StorageError> {
    ledger::hold(connection, kept.lock()).await?;
    Ok(sqlx::query_scalar(IS_UNSETTLED)
        .bind(kept.0.store.name())
        .bind(&kept.0.id)
        .fetch_one(connection)
        .await?)
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
