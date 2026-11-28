use std::num::NonZero;
use std::panic::resume_unwind;
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

mod server_api;

pub use server_api::{HintWritten, TestNotificationOutcome, run_test_notification};

use app_store::decoding::{self, Awaiting, Decoded};
use app_store::server_api::AppStoreApi;
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
use tokio::sync::{Semaphore, oneshot};
use tokio_util::task::TaskTracker;
use tracing::Instrument;
use uuid::Uuid;

use crate::telemetry::{self, Throttle};

const OPERATION: &str = "store.notification";

// The oldest signing a delivery may state. Apple sends a production notification again 1, 12, 24, 48 and 72 hours
// after each failed attempt, 157 hours in all, and may send it as first signed; a day and a half more covers Apple's
// own delays. Nothing checks revocation and validity is judged at signedDate, so this is also how long a leaf's key
// can still sign after its certificate expires.
const SIGNED_DATE_MAX_AGE: Duration = Duration::from_secs(8 * 24 * 60 * 60);

// How long a notification that waits on its subscription's status, or has no door in this build, stays out of the
// sweep: no sooner pass could change what it comes to.
pub const POSTPONED_FOR: Duration = Duration::from_secs(60 * 60);

// Applies at once, the door's and the sweep's together: half the ledger's connections, so keeping a notification
// always finds one. A burst waits here, in memory, rather than at the pool's 5 s bound for a connection.
const APPLIES_AT_ONCE: usize = Ledger::CONNECTIONS as usize / 2;

// A store's statement refused although its signature held, and a failure of its API, are worth knowing of at most this
// often: something outside the service decides how often they happen.
const REPORTED_EVERY: Duration = Duration::from_secs(10 * 60);

// The public doors through which the stores' statements reach the ledger (spec §5.1).
pub fn router(app_store: AppStoreDoor) -> Router {
    Router::new()
        .route(
            "/v1/stores/app-store/notifications",
            post(app_store_notification),
        )
        .with_state(app_store)
}

// The backend's doors that pull a store's state into the ledger (spec §5.2), which the internal listener serves
// behind its bearer secret.
pub fn internal_router(app_store: AppStoreDoor) -> Router {
    Router::new()
        .route("/internal/v1/app-store/claims", post(server_api::claim))
        .route(
            "/internal/v1/subscriptions/{subscriptionId}/refresh",
            post(server_api::refresh),
        )
        .with_state(app_store)
}

