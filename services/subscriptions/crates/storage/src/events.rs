use std::collections::BTreeMap;

use domain::{
    AccountEntitlement, AccountId, Change, Environment, Event, EventKind, Instant, OfferKind,
    Period, Store, Subscription, SubscriptionId,
};
use sqlx::{FromRow, PgConnection};
use uuid::Uuid;

use crate::ledger::{Ledger, StorageError};
use crate::subscriptions::{
    self, PeriodRow, SubscriptionRow, bind_period, named, subscription_columns,
};

// INV-8: the seq lock. Updating the ledger's one row takes its lock, which the transaction holds until it ends,
// so no transaction takes a seq while another that took one has yet to commit, and seq order is commit order.
// recordedAt is read under the lock, so it rises with seq as long as the database's clock does.
const TAKE_SEQS: &str =
    "update ledger set latest_seq = latest_seq + $1 returning latest_seq, now_millis()";
const INSERT_EVENT: &str = "insert into events (seq, type, occurred_at, recorded_at, subscription_id, \
     account_id, store, environment, subscription_offer_kind, period_id, period_store_transaction_id, \
     period_starts_at, period_ends_at, period_price_amount, period_price_currency, period_offer_kind, \
     period_refunded_at, period_observed_at, period_left_with, period_left_with_no_one) \
     values ($1, $2, $3, $4, $5::uuid, $6::uuid, $7, $8, $9, $10::uuid, $11, $12, $13, $14, $15, $16, $17, $18, \
     $19::uuid, $20)";
// The subscriptions an account's entitlement carries, copied beside each event told under it in one statement however
// many there are. The rows are copied as they stand and differ from the ones the entitlement was folded from in nothing
// it carries: under the seq lock only a write that records no event commits beside this one, and such a write changes
// nothing an entitlement carries (INV-14).
const COPY_ENTITLEMENT: &str = concat!(
    "insert into entitlement_subscriptions (seq, ",
    subscription_columns!(),
    ") select seq, ",
    subscription_columns!(),
    " from unnest($1::bigint[]) as seq, subscriptions where id = any($2::text[]::uuid[])"
);

const NEWEST_SEQ: &str =
    "select coalesce(max(seq), 0) from events where subscription_id = $1::uuid";

const SELECT_LEDGER: &str = "select epoch, latest_seq from ledger";
// The columns of an event, each one EventRow reads.
macro_rules! event_columns {
    () => {
        "seq, type, occurred_at, recorded_at, subscription_id, account_id, store, environment, \
         subscription_offer_kind, period_id, period_store_transaction_id, period_starts_at, period_ends_at, \
         period_price_amount, period_price_currency, period_offer_kind, period_refunded_at, period_observed_at, \
         period_left_with, period_left_with_no_one"
    };
}
const SELECT_EVENTS: &str = concat!(
    "select ",
    event_columns!(),
    " from events where seq > $1 order by seq limit $2"
);
const SELECT_EVENTS_OF_SUBSCRIPTION: &str = concat!(
    "select ",
    event_columns!(),
    " from events where subscription_id = $1::uuid order by seq"
);
const SELECT_ENTITLEMENT_SUBSCRIPTIONS: &str = concat!(
    "select seq, ",
    subscription_columns!(),
    " from entitlement_subscriptions where seq = any($1)"
);

// §5.2: a page of the feed. A cursor means something only within its epoch.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FeedPage {
    pub epoch: Uuid,
    pub entries: Vec<FeedEntry>,
    pub latest_seq: i64,
}

// D-6: an event as the ledger recorded it, stamped with its seq and recordedAt.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RecordedEvent {
    pub seq: i64,
    pub recorded_at: Instant,
    pub event: Event,
}

// One event as the feed carries it: with its subscription's store, environment and offer kind, and its account's
// entitlement, each as they stood after the transaction that recorded it. The entitlement is absent exactly when
// the event names no account.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FeedEntry {
    pub seq: i64,
    pub recorded_at: Instant,
    pub event: Event,
    pub store: Store,
    pub environment: Environment,
    pub offer_kind: Option<OfferKind>,
    pub entitlement: Option<AccountEntitlement>,
}

