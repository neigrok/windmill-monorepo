use serde::Deserialize;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
pub enum Environment {
    Production,
    Sandbox,
}

#[derive(Clone, PartialEq, Eq, Hash, Deserialize)]
#[serde(transparent)]
pub struct TransactionId(String);

impl TransactionId {
    pub fn new(value: impl Into<String>) -> Self {
        Self(value.into())
    }

    pub fn expose(&self) -> &str {
        &self.0
    }
}

#[derive(Clone, PartialEq, Eq, Hash, Deserialize)]
#[serde(transparent)]
pub struct AccountToken(String);

impl AccountToken {
    pub fn new(value: impl Into<String>) -> Self {
        Self(value.into())
    }

    pub fn expose(&self) -> &str {
        &self.0
    }
}

#[derive(PartialEq)]
pub struct Notification {
    pub notification_uuid: String,
    pub notification_type: String,
    pub subtype: Option<String>,
    pub signed_date: Option<i64>,
    pub environment: Environment,
    pub status: Option<i32>,
    pub transaction: Option<TransactionInfo>,
    pub renewal_info: Option<RenewalInfo>,
}

#[derive(PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransactionInfo {
    pub transaction_id: TransactionId,
    pub original_transaction_id: TransactionId,
    pub bundle_id: String,
    pub product_id: String,
    #[serde(rename = "type")]
    pub product_type: Option<String>,
    pub purchase_date: i64,
    pub original_purchase_date: Option<i64>,
    pub expires_date: Option<i64>,
    pub signed_date: Option<i64>,
    pub environment: Environment,
    pub storefront: Option<String>,
    pub price: Option<i64>,
    pub currency: Option<String>,
    pub app_account_token: Option<AccountToken>,
    pub in_app_ownership_type: Option<String>,
    pub transaction_reason: Option<String>,
    pub offer_type: Option<i32>,
    pub offer_discount_type: Option<String>,
    pub is_upgraded: Option<bool>,
    pub revocation_date: Option<i64>,
    pub revocation_reason: Option<i32>,
}

#[derive(PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenewalInfo {
    pub original_transaction_id: TransactionId,
    pub product_id: Option<String>,
    pub auto_renew_product_id: Option<String>,
    pub auto_renew_status: Option<i32>,
    pub expiration_intent: Option<i32>,
    pub is_in_billing_retry_period: Option<bool>,
    pub grace_period_expires_date: Option<i64>,
    pub price_increase_status: Option<i32>,
    pub renewal_date: Option<i64>,
    pub renewal_price: Option<i64>,
    pub currency: Option<String>,
    pub offer_type: Option<i32>,
    pub signed_date: Option<i64>,
    pub environment: Environment,
}

#[derive(Deserialize)]
pub(super) struct JwsHeader {
    pub(super) alg: String,
    pub(super) x5c: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct SigningDate {
    pub(super) signed_date: Option<i64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct NotificationPayload {
    pub(super) notification_type: String,
    pub(super) subtype: Option<String>,
    #[serde(rename = "notificationUUID")]
    pub(super) notification_uuid: String,
    pub(super) signed_date: Option<i64>,
    pub(super) data: Option<NotificationData>,
    summary: Option<App>,
    app_data: Option<App>,
}

impl NotificationPayload {
    pub(super) fn app(&self) -> Option<&App> {
        let data = self.data.as_ref().map(|data| &data.app);
        data.or(self.summary.as_ref()).or(self.app_data.as_ref())
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct NotificationData {
    #[serde(flatten)]
    app: App,
    pub(super) status: Option<i32>,
    pub(super) signed_transaction_info: Option<String>,
    pub(super) signed_renewal_info: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct App {
    pub(super) bundle_id: String,
    pub(super) environment: Environment,
}
