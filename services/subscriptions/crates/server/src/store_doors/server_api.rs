// The App Store door's work through the App Store Server API (spec §4, §5.2): a claim binds a subscription by the state
// the door pulls for it, a refresh applies that state, and the sweep writes back the hints a claim owes.

use std::time::{Duration, Instant};

use app_store::decoding::{self, Decoded};
use app_store::server_api::{ApiFailure, AppStoreApi, SendAttemptResult};
use app_store::verification::{self, AccountToken};
use axum::Json;
use axum::body::Bytes;
use axum::extract::rejection::PathRejection;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use domain::{Environment, Lineage, Observation, Store};
use serde::Deserialize;
use storage::{AccountClaim, Applied, HintRefusal, Observed, StorageError, StoreHint};
use uuid::Uuid;

use super::AppStoreDoor;
use crate::internal::responses::{
    ClaimResponse, EntitlementResponse, RefreshResponse, RefusalResponse,
};
use crate::internal::{canonical_id, detached};
use crate::telemetry::{self, Throttle};

const CLAIM: &str = "store.claim";
const REFRESH: &str = "store.refresh";
const HINT: &str = "store.hint";
const TEST_NOTIFICATION: &str = "store.test_notification";

// `POST /internal/v1/app-store/claims`, which the backend sends for a person whose phone bought or restored (§5.3).
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AppStoreClaimRequest {
    account_id: String,
    signed_transaction: String,
}

pub(super) async fn claim(State(door): State<AppStoreDoor>, body: Bytes) -> Response {
    detached(async move {
        let started = Instant::now();
        let claim = door.claimed(&body).await;
        claim.log(started.elapsed(), &door.recurring_failures);
        claim.answer()
    })
    .await
}

// `POST /internal/v1/subscriptions/{subscriptionId}/refresh`, the id the service's own, in its canonical spelling.
pub(super) async fn refresh(
    State(door): State<AppStoreDoor>,
    subscription_id: Result<Path<String>, PathRejection>,
) -> Response {
    let subscription_id = subscription_id
        .ok()
        .and_then(|Path(subscription_id)| canonical_id(&subscription_id));
    detached(async move {
        let started = Instant::now();
        let refresh = door.refreshed(subscription_id).await;
        refresh.log(started.elapsed(), &door.recurring_failures);
        refresh.answer()
    })
    .await
}

impl AppStoreDoor {
    // §4 by claim, in order: the backend's request, the transaction the phone holds verified as Apple's and naming the
    // lineage, then the lineage's state pulled from Apple, never the transaction's own, applied with the claim. The
    // answer is the claimed subscription's newest seq and the caller's entitlement (§5.2); a claim retried after its
    // answer was lost changes nothing and answers the same seq.
    async fn claimed(&self, body: &[u8]) -> Write {
        let came_to = |environment, outcome| Write {
            operation: CLAIM,
            environment,
            outcome,
        };
        let Ok(AppStoreClaimRequest {
            account_id,
            signed_transaction,
        }) = serde_json::from_slice(body)
        else {
            return came_to(None, Outcome::refused_as_asked("invalid_request"));
        };
        let Some(account_id) = canonical_id(&account_id) else {
            return came_to(None, Outcome::refused_as_asked("invalid_account_id"));
        };
        let verified = self
            .verified(move |verifier| verifier.verify_transaction(&signed_transaction))
            .await;
        let transaction = match verified {
            Ok(transaction) => transaction,
            Err(refusal) => {
                return came_to(
                    None,
                    Outcome::invalid_transaction(refusal.code(), refusal.after_signature()),
                );
            }
        };
        let environment = Some(Environment::from(transaction.environment));
        let statement = match decoding::decode_claim(&transaction) {
            Ok(statement) => statement,
            Err(unsupported) => {
                return came_to(
                    environment,
                    Outcome::invalid_transaction(unsupported.code(), true),
                );
            }
        };

        let claimed = AccountClaim {
            account_id,
            at: self.now(),
        };
        let (events, newest_seq) =
            match self.pull_and_apply(&statement.lineage, Some(claimed)).await {
                Ok(recorded) => recorded,
                Err(outcome) => return came_to(environment, outcome),
            };
        let outcome = match self.ledger.entitlement(account_id).await {
            Ok(entitlement) => Outcome::Applied {
                events,
                answer: Box::new(
                    Json(ClaimResponse {
                        seq: newest_seq,
                        entitlement: EntitlementResponse::from(&entitlement),
                    })
                    .into_response(),
                ),
            },
            Err(failure) => Outcome::LedgerFailed {
                outcome: "entitlement_unread",
                failure,
            },
        };
        came_to(environment, outcome)
    }

