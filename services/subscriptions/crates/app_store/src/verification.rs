mod chain;
mod payloads;

use std::fmt;
use std::time::{SystemTime, UNIX_EPOCH};

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use ring::signature::{ECDSA_P256_SHA256_FIXED, UnparsedPublicKey};
use serde::de::DeserializeOwned;

use chain::TrustedRoots;
pub use payloads::{
    AccountToken, Environment, Notification, RenewalInfo, TransactionId, TransactionInfo,
};
use payloads::{JwsHeader, NotificationPayload, SigningDate};

const APPLE_ROOT_CA_G3: &[u8] = include_bytes!("../roots/AppleRootCA-G3.cer");
const WINDMILL_BUNDLE_ID: &str = "works.windmill.app";
const CLOCK_SKEW_MILLIS: i64 = 60_000;

pub struct SignedDataVerifier {
    roots: TrustedRoots,
    bundle_id: String,
    clock: Box<dyn Fn() -> SystemTime + Send + Sync>,
}

impl SignedDataVerifier {
    pub fn windmill(clock: impl Fn() -> SystemTime + Send + Sync + 'static) -> Self {
        Self::new(&[APPLE_ROOT_CA_G3], WINDMILL_BUNDLE_ID, clock)
            .expect("Apple Root CA - G3 is a certificate with a P-384 key")
    }

    pub fn new(
        roots: &[&[u8]],
        bundle_id: &str,
        clock: impl Fn() -> SystemTime + Send + Sync + 'static,
    ) -> Result<Self, InvalidRoots> {
        Ok(Self {
            roots: TrustedRoots::new(roots)?,
            bundle_id: bundle_id.to_owned(),
            clock: Box::new(clock),
        })
    }

    pub fn verify_notification(&self, signed_payload: &str) -> Result<Notification, Refusal> {
        let notification: NotificationPayload = self.verify_signed(signed_payload)?;
        let app = notification.app().ok_or(Refusal::BundleId)?;
        if app.bundle_id != self.bundle_id {
            return Err(Refusal::BundleId);
        }
        let environment = app.environment;

        let data = notification.data.as_ref();
        let status = data.and_then(|data| data.status);
        let transaction = data
            .and_then(|data| data.signed_transaction_info.as_deref())
            .map(|signed| self.verify_transaction(signed))
            .transpose()?;
        let renewal_info = data
            .and_then(|data| data.signed_renewal_info.as_deref())
            .map(|signed| self.verify_signed::<RenewalInfo>(signed))
            .transpose()?;
        let nested_environments = [
            transaction.as_ref().map(|nested| nested.environment),
            renewal_info.as_ref().map(|nested| nested.environment),
        ];
        if nested_environments
            .into_iter()
            .flatten()
            .any(|nested| nested != environment)
        {
            return Err(Refusal::Environment);
        }

        Ok(Notification {
            notification_uuid: notification.notification_uuid,
            notification_type: notification.notification_type,
            subtype: notification.subtype,
            signed_date: notification.signed_date,
            environment,
            status,
            transaction,
            renewal_info,
        })
    }

    pub fn verify_transaction(&self, signed_transaction: &str) -> Result<TransactionInfo, Refusal> {
        let transaction: TransactionInfo = self.verify_signed(signed_transaction)?;
        if transaction.bundle_id != self.bundle_id {
            return Err(Refusal::BundleId);
        }
        Ok(transaction)
    }

    fn verify_signed<T: DeserializeOwned>(&self, jws: &str) -> Result<T, Refusal> {
        let (signing_input, signature) = jws.rsplit_once('.').ok_or(Refusal::Malformed)?;
        let (header, payload) = signing_input.split_once('.').ok_or(Refusal::Malformed)?;

        let header: JwsHeader = decode_json(&decode_segment(header)?)?;
        if header.alg != "ES256" {
            return Err(Refusal::Algorithm);
        }

        let payload = decode_segment(payload)?;
        let SigningDate { signed_date } = decode_json(&payload)?;
        let now = (self.clock)()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |since| since.as_millis() as i64);
        let signed_at = signed_date.unwrap_or(now);
        if signed_at > now.saturating_add(CLOCK_SKEW_MILLIS) {
            return Err(Refusal::SignedInFuture);
        }
        let leaf_key = self.roots.verify_chain(&header.x5c, signed_at)?;

        UnparsedPublicKey::new(&ECDSA_P256_SHA256_FIXED, leaf_key)
            .verify(signing_input.as_bytes(), &decode_segment(signature)?)
            .map_err(|_| Refusal::Signature)?;
        decode_json(&payload)
    }
}

fn decode_segment(segment: &str) -> Result<Vec<u8>, Refusal> {
    URL_SAFE_NO_PAD
        .decode(segment)
        .map_err(|_| Refusal::Malformed)
}

fn decode_json<T: DeserializeOwned>(json: &[u8]) -> Result<T, Refusal> {
    serde_json::from_slice(json).map_err(|_| Refusal::Malformed)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Refusal {
    Malformed,
    Algorithm,
    SignedInFuture,
    ChainLength,
    Certificate,
    Untrusted,
    AppleMarker,
    Validity,
    Signature,
    BundleId,
    Environment,
}

impl Refusal {
    pub fn code(self) -> &'static str {
        match self {
            Refusal::Malformed => "malformed",
            Refusal::Algorithm => "algorithm",
            Refusal::SignedInFuture => "signed_in_future",
            Refusal::ChainLength => "chain_length",
            Refusal::Certificate => "certificate",
            Refusal::Untrusted => "untrusted_chain",
            Refusal::AppleMarker => "apple_marker",
            Refusal::Validity => "certificate_validity",
            Refusal::Signature => "signature",
            Refusal::BundleId => "bundle_id",
            Refusal::Environment => "environment",
        }
    }
}

impl fmt::Display for Refusal {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.code())
    }
}

impl std::error::Error for Refusal {}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct InvalidRoots;

impl fmt::Display for InvalidRoots {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(
            "trusted roots must be one or more DER certificates with a P-256 or P-384 key",
        )
    }
}

impl std::error::Error for InvalidRoots {}

#[cfg(test)]
mod tests {
    use std::time::SystemTime;

    use super::{Environment, RenewalInfo, SignedDataVerifier, TransactionId};

    #[test]
    fn a_renewal_info_apple_signed_for_another_app_passes_the_chain_and_signature_under_the_pinned_root()
     {
        let signed =
            include_str!("../../../tests/fixtures/app_store/go-iap-renewal-info.jws").trim();

        let verified =
            SignedDataVerifier::windmill(SystemTime::now).verify_signed::<RenewalInfo>(signed);

        let expected = RenewalInfo {
            original_transaction_id: TransactionId::new("2000000335310644"),
            product_id: Some("co.ringalarm.swtich.quarterly2".to_owned()),
            auto_renew_product_id: Some("co.ringalarm.swtich.quarterly2".to_owned()),
            auto_renew_status: Some(1),
            expiration_intent: None,
            is_in_billing_retry_period: None,
            grace_period_expires_date: None,
            price_increase_status: None,
            renewal_date: None,
            renewal_price: None,
            currency: None,
            offer_type: None,
            signed_date: Some(1_684_822_778_492),
            environment: Environment::Sandbox,
        };
        assert!(verified == Ok(expected), "refused: {:?}", verified.err());
    }
}
