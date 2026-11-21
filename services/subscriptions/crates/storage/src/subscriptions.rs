use domain::{
    AccountId, BillingInterval, Binding, BoundBy, Change, EndReason, Ending, Environment, Instant,
    LeftWith, Lineage, Money, NextCharge, Offer, OfferKind, Period, PeriodChange, PeriodId, Plan,
    ProductId, Renewal, Span, State, Status, Store, StoreSubscriptionId, StoreTransactionId,
    Storefront, Subscription, SubscriptionId,
};
use sqlx::postgres::{PgArguments, PgConnection};
use sqlx::query::QueryAs;
use sqlx::{FromRow, Postgres};
use uuid::Uuid;

use crate::ledger::{self, Ledger, PgQuery, StorageError};

// The columns of a subscription the domain knows, in the order bind_subscription binds them. The table
// `entitlement_subscriptions` holds the same ones; verifiedAt is the sweep's bookkeeping beside them.
macro_rules! subscription_columns {
    () => {
        "id, store, environment, store_subscription_id, account_id, bound_at, bound_by, plan, product_id, \
         billing_interval, started_at, state, current_period_starts_at, current_period_ends_at, \
         pause_scheduled_for, payment_failed_at, grace_ends_at, paused_at, resumes_at, ended_at, end_reason, \
         auto_renew, next_charge_at, next_charge_amount, next_charge_currency, next_product_id, \
         cancel_requested_at, offer_kind, offer_ends_at, price_amount, price_currency, storefront, observed_at, \
         cancellation_observed_at"
    };
}

macro_rules! subscription_values {
    () => {
        "$1::uuid, $2, $3, $4, $5::uuid, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, \
         $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $31, $32, $33, $34"
    };
}

pub(crate) use subscription_columns;

const LOCK_LINEAGE: &str = "select pg_advisory_xact_lock(hashtextextended(\
     format('lineage %s %s %s', $1::text, $2::text, $3::text), 0))";
const SELECT_LINEAGE: &str = concat!(
    "select ",
    subscription_columns!(),
    " from subscriptions where store = $1 and environment = $2 and store_subscription_id = $3"
);
// No key of the row changes, so the lock admits the key-share lock another transaction's entitlement snapshot takes
// on it through its foreign key while that transaction holds the seq lock; a stronger one deadlocks the two.
const SELECT_LINEAGE_LOCKED: &str = concat!(
    "select ",
    subscription_columns!(),
    " from subscriptions where store = $1 and environment = $2 and store_subscription_id = $3 \
     for no key update"
);
const SELECT_BY_ID: &str = concat!(
    "select ",
    subscription_columns!(),
    " from subscriptions where id = $1::uuid"
);
// The one order a write that locks several lineages takes them in, so two such writes never wait on each other.
macro_rules! in_lineage_order {
    () => {
        " order by store, environment, store_subscription_id collate \"C\""
    };
}

pub(crate) use in_lineage_order;

// The lineages holding anything of an account: a subscription bound to it, a period it paid for that a new purchase
// moved away (R-11), or a hint owed to the store for it.
const SELECT_LINEAGES_OF_ACCOUNT: &str = concat!(
    "select store, environment, store_subscription_id from subscriptions s \
     where s.account_id = $1::uuid \
     or exists (select from periods p where p.subscription_id = s.id and p.left_with = $1::uuid) \
     or exists (select from store_hints h where h.subscription_id = s.id and h.account_id = $1::uuid)",
    in_lineage_order!()
);
const SELECT_BOUND_TO: &str = concat!(
    "select ",
    subscription_columns!(),
    " from subscriptions where account_id = $1::uuid"
);
const INSERT_SUBSCRIPTION: &str = concat!(
    "insert into subscriptions (",
    subscription_columns!(),
    ") values (",
    subscription_values!(),
    ")"
);
const UPDATE_SUBSCRIPTION: &str = concat!(
    "update subscriptions set (",
    subscription_columns!(),
    ") = (",
    subscription_values!(),
    ") where id = $1::uuid"
);
const STAMP_VERIFIED: &str =
    "update subscriptions set verified_at = greatest(verified_at, $2) where id = $1::uuid";

const SELECT_PERIODS: &str = "select id, store_transaction_id, starts_at, ends_at, price_amount, \
     price_currency, offer_kind, refunded_at, observed_at, left_with, left_with_no_one from periods \
     where subscription_id = $1::uuid order by starts_at, store_transaction_id collate \"C\"";