// The App Store's way into the ledger: its notifications on the public listener (§5.1), and on the internal one a
// claim and a refresh, whose state the door pulls from the App Store Server API (§5.2). The sweep applies what the
// door kept and left unsettled through the same step, and writes the hints a claim owes the App Store (§7).
#[derive(Clone)]
pub struct AppStoreDoor {
    ledger: Ledger,
    verifier: Arc<SignedDataVerifier>,
    // Absent while the deployment holds no in-app purchase key: nothing is pulled and no hint is written.
    api: Option<Arc<dyn AppStoreApi>>,
    clock: Arc<dyn Fn() -> SystemTime + Send + Sync>,
    deliveries: TaskTracker,
    // Verification is CPU work, run off the async workers and at most once per core, so payloads nobody signed
    // cost no more than the cores the service has.
    verifications: Arc<Semaphore>,
    applies: Arc<Semaphore>,
    refused_statements: Arc<Throttle>,
    // What can fail as often as Apple or the ledger stays down: a pull, a hint written or cleared.
    recurring_failures: Arc<Throttle>,
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
        api: Option<Arc<dyn AppStoreApi>>,
        clock: impl Fn() -> SystemTime + Send + Sync + 'static,
    ) -> AppStoreDoor {
        let cores = thread::available_parallelism().map_or(1, NonZero::get);
        AppStoreDoor {
            ledger,
            verifier: Arc::new(verifier),
            api,
            clock: Arc::new(clock),
            deliveries: TaskTracker::new(),
            verifications: Arc::new(Semaphore::new(cores)),
            applies: Arc::new(Semaphore::new(APPLIES_AT_ONCE)),
            refused_statements: Arc::new(Throttle::every(REPORTED_EVERY)),
            recurring_failures: Arc::new(Throttle::every(REPORTED_EVERY)),
        }
    }

    fn now(&self) -> domain::Instant {
        let millis = (self.clock)()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |since| since.as_millis() as i64);
        domain::Instant::from_epoch_millis(millis)
    }

    // Waits for every delivery under way to finish applying, once the listener accepts no more.
    pub async fn drain(&self) {
        self.deliveries.close();
        self.deliveries.wait().await;
    }

    pub fn deliveries_under_way(&self) -> usize {
        self.deliveries.len()
    }

    // §5.1 in order: steps 1 to 3 keep the notification, step 5 answers, then step 4 applies it. Once the inbox holds
    // it the answer is 200 whatever the apply does, since the sweep applies what the apply leaves unsettled (§7).
    async fn deliver(&self, body: &[u8], mut answer: oneshot::Sender<Response>) -> Delivery {
        let arrival = self.keep(body, &mut answer).await;
        let status = arrival.answer_status();
        let _ = answer.send(arrival.answer());
        let (environment, redelivered, payload_differs, outcome) = match arrival {
            Arrival::Left => (None, None, None, Outcome::Left),
            Arrival::Refused(refused) => {
                (refused.environment(), None, None, Outcome::Refused(refused))
            }
            Arrival::NotKept {
                environment,
                failure,
            } => (Some(environment), None, None, Outcome::NotKept(failure)),
            Arrival::Settled { environment } => {
                (Some(environment), Some(true), None, Outcome::Duplicate)
            }
            Arrival::Unsettled {
                environment,
                notification,
                kept,
                redelivered,
                payload_differs,
            } => {
                // A redelivery applies the notification the inbox holds: the record is what was kept first.
                let kept_outcome = match notification {
                    Some(notification) => self.apply(&notification, &kept).await,
                    None => self.apply_kept(&kept).await,
                };
                (
                    Some(environment),
                    Some(redelivered),
                    redelivered.then_some(payload_differs),
                    Outcome::Kept(kept_outcome),
                )
            }
        };
        Delivery {
            environment,
            redelivered,
            payload_differs,
            answered: status,
            outcome,
            refused_statements: self.refused_statements.clone(),
        }
    }

    // Steps 1 to 3: the bounded body as Apple posts it, the signed payload verified with the transaction and renewal
    // info inside it, then kept in the inbox under its notificationUUID, once.
    async fn keep(&self, body: &[u8], answer: &mut oneshot::Sender<Response>) -> Arrival {
        let Ok(AppStoreNotificationRequest { signed_payload }) = serde_json::from_slice(body)
        else {
            return Arrival::Refused(Refused::Body);
        };
        // A client that leaves before its payload is verified is owed nothing: the door keeps nothing of it.
        let verifying = signed_payload.clone();
        let verified = tokio::select! {
            verified = self.verified(move |verifier| verifier.verify_notification(&verifying)) => verified,
            () = answer.closed() => return Arrival::Left,
        };
        let notification = match verified {
            Ok(notification) => notification,
            Err(refusal) => return Arrival::Refused(Refused::Unverified(refusal)),
        };
        let environment = Environment::from(notification.environment);
        // The inbox keys the notification by its UUID, and no text the ledger keeps can hold NUL.
        if notification.notification_uuid.contains('\0') {
            return Arrival::Refused(Refused::NotificationUuid(environment));
        }
        let oldest = self
            .now()
            .epoch_millis()
            .saturating_sub(SIGNED_DATE_MAX_AGE.as_millis() as i64);
        if notification
            .signed_date
            .is_some_and(|signed_at| signed_at < oldest)
        {
            return Arrival::Refused(Refused::SignedTooLongAgo(environment));
        }

        let received = self
            .ledger
            .receive(storage::Notification {
                store: Store::AppStore,
                id: notification.notification_uuid.clone(),
                environment,
                signed_payload: signed_payload.clone(),
            })
            .await;
        match received {
            Ok(Receipt::Kept(kept)) => Arrival::Unsettled {
                environment,
                notification: Some(Box::new(notification)),
                kept,
                redelivered: false,
                payload_differs: false,
            },
            Ok(Receipt::Duplicate(Some(kept))) => {
                let payload_differs = kept.notification().signed_payload != signed_payload;
                Arrival::Unsettled {
                    environment,
                    notification: (!payload_differs).then(|| Box::new(notification)),
                    kept,
                    redelivered: true,
                    payload_differs,
                }
            }
            Ok(Receipt::Duplicate(None)) => Arrival::Settled { environment },
            Err(failure) => Arrival::NotKept {
                environment,
                failure,
            },
        }
    }

    // The verifier on the blocking pool, one payload per core at a time. The turn is the blocking task's own, so a
    // verification its caller stopped waiting for still holds it until it ends.
    async fn verified<T: Send + 'static>(
        &self,
        verify: impl FnOnce(&SignedDataVerifier) -> T + Send + 'static,
    ) -> T {
        let turn = self
            .verifications
            .clone()
            .acquire_owned()
            .await
            .expect("the door never closes its semaphores");
        let verifier = self.verifier.clone();
        let hub = Hub::current();
        let verified = tokio::task::spawn_blocking(move || {
            let verified = Hub::run(hub, || verify(&verifier));
            drop(turn);
            verified
        })
        .await;
        match verified {
            Ok(verified) => verified,
            Err(panicked) => resume_unwind(panicked.into_panic()),
        }
    }

    // Step 4 for a notification the inbox holds, read from the inbox's own copy: a redelivery whose bytes differ, or a
    // row the sweep found unsettled. The door's own rules held when it was kept and are not asked again.
    pub async fn apply_kept(&self, kept: &KeptNotification) -> KeptOutcome {
        let signed_payload = kept.notification().signed_payload.clone();
        match self
            .verified(move |verifier| verifier.verify_notification(&signed_payload))
            .await
        {
            Ok(notification) => self.apply(&notification, kept).await,
            // Kept under a root this deployment no longer trusts, or no longer readable: it states nothing to apply.
            Err(refusal) => {
                self.settle(kept, refusal.code(), KeptOutcome::Unverifiable)
                    .await
            }
        }
    }

    // Step 4: what the notification states, applied in the transaction that settles it, or the notification settled
    // with the code of why nothing applies. One whose state waits on a status pull is postponed (§8).
    async fn apply(&self, notification: &Notification, kept: &KeptNotification) -> KeptOutcome {
        let _turn = self
            .applies
            .acquire()
            .await
            .expect("the door never closes its semaphores");
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
                    Ok(Applied::Recorded { seqs, .. }) => {
                        KeptOutcome::Applied { events: seqs.len() }
                    }
                    Ok(Applied::Refused(refusal)) => KeptOutcome::Settled(refusal.name()),
                    Ok(Applied::AlreadySettled) => KeptOutcome::AlreadySettled,
                    Err(failure) => KeptOutcome::Failed(failure),
                }
            }
            Decoded::AwaitsStatus { awaiting, .. } => {
                match self
                    .ledger
                    .postpone(kept, POSTPONED_FOR.as_millis() as i64)
                    .await
                {
                    Ok(()) => KeptOutcome::AwaitsStatus(awaiting),
                    Err(failure) => KeptOutcome::Failed(failure),
                }
            }
            Decoded::Silent(silence) => {
                self.settle(kept, silence.code(), KeptOutcome::Settled)
                    .await
            }
            Decoded::Unsupported(unsupported) => {
                self.settle(kept, unsupported.code(), KeptOutcome::Unsupported)
                    .await
            }
        }
    }

    async fn settle(
        &self,
        kept: &KeptNotification,
        code: &'static str,
        outcome: fn(&'static str) -> KeptOutcome,
    ) -> KeptOutcome {
        match self.ledger.settle(kept, code).await {
            Ok(()) => outcome(code),
            Err(failure) => KeptOutcome::Failed(failure),
        }
    }
}