    // A pull of the subscription's state now, applied as any observation is; it binds nothing a hint does not.
    async fn refreshed(&self, subscription_id: Option<Uuid>) -> Write {
        let came_to = |environment, outcome| Write {
            operation: REFRESH,
            environment,
            outcome,
        };
        let Some(subscription_id) = subscription_id else {
            return came_to(None, Outcome::refused_as_asked("invalid_subscription_id"));
        };
        let subscription = match self.ledger.subscription(subscription_id).await {
            Ok(Some(subscription)) => subscription,
            Ok(None) => {
                return came_to(
                    None,
                    Outcome::Refused {
                        status: StatusCode::NOT_FOUND,
                        answer: "unknown_subscription",
                        code: "unknown_subscription",
                        warned: false,
                    },
                );
            }
            Err(failure) => {
                return came_to(
                    None,
                    Outcome::LedgerFailed {
                        outcome: "read_failed",
                        failure,
                    },
                );
            }
        };
        let lineage = subscription.lineage;
        let environment = Some(lineage.environment);
        if lineage.store != Store::AppStore {
            return came_to(environment, Outcome::StoreApiUnavailable);
        }
        let outcome = match self.pull_and_apply(&lineage, None).await {
            Ok((events, newest_seq)) => Outcome::Applied {
                events,
                answer: Box::new(Json(RefreshResponse { seq: newest_seq }).into_response()),
            },
            Err(outcome) => outcome,
        };
        came_to(environment, outcome)
    }

    // §3.4 for a pulled state: the lineage's status read from the App Store Server API, verified as a notification's
    // payloads are, decoded, and applied with the claim when a claim door calls. It answers how many events the apply
    // recorded and the subscription's newest seq, or what the outcome is instead.
    async fn pull_and_apply(
        &self,
        lineage: &Lineage,
        claim: Option<AccountClaim>,
    ) -> Result<(usize, i64), Outcome> {
        let Some(api) = &self.api else {
            return Err(Outcome::StoreApiUnavailable);
        };
        let (observation, account_token) = self
            .pull(api.as_ref(), lineage)
            .await
            .map_err(Outcome::PullFailed)?;
        let observed = Observed {
            observation,
            // §4: an appAccountToken that is not a UUID names no account.
            hint: account_token.and_then(|token| Uuid::parse_str(token.expose()).ok()),
            claim,
            pulled_at: Some(self.now()),
        };
        let _turn = self
            .applies
            .acquire()
            .await
            .expect("the door never closes its semaphores");
        match self.ledger.apply(observed).await {
            Ok(Applied::Recorded {
                seqs, newest_seq, ..
            }) => Ok((seqs.len(), newest_seq)),
            Ok(Applied::Refused(refusal)) => Err(Outcome::Refused {
                status: StatusCode::CONFLICT,
                answer: refusal.name(),
                code: refusal.name(),
                warned: false,
            }),
            Ok(Applied::AlreadySettled) => unreachable!("only a kept notification is settled"),
            Err(failure) => Err(Outcome::LedgerFailed {
                outcome: "apply_failed",
                failure,
            }),
        }
    }

