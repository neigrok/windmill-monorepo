use domain::{
    BillingInterval, EndReason, Ending, Environment, Instant, Lineage, Money, NextCharge,
    Observation, ObservedPeriod, Offer, OfferKind, Ownership, Plan, ProductId, Renewal, Span,
    State, Status, Store, StoreSubscriptionId, StoreTransactionId, Storefront,
};

use crate::verification::{self, AccountToken, Notification, TransactionInfo};

// §8: the one product Windmill sells on the App Store, a month of Windmill One.
const WINDMILL_ONE_MONTHLY: &str = "works.windmill.app.one.monthly";

// What one verified notification states, in the domain's words; the door logs the outcome, never the payload.
pub enum Decoded {
    // The subscription's whole state: the caller resolves the account token into the hint and applies it with observe.
    Observation {
        observation: Observation,
        account_token: Option<AccountToken>,
    },
    // The state has to come from the store's status: the caller pulls it, then applies the period with its own stamp (§8).
    AwaitsStatus {
        statement: PeriodStatement,
        awaiting: Awaiting,
    },
    // Apple states nothing about any subscription.
    Silent(Silence),
    // Kept in the inbox, logged as unsupported and reported; it changes nothing.
    Unsupported(Unsupported),
}

// One transaction's statement of the period it pays for, without the subscription's state.
pub struct PeriodStatement {
    pub lineage: Lineage,
    pub observed_at: Instant,
    pub ownership: Ownership,
    pub period: ObservedPeriod,
    pub account_token: Option<AccountToken>,
    // When renewal was turned off, as a DID_CHANGE_RENEWAL_STATUS states it; no status pull can say.
    pub cancel_requested_at: Option<Instant>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Awaiting {
    // A notification about an earlier transaction, as a refund of an earlier month.
    EarlierTransaction,
    // A transaction Apple's definition of the type makes the latest, which the renewal info does not confirm: reported.
    LatestUnconfirmed,
}

impl Awaiting {
    pub fn code(self) -> &'static str {
        match self {
            Awaiting::EarlierTransaction => "earlier_transaction",
            Awaiting::LatestUnconfirmed => "latest_unconfirmed",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Silence {
    Test,
    RenewalExtensionSummary,
}

impl Silence {
    pub fn code(self) -> &'static str {
        match self {
            Silence::Test => "test",
            Silence::RenewalExtensionSummary => "renewal_extension_summary",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Unsupported {
    UnknownType,
    OneTimeCharge,
    Seats,
    CommitmentPlan,
    ExternalPurchase,
    AdvancedCommerce,
    ParentalConsent,
    UnknownProduct,
    Incomplete,
    Inconsistent,
    UnknownValue,
}

impl Unsupported {
    pub fn code(self) -> &'static str {
        match self {
            Unsupported::UnknownType => "unknown_type",
            Unsupported::OneTimeCharge => "one_time_charge",
            Unsupported::Seats => "seats",
            Unsupported::CommitmentPlan => "commitment_plan",
            Unsupported::ExternalPurchase => "external_purchase",
            Unsupported::AdvancedCommerce => "advanced_commerce",
            Unsupported::ParentalConsent => "parental_consent",
            Unsupported::UnknownProduct => "unknown_product",
            Unsupported::Incomplete => "incomplete",
            Unsupported::Inconsistent => "inconsistent",
            Unsupported::UnknownValue => "unknown_value",
        }
    }
}

// App Store Server Notifications V2: the type and subtype say which notification it is; the state comes from its data.
pub fn decode(notification: &Notification) -> Decoded {
    read(notification).unwrap_or_else(Decoded::Unsupported)
}

// A signed transaction a phone hands to the claim door, stamped at its own signing (§4, §5.2).
pub fn decode_claim(transaction: &TransactionInfo) -> Result<PeriodStatement, Unsupported> {
    let observed_at = transaction
        .signed_date
        .map(Instant::from_epoch_millis)
        .ok_or(Unsupported::Incomplete)?;
    Ok(Purchase::read(transaction, observed_at, Refund::AsTransactionStates)?.statement(None))
}

// What a notification's type says beyond its data.
#[derive(Clone, Copy)]
struct Reading {
    of_the_latest: bool,
    states_cancel_time: bool,
    refund: Refund,
    expired_for: Option<EndReason>,
}

// What a notification's type says of the refund of its transaction, whatever the transaction still carries.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Refund {
    AsTransactionStates,
    Taken,
    Reversed,
}

impl Reading {
    // A type that, by Apple's definition, concerns the subscription's latest transaction.
    const OF_THE_LATEST: Reading = Reading {
        of_the_latest: true,
        states_cancel_time: false,
        refund: Refund::AsTransactionStates,
        expired_for: None,
    };
    const OF_ANY_TRANSACTION: Reading = Reading {
        of_the_latest: false,
        ..Reading::OF_THE_LATEST
    };

    const fn expired_for(reason: EndReason) -> Reading {
        Reading {
            expired_for: Some(reason),
            ..Reading::OF_THE_LATEST
        }
    }
}

fn read(notification: &Notification) -> Result<Decoded, Unsupported> {
    let reading = match (
        notification.notification_type.as_str(),
        notification.subtype.as_deref(),
    ) {
        ("SUBSCRIBED", Some("INITIAL_BUY" | "RESUBSCRIBE"))
        | ("DID_RENEW", None | Some("BILLING_RECOVERY"))
        | ("DID_FAIL_TO_RENEW", None | Some("GRACE_PERIOD"))
        | ("GRACE_PERIOD_EXPIRED" | "RENEWAL_EXTENDED" | "EXPIRED", None) => Reading::OF_THE_LATEST,
        ("EXPIRED", Some("VOLUNTARY")) => Reading::expired_for(EndReason::Cancelled),
        ("EXPIRED", Some("BILLING_RETRY")) => Reading::expired_for(EndReason::Billing),
        ("EXPIRED", Some("PRICE_INCREASE")) => Reading::expired_for(EndReason::PriceChangeDeclined),
        ("EXPIRED", Some("PRODUCT_NOT_FOR_SALE")) => {
            Reading::expired_for(EndReason::ProductUnavailable)
        }
        (
            "DID_CHANGE_RENEWAL_STATUS",
            None | Some("AUTO_RENEW_ENABLED" | "AUTO_RENEW_DISABLED"),
        ) => Reading {
            states_cancel_time: true,
            ..Reading::OF_THE_LATEST
        },
        ("REFUND", None) => Reading {
            refund: Refund::Taken,
            ..Reading::OF_ANY_TRANSACTION
        },
        ("REFUND_REVERSED", None) => Reading {
            refund: Refund::Reversed,
            ..Reading::OF_ANY_TRANSACTION
        },
        ("DID_CHANGE_RENEWAL_PREF" | "OFFER_REDEEMED", None | Some("UPGRADE" | "DOWNGRADE"))
        | ("PRICE_INCREASE", Some("PENDING" | "ACCEPTED"))
        | ("REFUND_DECLINED" | "REVOKE" | "CONSUMPTION_REQUEST", None)
        | ("RENEWAL_EXTENSION", Some("FAILURE")) => Reading::OF_ANY_TRANSACTION,
        ("TEST", None) => return Ok(Decoded::Silent(Silence::Test)),
        ("RENEWAL_EXTENSION", Some("SUMMARY")) => {
            return Ok(Decoded::Silent(Silence::RenewalExtensionSummary));
        }
        ("DID_CHANGE_RENEWAL_PREF", Some("INCREASE_QUANTITY" | "DECREASE_QUANTITY"))
        | ("REFUND", Some("SEATS"))
        | ("UNCLAIM_SEATS", None) => return Err(Unsupported::Seats),
        ("ONE_TIME_CHARGE", None) => return Err(Unsupported::OneTimeCharge),
        ("EXTERNAL_PURCHASE_TOKEN", Some("CREATED" | "ACTIVE_TOKEN_REMINDER" | "UNREPORTED")) => {
            return Err(Unsupported::ExternalPurchase);
        }
        ("METADATA_UPDATE" | "MIGRATION" | "PRICE_CHANGE", None) => {
            return Err(Unsupported::AdvancedCommerce);
        }
        ("RESCIND_CONSENT", None) => return Err(Unsupported::ParentalConsent),
        _ => return Err(Unsupported::UnknownType),
    };

    let observed_at = notification
        .signed_date
        .map(Instant::from_epoch_millis)
        .ok_or(Unsupported::Incomplete)?;
    let transaction = notification
        .transaction
        .as_ref()
        .ok_or(Unsupported::Incomplete)?;
    let purchase = Purchase::read(transaction, observed_at, reading.refund)?;
    let Some(renewal_info) = &notification.renewal_info else {
        return Ok(Decoded::AwaitsStatus {
            statement: purchase.statement(None),
            awaiting: Awaiting::LatestUnconfirmed,
        });
    };
    if renewal_info.original_transaction_id != transaction.original_transaction_id {
        return Err(Unsupported::Inconsistent);
    }
    let cancel_requested_at = (reading.states_cancel_time
        && renewal_info.auto_renew_status == Some(0))
    .then_some(observed_at);
    let awaiting = match renewal_info.renewal_date {
        Some(latest_expires_at) if transaction.expires_date == Some(latest_expires_at) => None,
        Some(latest_expires_at)
            if !reading.of_the_latest && transaction.expires_date < Some(latest_expires_at) =>
        {
            Some(Awaiting::EarlierTransaction)
        }
        _ => Some(Awaiting::LatestUnconfirmed),
    };
    if let Some(awaiting) = awaiting {
        return Ok(Decoded::AwaitsStatus {
            statement: purchase.statement(cancel_requested_at),
            awaiting,
        });
    }

    let Purchase {
        lineage,
        observed_at,
        ownership,
        product_id,
        plan,
        billing_interval,
        started_at,
        storefront,
        period,
        revoked,
        account_token,
    } = purchase;
    let period_end = period.span.end;
    let auto_renew = match renewal_info.auto_renew_status {
        Some(1) => true,
        Some(0) => false,
        Some(_) => return Err(Unsupported::UnknownValue),
        None => return Err(Unsupported::Incomplete),
    };
    let state = match notification.status {
        Some(1) => State::Active {
            pause_scheduled_for: None,
        },
        Some(2) => State::Expired(Ending {
            at: period_end,
            reason: match renewal_info.expiration_intent {
                Some(1) => EndReason::Cancelled,
                Some(2) => EndReason::Billing,
                Some(3) => EndReason::PriceChangeDeclined,
                Some(4) => EndReason::ProductUnavailable,
                Some(5) => EndReason::Unknown,
                _ => reading.expired_for.unwrap_or(EndReason::Unknown),
            },
        }),
        Some(3) => State::OnHold {
            payment_failed_at: period_end,
        },
        Some(4) => State::Grace {
            payment_failed_at: period_end,
            grace_ends_at: renewal_info
                .grace_period_expires_date
                .map(Instant::from_epoch_millis)
                .ok_or(Unsupported::Incomplete)?,
        },
        Some(5) => State::Revoked(revoked.unwrap_or(Ending {
            at: observed_at,
            reason: match reading.refund {
                Refund::Taken => EndReason::Refunded,
                _ => EndReason::Unknown,
            },
        })),
        Some(_) => return Err(Unsupported::UnknownValue),
        None => return Err(Unsupported::Incomplete),
    };
    let next_charge = match (
        renewal_info.renewal_price,
        renewal_info.currency.as_deref(),
        renewal_info.price_increase_status,
    ) {
        (Some(renewal_price), Some(currency), None | Some(1)) => money(renewal_price, currency)
            .map(|price| NextCharge {
                at: period_end,
                price,
            }),
        _ => None,
    };
    let offer_continues = auto_renew
        && renewal_info.offer_type.is_some()
        && renewal_info.offer_type == transaction.offer_type;
    let status = Status {
        plan,
        product_id,
        billing_interval,
        started_at,
        state,
        current_period: period.span,
        renewal: Renewal {
            auto_renew,
            next_charge,
            next_product_id: renewal_info
                .auto_renew_product_id
                .as_deref()
                .filter(|next| *next != transaction.product_id)
                .map(ProductId::new),
            cancel_requested_at,
        },
        offer: period.offer_kind.map(|kind| Offer {
            kind,
            ends_at: (!offer_continues).then_some(period_end),
        }),
        price: period.price.clone(),
        storefront,
    };
    Ok(Decoded::Observation {
        observation: Observation {
            lineage,
            observed_at,
            ownership,
            status,
            periods: vec![period],
        },
        account_token,
    })
}

// A transaction of the one product Windmill sells: a field that decides access or money refuses it, a descriptive one degrades.
struct Purchase {
    lineage: Lineage,
    observed_at: Instant,
    ownership: Ownership,
    product_id: ProductId,
    plan: Plan,
    billing_interval: BillingInterval,
    started_at: Instant,
    storefront: Option<Storefront>,
    period: ObservedPeriod,
    revoked: Option<Ending>,
    account_token: Option<AccountToken>,
}

impl Purchase {
    fn read(
        transaction: &TransactionInfo,
        observed_at: Instant,
        refund: Refund,
    ) -> Result<Purchase, Unsupported> {
        if let Some("Consumable" | "Non-Consumable" | "Non-Renewing Subscription") =
            transaction.product_type.as_deref()
        {
            return Err(Unsupported::OneTimeCharge);
        }
        if transaction.billing_plan_type.as_deref() == Some("MONTHLY") {
            return Err(Unsupported::CommitmentPlan);
        }
        let (plan, billing_interval) = match transaction.product_id.as_str() {
            WINDMILL_ONE_MONTHLY => (Plan::WindmillOne, BillingInterval::new("P1M")),
            _ => return Err(Unsupported::UnknownProduct),
        };
        let expires_at = transaction.expires_date.ok_or(Unsupported::Incomplete)?;
        let price = match (transaction.price, transaction.currency.as_deref()) {
            (Some(price), Some(currency)) => {
                money(price, currency).ok_or(Unsupported::UnknownValue)?
            }
            _ => return Err(Unsupported::Incomplete),
        };
        let ownership = match transaction.in_app_ownership_type.as_deref() {
            Some("PURCHASED") => Ownership::Purchased,
            _ => Ownership::Shared,
        };
        let revoked = transaction
            .revocation_date
            .map(Instant::from_epoch_millis)
            .map(|at| Ending {
                at,
                reason: match (transaction.revocation_type.as_deref(), ownership) {
                    (Some("REFUND_FULL" | "REFUND_PRORATED"), _) | (None, Ownership::Purchased) => {
                        EndReason::Refunded
                    }
                    (Some("FAMILY_REVOKE" | "ASSIGNMENT_REVOKE"), _)
                    | (None, Ownership::Shared) => EndReason::SharingRemoved,
                    (Some(_), _) => EndReason::Unknown,
                },
            });
        let refunded_at = match refund {
            Refund::Taken => Some(revoked.as_ref().map_or(observed_at, |ending| ending.at)),
            Refund::Reversed => None,
            Refund::AsTransactionStates => revoked
                .as_ref()
                .filter(|ending| ending.reason == EndReason::Refunded)
                .map(|ending| ending.at),
        };
        let offer_kind = match (
            transaction.offer_type,
            transaction.offer_discount_type.as_deref(),
        ) {
            (Some(1), Some("FREE_TRIAL")) => Some(OfferKind::FreeTrial),
            (Some(1), Some("PAY_AS_YOU_GO" | "PAY_UP_FRONT")) => Some(OfferKind::Introductory),
            (Some(2 | 5), _) => Some(OfferKind::Promotional),
            (Some(3), _) => Some(OfferKind::OfferCode),
            (Some(4), _) => Some(OfferKind::WinBack),
            _ => None,
        };
        Ok(Purchase {
            lineage: Lineage {
                store: Store::AppStore,
                environment: match transaction.environment {
                    verification::Environment::Production => Environment::Production,
                    verification::Environment::Sandbox => Environment::Sandbox,
                },
                store_subscription_id: StoreSubscriptionId::new(
                    transaction.original_transaction_id.expose(),
                ),
            },
            observed_at,
            ownership,
            product_id: ProductId::new(transaction.product_id.as_str()),
            plan,
            billing_interval,
            started_at: Instant::from_epoch_millis(
                transaction
                    .original_purchase_date
                    .unwrap_or(transaction.purchase_date),
            ),
            storefront: transaction.storefront.as_deref().map(Storefront::new),
            period: ObservedPeriod {
                transaction: StoreTransactionId::new(transaction.transaction_id.expose()),
                span: Span {
                    start: Instant::from_epoch_millis(transaction.purchase_date),
                    end: Instant::from_epoch_millis(expires_at),
                },
                price,
                offer_kind,
                refunded_at,
            },
            revoked,
            account_token: transaction.app_account_token.clone(),
        })
    }

    fn statement(self, cancel_requested_at: Option<Instant>) -> PeriodStatement {
        PeriodStatement {
            lineage: self.lineage,
            observed_at: self.observed_at,
            ownership: self.ownership,
            period: self.period,
            account_token: self.account_token,
            cancel_requested_at,
        }
    }
}

// Apple states prices in milliunits of an ISO 4217 currency, whose code it may write in any case.
fn money(milliunits: i64, currency: &str) -> Option<Money> {
    Money::from_units(
        u64::try_from(milliunits).ok()?,
        3,
        &currency.to_ascii_uppercase(),
    )
}