const INSERT_PERIOD: &str = "insert into periods (id, store_transaction_id, starts_at, ends_at, \
     price_amount, price_currency, offer_kind, refunded_at, observed_at, left_with, left_with_no_one, \
     subscription_id) values ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10::uuid, $11, $12::uuid)";
const RESTATE_PERIOD: &str = "update periods set refunded_at = $2, observed_at = $3, left_with = $4::uuid, \
     left_with_no_one = $5 where id = $1::uuid";

impl Ledger {
    // What the ledger holds for one lineage: its subscription, if any, and its periods, read in one snapshot.
    pub async fn lineage(&self, lineage: &Lineage) -> Result<domain::Ledger, StorageError> {
        let mut transaction = self
            .pool
            .begin_with("begin isolation level repeatable read, read only")
            .await?;
        let held = load(&mut transaction, lineage, SELECT_LINEAGE).await?;
        transaction.commit().await?;
        Ok(held)
    }

    // The subscription the ledger keeps under its own id, as a refresh names it.
    pub async fn subscription(&self, id: Uuid) -> Result<Option<Subscription>, StorageError> {
        let row: Option<SubscriptionRow> = sqlx::query_as(SELECT_BY_ID)
            .bind(id)
            .fetch_optional(&self.pool)
            .await?;
        row.map(Subscription::try_from).transpose()
    }
}

// §3.4 step 1: the lineage, locked against every other writer until the transaction ends, even before its first
// observation has written it, and what the ledger holds for it.
pub(crate) async fn lock(
    connection: &mut PgConnection,
    lineage: &Lineage,
) -> Result<domain::Ledger, StorageError> {
    hold(connection, lineage).await?;
    load(connection, lineage, SELECT_LINEAGE_LOCKED).await
}

// Holds the lineage's lock until the transaction ends. It guards every row of the lineage, its subscription, periods
// and the hint owed for it, so a write locks one of those rows only once it holds the lineage.
pub(crate) async fn hold(
    connection: &mut PgConnection,
    lineage: &Lineage,
) -> Result<(), StorageError> {
    let lock = sqlx::query(LOCK_LINEAGE)
        .bind(lineage.store.name())
        .bind(lineage.environment.name())
        .bind(lineage.store_subscription_id.as_str());
    ledger::hold(connection, lock).await
}

async fn load(
    connection: &mut PgConnection,
    lineage: &Lineage,
    statement: &'static str,
) -> Result<domain::Ledger, StorageError> {
    let row: Option<SubscriptionRow> = sqlx::query_as(statement)
        .bind(lineage.store.name())
        .bind(lineage.environment.name())
        .bind(lineage.store_subscription_id.as_str())
        .fetch_optional(&mut *connection)
        .await?;
    let Some(row) = row else {
        return Ok(domain::Ledger::default());
    };
    let subscription = Subscription::try_from(row)?;
    let periods = periods_of(connection, &subscription.id).await?;
    Ok(domain::Ledger {
        subscription: Some(subscription),
        periods,
    })
}

// The subscription's periods, by start.
pub(crate) async fn periods_of(
    connection: &mut PgConnection,
    subscription_id: &SubscriptionId,
) -> Result<Vec<Period>, StorageError> {
    let rows: Vec<PeriodRow> = sqlx::query_as(SELECT_PERIODS)
        .bind(subscription_id.as_str())
        .fetch_all(connection)
        .await?;
    rows.into_iter().map(Period::try_from).collect()
}

// Writes what a change makes of its lineage: the subscription when it differs from the one held, and each period
// written or restated. A replay changes neither, so it writes nothing (INV-4).
pub(crate) async fn save(
    connection: &mut PgConnection,
    held: Option<&Subscription>,
    change: &Change,
) -> Result<(), StorageError> {
    let subscription = &change.subscription;
    let statement = match held {
        None => Some(INSERT_SUBSCRIPTION),
        Some(held) if held != subscription => Some(UPDATE_SUBSCRIPTION),
        Some(_) => None,
    };
    if let Some(statement) = statement {
        bind_subscription(sqlx::query(statement), subscription)
            .execute(&mut *connection)
            .await?;
    }
    for period_change in &change.periods {
        match period_change {
            PeriodChange::Written(period) => {
                bind_period(sqlx::query(INSERT_PERIOD), Some(period))
                    .bind(subscription.id.as_str())
                    .execute(&mut *connection)
                    .await?;
            }
            PeriodChange::Restated(period) => {
                sqlx::query(RESTATE_PERIOD)
                    .bind(period.id.as_str())
                    .bind(period.refunded_at.map(Instant::epoch_millis))
                    .bind(period.observed_at.epoch_millis())
                    .bind(paid_by(Some(period)))
                    .bind(left_with_no_one(Some(period)))
                    .execute(&mut *connection)
                    .await?;
            }
        }
    }
    Ok(())
}

