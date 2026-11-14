use std::time::Duration;

use crate::values::{
    AccountId, BillingInterval, Environment, Instant, Money, PeriodId, Plan, ProductId, Span,
    Store, StoreSubscriptionId, StoreTransactionId, Storefront, SubscriptionId, closed_names,
};

pub const RENEWAL_SLACK: Duration = Duration::from_hours(24);

// D-1, D-2, D-3: unique together, so one lineage is one subscription.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct Lineage {
    pub store: Store,
    pub environment: Environment,
    pub store_subscription_id: StoreSubscriptionId,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Subscription {
    pub id: SubscriptionId,
    pub lineage: Lineage,
    pub binding: Option<Binding>,
    pub status: Status,
    pub observed_at: Instant,
}

impl Subscription {
    pub fn account_id(&self) -> Option<&AccountId> {
        self.binding.as_ref().map(|binding| &binding.account_id)
    }

    // INV-2
    pub fn access_until(&self) -> Option<Instant> {
        let renewal_slack = match self.lineage.environment {
            Environment::Production => RENEWAL_SLACK,
            Environment::Sandbox => Duration::ZERO,
        };
        match &self.status.state {
            State::Active { .. } if self.status.renewal.auto_renew => {
                Some(self.status.current_period.end + renewal_slack)
            }
            State::Active { .. } => Some(self.status.current_period.end),
            State::Grace { grace_ends_at, .. } => Some(*grace_ends_at),
            State::OnHold { .. } | State::Paused { .. } | State::Expired(_) | State::Revoked(_) => {
                None
            }
        }
    }

    // INV-1: the only definition of paid access.
    pub fn grants_access(&self, now: Instant) -> bool {
        self.access_until()
            .is_some_and(|access_until| now < access_until)
    }
}

// D-7
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Binding {
    pub account_id: AccountId,
    pub bound_at: Instant,
    pub bound_by: BoundBy,
}

// Everything a store states about a subscription at one instant. The subscription holds the newest.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Status {
    pub plan: Plan,
    pub product_id: ProductId,
    pub billing_interval: BillingInterval,
    pub started_at: Instant,
    pub state: State,
    pub current_period: Span,
    pub renewal: Renewal,
    pub offer: Option<Offer>,
    pub price: Money,
    pub storefront: Storefront,
}

impl Status {
    pub(crate) fn charging_only_while_renewing(mut self) -> Status {
        let renews = self.renewal.auto_renew && matches!(self.state, State::Active { .. });
        if !renews {
            self.renewal.next_charge = None;
        }
        self
    }
}

// §3.2: each state carries the facts that exist only in it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum State {
    Active {
        pause_scheduled_for: Option<Instant>,
    },
    Grace {
        payment_failed_at: Instant,
        grace_ends_at: Instant,
    },
    OnHold {
        payment_failed_at: Instant,
    },
    Paused {
        paused_at: Instant,
        resumes_at: Option<Instant>,
    },
    Expired(Ending),
    Revoked(Ending),
}

impl State {
    pub fn name(&self) -> &'static str {
        match self {
            State::Active { .. } => "active",
            State::Grace { .. } => "grace",
            State::OnHold { .. } => "on_hold",
            State::Paused { .. } => "paused",
            State::Expired(_) => "expired",
            State::Revoked(_) => "revoked",
        }
    }

    pub fn has_ended(&self) -> bool {
        matches!(self, State::Expired(_) | State::Revoked(_))
    }

    pub fn in_payment_trouble(&self) -> bool {
        matches!(self, State::Grace { .. } | State::OnHold { .. })
    }

    pub fn pause_scheduled_for(&self) -> Option<Instant> {
        match self {
            State::Active {
                pause_scheduled_for,
            } => *pause_scheduled_for,
            _ => None,
        }
    }

    pub fn payment_failed_at(&self) -> Option<Instant> {
        match self {
            State::Grace {
                payment_failed_at, ..
            }
            | State::OnHold { payment_failed_at } => Some(*payment_failed_at),
            _ => None,
        }
    }

    pub fn grace_ends_at(&self) -> Option<Instant> {
        match self {
            State::Grace { grace_ends_at, .. } => Some(*grace_ends_at),
            _ => None,
        }
    }

    pub fn paused_at(&self) -> Option<Instant> {
        match self {
            State::Paused { paused_at, .. } => Some(*paused_at),
            _ => None,
        }
    }

    pub fn resumes_at(&self) -> Option<Instant> {
        match self {
            State::Paused { resumes_at, .. } => *resumes_at,
            _ => None,
        }
    }

    pub fn ending(&self) -> Option<&Ending> {
        match self {
            State::Expired(ending) | State::Revoked(ending) => Some(ending),
            _ => None,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Ending {
    pub at: Instant,
    pub reason: EndReason,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Renewal {
    pub auto_renew: bool,
    pub next_charge: Option<NextCharge>,
    pub next_product_id: Option<ProductId>,
    pub cancel_requested_at: Option<Instant>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NextCharge {
    pub at: Instant,
    pub price: Money,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Offer {
    pub kind: OfferKind,
    pub ends_at: Option<Instant>,
}

// D-4. Written once (INV-7); its refund time follows the newest statement about it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Period {
    pub id: PeriodId,
    pub transaction: StoreTransactionId,
    pub span: Span,
    pub price: Money,
    pub offer_kind: Option<OfferKind>,
    pub refunded_at: Option<Instant>,
    pub observed_at: Instant,
}

closed_names! {
    pub enum BoundBy {
        Purchase = "purchase",
        Claim = "claim",
    }

    pub enum EndReason {
        Cancelled = "cancelled",
        Billing = "billing",
        PriceChangeDeclined = "price_change_declined",
        ProductUnavailable = "product_unavailable",
        Replaced = "replaced",
        Refunded = "refunded",
        Chargeback = "chargeback",
        SharingRemoved = "sharing_removed",
        Unknown = "unknown",
    }

    pub enum OfferKind {
        FreeTrial = "free_trial",
        Introductory = "introductory",
        Promotional = "promotional",
        OfferCode = "offer_code",
        WinBack = "win_back",
    }
}
