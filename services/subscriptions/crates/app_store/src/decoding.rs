use domain::{
    BillingInterval, EndReason, Ending, Environment, Instant, Lineage, Money, NextCharge,
    Observation, ObservedPeriod, Offer, OfferKind, Ownership, Plan, ProductId, Renewal, Span,
    State, Status, Store, StoreSubscriptionId, StoreTransactionId, Storefront,
};

use crate::verification::{self, AccountToken, Notification, TransactionInfo};

// §8: the one product Windmill sells on the App Store, a month of Windmill One.
const WINDMILL_ONE_MONTHLY: &str = "works.windmill.app.one.monthly";

// What one verified notification states, in the domain's words; the door logs the outcome, never the payload.
#[expect(
    clippy::large_enum_variant,
    reason = "one value per notification, moved whole to its caller"
)]
pub enum Decoded {
    // The subscription's whole state: the caller resolves the account token into the hint and applies it with observe.
    Observation {
        observation: Observation,
        account_token: Option<AccountToken>,
    },
    // A transaction other than the latest: the caller pulls the store's status before the period can be applied (§8).
    AwaitsStatus(PeriodStatement),
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
    let observed_at = transaction.signed_date.ok_or(Unsupported::Incomplete)?;
    Ok(Purchase::read(transaction)?.statement(Instant::from_epoch_millis(observed_at)))
}

