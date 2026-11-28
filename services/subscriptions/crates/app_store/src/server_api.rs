use std::fmt;
use std::pin::Pin;
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
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::verification::WINDMILL_BUNDLE_ID;

// Each request signs a token of its own, which Apple takes for up to an hour after its issue.
const TOKEN_LIFETIME: Duration = Duration::from_secs(5 * 60);

// One request, connecting included, ends within this: under the internal listener's request bound, so a claim or a
// refresh answers its own 503 rather than the listener's timeout, and background history reads stay bounded.
const REQUEST_BOUND: Duration = Duration::from_secs(3);

// Apple's 404s that it says a later try may pass: AccountNotFoundRetryableError, AppNotFoundRetryableError and
// OriginalTransactionIdNotFoundRetryableError.
const RETRYABLE_NOT_FOUND: [i64; 3] = [4_040_002, 4_040_004, 4_040_006];

pub type ApiFuture<'a, T> = Pin<Box<dyn Future<Output = Result<T, ApiFailure>> + Send + 'a>>;

// The App Store Server API surface the service calls (spec §4, §7, §8): `ServerApi` talks to Apple over HTTPS, and
// tests hand doors an in-memory fake behind `Arc<dyn AppStoreApi>`.
pub trait AppStoreApi: Send + Sync {
    fn subscription_status<'a>(
        &'a self,
        environment: Environment,
        original_transaction_id: &'a str,
    ) -> ApiFuture<'a, SignedStatus>;

    fn set_app_account_token<'a>(
        &'a self,
        environment: Environment,
        original_transaction_id: &'a str,
        app_account_token: &'a str,
    ) -> ApiFuture<'a, ()>;

    fn transaction_history<'a>(
        &'a self,
        environment: Environment,
        transaction_id: &'a str,
        revision: Option<&'a str>,
    ) -> ApiFuture<'a, TransactionHistoryPage>;

    fn notification_history<'a>(
        &'a self,
        environment: Environment,
        request: &'a NotificationHistoryRequest,
        pagination_token: Option<&'a str>,
    ) -> ApiFuture<'a, NotificationHistoryPage>;

    fn request_test_notification<'a>(
        &'a self,
        environment: Environment,
    ) -> ApiFuture<'a, TestNotificationToken>;

    fn test_notification_status<'a>(
        &'a self,
        environment: Environment,
        token: &'a TestNotificationToken,
    ) -> ApiFuture<'a, TestNotificationStatus>;
}

// The App Store Server API, called with Windmill's in-app purchase key: subscription statuses, transaction history,
// notification history, test notifications, and the account token Apple names in a lineage's later transactions
// (spec §4, §7, §8). It verifies nothing Apple signs; the verifier does.
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

// One page of Apple's answer to Get Transaction History v2: unverified signed transactions and the cursor to the next
// page. Debug redacts the payloads and revision token.
#[derive(Clone, PartialEq, Eq)]
pub struct TransactionHistoryPage {
    pub signed_transactions: Vec<String>,
    pub revision: Option<String>,
    pub has_more: bool,
}

impl fmt::Debug for TransactionHistoryPage {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("TransactionHistoryPage")
            .field("signed_transactions", &self.signed_transactions.len())
            .field("revision", &self.revision.as_ref().map(|_| "(redacted)"))
            .field("has_more", &self.has_more)
            .finish()
    }
}

// The JSON body for Get Notification History: an epoch-millisecond span (180 days in production, 30 in sandbox) and
// optional filters. Debug redacts transaction_id.
#[derive(Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotificationHistoryRequest {
    pub start_date: i64,
    pub end_date: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub notification_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub notification_subtype: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub only_failures: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub transaction_id: Option<String>,
}

impl NotificationHistoryRequest {
    fn is_valid(&self) -> bool {
        if self.start_date > self.end_date {
            return false;
        }
        if self.notification_type.as_deref() == Some("")
            || self.notification_subtype.as_deref() == Some("")
            || self.transaction_id.as_deref() == Some("")
        {
            return false;
        }
        if self.notification_subtype.is_some() && self.notification_type.is_none() {
            return false;
        }
        if self.notification_type.is_some() && self.transaction_id.is_some() {
            return false;
        }
        true
    }
}

impl fmt::Debug for NotificationHistoryRequest {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("NotificationHistoryRequest")
            .field("start_date", &self.start_date)
            .field("end_date", &self.end_date)
            .field("notification_type", &self.notification_type)
            .field("notification_subtype", &self.notification_subtype)
            .field("only_failures", &self.only_failures)
            .field(
                "transaction_id",
                &self.transaction_id.as_ref().map(|_| "(redacted)"),
            )
            .finish()
    }
}

