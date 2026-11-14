use std::fmt;
use std::mem;
use std::time::{SystemTime, UNIX_EPOCH};

use base64::Engine;
use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use ring::rand::SystemRandom;
use ring::signature::{ECDSA_P256_SHA256_FIXED_SIGNING, EcdsaKeyPair};
use serde::Deserialize;
use serde_json::{Map, Value, json};
use uuid::Uuid;

pub const TEST_ROOT: &[u8] =
    include_bytes!("../../../tests/fixtures/app_store/test-chain/root.cer");
const TEST_INTERMEDIATE: &[u8] =
    include_bytes!("../../../tests/fixtures/app_store/test-chain/intermediate.cer");
const TEST_LEAF: &[u8] = include_bytes!("../../../tests/fixtures/app_store/test-chain/leaf.cer");
const TEST_LEAF_KEY: &[u8] =
    include_bytes!("../../../tests/fixtures/app_store/test-chain/leaf-key.der");

const SANDBOX: &str = "Sandbox";
const WINDMILL_BUNDLE_ID: &str = "works.windmill.app";

// The fields Apple states in milliseconds since the epoch, which a description may also write relative to its signing.
const DATE_FIELDS: [&str; 8] = [
    "signedDate",
    "purchaseDate",
    "originalPurchaseDate",
    "expiresDate",
    "revocationDate",
    "renewalDate",
    "gracePeriodExpiresDate",
    "recentSubscriptionStartDate",
];

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Description {
    Notification(Map<String, Value>),
    Transaction(Map<String, Value>),
}

pub fn sign(description: Description, now: SystemTime) -> Result<String, InvalidDate> {
    let leaf = TestLeaf::new();
    let now = now
        .duration_since(UNIX_EPOCH)
        .map_or(0, |since| since.as_millis() as i64);
    match description {
        Description::Notification(notification) => leaf.sign_notification(notification, now),
        Description::Transaction(transaction) => leaf.sign_payload(
            transaction,
            now,
            [
                ("environment", SANDBOX.into()),
                ("bundleId", WINDMILL_BUNDLE_ID.into()),
                ("signedDate", now.into()),
            ],
        ),
    }
}

struct TestLeaf {
    key: EcdsaKeyPair,
    header: String,
}

impl TestLeaf {
    fn new() -> Self {
        let x5c: Vec<String> = [TEST_LEAF, TEST_INTERMEDIATE, TEST_ROOT]
            .iter()
            .map(|der| STANDARD.encode(der))
            .collect();
        Self {
            key: EcdsaKeyPair::from_pkcs8(
                &ECDSA_P256_SHA256_FIXED_SIGNING,
                TEST_LEAF_KEY,
                &SystemRandom::new(),
            )
            .expect("the test leaf key is a P-256 key in PKCS#8"),
            header: URL_SAFE_NO_PAD.encode(json!({ "alg": "ES256", "x5c": x5c }).to_string()),
        }
    }

    fn sign_notification(
        &self,
        mut notification: Map<String, Value>,
        now: i64,
    ) -> Result<String, InvalidDate> {
        if let Some(Value::Object(data)) = notification.get_mut("data") {
            fill(
                data,
                [
                    ("environment", SANDBOX.into()),
                    ("bundleId", WINDMILL_BUNDLE_ID.into()),
                ],
            );
            let environment = data["environment"].clone();
            let nested = [
                (
                    "signedTransactionInfo",
                    vec![
                        ("environment", environment.clone()),
                        ("bundleId", data["bundleId"].clone()),
                        ("signedDate", now.into()),
                    ],
                ),
                (
                    "signedRenewalInfo",
                    vec![("environment", environment), ("signedDate", now.into())],
                ),
            ];
            for (field, defaults) in nested {
                if let Some(Value::Object(payload)) = data.get_mut(field) {
                    let signed = self.sign_payload(mem::take(payload), now, defaults)?;
                    data[field] = signed.into();
                }
            }
        }
        self.sign_payload(
            notification,
            now,
            [
                ("notificationUUID", Uuid::new_v4().to_string().into()),
                ("version", "2.0".into()),
                ("signedDate", now.into()),
            ],
        )
    }

    fn sign_payload(
        &self,
        mut payload: Map<String, Value>,
        now: i64,
        defaults: impl IntoIterator<Item = (&'static str, Value)>,
    ) -> Result<String, InvalidDate> {
        for field in DATE_FIELDS {
            if let Some(Value::String(date)) = payload.get(field) {
                let millis = relative_to(now, date).ok_or_else(|| InvalidDate {
                    field,
                    date: date.clone(),
                })?;
                payload[field] = millis.into();
            }
        }
        fill(&mut payload, defaults);

        let signing_input = format!(
            "{}.{}",
            self.header,
            URL_SAFE_NO_PAD.encode(Value::Object(payload).to_string())
        );
        let signature = self
            .key
            .sign(&SystemRandom::new(), signing_input.as_bytes())
            .expect("a P-256 key signs any message");
        Ok(format!(
            "{signing_input}.{}",
            URL_SAFE_NO_PAD.encode(signature.as_ref())
        ))
    }
}

fn fill(
    payload: &mut Map<String, Value>,
    defaults: impl IntoIterator<Item = (&'static str, Value)>,
) {
    for (field, value) in defaults {
        payload.entry(field).or_insert(value);
    }
}

fn relative_to(now: i64, date: &str) -> Option<i64> {
    let offset = date.strip_prefix("now")?;
    if offset.is_empty() {
        return Some(now);
    }
    let (count, unit) = offset.split_at_checked(offset.len() - 1)?;
    let unit_millis = match unit {
        "d" => 86_400_000,
        "h" => 3_600_000,
        "m" => 60_000,
        _ => return None,
    };
    if !count.starts_with(['+', '-']) {
        return None;
    }
    let count: i64 = count.parse().ok()?;
    now.checked_add(count.checked_mul(unit_millis)?)
}

#[derive(Debug)]
pub struct InvalidDate {
    field: &'static str,
    date: String,
}

impl fmt::Display for InvalidDate {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "{} is {:?}: a date is milliseconds since the epoch, or now with an optional offset in days, hours or minutes, such as now+30d, now-2h or now+15m",
            self.field, self.date
        )
    }
}

impl std::error::Error for InvalidDate {}
