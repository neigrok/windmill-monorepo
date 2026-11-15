// The internal doors' wire shapes (spec §5.2), written from the ledger's own types; packages/api-contract/subscriptions
// pins each of them.

use domain::{AccountEntitlement, Entitlement, Event, Instant, Money, Period, Span, Subscription};
use serde::Serialize;
use storage::{AccountRecord, FeedEntry, FeedPage, RecordedEvent, SubscriptionRecord};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FeedPageResponse {
    pub epoch: String,
    pub entries: Vec<FeedEntryResponse>,
    pub latest_seq: i64,
}

impl From<&FeedPage> for FeedPageResponse {
    fn from(page: &FeedPage) -> FeedPageResponse {
        FeedPageResponse {
            epoch: page.epoch.to_string(),
            entries: page.entries.iter().map(FeedEntryResponse::from).collect(),
            latest_seq: page.latest_seq,
        }
    }
}

// One event with its subscription's store, environment and offer kind, and its account's entitlement, as they stood
// after the transaction that recorded it.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FeedEntryResponse {
    pub seq: i64,
    #[serde(rename = "type")]
    pub kind: &'static str,
    pub occurred_at: i64,
    pub recorded_at: i64,
    pub subscription_id: String,
    pub account_id: Option<String>,
    pub store: &'static str,
    pub environment: &'static str,
    pub offer_kind: Option<&'static str>,
    pub period: Option<PeriodResponse>,
    pub entitlement: Option<EntitlementResponse>,
}

impl From<&FeedEntry> for FeedEntryResponse {
    fn from(entry: &FeedEntry) -> FeedEntryResponse {
        let Event {
            kind,
            occurred_at,
            subscription_id,
            account_id,
        } = &entry.event;
        FeedEntryResponse {
            seq: entry.seq,
            kind: kind.name(),
            occurred_at: occurred_at.epoch_millis(),
            recorded_at: entry.recorded_at.epoch_millis(),
            subscription_id: subscription_id.as_str().to_owned(),
            account_id: account_id.as_ref().map(|id| id.as_str().to_owned()),
            store: entry.store.name(),
            environment: entry.environment.name(),
            offer_kind: entry.offer_kind.map(|kind| kind.name()),
            period: kind.period().map(PeriodResponse::from),
            entitlement: entry.entitlement.as_ref().map(EntitlementResponse::from),
        }
    }
}

// `EntitlementResponse` (§5.2): one block for each environment.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EntitlementResponse {
    pub account_id: String,
    pub production: EntitlementBlockResponse,
    pub sandbox: EntitlementBlockResponse,
}

impl From<&AccountEntitlement> for EntitlementResponse {
    fn from(entitlement: &AccountEntitlement) -> EntitlementResponse {
        EntitlementResponse {
            account_id: entitlement.account_id.as_str().to_owned(),
            production: EntitlementBlockResponse::from(&entitlement.production),
            sandbox: EntitlementBlockResponse::from(&entitlement.sandbox),
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EntitlementBlockResponse {
    pub plan: Option<&'static str>,
    pub access_until: Option<i64>,
    pub governing: Option<SubscriptionStatusResponse>,
    pub others: Vec<SubscriptionStatusResponse>,
}

impl From<&Entitlement> for EntitlementBlockResponse {
    fn from(entitlement: &Entitlement) -> EntitlementBlockResponse {
        EntitlementBlockResponse {
            plan: entitlement.plan().map(|plan| plan.name()),
            access_until: entitlement.access_until.map(Instant::epoch_millis),
            governing: entitlement
                .governing
                .as_ref()
                .map(SubscriptionStatusResponse::from),
            others: entitlement
                .others
                .iter()
                .map(SubscriptionStatusResponse::from)
                .collect(),
        }
    }
}

// A subscription as an entitlement shows it: `governing` and each of `others` (§5.2).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubscriptionStatusResponse {
    pub subscription_id: String,
    pub store: &'static str,
    pub state: &'static str,
    pub started_at: i64,
    pub current_period: SpanResponse,
    pub access_until: Option<i64>,
    pub auto_renew: bool,
    pub next_charge_at: Option<i64>,
    pub next_charge: Option<MoneyResponse>,
    pub next_product_id: Option<String>,
    pub cancel_requested_at: Option<i64>,
    pub payment_failed_at: Option<i64>,
    pub grace_ends_at: Option<i64>,
    pub pause_scheduled_for: Option<i64>,
    pub paused_at: Option<i64>,
    pub resumes_at: Option<i64>,
    pub offer_kind: Option<&'static str>,
    pub offer_ends_at: Option<i64>,
    pub ended_at: Option<i64>,
    pub end_reason: Option<&'static str>,
}

impl From<&Subscription> for SubscriptionStatusResponse {
    fn from(subscription: &Subscription) -> SubscriptionStatusResponse {
        let status = &subscription.status;
        let state = &status.state;
        let renewal = &status.renewal;
        let millis = |instant: Option<Instant>| instant.map(Instant::epoch_millis);
        SubscriptionStatusResponse {
            subscription_id: subscription.id.as_str().to_owned(),
            store: subscription.lineage.store.name(),
            state: state.name(),
            started_at: status.started_at.epoch_millis(),
            current_period: SpanResponse::from(&status.current_period),
            access_until: millis(subscription.access_until()),
            auto_renew: renewal.auto_renew,
            next_charge_at: millis(renewal.next_charge.as_ref().map(|charge| charge.at)),
            next_charge: renewal
                .next_charge
                .as_ref()
                .map(|charge| MoneyResponse::from(&charge.price)),
            next_product_id: renewal
                .next_product_id
                .as_ref()
                .map(|product| product.as_str().to_owned()),
            cancel_requested_at: millis(renewal.cancel_requested_at),
            payment_failed_at: millis(state.payment_failed_at()),
            grace_ends_at: millis(state.grace_ends_at()),
            pause_scheduled_for: millis(state.pause_scheduled_for()),
            paused_at: millis(state.paused_at()),
            resumes_at: millis(state.resumes_at()),
            offer_kind: status.offer.as_ref().map(|offer| offer.kind.name()),
            offer_ends_at: millis(status.offer.as_ref().and_then(|offer| offer.ends_at)),
            ended_at: millis(state.ending().map(|ending| ending.at)),
            end_reason: state.ending().map(|ending| ending.reason.name()),
        }
    }
}

// D-4 as a period event carries it; `id` is the service's own, never the store's transaction id.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PeriodResponse {
    pub id: String,
    pub start: i64,
    pub end: i64,
    pub price: MoneyResponse,
    pub offer_kind: Option<&'static str>,
    pub refunded_at: Option<i64>,
}

impl From<&Period> for PeriodResponse {
    fn from(period: &Period) -> PeriodResponse {
        PeriodResponse {
            id: period.id.as_str().to_owned(),
            start: period.span.start.epoch_millis(),
            end: period.span.end.epoch_millis(),
            price: MoneyResponse::from(&period.price),
            offer_kind: period.offer_kind.map(|kind| kind.name()),
            refunded_at: period.refunded_at.map(Instant::epoch_millis),
        }
    }
}

#[derive(Serialize)]
pub struct SpanResponse {
    pub start: i64,
    pub end: i64,
}

impl From<&Span> for SpanResponse {
    fn from(span: &Span) -> SpanResponse {
        SpanResponse {
            start: span.start.epoch_millis(),
            end: span.end.epoch_millis(),
        }
    }
}

#[derive(Serialize)]
pub struct MoneyResponse {
    pub amount: String,
    pub currency: String,
}

impl From<&Money> for MoneyResponse {
    fn from(money: &Money) -> MoneyResponse {
        MoneyResponse {
            amount: money.amount().to_owned(),
            currency: money.currency().to_owned(),
        }
    }
}

// `GET /internal/v1/accounts/{accountId}`: the entitlement, and every subscription bound to the account with its
// periods and its events, each event under the account it was told under.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountResponse {
    pub entitlement: EntitlementResponse,
    pub subscriptions: Vec<BoundSubscriptionResponse>,
}