// What Apple records for one delivery attempt of a server notification, mapped to a closed enum so no arbitrary text
// from the network reaches logs.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SendAttemptResult {
    Success,
    TimedOut,
    TlsIssue,
    CircularRedirect,
    NoResponse,
    SocketIssue,
    UnsupportedCharset,
    InvalidResponse,
    PrematureClose,
    UnsuccessfulHttpResponseCode,
    Other,
    Unknown,
}

impl SendAttemptResult {
    pub fn from_apple(value: &str) -> SendAttemptResult {
        match value {
            "SUCCESS" => SendAttemptResult::Success,
            "TIMED_OUT" => SendAttemptResult::TimedOut,
            "TLS_ISSUE" => SendAttemptResult::TlsIssue,
            "CIRCULAR_REDIRECT" => SendAttemptResult::CircularRedirect,
            "NO_RESPONSE" => SendAttemptResult::NoResponse,
            "SOCKET_ISSUE" => SendAttemptResult::SocketIssue,
            "UNSUPPORTED_CHARSET" => SendAttemptResult::UnsupportedCharset,
            "INVALID_RESPONSE" => SendAttemptResult::InvalidResponse,
            "PREMATURE_CLOSE" => SendAttemptResult::PrematureClose,
            "UNSUCCESSFUL_HTTP_RESPONSE_CODE" => SendAttemptResult::UnsuccessfulHttpResponseCode,
            "OTHER" => SendAttemptResult::Other,
            _ => SendAttemptResult::Unknown,
        }
    }

    pub fn code(self) -> &'static str {
        match self {
            SendAttemptResult::Success => "success",
            SendAttemptResult::TimedOut => "timed_out",
            SendAttemptResult::TlsIssue => "tls_issue",
            SendAttemptResult::CircularRedirect => "circular_redirect",
            SendAttemptResult::NoResponse => "no_response",
            SendAttemptResult::SocketIssue => "socket_issue",
            SendAttemptResult::UnsupportedCharset => "unsupported_charset",
            SendAttemptResult::InvalidResponse => "invalid_response",
            SendAttemptResult::PrematureClose => "premature_close",
            SendAttemptResult::UnsuccessfulHttpResponseCode => "unsuccessful_http_response_code",
            SendAttemptResult::Other => "other",
            SendAttemptResult::Unknown => "unknown",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SendAttempt {
    pub attempt_date: Option<i64>,
    pub result: Option<SendAttemptResult>,
}

// One notification entry in Apple's answer to Get Notification History: the signed payload Apple attempted to send
// and its delivery attempts. Debug redacts the signed payload.
#[derive(Clone, PartialEq, Eq)]
pub struct NotificationHistoryEntry {
    pub signed_payload: String,
    pub send_attempts: Vec<SendAttempt>,
}

impl fmt::Debug for NotificationHistoryEntry {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("NotificationHistoryEntry")
            .field("signed_payload", &"(redacted)")
            .field("send_attempts", &self.send_attempts)
            .finish()
    }
}

// One page of Apple's answer to Get Notification History. Debug redacts payloads and the pagination token.
#[derive(Clone, PartialEq, Eq)]
pub struct NotificationHistoryPage {
    pub entries: Vec<NotificationHistoryEntry>,
    pub pagination_token: Option<String>,
    pub has_more: bool,
}

impl fmt::Debug for NotificationHistoryPage {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("NotificationHistoryPage")
            .field("entries", &self.entries)
            .field(
                "pagination_token",
                &self.pagination_token.as_ref().map(|_| "(redacted)"),
            )
            .field("has_more", &self.has_more)
            .finish()
    }
}

// The token Apple returns from Request a Test Notification. Debug prints redacted and Display is absent so no log
// line or panic message repeats it.
#[derive(Clone, PartialEq, Eq)]
pub struct TestNotificationToken(String);

impl TestNotificationToken {
    pub fn new(token: impl Into<String>) -> TestNotificationToken {
        TestNotificationToken(token.into())
    }

    pub fn expose(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for TestNotificationToken {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("TestNotificationToken(redacted)")
    }
}

// Apple's answer to Get Test Notification Status. Debug redacts the signed payload.
#[derive(Clone, PartialEq, Eq)]
pub struct TestNotificationStatus {
    pub signed_payload: String,
    pub send_attempts: Vec<SendAttempt>,
}

impl fmt::Debug for TestNotificationStatus {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("TestNotificationStatus")
            .field("signed_payload", &"(redacted)")
            .field("send_attempts", &self.send_attempts)
            .finish()
    }
}

