use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use app_store::decoding::{self, Awaiting, Decoded};
use app_store::verification::{self, Notification, SignedDataVerifier};
use axum::body::Bytes;
use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use axum::{Json, Router};
use domain::{Environment, Store};
use sentry::{Hub, SentryFutureExt};
use serde::Deserialize;
use serde_json::json;
use storage::{Applied, KeptNotification, Ledger, Observed, Receipt, StorageError};
use tokio::sync::oneshot;
use tokio_util::task::TaskTracker;
use tracing::Instrument;
use uuid::Uuid;

use crate::telemetry;

const OPERATION: &str = "store.notification";

// The oldest signing a delivery may state. Apple sends a production notification again 1, 12, 24, 48 and 72 hours
// after each failed attempt, 157 hours in all, and may send it as first signed; a day and a half more covers Apple's
// own delays. Nothing checks revocation and validity is judged at signedDate, so this is also how long a leaf's key
// can still sign after its certificate expires.
const SIGNED_DATE_MAX_AGE: Duration = Duration::from_secs(8 * 24 * 60 * 60);

// The public doors through which the stores' statements reach the ledger (spec §5.1).
pub fn router(app_store: AppStoreDoor) -> Router {
    Router::new()
        .route(
            "/v1/stores/app-store/notifications",
            post(app_store_notification),
        )
        .with_state(app_store)
}

// App Store Server Notifications V2, from both environments: the environment is the verified payload's.
#[derive(Clone)]
pub struct AppStoreDoor {
    ledger: Ledger,
    verifier: Arc<SignedDataVerifier>,
    clock: Arc<dyn Fn() -> SystemTime + Send + Sync>,
    deliveries: TaskTracker,
}

// What Apple posts: the notification as one signed payload.
#[derive(Deserialize)]
struct AppStoreNotificationRequest {
    #[serde(rename = "signedPayload")]
    signed_payload: String,
}

// The delivery runs as a task of its own, so neither a client that leaves nor a request past its bound cancels it
// between keeping the notification and applying it. It answers before it applies, and fails to answer only by
// panicking.
async fn app_store_notification(State(door): State<AppStoreDoor>, body: Bytes) -> Response {
    let (answer, answered) = oneshot::channel();
    let delivery = {
        let door = door.clone();
        async move {
            let started = Instant::now();
            door.deliver(&body, answer).await.log(started.elapsed());
        }
    };
    door.deliveries
        .spawn(delivery.bind_hub(Hub::current()).in_current_span());
    answered.await.unwrap_or_else(|_| {
        let body = Json(json!({ "error": "internal" }));
        (StatusCode::INTERNAL_SERVER_ERROR, body).into_response()
    })
}

impl AppStoreDoor {
    pub fn new(
        ledger: Ledger,
        verifier: SignedDataVerifier,
        clock: impl Fn() -> SystemTime + Send + Sync + 'static,
    ) -> AppStoreDoor {
        AppStoreDoor {
            ledger,
            verifier: Arc::new(verifier),
            clock: Arc::new(clock),
            deliveries: TaskTracker::new(),
        }
    }

    // Waits for every delivery under way to finish applying, once the listener accepts no more.
    pub async fn drain(&self) {
        self.deliveries.close();
        self.deliveries.wait().await;
    }

    // §5.1 in order: steps 1 to 3 keep the notification, step 5 answers, then step 4 applies it. Once the inbox holds
    // it the answer is 200 whatever the apply does, since the sweep applies what the apply leaves unsettled (§7).
    async fn deliver(&self, body: &[u8], answer: oneshot::Sender<Response>) -> Delivery {
        let arrival = self.keep(body).await;
        let _ = answer.send(arrival.answer());
        match arrival {
            Arrival::Refused(refused) => Delivery {
                environment: None,
                redelivered: None,
                outcome: Outcome::Refused(refused),
            },
            Arrival::NotKept {
                environment,
                failure,
            } => Delivery {
                environment: Some(environment),
                redelivered: None,
                outcome: Outcome::NotKept(failure),
            },
            Arrival::Settled { environment } => Delivery {
                environment: Some(environment),
                redelivered: Some(true),
                outcome: Outcome::Duplicate,
            },
            Arrival::Unsettled {
                environment,
                notification,
                kept,
                redelivered,
            } => Delivery {
                environment: Some(environment),
                redelivered: Some(redelivered),
                outcome: self.apply(&notification, &kept).await,
            },
        }
    }