    // Apple's entry for the lineage, believed only as the lineage it asked for: Apple picks the entry by an id it does
    // not sign, so the signed transaction must name the same one.
    async fn pull(
        &self,
        api: &dyn AppStoreApi,
        lineage: &Lineage,
    ) -> Result<(Observation, Option<AccountToken>), PullFailure> {
        let signed = api
            .subscription_status(lineage.environment, lineage.store_subscription_id.as_str())
            .await
            .map_err(PullFailure::Api)?;
        let environment = verification::Environment::from(lineage.environment);
        let status = self
            .verified(move |verifier| verifier.verify_status(environment, &signed))
            .await
            .map_err(PullFailure::Unverified)?;
        match decoding::decode_status(&status) {
            Decoded::Observation {
                observation,
                account_token,
            } if observation.lineage == *lineage => Ok((observation, account_token)),
            Decoded::Observation { .. } => Err(PullFailure::Unreadable("inconsistent")),
            Decoded::AwaitsStatus { awaiting, .. } => Err(PullFailure::Unreadable(awaiting.code())),
            Decoded::Silent(silence) => Err(PullFailure::Unreadable(silence.code())),
            Decoded::Unsupported(unsupported) => Err(PullFailure::Unreadable(unsupported.code())),
        }
    }

    // Whether the sweep has the API to write the hints a claim owes the App Store.
    pub fn writes_store_hints(&self) -> bool {
        self.api.is_some()
    }

    // §4: the account a claim bound, written to the App Store as the lineage's app account token, then cleared from
    // what the ledger owes. A failure of the API as a whole leaves the hint as it was, owed for the next pass; a
    // refusal of this hint makes it wait, and its fifth abandons it. One `store.hint` line logs it.
    pub async fn write_store_hint(&self, hint: &StoreHint) -> HintWritten {
        let started = Instant::now();
        let written = match &self.api {
            None => HintWritten::StoreApiUnavailable,
            Some(api) => match api
                .set_app_account_token(
                    hint.lineage.environment,
                    hint.lineage.store_subscription_id.as_str(),
                    hint.account_id.as_str(),
                )
                .await
            {
                Err(failure) if failure.of_the_api() => HintWritten::WriteFailed(failure),
                Err(failure) => match self.ledger.count_store_hint_refusal(hint).await {
                    Ok(HintRefusal::WaitsToRetry) => HintWritten::Refused(failure),
                    Ok(HintRefusal::Abandoned) => HintWritten::Abandoned(failure),
                    Err(unrecorded) => HintWritten::Unrecorded(unrecorded),
                },
                Ok(()) => match self.ledger.clear_store_hint(hint).await {
                    Ok(()) => HintWritten::Written,
                    Err(unrecorded) => HintWritten::Unrecorded(unrecorded),
                },
            },
        };
        written.log(
            hint.lineage.environment,
            started.elapsed(),
            &self.recurring_failures,
        );
        written
    }

    // The hints the sweep writes this pass: every hint no longer owed is dropped first, its subscription bound to
    // another account since (§4), then at most `limit` of the rest are read, the longest owed first. Each is logged as
    // a `store.hint` line, and a ledger that does not answer is reported once in a while.
    pub async fn store_hints_due(&self, limit: i64) -> Result<Vec<StoreHint>, StorageError> {
        let read = async {
            let forgotten = self.ledger.forget_stale_store_hints().await?;
            let due = self.ledger.store_hints(limit).await?;
            Ok::<_, StorageError>((forgotten, due))
        };
        match read.await {
            Ok((forgotten, due)) => {
                if forgotten > 0 {
                    tracing::info!(
                        operation = HINT,
                        outcome = "forgotten",
                        hints = forgotten,
                        "{HINT}"
                    );
                }
                Ok(due)
            }
            Err(failure) => {
                let sentry_event_id = self.recurring_failures.report(
                    sentry::Level::Error,
                    HINT,
                    failure.code(),
                    failure.sqlstate(),
                );
                tracing::error!(
                    operation = HINT,
                    outcome = "unread",
                    code = failure.code(),
                    sqlstate = failure.sqlstate(),
                    sentry_event_id,
                    "{HINT}"
                );
                Err(failure)
            }
        }
    }
}

// Why a pull gave no state to apply.
enum PullFailure {
    Api(ApiFailure),
    // Apple's payloads did not verify.
    Unverified(verification::Refusal),
    // They verified, and state nothing the decoder reads as the lineage's state.
    Unreadable(&'static str),
}

impl PullFailure {
    fn code(&self) -> &'static str {
        match self {
            PullFailure::Api(failure) => failure.code(),
            PullFailure::Unverified(refusal) => refusal.code(),
            PullFailure::Unreadable(code) => code,
        }
    }
}

