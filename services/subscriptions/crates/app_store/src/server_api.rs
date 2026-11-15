use std::fmt;
use std::str::FromStr;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::Engine;
use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use domain::Environment;
use reqwest::header::CONTENT_TYPE;
use reqwest::redirect::Policy;
use reqwest::{Client, RequestBuilder, StatusCode, Url};
use ring::rand::SystemRandom;
use ring::signature::{ECDSA_P256_SHA256_FIXED_SIGNING, EcdsaKeyPair, KeyPair};
use serde::Deserialize;
use serde_json::json;

use crate::verification::WINDMILL_BUNDLE_ID;

// Each request signs a token of its own, which Apple takes for up to an hour after its issue.
const TOKEN_LIFETIME: Duration = Duration::from_secs(5 * 60);

// One request, connecting included, ends within this: under the internal listener's 5 s, so a claim or a refresh
// answers its own 503 rather than the listener's timeout.
const REQUEST_BOUND: Duration = Duration::from_secs(3);

// Apple's 404s that it says a later try may pass: AccountNotFoundRetryableError, AppNotFoundRetryableError and
// OriginalTransactionIdNotFoundRetryableError.
const RETRYABLE_NOT_FOUND: [i64; 3] = [4_040_002, 4_040_004, 4_040_006];

// The App Store Server API, called with Windmill's in-app purchase key: a subscription's status, and the account
// token Apple names in a lineage's later transactions (spec §4, §8). It verifies nothing Apple signs; the verifier does.
pub struct ServerApi {
    key: ApiKey,
    hosts: Hosts,
    client: Client,
    clock: Box<dyn Fn() -> SystemTime + Send + Sync>,
}

// The in-app purchase key App Store Connect issues: its issuer, its id, and its private key.
#[derive(Clone, Debug, PartialEq)]
pub struct ApiKey {
    pub issuer_id: String,
    pub key_id: String,
    pub private_key: PrivateKey,
}

// A P-256 key in PKCS#8, as the .p8 file App Store Connect hands out holds it in PEM. Neither Debug nor any error
// repeats it.
#[derive(Clone)]
pub struct PrivateKey(Arc<EcdsaKeyPair>);

// Where each environment's API answers: Apple's two hosts, or one address a test's own Apple serves both at.
#[derive(Clone, Debug, PartialEq)]
pub struct Hosts {
    pub production: Url,
    pub sandbox: Url,
}

// One subscription's entry in Apple's answer to Get All Subscription Statuses, as Apple sent it: its status, and the
// transaction and renewal info Apple signed. The payloads carry store ids, so it implements no Debug.
#[derive(Clone, PartialEq, Eq)]
pub struct SignedStatus {
    pub status: Option<i32>,
    pub signed_transaction_info: String,
    pub signed_renewal_info: Option<String>,
}

// How a call failed, as a code a log line may carry: Apple's error message is never read.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ApiFailure {
    // No answer within REQUEST_BOUND: nothing listened, the connection broke or Apple stalled.
    Unreachable,
    // 401: Apple refused the token, so the key, its id or its issuer is not the one App Store Connect issued.
    Unauthorized,
    // 429.
    RateLimited,
    // A 5xx, or a 404 Apple says a later try may pass.
    StoreError,
    // A 404 for good, or an answer that lists no such subscription.
    NotFound,
    // Any other answer that is not a success: Apple took the request as invalid.
    BadRequest,
    // A success whose body is not the shape Apple documents.
    Malformed,
}

impl ApiFailure {
    pub fn code(self) -> &'static str {
        match self {
            ApiFailure::Unreachable => "unreachable",
            ApiFailure::Unauthorized => "unauthorized",
            ApiFailure::RateLimited => "rate_limited",
            ApiFailure::StoreError => "store_error",
            ApiFailure::NotFound => "not_found",
            ApiFailure::BadRequest => "bad_request",
            ApiFailure::Malformed => "malformed",
        }
    }

    // Whether any request would fail the same way now, whatever it asks: the API is at fault, not the request.
    pub fn of_the_api(self) -> bool {
        matches!(
            self,
            ApiFailure::Unreachable
                | ApiFailure::Unauthorized
                | ApiFailure::RateLimited
                | ApiFailure::StoreError
        )
    }
}

impl fmt::Display for ApiFailure {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.code())
    }
}

impl std::error::Error for ApiFailure {}

impl ServerApi {
    pub fn new(
        key: ApiKey,
        hosts: Hosts,
        clock: impl Fn() -> SystemTime + Send + Sync + 'static,
    ) -> ServerApi {
        let client = Client::builder()
            .timeout(REQUEST_BOUND)
            .redirect(Policy::none())
            .build()
            .expect("the HTTP client for Apple starts with the TLS the image carries");
        ServerApi {
            key,
            hosts,
            client,
            clock: Box::new(clock),
        }
    }

    // Get All Subscription Statuses, read for one lineage: the entry of the subscription the original transaction
    // began, among every subscription Apple lists for its customer.
    pub async fn subscription_status(
        &self,
        environment: Environment,
        original_transaction_id: &str,
    ) -> Result<SignedStatus, ApiFailure> {
        let url = self.url(
            environment,
            ["inApps", "v1", "subscriptions", original_transaction_id],
        );
        let body = self.send(self.client.get(url)).await?;
        let StatusResponse { data } =
            serde_json::from_slice(&body).map_err(|_| ApiFailure::Malformed)?;
        data.into_iter()
            .flat_map(|group| group.last_transactions)
            .find(|entry| entry.original_transaction_id == original_transaction_id)
            .map(|entry| SignedStatus {
                status: entry.status,
                signed_transaction_info: entry.signed_transaction_info,
                signed_renewal_info: entry.signed_renewal_info,
            })
            .ok_or(ApiFailure::NotFound)
    }