// What step 4 came to for a notification the inbox holds, by the door or by the sweep.
pub enum KeptOutcome {
    Applied { events: usize },
    // Settled with the code of why nothing applies: Apple's silence, or the domain's refusal.
    Settled(&'static str),
    // Settled with the code of what the adapter does not map (§8).
    Unsupported(&'static str),
    // Settled with the verifier's code: the inbox's copy does not verify any more.
    Unverifiable(&'static str),
    // Postponed until the subscription's status is pulled (§8).
    AwaitsStatus(Awaiting),
    // Settled by another delivery or the sweep first: nothing changed.
    AlreadySettled,
    // Left unsettled, for the sweep.
    Failed(StorageError),
}

impl KeptOutcome {
    pub fn label(&self) -> &'static str {
        match self {
            KeptOutcome::Applied { .. } => "applied",
            KeptOutcome::Settled(_) => "settled",
            KeptOutcome::Unsupported(_) => "unsupported",
            KeptOutcome::Unverifiable(_) => "unverifiable",
            KeptOutcome::AwaitsStatus(_) => "awaits_status",
            KeptOutcome::AlreadySettled => "duplicate",
            KeptOutcome::Failed(_) => "apply_failed",
        }
    }

    pub fn code(&self) -> Option<&'static str> {
        match self {
            KeptOutcome::Applied { .. } | KeptOutcome::AlreadySettled => None,
            KeptOutcome::Settled(code)
            | KeptOutcome::Unsupported(code)
            | KeptOutcome::Unverifiable(code) => Some(code),
            KeptOutcome::AwaitsStatus(awaiting) => Some(awaiting.code()),
            KeptOutcome::Failed(failure) => Some(failure.code()),
        }
    }

    pub fn sqlstate(&self) -> Option<&str> {
        match self {
            KeptOutcome::Failed(failure) => failure.sqlstate(),
            _ => None,
        }
    }

    // A failure, and what the ledger cannot take from a notification it holds: a type the adapter does not map, a copy
    // that does not verify any more, a latest transaction Apple's renewal info does not confirm, which stalls its
    // lineage until a status pull (§8).
    pub fn reported(&self) -> bool {
        matches!(
            self,
            KeptOutcome::Failed(_)
                | KeptOutcome::Unsupported(_)
                | KeptOutcome::Unverifiable(_)
                | KeptOutcome::AwaitsStatus(Awaiting::LatestUnconfirmed)
        )
    }
}

// What steps 1 to 3 came to, which decides the answer.
enum Arrival {
    // The client left before its payload was verified.
    Left,
    Refused(Refused),
    NotKept {
        environment: Environment,
        failure: StorageError,
    },
    // The inbox holds it, settled already.
    Settled {
        environment: Environment,
    },
    // The inbox holds it unsettled: a first delivery, or a redelivery of one not applied yet, which applies now. The
    // verified notification comes along when it is the inbox's copy.
    Unsettled {
        environment: Environment,
        notification: Option<Box<Notification>>,
        kept: KeptNotification,
        redelivered: bool,
        payload_differs: bool,
    },
}

impl Arrival {
    // Any 4xx or 5xx makes Apple send a notification again; Apple reads no body, and a refusal's code is the log's.
    fn answer_status(&self) -> StatusCode {
        match self {
            Arrival::Refused(_) => StatusCode::BAD_REQUEST,
            Arrival::NotKept { .. } | Arrival::Left => StatusCode::SERVICE_UNAVAILABLE,
            Arrival::Settled { .. } | Arrival::Unsettled { .. } => StatusCode::OK,
        }
    }