// verifiedAt: the newest time the service pulled the subscription's state from its store.
pub(crate) async fn stamp_verified(
    connection: &mut PgConnection,
    subscription_id: &SubscriptionId,
    pulled_at: Instant,
) -> Result<(), StorageError> {
    sqlx::query(STAMP_VERIFIED)
        .bind(subscription_id.as_str())
        .bind(pulled_at.epoch_millis())
        .execute(connection)
        .await?;
    Ok(())
}

// The lineages an erasure of the account changes (§6.4), in lineage order. Read before their locks are taken; only a
// move away from the account changes what one holds of it meanwhile, and a lineage moved away still holds the periods
// the account paid for.
pub(crate) async fn of_account(
    connection: &mut PgConnection,
    account_id: &AccountId,
) -> Result<Vec<Lineage>, StorageError> {
    lineages(
        connection,
        sqlx::query_as(SELECT_LINEAGES_OF_ACCOUNT).bind(account_id.as_str()),
    )
    .await
}

// The lineages a query answers as rows of store, environment and store subscription id.
pub(crate) async fn lineages(
    connection: &mut PgConnection,
    query: QueryAs<'_, Postgres, (String, String, String), PgArguments>,
) -> Result<Vec<Lineage>, StorageError> {
    let rows = query.fetch_all(connection).await?;
    rows.into_iter()
        .map(|(store, environment, store_subscription_id)| {
            Ok(Lineage {
                store: named(Store::from_name, &store)?,
                environment: named(Environment::from_name, &environment)?,
                store_subscription_id: StoreSubscriptionId::new(store_subscription_id),
            })
        })
        .collect()
}

// Every subscription bound to the account, what its entitlement folds over (D-8).
pub(crate) async fn bound_to(
    connection: &mut PgConnection,
    account_id: &AccountId,
) -> Result<Vec<Subscription>, StorageError> {
    let rows: Vec<SubscriptionRow> = sqlx::query_as(SELECT_BOUND_TO)
        .bind(account_id.as_str())
        .fetch_all(connection)
        .await?;
    rows.into_iter().map(Subscription::try_from).collect()
}

// Binds a subscription to the parameters subscription_values names, in the order of subscription_columns.
fn bind_subscription<'q>(query: PgQuery<'q>, subscription: &Subscription) -> PgQuery<'q> {
    let Subscription {
        id,
        lineage,
        binding,
        status,
        observed_at,
        cancellation_observed_at,
    } = subscription;
    let binding = binding.as_ref();
    let state = &status.state;
    let ending = state.ending();
    let next_charge = status.renewal.next_charge.as_ref();
    let offer = status.offer.as_ref();
    query
        .bind(id.as_str())
        .bind(lineage.store.name())
        .bind(lineage.environment.name())
        .bind(lineage.store_subscription_id.as_str())
        .bind(binding.map(|binding| binding.account_id.as_str()))
        .bind(binding.map(|binding| binding.bound_at.epoch_millis()))
        .bind(binding.map(|binding| binding.bound_by.name()))
        .bind(status.plan.name())
        .bind(status.product_id.as_str())
        .bind(status.billing_interval.as_str())
        .bind(status.started_at.epoch_millis())
        .bind(state.name())
        .bind(status.current_period.start.epoch_millis())
        .bind(status.current_period.end.epoch_millis())
        .bind(state.pause_scheduled_for().map(Instant::epoch_millis))
        .bind(state.payment_failed_at().map(Instant::epoch_millis))
        .bind(state.grace_ends_at().map(Instant::epoch_millis))
        .bind(state.paused_at().map(Instant::epoch_millis))
        .bind(state.resumes_at().map(Instant::epoch_millis))
        .bind(ending.map(|ending| ending.at.epoch_millis()))
        .bind(ending.map(|ending| ending.reason.name()))
        .bind(status.renewal.auto_renew)
        .bind(next_charge.map(|charge| charge.at.epoch_millis()))
        .bind(next_charge.map(|charge| charge.price.amount()))
        .bind(next_charge.map(|charge| charge.price.currency()))
        .bind(
            status
                .renewal
                .next_product_id
                .as_ref()
                .map(ProductId::as_str),
        )
        .bind(
            status
                .renewal
                .cancel_requested_at
                .map(Instant::epoch_millis),
        )
        .bind(offer.map(|offer| offer.kind.name()))
        .bind(
            offer
                .and_then(|offer| offer.ends_at)
                .map(Instant::epoch_millis),
        )
        .bind(status.price.amount())
        .bind(status.price.currency())
        .bind(status.storefront.as_ref().map(Storefront::as_str))
        .bind(observed_at.epoch_millis())
        .bind(cancellation_observed_at.map(Instant::epoch_millis))
}

