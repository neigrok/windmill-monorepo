pub mod responses;

use std::fmt;
use std::str::FromStr;
use std::time::{Duration, Instant};

use axum::extract::rejection::{PathRejection, QueryRejection};
use axum::extract::{Path, Query, Request, State};
use axum::http::StatusCode;
use axum::http::header::{AUTHORIZATION, WWW_AUTHENTICATE};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use sentry::{Hub, SentryFutureExt};
use serde::Deserialize;
use serde_json::json;
use storage::{AccountRecord, Erasure, FeedPage, Ledger, StorageError};
use subtle::ConstantTimeEq;
use tracing::Instrument;
use uuid::Uuid;

use crate::telemetry;

use responses::{AccountResponse, FeedPageResponse, RefusalResponse};

// The backend's follower reads this every few seconds forever (spec §6.1).
pub const FEED_ROUTE: &str = "/internal/v1/feed";

// §5.2: a feed page holds at most this many events.
const PAGE_LIMIT: i64 = 500;

const UNBIND: &str = "account.unbind";

// What the backend's account and feed doors ask of the ledger: its reads, and an account's erasure. `Ledger` is the one
// the service runs on.
pub trait BackendLedger: Clone + Send + Sync + 'static {
    fn feed(
        &self,
        after: i64,
        limit: i64,
    ) -> impl Future<Output = Result<FeedPage, StorageError>> + Send;

    fn account(
        &self,
        account_id: Uuid,
    ) -> impl Future<Output = Result<AccountRecord, StorageError>> + Send;

    fn erase_account(
        &self,
        account_id: Uuid,
    ) -> impl Future<Output = Result<Erasure, StorageError>> + Send;
}

impl BackendLedger for Ledger {
    async fn feed(&self, after: i64, limit: i64) -> Result<FeedPage, StorageError> {
        Ledger::feed(self, after, limit).await
    }

    async fn account(&self, account_id: Uuid) -> Result<AccountRecord, StorageError> {
        Ledger::account(self, account_id).await
    }

