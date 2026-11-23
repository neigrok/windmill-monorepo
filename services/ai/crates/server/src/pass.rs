use std::collections::BTreeMap;

use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use ed25519_dalek::{Signature, VerifyingKey};
use serde::Deserialize;
use sha2::{Digest, Sha256};

pub const PASS_MAX_LENGTH: usize = 2_048;
pub const PASS_MAX_LIFETIME: i64 = 600_000;
pub const PASS_SKEW: i64 = 60_000;
pub const TEST_PUBLIC_KEYS: [&str; 1] = ["11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo"];

#[derive(Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Environment {
    Development,
    Production,
}

impl Environment {
    pub fn label(self) -> &'static str {
        match self {
            Self::Development => "development",
            Self::Production => "production",
        }
    }
}

#[derive(Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Client {
    Ios,
    Android,
    Web,
    Server,
}

impl Client {
    pub fn label(self) -> &'static str {
        match self {
            Self::Ios => "ios",
            Self::Android => "android",
            Self::Web => "web",
            Self::Server => "server",
        }
    }
}

#[derive(Clone, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Claims {
    pub aud: String,
    pub env: Environment,
    pub iat: i64,
    pub exp: i64,
    pub sub: Subject,
    pub plan: Option<Plan>,
    pub owner_grant: Option<bool>,
    pub installation: Option<String>,
    pub client: Client,
}

#[derive(Clone, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Subject {
    pub installation: Option<String>,
    pub account: Option<String>,
}

#[derive(Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Plan {
    None,
    One,
}

impl Claims {
    pub fn principal_key(&self) -> String {
        match &self.sub.account {
            Some(id) => format!("account:{id}"),
            None => format!(
                "installation:{}",
                self.sub.installation.as_deref().unwrap_or("")
            ),
        }
    }
}

pub struct PassVerifier {
    environment: Environment,
    keys: BTreeMap<String, VerifyingKey>,
}

impl PassVerifier {
    pub fn new(
        environment: Environment,
        keys: BTreeMap<String, String>,
    ) -> Result<Self, &'static str> {
        let mut public_keys = BTreeMap::new();
        for (kid, encoded) in keys {
            if !valid_kid(&kid) {
                return Err("pass_key_id");
            }
            let bytes: [u8; 32] = URL_SAFE_NO_PAD
                .decode(encoded)
                .map_err(|_| "pass_key")?
                .try_into()
                .map_err(|_| "pass_key")?;
            let key = VerifyingKey::from_bytes(&bytes).map_err(|_| "pass_key")?;
            if environment == Environment::Production
                && (kid.starts_with("test-")
                    || TEST_PUBLIC_KEYS.iter().any(|test| {
                        URL_SAFE_NO_PAD
                            .decode(test)
                            .is_ok_and(|test| Sha256::digest(test) == Sha256::digest(bytes))
                    }))
            {
                return Err("public_test_key");
            }
            public_keys.insert(kid, key);
        }
        Ok(Self {
            environment,
            keys: public_keys,
        })
    }

    pub fn verify(&self, token: Option<&str>, now: i64) -> Result<Claims, &'static str> {
        let token = token.ok_or("pass_missing")?;
        if token.len() > PASS_MAX_LENGTH || !token.is_ascii() {
            return Err("pass_signature");
        }
        let mut segments = token.split('.');
        if segments.next() != Some("wm-pass") || segments.next() != Some("v1") {
            return Err("pass_signature");
        }
        let kid = segments.next().ok_or("pass_signature")?;
        let payload = segments.next().ok_or("pass_signature")?;
        let signature = segments.next().ok_or("pass_signature")?;
        if segments.next().is_some() || !valid_kid(kid) {
            return Err("pass_signature");
        }
        let key = self.keys.get(kid).ok_or("pass_signature")?;
        let bytes = URL_SAFE_NO_PAD
            .decode(signature)
            .map_err(|_| "pass_signature")?;
        let signature = Signature::from_slice(&bytes).map_err(|_| "pass_signature")?;
        let signed = token.rsplit_once('.').ok_or("pass_signature")?.0;
        key.verify_strict(signed.as_bytes(), &signature)
            .map_err(|_| "pass_signature")?;
        let bytes = URL_SAFE_NO_PAD
            .decode(payload)
            .map_err(|_| "pass_malformed")?;
        let value: serde_json::Value =
            serde_json::from_slice(&bytes).map_err(|_| "pass_malformed")?;
        if !value.is_object() {
            return Err("pass_audience");
        }
        if value.get("aud").and_then(|v| v.as_str()) != Some("ai")
            || value.get("env").and_then(|v| v.as_str()) != Some(self.environment.label())
        {
            return Err("pass_audience");
        }
        for optional in ["plan", "ownerGrant", "installation"] {
            if value.get(optional).is_some_and(serde_json::Value::is_null) {
                return Err("pass_malformed");
            }
        }
        if value
            .get("sub")
            .and_then(|sub| sub.as_object())
            .is_some_and(|sub| sub.values().any(serde_json::Value::is_null))
        {
            return Err("pass_malformed");
        }
        let claims: Claims = serde_json::from_slice(&bytes).map_err(|_| "pass_malformed")?;
        let valid_id =
            |id: &str| !id.is_empty() && id.len() <= 256 && !id.chars().any(char::is_control);
        match (&claims.sub.installation, &claims.sub.account) {
            (Some(id), None) if valid_id(id) && claims.client != Client::Server => {
                if claims.plan.is_some()
                    || claims.owner_grant.is_some()
                    || claims.installation.is_some()
                {
                    return Err("pass_malformed");
                }
            }
            (None, Some(id)) if valid_id(id) => {
                if claims.client == Client::Server
                    && (claims.plan != Some(Plan::None)
                        || claims.owner_grant.is_some()
                        || claims.installation.is_some())
                {
                    return Err("pass_malformed");
                }
                if claims.plan.is_none()
                    || claims
                        .owner_grant
                        .is_some_and(|owner| !owner || claims.plan != Some(Plan::One))
                    || claims
                        .installation
                        .as_deref()
                        .is_some_and(|id| !valid_id(id))
                {
                    return Err("pass_malformed");
                }
            }
            _ => return Err("pass_malformed"),
        }
        if claims
            .exp
            .checked_sub(claims.iat)
            .is_none_or(|life| life <= 0 || life > PASS_MAX_LIFETIME)
        {
            return Err("pass_malformed");
        }
        if now < claims.iat.saturating_sub(PASS_SKEW) || now >= claims.exp {
            return Err("pass_expired");
        }
        Ok(claims)
    }
}

pub fn valid_kid(value: &str) -> bool {
    (1..=32).contains(&value.len())
        && value
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}