    // Set App Account Token: Apple names the account in the lineage's current transaction and every renewal after it.
    pub async fn set_app_account_token(
        &self,
        environment: Environment,
        original_transaction_id: &str,
        app_account_token: &str,
    ) -> Result<(), ApiFailure> {
        let url = self.url(
            environment,
            [
                "inApps",
                "v1",
                "transactions",
                original_transaction_id,
                "appAccountToken",
            ],
        );
        let request = self
            .client
            .put(url)
            .header(CONTENT_TYPE, "application/json")
            .body(json!({ "appAccountToken": app_account_token }).to_string());
        self.send(request).await.map(|_| ())
    }

    fn url<'a>(
        &self,
        environment: Environment,
        segments: impl IntoIterator<Item = &'a str>,
    ) -> Url {
        let mut url = match environment {
            Environment::Production => self.hosts.production.clone(),
            Environment::Sandbox => self.hosts.sandbox.clone(),
        };
        url.path_segments_mut()
            .expect("an http or https URL takes path segments")
            .pop_if_empty()
            .extend(segments);
        url
    }

    async fn send(&self, request: RequestBuilder) -> Result<Vec<u8>, ApiFailure> {
        let response = request
            .bearer_auth(self.token())
            .send()
            .await
            .map_err(|_| ApiFailure::Unreachable)?;
        let status = response.status();
        let body = response
            .bytes()
            .await
            .map_err(|_| ApiFailure::Unreachable)?;
        match status {
            _ if status.is_success() => Ok(body.to_vec()),
            StatusCode::UNAUTHORIZED => Err(ApiFailure::Unauthorized),
            StatusCode::TOO_MANY_REQUESTS => Err(ApiFailure::RateLimited),
            StatusCode::NOT_FOUND => {
                let retryable = serde_json::from_slice::<ErrorResponse>(&body)
                    .is_ok_and(|error| RETRYABLE_NOT_FOUND.contains(&error.error_code));
                Err(if retryable {
                    ApiFailure::StoreError
                } else {
                    ApiFailure::NotFound
                })
            }
            _ if status.is_server_error() => Err(ApiFailure::StoreError),
            _ => Err(ApiFailure::BadRequest),
        }
    }

    // The ES256 JSON Web Token every request carries as its bearer, as Apple's "Generating JSON Web Tokens for API
    // requests" describes it.
    fn token(&self) -> String {
        let issued_at = (self.clock)()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |since| since.as_secs());
        let header = json!({ "alg": "ES256", "kid": self.key.key_id, "typ": "JWT" });
        let claims = json!({
            "iss": self.key.issuer_id,
            "iat": issued_at,
            "exp": issued_at + TOKEN_LIFETIME.as_secs(),
            "aud": "appstoreconnect-v1",
            "bid": WINDMILL_BUNDLE_ID,
        });
        let signing_input = format!(
            "{}.{}",
            URL_SAFE_NO_PAD.encode(header.to_string()),
            URL_SAFE_NO_PAD.encode(claims.to_string())
        );
        let signature = self
            .key
            .private_key
            .0
            .sign(&SystemRandom::new(), signing_input.as_bytes())
            .expect("a P-256 key signs any message");
        format!(
            "{signing_input}.{}",
            URL_SAFE_NO_PAD.encode(signature.as_ref())
        )
    }
}

impl Hosts {
    // Apple's hosts, as the API's reference names them.
    pub fn apple() -> Hosts {
        Hosts {
            production: Url::parse("https://api.storekit.apple.com")
                .expect("Apple's production host is a URL"),
            sandbox: Url::parse("https://api.storekit-sandbox.apple.com")
                .expect("Apple's sandbox host is a URL"),
        }
    }
}

impl FromStr for PrivateKey {
    type Err = InvalidKey;

    fn from_str(pem: &str) -> Result<PrivateKey, InvalidKey> {
        let body = pem
            .trim()
            .strip_prefix("-----BEGIN PRIVATE KEY-----")
            .and_then(|rest| rest.strip_suffix("-----END PRIVATE KEY-----"))
            .ok_or(InvalidKey)?;
        let encoded: String = body
            .chars()
            .filter(|character| !character.is_ascii_whitespace())
            .collect();
        let pkcs8 = STANDARD.decode(encoded).map_err(|_| InvalidKey)?;
        EcdsaKeyPair::from_pkcs8(
            &ECDSA_P256_SHA256_FIXED_SIGNING,
            &pkcs8,
            &SystemRandom::new(),
        )
        .map(|key| PrivateKey(Arc::new(key)))
        .map_err(|_| InvalidKey)
    }
}

// Two keys are one when their public halves are.
impl PartialEq for PrivateKey {
    fn eq(&self, other: &PrivateKey) -> bool {
        self.0.public_key().as_ref() == other.0.public_key().as_ref()
    }
}

impl fmt::Debug for PrivateKey {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("PrivateKey(redacted)")
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct InvalidKey;

impl fmt::Display for InvalidKey {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("the key is no P-256 private key in PKCS#8 PEM")
    }
}

impl std::error::Error for InvalidKey {}

#[derive(Deserialize)]
struct StatusResponse {
    data: Vec<SubscriptionGroup>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SubscriptionGroup {
    last_transactions: Vec<LastTransaction>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LastTransaction {
    original_transaction_id: String,
    status: Option<i32>,
    signed_transaction_info: String,
    signed_renewal_info: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ErrorResponse {
    error_code: i64,
}