    async fn erase_account(&self, account_id: Uuid) -> Result<Erasure, StorageError> {
        Ledger::erase_account(self, account_id).await
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

// The backend's doors (§5.2), each behind the bearer secret: its reads, an account's erasure, and the store doors' routes
// that pull a store's state, `store_doors::internal_router`. Without a secret every one of them answers 401, so the doors
// are shut until the deployment sets one.
pub fn doors<L: BackendLedger>(
    secret: Option<BearerSecret>,
    ledger: L,
    store_doors: Router,
) -> Router {
    Router::new()
        .route(FEED_ROUTE, get(feed::<L>))
        .route(
            "/internal/v1/accounts/{accountId}",
            get(account::<L>).delete(erase::<L>),
        )
        .with_state(ledger)
        .merge(store_doors)
        .route_layer(middleware::from_fn_with_state(secret, bearer))
}

// An id as the contract writes every one: a UUID in its canonical spelling, lowercase and hyphenated. A door takes no
// other spelling.
pub fn canonical_id(text: &str) -> Option<Uuid> {
    Uuid::try_parse(text)
        .ok()
        .filter(|parsed| parsed.hyphenated().to_string() == text)
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

async fn feed<L: BackendLedger>(
    State(ledger): State<L>,
    request: Result<Query<FeedRequest>, QueryRejection>,
) -> Response {
    let Ok(Query(FeedRequest { after, limit })) = request else {
        return refused(StatusCode::BAD_REQUEST, "invalid_query");
    };
    if after < 0 || !(1..=PAGE_LIMIT).contains(&limit) {
        return refused(StatusCode::BAD_REQUEST, "invalid_query");
    }
    let page = match ledger.feed(after, limit).await {
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

// `GET /internal/v1/accounts/{accountId}`, the id in its canonical spelling. The account id is a hint a store carries,
// so no line or refusal names it (§10).
async fn account<L: BackendLedger>(
    State(ledger): State<L>,
    account_id: Result<Path<String>, PathRejection>,
) -> Response {
    let Some(account_id) = account_id
        .ok()
        .and_then(|Path(account_id)| canonical_id(&account_id))
    else {
        return refused(StatusCode::BAD_REQUEST, "invalid_account_id");
    };
    let record = match ledger.account(account_id).await {
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

// `DELETE /internal/v1/accounts/{accountId}` (§6.4), which the backend sends once it erased the account and repeats
// until it answers: the account recorded as erased and everything it holds unbound. It answers 204 whether it changed
// anything or the account was erased already, so a repeat answers the same.
async fn erase<L: BackendLedger>(
    State(ledger): State<L>,
    account_id: Result<Path<String>, PathRejection>,
) -> Response {
    let account_id = account_id
        .ok()
        .and_then(|Path(account_id)| canonical_id(&account_id));
    detached(async move {
        let started = Instant::now();
        let unbind = match account_id {
            None => Unbind::Refused("invalid_account_id"),
            Some(account_id) => match ledger.erase_account(account_id).await {
                Ok(erasure) => Unbind::Erased(erasure),
                Err(failure) => Unbind::LedgerFailed(failure),
            },
        };
        unbind.log(started.elapsed());
        unbind.answer()
    })
    .await
}

// What one erasure came to, written as its one `account.unbind` line: how much it changed, never which account (§10).
enum Unbind {
    Erased(Erasure),
    Refused(&'static str),
    LedgerFailed(StorageError),
}

impl Unbind {
    fn answer(self) -> Response {
        match self {
            Unbind::Erased(_) => StatusCode::NO_CONTENT.into_response(),
            Unbind::Refused(code) => refused(StatusCode::BAD_REQUEST, code),
            Unbind::LedgerFailed(_) => refused(StatusCode::SERVICE_UNAVAILABLE, "unavailable"),
        }
    }

    // A ledger that failed is an Issue under the operation and its code; a refusal is the line alone.
    fn log(&self, elapsed: Duration) {
        let duration_ms = (elapsed.as_secs_f64() * 100_000.0).round() / 100.0;
        match self {
            Unbind::Erased(erasure) => {
                let unbound = erasure
                    .lineages
                    .iter()
                    .filter(|lineage| !lineage.change.events.is_empty())
                    .count();
                let periods: usize = erasure
                    .lineages
                    .iter()
                    .map(|lineage| lineage.change.periods.len())
                    .sum();
                let events: usize = erasure
                    .lineages
                    .iter()
                    .map(|lineage| lineage.seqs.len())
                    .sum();
                tracing::info!(
                    operation = UNBIND,
                    outcome = if erasure.newly_erased {
                        "erased"
                    } else {
                        "already_erased"
                    },
                    answered = StatusCode::NO_CONTENT.as_u16(),
                    unbound,
                    periods,
                    hints_dropped = erasure.hints_dropped,
                    events,
                    duration_ms,
                    "{UNBIND}"
                );
            }
            Unbind::Refused(code) => tracing::info!(
                operation = UNBIND,
                outcome = "refused",
                code,
                answered = StatusCode::BAD_REQUEST.as_u16(),
                duration_ms,
                "{UNBIND}"
            ),
            Unbind::LedgerFailed(failure) => {
                let (code, sqlstate) = (failure.code(), failure.sqlstate());
                let sentry_event_id =
                    telemetry::report(sentry::Level::Error, UNBIND, code, sqlstate);
                tracing::error!(
                    operation = UNBIND,
                    outcome = "ledger_failed",
                    code,
                    sqlstate,
                    answered = StatusCode::SERVICE_UNAVAILABLE.as_u16(),
                    duration_ms,
                    sentry_event_id,
                    "{UNBIND}"
                );
            }
        }
    }
}

// An internal door's write runs as a task of its own, so a client that leaves cancels neither its write nor its line;
// the handler waits for its answer, and answers 500 only when the task panicked.
pub(crate) async fn detached(work: impl Future<Output = Response> + Send + 'static) -> Response {
    let task = tokio::spawn(work.bind_hub(Hub::current()).in_current_span());
    task.await.unwrap_or_else(|_| {
        let body = Json(json!({ "error": "internal" }));
        (StatusCode::INTERNAL_SERVER_ERROR, body).into_response()
    })
}

fn refused(status: StatusCode, code: &'static str) -> Response {
    (status, Json(RefusalResponse { code })).into_response()
}

// A read the ledger did not answer is an Issue under the read's operation (spec §10), and the backend reads again.
fn unavailable(operation: &'static str, failure: &StorageError) -> Response {
    telemetry::report_failure(operation, failure.code(), failure.sqlstate());
    refused(StatusCode::SERVICE_UNAVAILABLE, "unavailable")
}