impl Ledger {
    // At most `limit` events after the seq `after`, in seq order, read in one snapshot with the newest seq it holds.
    pub async fn feed(&self, after: i64, limit: i64) -> Result<FeedPage, StorageError> {
        let mut transaction = self
            .pool
            .begin_with("begin isolation level repeatable read, read only")
            .await?;
        let (epoch, latest_seq): (Uuid, i64) = sqlx::query_as(SELECT_LEDGER)
            .fetch_one(&mut *transaction)
            .await?;
        let events: Vec<EventRow> = sqlx::query_as(SELECT_EVENTS)
            .bind(after)
            .bind(limit)
            .fetch_all(&mut *transaction)
            .await?;
        let seqs: Vec<i64> = events.iter().map(|event| event.seq).collect();
        let entitlement_subscriptions: Vec<EntitlementSubscriptionRow> =
            sqlx::query_as(SELECT_ENTITLEMENT_SUBSCRIPTIONS)
                .bind(seqs)
                .fetch_all(&mut *transaction)
                .await?;
        transaction.commit().await?;

        let mut folded: BTreeMap<i64, Vec<Subscription>> = BTreeMap::new();
        for row in entitlement_subscriptions {
            folded
                .entry(row.seq)
                .or_default()
                .push(Subscription::try_from(row.subscription)?);
        }
        let entries = events
            .into_iter()
            .map(|event| {
                let subscriptions = folded.remove(&event.seq).unwrap_or_default();
                event.into_entry(subscriptions)
            })
            .collect::<Result<_, _>>()?;
        Ok(FeedPage {
            epoch,
            entries,
            latest_seq,
        })
    }
}

// Appends a change's events, all of one subscription, under the seq lock, each with the subscriptions its account's
// entitlement carries as this transaction leaves them. Returns each event's seq, in order; a change without events
// takes no seq.
pub(crate) async fn append(
    connection: &mut PgConnection,
    change: &Change,
) -> Result<Vec<i64>, StorageError> {
    if change.events.is_empty() {
        return Ok(Vec::new());
    }
    let count = change.events.len() as i64;
    let (latest_seq, recorded_at): (i64, i64) = sqlx::query_as(TAKE_SEQS)
        .bind(count)
        .fetch_one(&mut *connection)
        .await?;
    let seqs: Vec<i64> = (latest_seq - count + 1..=latest_seq).collect();

    let mut entitlements: BTreeMap<&AccountId, AccountEntitlement> = BTreeMap::new();
    for account_id in change
        .events
        .iter()
        .filter_map(|event| event.account_id.as_ref())
    {
        if !entitlements.contains_key(account_id) {
            let held = subscriptions::bound_to(connection, account_id).await?;
            entitlements.insert(account_id, AccountEntitlement::of(account_id.clone(), held));
        }
    }

    let subscription = &change.subscription;
    for (seq, event) in seqs.iter().zip(&change.events) {
        let event_row = sqlx::query(INSERT_EVENT)
            .bind(seq)
            .bind(event.kind.name())
            .bind(event.occurred_at.epoch_millis())
            .bind(recorded_at)
            .bind(event.subscription_id.as_str())
            .bind(event.account_id.as_ref().map(AccountId::as_str))
            .bind(subscription.lineage.store.name())
            .bind(subscription.lineage.environment.name())
            .bind(
                subscription
                    .status
                    .offer
                    .as_ref()
                    .map(|offer| offer.kind.name()),
            );
        bind_period(event_row, event.kind.period())
            .execute(&mut *connection)
            .await?;
    }
    for (account_id, entitlement) in &entitlements {
        let told: Vec<i64> = seqs
            .iter()
            .zip(&change.events)
            .filter(|(_, event)| event.account_id.as_ref() == Some(*account_id))
            .map(|(seq, _)| *seq)
            .collect();
        let carried: Vec<&str> = entitlement
            .subscriptions()
            .map(|held| held.id.as_str())
            .collect();
        sqlx::query(COPY_ENTITLEMENT)
            .bind(told)
            .bind(carried)
            .execute(&mut *connection)
            .await?;
    }
    Ok(seqs)
}

// Every event of the subscription, in seq order, whichever account each was told under.
pub(crate) async fn recorded_for(
    connection: &mut PgConnection,
    subscription_id: &SubscriptionId,
) -> Result<Vec<RecordedEvent>, StorageError> {
    let rows: Vec<EventRow> = sqlx::query_as(SELECT_EVENTS_OF_SUBSCRIPTION)
        .bind(subscription_id.as_str())
        .fetch_all(connection)
        .await?;
    rows.into_iter().map(RecordedEvent::try_from).collect()
}

// The seq of the subscription's newest event, 0 before its first. Read under its lineage's lock, it stays the
// newest until the transaction ends.
pub(crate) async fn newest_seq(
    connection: &mut PgConnection,
    subscription_id: &SubscriptionId,
) -> Result<i64, StorageError> {
    Ok(sqlx::query_scalar(NEWEST_SEQ)
        .bind(subscription_id.as_str())
        .fetch_one(connection)
        .await?)
}