// Binds a period, or none, to eleven parameters in the order of the periods table: id, store transaction, start, end,
// price amount and currency, offer kind, refund time, the stamp of its newest statement, the account it stays with,
// cast from text to uuid, and whether it stays with no one, false for none.
pub(crate) fn bind_period<'q>(query: PgQuery<'q>, period: Option<&Period>) -> PgQuery<'q> {
    query
        .bind(period.map(|period| period.id.as_str()))
        .bind(period.map(|period| period.transaction.as_str()))
        .bind(period.map(|period| period.span.start.epoch_millis()))
        .bind(period.map(|period| period.span.end.epoch_millis()))
        .bind(period.map(|period| period.price.amount()))
        .bind(period.map(|period| period.price.currency()))
        .bind(
            period
                .and_then(|period| period.offer_kind)
                .map(OfferKind::name),
        )
        .bind(
            period
                .and_then(|period| period.refunded_at)
                .map(Instant::epoch_millis),
        )
        .bind(period.map(|period| period.observed_at.epoch_millis()))
        .bind(paid_by(period))
        .bind(left_with_no_one(period))
}

// The account a period stays with once a new purchase moved its subscription (R-11).
fn paid_by(period: Option<&Period>) -> Option<&str> {
    match period.and_then(|period| period.left_with.as_ref()) {
        Some(LeftWith::Account(account_id)) => Some(account_id.as_str()),
        Some(LeftWith::NoOne) | None => None,
    }
}

fn left_with_no_one(period: Option<&Period>) -> bool {
    period.is_some_and(|period| period.left_with == Some(LeftWith::NoOne))
}

#[derive(FromRow)]
pub(crate) struct SubscriptionRow {
    id: Uuid,
    store: String,
    environment: String,
    store_subscription_id: String,
    account_id: Option<Uuid>,
    bound_at: Option<i64>,
    bound_by: Option<String>,
    plan: String,
    product_id: String,
    billing_interval: String,
    started_at: i64,
    state: String,
    current_period_starts_at: i64,
    current_period_ends_at: i64,
    pause_scheduled_for: Option<i64>,
    payment_failed_at: Option<i64>,
    grace_ends_at: Option<i64>,
    paused_at: Option<i64>,
    resumes_at: Option<i64>,
    ended_at: Option<i64>,
    end_reason: Option<String>,
    auto_renew: bool,
    next_charge_at: Option<i64>,
    next_charge_amount: Option<String>,
    next_charge_currency: Option<String>,
    next_product_id: Option<String>,
    cancel_requested_at: Option<i64>,
    offer_kind: Option<String>,
    offer_ends_at: Option<i64>,
    price_amount: String,
    price_currency: String,
    storefront: Option<String>,
    observed_at: i64,
    cancellation_observed_at: Option<i64>,
}

impl TryFrom<SubscriptionRow> for Subscription {
    type Error = StorageError;