// What one claim or refresh came to: the one line that logs it, and its answer. The line names no account,
// transaction or subscription (§10).
struct Write {
    operation: &'static str,
    environment: Option<Environment>,
    outcome: Outcome,
}

enum Outcome {
    // 200, with the events the pulled state recorded, answered as the door's own type writes it.
    Applied {
        events: usize,
        answer: Box<Response>,
    },
    // Refused for what was asked: the status and code it answers, the code its line carries, and whether the line is a
    // warning, as when the backend sent what the contract does not allow or Apple signed what is refused.
    Refused {
        status: StatusCode,
        answer: &'static str,
        code: &'static str,
        warned: bool,
    },
    // 503: the deployment holds no key for the store's API.
    StoreApiUnavailable,
    // 503: the store's API answered no state the door can apply.
    PullFailed(PullFailure),
    // 503: the ledger did not answer, before the state was applied or after.
    LedgerFailed {
        outcome: &'static str,
        failure: StorageError,
    },
}

impl Outcome {
    fn refused_as_asked(code: &'static str) -> Outcome {
        Outcome::Refused {
            status: StatusCode::BAD_REQUEST,
            answer: code,
            code,
            warned: true,
        }
    }

    // §5.2: a transaction the service cannot take answers one code, whatever the reason its line carries.
    fn invalid_transaction(code: &'static str, signed: bool) -> Outcome {
        Outcome::Refused {
            status: StatusCode::BAD_REQUEST,
            answer: "invalid_transaction",
            code,
            warned: signed,
        }
    }

    fn label(&self) -> &'static str {
        match self {
            Outcome::Applied { .. } => "applied",
            Outcome::Refused { .. } => "refused",
            Outcome::StoreApiUnavailable => "store_api_unavailable",
            Outcome::PullFailed(_) => "pull_failed",
            Outcome::LedgerFailed { outcome, .. } => outcome,
        }
    }

    fn code(&self) -> Option<&'static str> {
        match self {
            Outcome::Applied { .. } | Outcome::StoreApiUnavailable => None,
            Outcome::Refused { code, .. } => Some(code),
            Outcome::PullFailed(failure) => Some(failure.code()),
            Outcome::LedgerFailed { failure, .. } => Some(failure.code()),
        }
    }

    fn status(&self) -> StatusCode {
        match self {
            Outcome::Applied { .. } => StatusCode::OK,
            Outcome::Refused { status, .. } => *status,
            Outcome::StoreApiUnavailable
            | Outcome::PullFailed(_)
            | Outcome::LedgerFailed { .. } => StatusCode::SERVICE_UNAVAILABLE,
        }
    }
}

impl Write {
    fn answer(self) -> Response {
        let status = self.outcome.status();
        let refused = |code| (status, Json(RefusalResponse { code })).into_response();
        match self.outcome {
            Outcome::Applied { answer, .. } => *answer,
            Outcome::Refused { answer, .. } => refused(answer),
            Outcome::StoreApiUnavailable => refused("store_api_unavailable"),
            Outcome::PullFailed(_) => refused("store_unavailable"),
            Outcome::LedgerFailed { .. } => refused("unavailable"),
        }
    }