    fn answer(&self) -> Response {
        let status = self.answer_status();
        match self {
            Arrival::Refused(_) => (status, Json(json!({ "error": "refused" }))).into_response(),
            Arrival::NotKept { .. } | Arrival::Left => {
                (status, Json(json!({ "error": "unavailable" }))).into_response()
            }
            Arrival::Settled { .. } | Arrival::Unsettled { .. } => status.into_response(),
        }
    }
}

// Why the door kept nothing of a delivery. A payload refused before its signature held could be anyone's; one refused
// after it is the store's own statement, which the door refuses for what it says.
#[derive(Clone, Copy)]
enum Refused {
    Body,
    Unverified(verification::Refusal),
    NotificationUuid(Environment),
    SignedTooLongAgo(Environment),
}

impl Refused {
    fn code(self) -> &'static str {
        match self {
            Refused::Body => "body",
            Refused::Unverified(refusal) => refusal.code(),
            Refused::NotificationUuid(_) => "notification_uuid",
            Refused::SignedTooLongAgo(_) => "signed_too_long_ago",
        }
    }

    fn signed(self) -> bool {
        match self {
            Refused::Body => false,
            Refused::Unverified(refusal) => refusal.after_signature(),
            Refused::NotificationUuid(_) | Refused::SignedTooLongAgo(_) => true,
        }
    }