fn read(notification: &Notification) -> Result<Decoded, Unsupported> {
    let states_cancel_time = match (
        notification.notification_type.as_str(),
        notification.subtype.as_deref(),
    ) {
        (
            "DID_CHANGE_RENEWAL_STATUS",
            None | Some("AUTO_RENEW_ENABLED" | "AUTO_RENEW_DISABLED"),
        ) => true,
        ("SUBSCRIBED", Some("INITIAL_BUY" | "RESUBSCRIBE"))
        | ("DID_RENEW", None | Some("BILLING_RECOVERY"))
        | ("DID_CHANGE_RENEWAL_PREF", None | Some("UPGRADE" | "DOWNGRADE"))
        | ("OFFER_REDEEMED", None | Some("UPGRADE" | "DOWNGRADE"))
        | ("DID_FAIL_TO_RENEW", None | Some("GRACE_PERIOD"))
        | ("GRACE_PERIOD_EXPIRED", None)
        | (
            "EXPIRED",
            None | Some("VOLUNTARY" | "BILLING_RETRY" | "PRICE_INCREASE" | "PRODUCT_NOT_FOR_SALE"),
        )
        | ("PRICE_INCREASE", Some("PENDING" | "ACCEPTED"))
        | ("REFUND" | "REFUND_REVERSED" | "REFUND_DECLINED" | "REVOKE", None)
        | ("CONSUMPTION_REQUEST" | "RENEWAL_EXTENDED", None)
        | ("RENEWAL_EXTENSION", Some("FAILURE")) => false,
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
    let purchase = Purchase::read(transaction)?;
    let renewal_info = notification
        .renewal_info
        .as_ref()
        .ok_or(Unsupported::Incomplete)?;
    if renewal_info.original_transaction_id != transaction.original_transaction_id {
        return Err(Unsupported::Inconsistent);
    }
    let latest_expires_at = renewal_info.renewal_date.ok_or(Unsupported::Incomplete)?;
    if transaction.expires_date != Some(latest_expires_at) {
        return Ok(Decoded::AwaitsStatus(purchase.statement(observed_at)));
    }

    let Purchase {
        lineage,
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
                _ => EndReason::Unknown,
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
        Some(5) => State::Revoked(revoked.ok_or(Unsupported::Incomplete)?),
        Some(_) => return Err(Unsupported::UnknownValue),
        None => return Err(Unsupported::Incomplete),
    };
    let next_charge = match (renewal_info.renewal_price, renewal_info.currency.as_deref()) {
        (None, None) => None,
        (renewal_price, currency) => Some(NextCharge {
            at: period_end,
            price: money(renewal_price, currency)?,
        }),
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
            cancel_requested_at: (states_cancel_time && !auto_renew).then_some(observed_at),
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

// A transaction of the one product Windmill sells, read into the domain's words.
struct Purchase {
    lineage: Lineage,
    ownership: Ownership,
    product_id: ProductId,
    plan: Plan,
    billing_interval: BillingInterval,
    started_at: Instant,
    storefront: Storefront,
    period: ObservedPeriod,
    revoked: Option<Ending>,
    account_token: Option<AccountToken>,
}

impl Purchase {
    fn read(transaction: &TransactionInfo) -> Result<Purchase, Unsupported> {
        match transaction.product_type.as_deref() {
            Some("Auto-Renewable Subscription") => {}
            Some("Consumable" | "Non-Consumable" | "Non-Renewing Subscription") => {
                return Err(Unsupported::OneTimeCharge);
            }
            Some(_) => return Err(Unsupported::UnknownValue),
            None => return Err(Unsupported::Incomplete),
        }
        match transaction.billing_plan_type.as_deref() {
            None | Some("BILLED_UPFRONT") => {}
            Some("MONTHLY") => return Err(Unsupported::CommitmentPlan),
            Some(_) => return Err(Unsupported::UnknownValue),
        }
        let (plan, billing_interval) = match transaction.product_id.as_str() {
            WINDMILL_ONE_MONTHLY => (Plan::WindmillOne, BillingInterval::new("P1M")),
            _ => return Err(Unsupported::UnknownProduct),
        };
        let ownership = match transaction.in_app_ownership_type.as_deref() {
            Some("PURCHASED") => Ownership::Purchased,
            Some("FAMILY_SHARED" | "ASSIGNED") => Ownership::Shared,
            Some(_) => return Err(Unsupported::UnknownValue),
            None => return Err(Unsupported::Incomplete),
        };
        let revoked = match (
            transaction.revocation_date.map(Instant::from_epoch_millis),
            transaction.revocation_type.as_deref(),
        ) {
            (None, _) => None,
            (Some(at), Some("REFUND_FULL" | "REFUND_PRORATED")) => Some(Ending {
                at,
                reason: EndReason::Refunded,
            }),
            (Some(at), Some("FAMILY_REVOKE" | "ASSIGNMENT_REVOKE")) => Some(Ending {
                at,
                reason: EndReason::SharingRemoved,
            }),
            (Some(at), None) => Some(Ending {
                at,
                reason: match ownership {
                    Ownership::Purchased => EndReason::Refunded,
                    Ownership::Shared => EndReason::SharingRemoved,
                },
            }),
            (Some(_), Some(_)) => return Err(Unsupported::UnknownValue),
        };
        let offer_kind = match (
            transaction.offer_type,
            transaction.offer_discount_type.as_deref(),
        ) {
            (None, _) => None,
            (Some(1), Some("FREE_TRIAL")) => Some(OfferKind::FreeTrial),
            (Some(1), Some("PAY_AS_YOU_GO" | "PAY_UP_FRONT")) => Some(OfferKind::Introductory),
            (Some(1), None) => return Err(Unsupported::Incomplete),
            (Some(2 | 5), _) => Some(OfferKind::Promotional),
            (Some(3), _) => Some(OfferKind::OfferCode),
            (Some(4), _) => Some(OfferKind::WinBack),
            (Some(_), _) => return Err(Unsupported::UnknownValue),
        };
        let expires_at = transaction.expires_date.ok_or(Unsupported::Incomplete)?;
        let started_at = transaction
            .original_purchase_date
            .ok_or(Unsupported::Incomplete)?;
        let storefront = transaction
            .storefront
            .as_deref()
            .ok_or(Unsupported::Incomplete)?;
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
            ownership,
            product_id: ProductId::new(transaction.product_id.as_str()),
            plan,
            billing_interval,
            started_at: Instant::from_epoch_millis(started_at),
            storefront: Storefront::new(storefront),
            period: ObservedPeriod {
                transaction: StoreTransactionId::new(transaction.transaction_id.expose()),
                span: Span {
                    start: Instant::from_epoch_millis(transaction.purchase_date),
                    end: Instant::from_epoch_millis(expires_at),
                },
                price: money(transaction.price, transaction.currency.as_deref())?,
                offer_kind,
                refunded_at: revoked
                    .as_ref()
                    .filter(|ending| ending.reason == EndReason::Refunded)
                    .map(|ending| ending.at),
            },
            revoked,
            account_token: transaction.app_account_token.clone(),
        })
    }

    fn statement(self, observed_at: Instant) -> PeriodStatement {
        PeriodStatement {
            lineage: self.lineage,
            observed_at,
            ownership: self.ownership,
            period: self.period,
            account_token: self.account_token,
        }
    }
}

// Apple states prices in milliunits; the amount keeps two decimals, and a third only when Apple states one.
fn money(milliunits: Option<i64>, currency: Option<&str>) -> Result<Money, Unsupported> {
    let (Some(milliunits), Some(currency)) = (milliunits, currency) else {
        return Err(Unsupported::Incomplete);
    };
    let milliunits = u64::try_from(milliunits).map_err(|_| Unsupported::UnknownValue)?;
    let (units, thousandths) = (milliunits / 1000, milliunits % 1000);
    let amount = match thousandths % 10 {
        0 => format!("{units}.{:02}", thousandths / 10),
        _ => format!("{units}.{thousandths:03}"),
    };
    Money::new(&amount, currency).ok_or(Unsupported::UnknownValue)
}