    fn try_from(row: SubscriptionRow) -> Result<Subscription, StorageError> {
        let instant = Instant::from_epoch_millis;
        let fact = |millis: Option<i64>| millis.map(instant).ok_or(StorageError::Unreadable);
        let ending = || -> Result<Ending, StorageError> {
            Ok(Ending {
                at: fact(row.ended_at)?,
                reason: named(
                    EndReason::from_name,
                    row.end_reason.as_deref().ok_or(StorageError::Unreadable)?,
                )?,
            })
        };
        let state = match row.state.as_str() {
            "active" => State::Active {
                pause_scheduled_for: row.pause_scheduled_for.map(instant),
            },
            "grace" => State::Grace {
                payment_failed_at: fact(row.payment_failed_at)?,
                grace_ends_at: fact(row.grace_ends_at)?,
            },
            "on_hold" => State::OnHold {
                payment_failed_at: fact(row.payment_failed_at)?,
            },
            "paused" => State::Paused {
                paused_at: fact(row.paused_at)?,
                resumes_at: row.resumes_at.map(instant),
            },
            "expired" => State::Expired(ending()?),
            "revoked" => State::Revoked(ending()?),
            _ => return Err(StorageError::Unreadable),
        };
        let binding = match (row.account_id, row.bound_at, row.bound_by.as_deref()) {
            (None, None, None) => None,
            (Some(account_id), Some(bound_at), Some(bound_by)) => Some(Binding {
                account_id: AccountId::new(account_id.to_string()),
                bound_at: instant(bound_at),
                bound_by: named(BoundBy::from_name, bound_by)?,
            }),
            _ => return Err(StorageError::Unreadable),
        };
        let next_charge = match (
            row.next_charge_at,
            row.next_charge_amount,
            row.next_charge_currency,
        ) {
            (None, None, None) => None,
            (Some(at), Some(amount), Some(currency)) => Some(NextCharge {
                at: instant(at),
                price: money(&amount, &currency)?,
            }),
            _ => return Err(StorageError::Unreadable),
        };
        let offer = match (row.offer_kind.as_deref(), row.offer_ends_at) {
            (None, None) => None,
            (Some(kind), ends_at) => Some(Offer {
                kind: named(OfferKind::from_name, kind)?,
                ends_at: ends_at.map(instant),
            }),
            (None, Some(_)) => return Err(StorageError::Unreadable),
        };
        Ok(Subscription {
            id: SubscriptionId::new(row.id.to_string()),
            lineage: Lineage {
                store: named(Store::from_name, &row.store)?,
                environment: named(Environment::from_name, &row.environment)?,
                store_subscription_id: StoreSubscriptionId::new(row.store_subscription_id),
            },
            binding,
            status: Status {
                plan: named(Plan::from_name, &row.plan)?,
                product_id: ProductId::new(row.product_id),
                billing_interval: BillingInterval::new(row.billing_interval),
                started_at: instant(row.started_at),
                state,
                current_period: Span {
                    start: instant(row.current_period_starts_at),
                    end: instant(row.current_period_ends_at),
                },
                renewal: Renewal {
                    auto_renew: row.auto_renew,
                    next_charge,
                    next_product_id: row.next_product_id.map(ProductId::new),
                    cancel_requested_at: row.cancel_requested_at.map(instant),
                },
                offer,
                price: money(&row.price_amount, &row.price_currency)?,
                storefront: row.storefront.map(Storefront::new),
            },
            observed_at: instant(row.observed_at),
            cancellation_observed_at: row.cancellation_observed_at.map(instant),
        })
    }
}

#[derive(FromRow)]
pub(crate) struct PeriodRow {
    pub(crate) id: Uuid,
    pub(crate) store_transaction_id: String,
    pub(crate) starts_at: i64,
    pub(crate) ends_at: i64,
    pub(crate) price_amount: String,
    pub(crate) price_currency: String,
    pub(crate) offer_kind: Option<String>,
    pub(crate) refunded_at: Option<i64>,
    pub(crate) observed_at: i64,
    pub(crate) left_with: Option<Uuid>,
    pub(crate) left_with_no_one: bool,
}

impl TryFrom<PeriodRow> for Period {
    type Error = StorageError;

    fn try_from(row: PeriodRow) -> Result<Period, StorageError> {
        Ok(Period {
            id: PeriodId::new(row.id.to_string()),
            transaction: StoreTransactionId::new(row.store_transaction_id),
            span: Span {
                start: Instant::from_epoch_millis(row.starts_at),
                end: Instant::from_epoch_millis(row.ends_at),
            },
            price: money(&row.price_amount, &row.price_currency)?,
            offer_kind: row
                .offer_kind
                .as_deref()
                .map(|kind| named(OfferKind::from_name, kind))
                .transpose()?,
            refunded_at: row.refunded_at.map(Instant::from_epoch_millis),
            observed_at: Instant::from_epoch_millis(row.observed_at),
            left_with: match (row.left_with, row.left_with_no_one) {
                (None, false) => None,
                (Some(account_id), false) => {
                    Some(LeftWith::Account(AccountId::new(account_id.to_string())))
                }
                (None, true) => Some(LeftWith::NoOne),
                (Some(_), true) => return Err(StorageError::Unreadable),
            },
        })
    }
}

// A closed name read back; one this build does not know is unreadable.
pub(crate) fn named<T>(from_name: fn(&str) -> Option<T>, name: &str) -> Result<T, StorageError> {
    from_name(name).ok_or(StorageError::Unreadable)
}

fn money(amount: &str, currency: &str) -> Result<Money, StorageError> {
    Money::new(amount, currency).ok_or(StorageError::Unreadable)
}