    // A pull or a ledger that failed is an Issue under the operation and its code, a failing Apple at most once in a
    // while; a refusal is the line alone.
    fn log(&self, elapsed: Duration, recurring_failures: &Throttle) {
        let Write {
            operation,
            environment,
            ref outcome,
        } = *self;
        let store = Store::AppStore.name();
        let environment = environment.map(Environment::name);
        let code = outcome.code();
        let sqlstate = match outcome {
            Outcome::LedgerFailed { failure, .. } => failure.sqlstate(),
            _ => None,
        };
        let events = match outcome {
            Outcome::Applied { events, .. } => Some(*events),
            _ => None,
        };
        let sentry_event_id = match (outcome, code) {
            (Outcome::PullFailed(_), Some(code)) => {
                recurring_failures.report(sentry::Level::Error, operation, code, None)
            }
            (Outcome::LedgerFailed { .. }, Some(code)) => {
                telemetry::report(sentry::Level::Error, operation, code, sqlstate)
            }
            _ => None,
        };
        let answered = outcome.status().as_u16();
        let duration_ms = (elapsed.as_secs_f64() * 100_000.0).round() / 100.0;
        // tracing fixes a line's level at the call, so the line is written once, placed below.
        macro_rules! write_line {
            ($level:ident) => {
                tracing::$level!(
                    operation,
                    store,
                    environment,
                    outcome = outcome.label(),
                    code,
                    sqlstate,
                    answered,
                    events,
                    duration_ms,
                    sentry_event_id,
                    "{operation}"
                )
            };
        }
        match outcome {
            Outcome::PullFailed(_) | Outcome::LedgerFailed { .. } => write_line!(error),
            Outcome::Refused { warned: true, .. } | Outcome::StoreApiUnavailable => {
                write_line!(warn)
            }
            Outcome::Refused { .. } | Outcome::Applied { .. } => write_line!(info),
        }
    }
}

// What writing one owed hint came to.
#[derive(Debug, PartialEq)]
pub enum HintWritten {
    Written,
    // The deployment holds no key for the App Store Server API.
    StoreApiUnavailable,
    // The API failed as it would for any hint, as when Apple does not answer: the hint is owed as it was.
    WriteFailed(ApiFailure),
    // Apple refused this hint: it waits 1, 2, 4 or 8 hours before it is written again.
    Refused(ApiFailure),
    // Apple refused it a fifth time: it is never written again.
    Abandoned(ApiFailure),
    // The ledger did not record what Apple answered; the hint is owed as it was, and a hint Apple took is written
    // again, which sets the same token.
    Unrecorded(StorageError),
}

impl HintWritten {
    // Whether the next hint would fail the same way now, so the pass ends here.
    pub fn ends_the_pass(&self) -> bool {
        match self {
            HintWritten::Written | HintWritten::Refused(_) | HintWritten::Abandoned(_) => false,
            HintWritten::StoreApiUnavailable
            | HintWritten::WriteFailed(_)
            | HintWritten::Unrecorded(_) => true,
        }
    }

    // A refusal that waits is a warning alone; an abandoned hint is an Issue of its own; a failing Apple or ledger
    // reports at most once in a while.
    fn log(&self, environment: Environment, elapsed: Duration, recurring_failures: &Throttle) {
        let store = Store::AppStore.name();
        let environment = environment.name();
        let duration_ms = (elapsed.as_secs_f64() * 100_000.0).round() / 100.0;
        let (outcome, code, sqlstate) = match self {
            HintWritten::Written => ("written", None, None),
            HintWritten::StoreApiUnavailable => ("store_api_unavailable", None, None),
            HintWritten::WriteFailed(failure) => ("write_failed", Some(failure.code()), None),
            HintWritten::Refused(failure) => ("refused", Some(failure.code()), None),
            HintWritten::Abandoned(failure) => ("abandoned", Some(failure.code()), None),
            HintWritten::Unrecorded(failure) => {
                ("unrecorded", Some(failure.code()), failure.sqlstate())
            }
        };
        let sentry_event_id = match (self, code) {
            (HintWritten::Abandoned(_), Some(code)) => {
                telemetry::report(sentry::Level::Error, HINT, code, None)
            }
            (HintWritten::WriteFailed(_) | HintWritten::Unrecorded(_), Some(code)) => {
                recurring_failures.report(sentry::Level::Error, HINT, code, sqlstate)
            }
            _ => None,
        };
        // tracing fixes a line's level at the call, so the line is written once, placed below.
        macro_rules! hint_line {
            ($level:ident) => {
                tracing::$level!(
                    operation = HINT,
                    store,
                    environment,
                    outcome,
                    code,
                    sqlstate,
                    duration_ms,
                    sentry_event_id,
                    "{HINT}"
                )
            };
        }
        match self {
            HintWritten::Written => hint_line!(info),
            HintWritten::StoreApiUnavailable | HintWritten::Refused(_) => hint_line!(warn),
            HintWritten::WriteFailed(_)
            | HintWritten::Abandoned(_)
            | HintWritten::Unrecorded(_) => {
                hint_line!(error)
            }
        }
    }
}