#[derive(FromRow)]
struct EventRow {
    seq: i64,
    #[sqlx(rename = "type")]
    kind: String,
    occurred_at: i64,
    recorded_at: i64,
    subscription_id: Uuid,
    account_id: Option<Uuid>,
    store: String,
    environment: String,
    subscription_offer_kind: Option<String>,
    period_id: Option<Uuid>,
    period_store_transaction_id: Option<String>,
    period_starts_at: Option<i64>,
    period_ends_at: Option<i64>,
    period_price_amount: Option<String>,
    period_price_currency: Option<String>,
    period_offer_kind: Option<String>,
    period_refunded_at: Option<i64>,
    period_observed_at: Option<i64>,
    period_left_with: Option<Uuid>,
    period_left_with_no_one: bool,
}

impl EventRow {
    // The entry this row records, its entitlement folded over the subscriptions it names.
    fn into_entry(self, subscriptions: Vec<Subscription>) -> Result<FeedEntry, StorageError> {
        let store = named(Store::from_name, &self.store)?;
        let environment = named(Environment::from_name, &self.environment)?;
        let offer_kind = self
            .subscription_offer_kind
            .as_deref()
            .map(|kind| named(OfferKind::from_name, kind))
            .transpose()?;
        let RecordedEvent {
            seq,
            recorded_at,
            event,
        } = RecordedEvent::try_from(self)?;
        let entitlement = event
            .account_id
            .clone()
            .map(|account_id| AccountEntitlement::of(account_id, subscriptions));
        Ok(FeedEntry {
            seq,
            recorded_at,
            event,
            store,
            environment,
            offer_kind,
            entitlement,
        })
    }
}

impl TryFrom<EventRow> for RecordedEvent {
    type Error = StorageError;

    fn try_from(row: EventRow) -> Result<RecordedEvent, StorageError> {
        let unreadable = || StorageError::Unreadable;
        let period = match row.period_id {
            None => None,
            Some(id) => Some(Period::try_from(PeriodRow {
                id,
                store_transaction_id: row.period_store_transaction_id.ok_or_else(unreadable)?,
                starts_at: row.period_starts_at.ok_or_else(unreadable)?,
                ends_at: row.period_ends_at.ok_or_else(unreadable)?,
                price_amount: row.period_price_amount.ok_or_else(unreadable)?,
                price_currency: row.period_price_currency.ok_or_else(unreadable)?,
                offer_kind: row.period_offer_kind,
                refunded_at: row.period_refunded_at,
                observed_at: row.period_observed_at.ok_or_else(unreadable)?,
                left_with: row.period_left_with,
                left_with_no_one: row.period_left_with_no_one,
            })?),
        };
        Ok(RecordedEvent {
            seq: row.seq,
            recorded_at: Instant::from_epoch_millis(row.recorded_at),
            event: Event {
                kind: event_kind(&row.kind, period)?,
                occurred_at: Instant::from_epoch_millis(row.occurred_at),
                subscription_id: SubscriptionId::new(row.subscription_id.to_string()),
                account_id: row
                    .account_id
                    .map(|account_id| AccountId::new(account_id.to_string())),
            },
        })
    }
}

// The event a stored type names; a period event carries its period and no other event does (INV-13).
fn event_kind(name: &str, period: Option<Period>) -> Result<EventKind, StorageError> {
    let kind = match (name, period) {
        ("period_recorded", Some(period)) => EventKind::PeriodRecorded(period),
        ("period_refunded", Some(period)) => EventKind::PeriodRefunded(period),
        ("period_refund_reversed", Some(period)) => EventKind::PeriodRefundReversed(period),
        (_, Some(_)) => return Err(StorageError::Unreadable),
        ("started", None) => EventKind::Started,
        ("renewed", None) => EventKind::Renewed,
        ("renewal_turned_off", None) => EventKind::RenewalTurnedOff,
        ("renewal_turned_on", None) => EventKind::RenewalTurnedOn,
        ("payment_failed", None) => EventKind::PaymentFailed,
        ("payment_recovered", None) => EventKind::PaymentRecovered,
        ("pause_scheduled", None) => EventKind::PauseScheduled,
        ("paused", None) => EventKind::Paused,
        ("resumed", None) => EventKind::Resumed,
        ("plan_change_scheduled", None) => EventKind::PlanChangeScheduled,
        ("plan_changed", None) => EventKind::PlanChanged,
        ("period_extended", None) => EventKind::PeriodExtended,
        ("updated", None) => EventKind::Updated,
        ("expired", None) => EventKind::Expired,
        ("revoked", None) => EventKind::Revoked,
        ("revocation_reversed", None) => EventKind::RevocationReversed,
        ("bound", None) => EventKind::Bound,
        ("unbound", None) => EventKind::Unbound,
        (_, None) => return Err(StorageError::Unreadable),
    };
    Ok(kind)
}

#[derive(FromRow)]
struct EntitlementSubscriptionRow {
    seq: i64,
    #[sqlx(flatten)]
    subscription: SubscriptionRow,
}