    // Steps 1 to 3: the bounded body as Apple posts it, the signed payload verified with the transaction and renewal
    // info inside it, then kept in the inbox under its notificationUUID, once.
    async fn keep(&self, body: &[u8]) -> Arrival {
        let (notification, signed_payload) = match self.verify(body) {
            Ok(verified) => verified,
            Err(refused) => return Arrival::Refused(refused),
        };
        let environment = match notification.environment {
            verification::Environment::Production => Environment::Production,
            verification::Environment::Sandbox => Environment::Sandbox,
        };
        let received = self
            .ledger
            .receive(storage::Notification {
                store: Store::AppStore,
                id: notification.notification_uuid.clone(),
                environment,
                signed_payload,
            })
            .await;
        let (kept, redelivered) = match received {
            Ok(Receipt::Kept(kept)) => (kept, false),
            Ok(Receipt::Duplicate(Some(kept))) => (kept, true),
            Ok(Receipt::Duplicate(None)) => return Arrival::Settled { environment },
            Err(failure) => {
                return Arrival::NotKept {
                    environment,
                    failure,
                };
            }
        };
        Arrival::Unsettled {
            environment,
            notification: Box::new(notification),
            kept,
            redelivered,
        }
    }

    fn verify(&self, body: &[u8]) -> Result<(Notification, String), Refused> {
        let AppStoreNotificationRequest { signed_payload } =
            serde_json::from_slice(body).map_err(|_| Refused::Body)?;
        let notification = self
            .verifier
            .verify_notification(&signed_payload)
            .map_err(Refused::Unverified)?;
        // The inbox keys the notification by its UUID, and no text the ledger keeps can hold NUL.
        if notification.notification_uuid.contains('\0') {
            return Err(Refused::NotificationUuid);
        }
        let now = (self.clock)()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |since| since.as_millis() as i64);
        let oldest = now.saturating_sub(SIGNED_DATE_MAX_AGE.as_millis() as i64);
        if notification
            .signed_date
            .is_some_and(|signed_at| signed_at < oldest)
        {
            return Err(Refused::SignedTooLongAgo);
        }
        Ok((notification, signed_payload))
    }

    // Step 4: what the notification states, applied in the transaction that settles it, or the notification settled
    // with the code of why nothing applies. One whose state waits on a status pull stays unsettled (§8).
    async fn apply(&self, notification: &Notification, kept: &KeptNotification) -> Outcome {
        match decoding::decode(notification) {
            Decoded::Observation {
                observation,
                account_token,
            } => {
                let observed = Observed {
                    observation,
                    // §4: an appAccountToken that is not a UUID names no account.
                    hint: account_token.and_then(|token| Uuid::parse_str(token.expose()).ok()),
                    claim: None,
                    pulled_at: None,
                };
                match self.ledger.apply_notification(kept, observed).await {
                    Ok(Applied::Recorded { seqs, .. }) => Outcome::Applied { events: seqs.len() },
                    Ok(Applied::Refused(refusal)) => Outcome::Settled(refusal.name()),
                    Ok(Applied::AlreadySettled) => Outcome::Duplicate,
                    Err(failure) => Outcome::ApplyFailed(failure),
                }
            }
            Decoded::AwaitsStatus { awaiting, .. } => Outcome::AwaitsStatus(awaiting),
            Decoded::Silent(silence) => self.settle(kept, silence.code(), Outcome::Settled).await,
            Decoded::Unsupported(unsupported) => {
                self.settle(kept, unsupported.code(), Outcome::Unsupported)
                    .await
            }
        }
    }

    async fn settle(
        &self,
        kept: &KeptNotification,
        code: &'static str,
        outcome: fn(&'static str) -> Outcome,
    ) -> Outcome {
        match self.ledger.settle(kept, code).await {
            Ok(()) => outcome(code),
            Err(failure) => Outcome::ApplyFailed(failure),
        }
    }
}

// What steps 1 to 3 came to, which decides the answer.
enum Arrival {
    Refused(Refused),
    NotKept {
        environment: Environment,
        failure: StorageError,
    },
    // The inbox holds it, settled already.
    Settled {
        environment: Environment,
    },
    // The inbox holds it unsettled: a first delivery, or a redelivery of one not applied yet, which applies now.
    Unsettled {
        environment: Environment,
        notification: Box<Notification>,
        kept: KeptNotification,
        redelivered: bool,
    },
}

impl Arrival {
    // A refusal is the store's to see; any 4xx or 5xx makes Apple send the notification again.
    fn answer(&self) -> Response {
        match self {
            Arrival::Refused(refused) => {
                let body = Json(json!({ "error": refused.code() }));
                (StatusCode::BAD_REQUEST, body).into_response()
            }
            Arrival::NotKept { .. } => {
                let body = Json(json!({ "error": "unavailable" }));
                (StatusCode::SERVICE_UNAVAILABLE, body).into_response()
            }
            Arrival::Settled { .. } | Arrival::Unsettled { .. } => StatusCode::OK.into_response(),
        }
    }
}

