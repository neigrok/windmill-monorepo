mod chain;
mod payloads;

use std::fmt;
use std::time::{SystemTime, UNIX_EPOCH};

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use ring::signature::{ECDSA_P256_SHA256_FIXED, UnparsedPublicKey};
use serde::de::DeserializeOwned;

use chain::TrustedRoots;
pub use payloads::{Environment, Notification, RenewalInfo, TransactionInfo};
use payloads::{JwsHeader, NotificationPayload, SigningDate};

const APPLE_ROOT_CA_G3: &[u8] = include_bytes!("../roots/AppleRootCA-G3.cer");
const WINDMILL_BUNDLE_ID: &str = "works.windmill.app";

pub struct SignedDataVerifier {
    roots: TrustedRoots,
    environments: Vec<Environment>,
    bundle_id: String,
    clock: Box<dyn Fn() -> SystemTime + Send + Sync>,
}

impl SignedDataVerifier {
    pub fn windmill(clock: impl Fn() -> SystemTime + Send + Sync + 'static) -> Self {
        let environments = [Environment::Production, Environment::Sandbox];
        Self::new(
            &[APPLE_ROOT_CA_G3],
            &environments,
            WINDMILL_BUNDLE_ID,
            clock,
        )
        .expect("Apple Root CA - G3 is a certificate with a P-384 key")
    }

    pub fn new(
        roots: &[&[u8]],
        environments: &[Environment],
        bundle_id: &str,
        clock: impl Fn() -> SystemTime + Send + Sync + 'static,
    ) -> Result<Self, InvalidRoots> {
        Ok(Self {
            roots: TrustedRoots::new(roots)?,
            environments: environments.to_vec(),
            bundle_id: bundle_id.to_owned(),
            clock: Box::new(clock),
        })
    }

    pub fn verify_notification(&self, signed_payload: &str) -> Result<Notification, Refusal> {
        let notification: NotificationPayload = self.verify_signed(signed_payload)?;
        let app = notification.app().ok_or(Refusal::BundleId)?;
        self.check_app(&app.bundle_id, app.environment)?;
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
        self.check_app(&transaction.bundle_id, transaction.environment)?;
        Ok(transaction)
    }

    fn check_app(&self, bundle_id: &str, environment: Environment) -> Result<(), Refusal> {
        if bundle_id != self.bundle_id {
            return Err(Refusal::BundleId);
        }
        if !self.environments.contains(&environment) {
            return Err(Refusal::Environment);
        }
        Ok(())
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
        let signed_at = match signed_date {
            Some(signed_date) => signed_date,
            None => (self.clock)()
                .duration_since(UNIX_EPOCH)
                .map_or(0, |since| since.as_millis() as i64),
        };
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