// How a call failed, as a code a log line may carry, each `api_`, so none reads as the ledger's or the verifier's code
// beside it: Apple's error message is never read.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ApiFailure {
    // No answer within REQUEST_BOUND: nothing listened, the connection broke or Apple stalled.
    Unreachable,
    // 401: Apple refused the token, so the key, its id or its issuer is not the one App Store Connect issued.
    Unauthorized,
    // 429.
    RateLimited,
    // A 5xx, or a 404 Apple says a later try may pass.
    ServerError,
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
            ApiFailure::Unreachable => "api_unreachable",
            ApiFailure::Unauthorized => "api_unauthorized",
            ApiFailure::RateLimited => "api_rate_limited",
            ApiFailure::ServerError => "api_server_error",
            ApiFailure::NotFound => "api_not_found",
            ApiFailure::BadRequest => "api_bad_request",
            ApiFailure::Malformed => "api_malformed",
        }
    }

    // Whether any request would fail the same way now, whatever it asks: the API is at fault, not the request.
    pub fn of_the_api(self) -> bool {
        matches!(
            self,
            ApiFailure::Unreachable
                | ApiFailure::Unauthorized
                | ApiFailure::RateLimited
                | ApiFailure::ServerError
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
        if invalid_path_segment(original_transaction_id) {
            return Err(ApiFailure::BadRequest);
        }
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
        if invalid_path_segment(original_transaction_id) {
            return Err(ApiFailure::BadRequest);
        }
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

    // Get Transaction History v2: one page of signed transactions for the customer of `transaction_id`, resuming from
    // `revision` when paging.
    pub async fn transaction_history(
        &self,
        environment: Environment,
        transaction_id: &str,
        revision: Option<&str>,
    ) -> Result<TransactionHistoryPage, ApiFailure> {
        if invalid_path_segment(transaction_id) || revision == Some("") {
            return Err(ApiFailure::BadRequest);
        }
        let mut url = self.url(environment, ["inApps", "v2", "history", transaction_id]);
        if let Some(revision) = revision {
            url.query_pairs_mut().append_pair("revision", revision);
        }
        let body = self.send(self.client.get(url)).await?;
        let HistoryResponse {
            signed_transactions,
            revision: response_revision,
            has_more,
        } = serde_json::from_slice(&body).map_err(|_| ApiFailure::Malformed)?;
        let next_revision = response_revision.filter(|value| !value.is_empty());
        if (has_more && (next_revision.is_none() || next_revision.as_deref() == revision))
            || signed_transactions.iter().any(String::is_empty)
        {
            return Err(ApiFailure::Malformed);
        }
        Ok(TransactionHistoryPage {
            signed_transactions,
            revision: next_revision,
            has_more,
        })
    }

    // Get Notification History: one page of notifications Apple attempted to send in the requested window, resuming
    // from `pagination_token` when paging (spec §7 step 4, §8).
    pub async fn notification_history(
        &self,
        environment: Environment,
        request: &NotificationHistoryRequest,
        pagination_token: Option<&str>,
    ) -> Result<NotificationHistoryPage, ApiFailure> {
        if pagination_token == Some("") || !request.is_valid() {
            return Err(ApiFailure::BadRequest);
        }
        let mut url = self.url(environment, ["inApps", "v1", "notifications", "history"]);
        if let Some(token) = pagination_token {
            url.query_pairs_mut().append_pair("paginationToken", token);
        }
        let body = serde_json::to_string(request).map_err(|_| ApiFailure::BadRequest)?;
        let http_request = self
            .client
            .post(url)
            .header(CONTENT_TYPE, "application/json")
            .body(body);
        let response = self.send(http_request).await?;
        let NotificationHistoryResponse {
            notification_history,
            pagination_token: response_token,
            has_more,
        } = serde_json::from_slice(&response).map_err(|_| ApiFailure::Malformed)?;
        let next_token = response_token.filter(|value| !value.is_empty());
        if has_more && (next_token.is_none() || next_token.as_deref() == pagination_token) {
            return Err(ApiFailure::Malformed);
        }
        let mut entries = Vec::with_capacity(notification_history.len());
        for entry in notification_history {
            if entry.signed_payload.is_empty() {
                return Err(ApiFailure::Malformed);
            }
            entries.push(NotificationHistoryEntry {
                signed_payload: entry.signed_payload,
                send_attempts: entry.send_attempts.into_iter().map(Into::into).collect(),
            });
        }
        Ok(NotificationHistoryPage {
            entries,
            pagination_token: next_token,
            has_more,
        })
    }

    // Request a Test Notification: asks Apple to dispatch a TEST notification to the configured door and answers the
    // token that reads its status.
    pub async fn request_test_notification(
        &self,
        environment: Environment,
    ) -> Result<TestNotificationToken, ApiFailure> {
        let url = self.url(environment, ["inApps", "v1", "notifications", "test"]);
        let body = self.send(self.client.post(url)).await?;
        let SendTestNotificationResponse {
            test_notification_token,
        } = serde_json::from_slice(&body).map_err(|_| ApiFailure::Malformed)?;
        if invalid_path_segment(&test_notification_token) {
            return Err(ApiFailure::Malformed);
        }
        Ok(TestNotificationToken(test_notification_token))
    }

    // Get Test Notification Status: reads the signed TEST payload Apple sent and the delivery attempts it recorded.
    pub async fn test_notification_status(
        &self,
        environment: Environment,
        token: &TestNotificationToken,
    ) -> Result<TestNotificationStatus, ApiFailure> {
        if invalid_path_segment(token.expose()) {
            return Err(ApiFailure::BadRequest);
        }
        let url = self.url(
            environment,
            ["inApps", "v1", "notifications", "test", token.expose()],
        );
        let body = self.send(self.client.get(url)).await?;
        let CheckTestNotificationResponse {
            signed_payload,
            send_attempts,
        } = serde_json::from_slice(&body).map_err(|_| ApiFailure::Malformed)?;
        if signed_payload.is_empty() {
            return Err(ApiFailure::Malformed);
        }
        Ok(TestNotificationStatus {
            signed_payload,
            send_attempts: send_attempts.into_iter().map(Into::into).collect(),
        })
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
                    ApiFailure::ServerError
                } else {
                    ApiFailure::NotFound
                })
            }
            _ if status.is_server_error() => Err(ApiFailure::ServerError),
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