// Why the door kept nothing of a delivery: what a log line and the answer carry about it.
#[derive(Clone, Copy)]
enum Refused {
    Body,
    Unverified(verification::Refusal),
    NotificationUuid,
    SignedTooLongAgo,
}

impl Refused {
    fn code(self) -> &'static str {
        match self {
            Refused::Body => "body",
            Refused::Unverified(refusal) => refusal.code(),
            Refused::NotificationUuid => "notification_uuid",
            Refused::SignedTooLongAgo => "signed_too_long_ago",
        }
    }
}

enum Outcome {
    Refused(Refused),
    // Answered 503, so the store sends it again.
    NotKept(StorageError),
    // Settled already, by an earlier delivery or the sweep: nothing changed.
    Duplicate,
    Applied { events: usize },
    // Settled with the code of why nothing applies: Apple's silence, or the domain's refusal.
    Settled(&'static str),
    // Settled with the code of what the adapter does not map (§8).
    Unsupported(&'static str),
    // Kept unsettled until the subscription's status is pulled (§8).
    AwaitsStatus(Awaiting),
    // Kept unsettled, for the sweep.
    ApplyFailed(StorageError),
}

impl Outcome {
    fn label(&self) -> &'static str {
        match self {
            Outcome::Refused(_) => "refused",
            Outcome::NotKept(_) => "not_kept",
            Outcome::Duplicate => "duplicate",
            Outcome::Applied { .. } => "applied",
            Outcome::Settled(_) => "settled",
            Outcome::Unsupported(_) => "unsupported",
            Outcome::AwaitsStatus(_) => "awaits_status",
            Outcome::ApplyFailed(_) => "apply_failed",
        }
    }

    fn code(&self) -> Option<&'static str> {
        match self {
            Outcome::Refused(refused) => Some(refused.code()),
            Outcome::NotKept(failure) | Outcome::ApplyFailed(failure) => Some(failure.code()),
            Outcome::Duplicate | Outcome::Applied { .. } => None,
            Outcome::Settled(code) | Outcome::Unsupported(code) => Some(code),
            Outcome::AwaitsStatus(awaiting) => Some(awaiting.code()),
        }
    }

    fn sqlstate(&self) -> Option<&str> {
        match self {
            Outcome::NotKept(failure) | Outcome::ApplyFailed(failure) => failure.sqlstate(),
            _ => None,
        }
    }

    // A failure, a notification the adapter does not map, and a latest transaction Apple's renewal info does not
    // confirm, which stalls its lineage until a status pull (§8). A refusal is never an Issue (§10).
    fn reported(&self) -> bool {
        matches!(
            self,
            Outcome::NotKept(_)
                | Outcome::ApplyFailed(_)
                | Outcome::Unsupported(_)
                | Outcome::AwaitsStatus(Awaiting::LatestUnconfirmed)
        )
    }
}

// What one delivery came to, written as its one `store.notification` line. The line names no notification, payload,
// transaction or account (§10).
struct Delivery {
    environment: Option<Environment>,
    redelivered: Option<bool>,
    outcome: Outcome,
}

impl Delivery {
    fn log(self, elapsed: Duration) {
        let Delivery {
            environment,
            redelivered,
            ref outcome,
        } = self;
        let store = Store::AppStore.name();
        let environment = environment.map(Environment::name);
        let code = outcome.code();
        let sqlstate = outcome.sqlstate();
        let events = match outcome {
            Outcome::Applied { events } => Some(*events),
            _ => None,
        };
        let sentry_event_id = code
            .filter(|_| outcome.reported())
            .and_then(|code| telemetry::report(OPERATION, code, sqlstate));
        let duration_ms = (elapsed.as_secs_f64() * 100_000.0).round() / 100.0;
        // tracing fixes a line's level at the call, so the line is written once, placed below.
        macro_rules! notification_line {
            ($level:ident) => {
                tracing::$level!(
                    operation = OPERATION,
                    store,
                    environment,
                    outcome = outcome.label(),
                    code,
                    sqlstate,
                    redelivered,
                    events,
                    duration_ms,
                    sentry_event_id,
                    "{OPERATION}"
                )
            };
        }
        match outcome {
            _ if outcome.reported() => notification_line!(error),
            Outcome::Refused(_) | Outcome::AwaitsStatus(_) => notification_line!(warn),
            _ => notification_line!(info),
        }
    }
}
