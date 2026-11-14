mod responses;

use std::fmt;
use std::str::FromStr;

use axum::extract::rejection::QueryRejection;
use axum::extract::{Path, Query, Request, State};
use axum::http::StatusCode;
use axum::http::header::{AUTHORIZATION, WWW_AUTHENTICATE};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use serde::Deserialize;
use storage::{AccountRecord, FeedPage, Ledger, StorageError};
use subtle::ConstantTimeEq;
use uuid::Uuid;

use crate::telemetry;

use responses::{AccountResponse, FeedPageResponse, RefusalResponse};

// The backend's follower reads this every few seconds forever (spec §6.1).
pub const FEED_ROUTE: &str = "/internal/v1/feed";

// §5.2: a feed page holds at most this many events.
const PAGE_LIMIT: i64 = 500;

// What the backend's read doors ask of the ledger. `Ledger` is the one the service runs on.
pub trait Reads: Clone + Send + Sync + 'static {
    fn feed(
        &self,
        after: i64,
        limit: i64,
    ) -> impl Future<Output = Result<FeedPage, StorageError>> + Send;

    fn account(
        &self,
        account_id: Uuid,
    ) -> impl Future<Output = Result<AccountRecord, StorageError>> + Send;
}

impl Reads for Ledger {
    async fn feed(&self, after: i64, limit: i64) -> Result<FeedPage, StorageError> {
        Ledger::feed(self, after, limit).await
    }

    async fn account(&self, account_id: Uuid) -> Result<AccountRecord, StorageError> {
        Ledger::account(self, account_id).await
    }
}

// The secret the backend presents as a bearer on every internal door (§5.2): at least 32 characters, none of them a
// space or a control character, so it travels in a header as it is. Neither Debug nor any error repeats it.
#[derive(Clone)]
pub struct BearerSecret(String);

impl BearerSecret {
    // Compares in time that depends on the lengths alone, so a caller learns nothing of the secret from how long a
    // refusal takes.
    pub fn admits(&self, presented: &str) -> bool {
        self.0.as_bytes().ct_eq(presented.as_bytes()).into()
    }
}

impl FromStr for BearerSecret {
    type Err = ();

    fn from_str(value: &str) -> Result<BearerSecret, ()> {
        let visible = value.bytes().all(|byte| byte.is_ascii_graphic());
        if !visible || value.len() < 32 {
            return Err(());
        }
        Ok(BearerSecret(value.to_owned()))
    }
}

impl PartialEq for BearerSecret {
    fn eq(&self, other: &BearerSecret) -> bool {
        self.admits(&other.0)
    }
}

impl fmt::Debug for BearerSecret {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("BearerSecret(redacted)")
    }
}

// The backend's read doors, each behind the bearer secret. Without a secret every one of them answers 401, so the
// doors are shut until the deployment sets one.
pub fn doors<R: Reads>(secret: Option<BearerSecret>, reads: R) -> Router {
    Router::new()
        .route(FEED_ROUTE, get(feed::<R>))
        .route("/internal/v1/accounts/{accountId}", get(account::<R>))
        .with_state(reads)
        .route_layer(middleware::from_fn_with_state(secret, bearer))
}

// Refuses with no word of why: no secret is set, none was presented, or another was.
async fn bearer(
    State(secret): State<Option<BearerSecret>>,
    request: Request,
    next: Next,
) -> Response {
    let presented = request
        .headers()
        .get(AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split_once(' '))
        .filter(|(scheme, _)| scheme.eq_ignore_ascii_case("bearer"))
        .map(|(_, presented)| presented);
    match (secret, presented) {
        (Some(secret), Some(presented)) if secret.admits(presented) => next.run(request).await,
        _ => (
            StatusCode::UNAUTHORIZED,
            [(WWW_AUTHENTICATE, "Bearer")],
            Json(RefusalResponse {
                code: "unauthorized",
            }),
        )
            .into_response(),
    }
}

// `GET /internal/v1/feed?after=<seq>&limit=<n>`: both required, `after` from 0, `limit` from 1 to 500.
#[derive(Deserialize)]
struct FeedRequest {
    after: i64,
    limit: i64,
}

async fn feed<R: Reads>(
    State(reads): State<R>,
    request: Result<Query<FeedRequest>, QueryRejection>,
) -> Response {
    let Ok(Query(FeedRequest { after, limit })) = request else {
        return refused(StatusCode::BAD_REQUEST, "invalid_query");
    };
    if after < 0 || !(1..=PAGE_LIMIT).contains(&limit) {
        return refused(StatusCode::BAD_REQUEST, "invalid_query");
    }
    let page = match reads.feed(after, limit).await {
        Ok(page) => page,
        Err(failure) => return unavailable("feed.read", &failure),
    };
    let entries = page.entries.len();
    // A caught-up follower reads an empty page every few seconds; only a page that carries events is news.
    if entries == 0 {
        tracing::debug!(
            operation = "feed.read",
            outcome = "ok",
            entries,
            "feed.read"
        );
    } else {
        tracing::info!(
            operation = "feed.read",
            outcome = "ok",
            entries,
            "feed.read"
        );
    }
    Json(FeedPageResponse::from(&page)).into_response()
}

// `GET /internal/v1/accounts/{accountId}`. The account id is a hint a store carries, so no line names it (§10).
async fn account<R: Reads>(State(reads): State<R>, Path(account_id): Path<String>) -> Response {
    let Ok(account_id) = Uuid::parse_str(&account_id) else {
        return refused(StatusCode::BAD_REQUEST, "invalid_account_id");
    };
    let record = match reads.account(account_id).await {
        Ok(record) => record,
        Err(failure) => return unavailable("account.read", &failure),
    };
    tracing::info!(
        operation = "account.read",
        outcome = "ok",
        subscriptions = record.subscriptions.len(),
        "account.read"
    );
    Json(AccountResponse::from(&record)).into_response()
}

fn refused(status: StatusCode, code: &'static str) -> Response {
    (status, Json(RefusalResponse { code })).into_response()
}

// A read the ledger did not answer is an Issue under the read's operation (spec §10), and the backend reads again.
fn unavailable(operation: &'static str, failure: &StorageError) -> Response {
    telemetry::report_failure(operation, failure.code(), failure.sqlstate());
    refused(StatusCode::SERVICE_UNAVAILABLE, "unavailable")
}