impl From<&AccountRecord> for AccountResponse {
    fn from(record: &AccountRecord) -> AccountResponse {
        AccountResponse {
            entitlement: EntitlementResponse::from(&record.entitlement),
            subscriptions: record
                .subscriptions
                .iter()
                .map(BoundSubscriptionResponse::from)
                .collect(),
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BoundSubscriptionResponse {
    #[serde(flatten)]
    pub status: SubscriptionStatusResponse,
    pub environment: &'static str,
    pub bound_at: Option<i64>,
    pub bound_by: Option<&'static str>,
    pub periods: Vec<PeriodResponse>,
    pub events: Vec<EventResponse>,
}

impl From<&SubscriptionRecord> for BoundSubscriptionResponse {
    fn from(record: &SubscriptionRecord) -> BoundSubscriptionResponse {
        let subscription = &record.subscription;
        let binding = subscription.binding.as_ref();
        BoundSubscriptionResponse {
            status: SubscriptionStatusResponse::from(subscription),
            environment: subscription.lineage.environment.name(),
            bound_at: binding.map(|binding| binding.bound_at.epoch_millis()),
            bound_by: binding.map(|binding| binding.bound_by.name()),
            periods: record.periods.iter().map(PeriodResponse::from).collect(),
            events: record.events.iter().map(EventResponse::from).collect(),
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EventResponse {
    pub seq: i64,
    #[serde(rename = "type")]
    pub kind: &'static str,
    pub occurred_at: i64,
    pub recorded_at: i64,
    pub account_id: Option<String>,
    pub period: Option<PeriodResponse>,
}

impl From<&RecordedEvent> for EventResponse {
    fn from(recorded: &RecordedEvent) -> EventResponse {
        let event = &recorded.event;
        EventResponse {
            seq: recorded.seq,
            kind: event.kind.name(),
            occurred_at: event.occurred_at.epoch_millis(),
            recorded_at: recorded.recorded_at.epoch_millis(),
            account_id: event.account_id.as_ref().map(|id| id.as_str().to_owned()),
            period: event.kind.period().map(PeriodResponse::from),
        }
    }
}

// The internal claim's answer (§5.2): the claimed subscription's newest seq, and the caller's entitlement after it.
#[derive(Serialize)]
pub struct ClaimResponse {
    pub seq: i64,
    pub entitlement: EntitlementResponse,
}

// A refresh's answer: the subscription's newest seq once the pulled state applied.
#[derive(Serialize)]
pub struct RefreshResponse {
    pub seq: i64,
}

// What a door answers when it refuses: a code, and nothing about the request.
#[derive(Serialize)]
pub struct RefusalResponse {
    pub code: &'static str,
}