// Requests a TEST notification from Apple and polls its delivery status until Apple records a send attempt or the
// poll budget runs out. Never exposes the token, signed payload, key, or raw Apple error body.
pub async fn run_test_notification(
    api: &dyn AppStoreApi,
    environment: Environment,
    max_polls: usize,
    poll_every: Duration,
) -> TestNotificationOutcome {
    let token = match api.request_test_notification(environment).await {
        Ok(token) => token,
        Err(failure) => return TestNotificationOutcome::RequestFailed(failure),
    };
    let polls = max_polls.max(1);
    let mut last_server_error = None;
    for poll in 0..polls {
        match api.test_notification_status(environment, &token).await {
            Ok(status) => {
                last_server_error = None;
                if let Some(last) = status.send_attempts.last() {
                    if last.result == Some(SendAttemptResult::Success) {
                        return TestNotificationOutcome::Delivered {
                            attempts: status.send_attempts.len(),
                        };
                    }
                    return TestNotificationOutcome::DeliveryFailed {
                        attempts: status.send_attempts.len(),
                        result: last.result,
                    };
                }
            }
            Err(ApiFailure::NotFound) => {
                last_server_error = None;
            }
            Err(ApiFailure::ServerError) => {
                last_server_error = Some(ApiFailure::ServerError);
            }
            Err(failure) => return TestNotificationOutcome::StatusFailed(failure),
        }
        if poll + 1 < polls {
            tokio::time::sleep(poll_every).await;
        }
    }
    match last_server_error {
        Some(failure) => TestNotificationOutcome::StatusFailed(failure),
        None => TestNotificationOutcome::Pending,
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TestNotificationOutcome {
    Delivered {
        attempts: usize,
    },
    DeliveryFailed {
        attempts: usize,
        result: Option<SendAttemptResult>,
    },
    Pending,
    RequestFailed(ApiFailure),
    StatusFailed(ApiFailure),
}

impl TestNotificationOutcome {
    pub fn succeeded(self) -> bool {
        matches!(self, TestNotificationOutcome::Delivered { .. })
    }

    pub fn log(self, environment: Environment, elapsed: Duration) {
        let store = Store::AppStore.name();
        let environment = environment.name();
        let duration_ms = (elapsed.as_secs_f64() * 100_000.0).round() / 100.0;
        let (outcome, code, send_attempt_result, attempts) = match self {
            TestNotificationOutcome::Delivered { attempts } => (
                "delivered",
                None,
                Some(SendAttemptResult::Success.code()),
                Some(attempts),
            ),
            TestNotificationOutcome::DeliveryFailed { attempts, result } => (
                "delivery_failed",
                None,
                result.map(SendAttemptResult::code),
                Some(attempts),
            ),
            TestNotificationOutcome::Pending => ("pending", None, None, Some(0)),
            TestNotificationOutcome::RequestFailed(failure) => {
                ("request_failed", Some(failure.code()), None, None)
            }
            TestNotificationOutcome::StatusFailed(failure) => {
                ("status_failed", Some(failure.code()), None, None)
            }
        };
        macro_rules! test_notification_line {
            ($level:ident) => {
                tracing::$level!(
                    operation = TEST_NOTIFICATION,
                    store,
                    environment,
                    outcome,
                    code,
                    send_attempt_result,
                    attempts,
                    duration_ms,
                    "{TEST_NOTIFICATION}"
                )
            };
        }
        match self {
            TestNotificationOutcome::Delivered { .. } => test_notification_line!(info),
            TestNotificationOutcome::Pending => test_notification_line!(warn),
            TestNotificationOutcome::DeliveryFailed { .. }
            | TestNotificationOutcome::RequestFailed(_)
            | TestNotificationOutcome::StatusFailed(_) => test_notification_line!(error),
        }
    }
}