    // The verifier answers its refusals without the payload's environment, so only the door's own carry one.
    fn environment(self) -> Option<Environment> {
        match self {
            Refused::Body | Refused::Unverified(_) => None,
            Refused::NotificationUuid(environment) | Refused::SignedTooLongAgo(environment) => {
                Some(environment)
            }
        }
    }
}

enum Outcome {
    Left,
    Refused(Refused),
    // Answered 503, so the store sends it again.
    NotKept(StorageError),
    // Settled already when it arrived: nothing changed.
    Duplicate,
    Kept(KeptOutcome),
}

impl Outcome {
    fn label(&self) -> &'static str {
        match self {
            Outcome::Left => "left",
            Outcome::Refused(_) => "refused",
            Outcome::NotKept(_) => "not_kept",
            Outcome::Duplicate => "duplicate",
            Outcome::Kept(kept) => kept.label(),
        }
    }

    fn code(&self) -> Option<&'static str> {
        match self {
            Outcome::Left | Outcome::Duplicate => None,
            Outcome::Refused(refused) => Some(refused.code()),
            Outcome::NotKept(failure) => Some(failure.code()),
            Outcome::Kept(kept) => kept.code(),
        }
    }

    fn sqlstate(&self) -> Option<&str> {
        match self {
            Outcome::NotKept(failure) => failure.sqlstate(),
            Outcome::Kept(kept) => kept.sqlstate(),
            _ => None,
        }
    }
}

// What one delivery came to, written as its one `store.notification` line. The line names no notification, payload,
// transaction or account (§10).
struct Delivery {
    environment: Option<Environment>,
    redelivered: Option<bool>,
    payload_differs: Option<bool>,
    answered: StatusCode,
    outcome: Outcome,
    refused_statements: Arc<Throttle>,
}

impl Delivery {
    fn log(self, elapsed: Duration) {
        let Delivery {
            environment,
            redelivered,
            payload_differs,
            answered,
            ref outcome,
            ref refused_statements,
        } = self;
        let store = Store::AppStore.name();
        let environment = environment.map(Environment::name);
        let answered = answered.as_u16();
        let code = outcome.code();
        let sqlstate = outcome.sqlstate();
        let events = match outcome {
            Outcome::Kept(KeptOutcome::Applied { events }) => Some(*events),
            _ => None,
        };
        let failed = match outcome {
            Outcome::NotKept(_) => true,
            Outcome::Kept(kept) => kept.reported(),
            _ => false,
        };
        let refused_statement = matches!(outcome, Outcome::Refused(refused) if refused.signed());
        let sentry_event_id = match code {
            Some(code) if failed => {
                telemetry::report(sentry::Level::Error, OPERATION, code, sqlstate)
            }
            Some(code) if refused_statement => {
                refused_statements.report(sentry::Level::Warning, OPERATION, code, None)
            }
            _ => None,
        };
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
                    answered,
                    redelivered,
                    payload_differs,
                    events,
                    duration_ms,
                    sentry_event_id,
                    "{OPERATION}"
                )
            };
        }
        match outcome {
            _ if failed => notification_line!(error),
            _ if refused_statement => notification_line!(warn),
            Outcome::Kept(KeptOutcome::AwaitsStatus(_)) => notification_line!(warn),
            _ => notification_line!(info),
        }
    }
}