impl AppStoreApi for ServerApi {
    fn subscription_status<'a>(
        &'a self,
        environment: Environment,
        original_transaction_id: &'a str,
    ) -> ApiFuture<'a, SignedStatus> {
        Box::pin(ServerApi::subscription_status(
            self,
            environment,
            original_transaction_id,
        ))
    }

    fn set_app_account_token<'a>(
        &'a self,
        environment: Environment,
        original_transaction_id: &'a str,
        app_account_token: &'a str,
    ) -> ApiFuture<'a, ()> {
        Box::pin(ServerApi::set_app_account_token(
            self,
            environment,
            original_transaction_id,
            app_account_token,
        ))
    }

    fn transaction_history<'a>(
        &'a self,
        environment: Environment,
        transaction_id: &'a str,
        revision: Option<&'a str>,
    ) -> ApiFuture<'a, TransactionHistoryPage> {
        Box::pin(ServerApi::transaction_history(
            self,
            environment,
            transaction_id,
            revision,
        ))
    }

    fn notification_history<'a>(
        &'a self,
        environment: Environment,
        request: &'a NotificationHistoryRequest,
        pagination_token: Option<&'a str>,
    ) -> ApiFuture<'a, NotificationHistoryPage> {
        Box::pin(ServerApi::notification_history(
            self,
            environment,
            request,
            pagination_token,
        ))
    }

    fn request_test_notification<'a>(
        &'a self,
        environment: Environment,
    ) -> ApiFuture<'a, TestNotificationToken> {
        Box::pin(ServerApi::request_test_notification(self, environment))
    }

    fn test_notification_status<'a>(
        &'a self,
        environment: Environment,
        token: &'a TestNotificationToken,
    ) -> ApiFuture<'a, TestNotificationStatus> {
        Box::pin(ServerApi::test_notification_status(
            self,
            environment,
            token,
        ))
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

// `Url::path_segments_mut().extend(...)` treats "." and ".." as dot segments and resolves them rather than
// appending a segment; refuse them alongside empty ids before any request is sent.
fn invalid_path_segment(segment: &str) -> bool {
    segment.is_empty() || segment == "." || segment == ".."
}

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
struct HistoryResponse {
    #[serde(default)]
    signed_transactions: Vec<String>,
    revision: Option<String>,
    has_more: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct NotificationHistoryResponse {
    #[serde(default)]
    notification_history: Vec<RawNotificationHistoryEntry>,
    pagination_token: Option<String>,
    has_more: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawNotificationHistoryEntry {
    signed_payload: String,
    #[serde(default)]
    send_attempts: Vec<RawSendAttempt>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawSendAttempt {
    attempt_date: Option<i64>,
    send_attempt_result: Option<String>,
}

impl From<RawSendAttempt> for SendAttempt {
    fn from(raw: RawSendAttempt) -> SendAttempt {
        SendAttempt {
            attempt_date: raw.attempt_date,
            result: raw
                .send_attempt_result
                .as_deref()
                .map(SendAttemptResult::from_apple),
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SendTestNotificationResponse {
    test_notification_token: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CheckTestNotificationResponse {
    signed_payload: String,
    #[serde(default)]
    send_attempts: Vec<RawSendAttempt>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ErrorResponse {
    error_code: i64,
}
