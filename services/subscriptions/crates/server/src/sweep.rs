use std::panic::AssertUnwindSafe;
use std::time::{Duration, Instant};

use domain::Store;
use futures_util::FutureExt;
use storage::{Ledger, StorageError};
use tokio::time::MissedTickBehavior;
use tokio_util::sync::CancellationToken;

use crate::store_doors::{AppStoreDoor, HintWritten, KeptOutcome, POSTPONED_FOR};
use crate::telemetry::Throttle;

const OPERATION: &str = "sweep.inbox";

// How often each step passes in the service (spec §7).
pub const EVERY: Duration = Duration::from_secs(60);

// Rows read at once. A pass reads page after page while each settles or postpones some of its rows.
const PAGE: i64 = 100;

// A failure that lasts reports once in this long, though every pass meets it.
const REPORTED_EVERY: Duration = Duration::from_secs(10 * 60);

// The sweep (spec §7): on start and every `every`, a minute in the service, step 1, the inbox, and beside it the hints
// claims owe the stores, each on a clock of its own. The hint step runs as a task of its own, so the inbox's step never
// waits on a store's API, however slowly it answers and however many hints it refuses. Steps 2 to 4 are not built.
pub struct Sweep {
    inbox: InboxSweep,
    store_hints: StoreHintSweep,
    every: Duration,
}

impl Sweep {
    pub fn new(ledger: Ledger, app_store: AppStoreDoor, every: Duration) -> Sweep {
        Sweep {
            inbox: InboxSweep::new(ledger, app_store.clone()),
            store_hints: StoreHintSweep::new(app_store),
            every,
        }
    }

    // Both steps pass until `stop`, and the sweep returns once both have.
    pub async fn run(self, stop: CancellationToken) {
        let Sweep {
            inbox,
            store_hints,
            every,
        } = self;
        let hints = tokio::spawn(store_hints.run(stop.clone(), every));
        inbox.run(stop, every).await;
        let _ = hints.await;
    }
}

// One step's passes: one at once, then one `every` after each, until `stop`, which also ends a pass between two rows.
// A pass that panics is reported by the panic hook, and the next one runs on time.
async fn passing<F: Future>(
    every: Duration,
    stop: &CancellationToken,
    mut pass: impl FnMut() -> F,
) {
    let mut ticks = tokio::time::interval(every);
    ticks.set_missed_tick_behavior(MissedTickBehavior::Delay);
    loop {
        tokio::select! {
            _ = ticks.tick() => {}
            () = stop.cancelled() => return,
        }
        let _ = AssertUnwindSafe(pass()).catch_unwind().await;
    }
}

// Step 1 (§7): each notification the inbox holds unsettled and not waiting after a failed attempt is applied through
// its door's own step 4, so none waits on its store's redelivery schedule (§5.1).
pub struct InboxSweep {
    ledger: Ledger,
    app_store: AppStoreDoor,
    reports: Throttle,
}

impl InboxSweep {
    pub fn new(ledger: Ledger, app_store: AppStoreDoor) -> InboxSweep {
        InboxSweep {
            ledger,
            app_store,
            reports: Throttle::every(REPORTED_EVERY),
        }
    }

    pub async fn run(self, stop: CancellationToken, every: Duration) {
        let (sweep, stop) = (&self, &stop);
        passing(every, stop, move || sweep.pass(stop)).await;
    }

    // One pass, written as one `sweep.inbox` line.
    pub async fn pass(&self, stop: &CancellationToken) -> Pass {
        let started = Instant::now();
        let mut pass = Pass::default();
        'pages: while !stop.is_cancelled() {
            let page = match self.ledger.unsettled(PAGE).await {
                Ok(page) => page,
                Err(failure) => {
                    pass.unread = Some(failure);
                    break;
                }
            };
            if page.is_empty() {
                break;
            }
            let mut moved = false;
            for kept in page {
                if stop.is_cancelled() {
                    break 'pages;
                }
                let outcome = match kept.notification().store {
                    Store::AppStore => self.app_store.apply_kept(&kept).await,
                    // No door of this build keeps such a notification, so none can be applied yet.
                    Store::PlayStore | Store::Paddle => {
                        match self
                            .ledger
                            .postpone(&kept, POSTPONED_FOR.as_millis() as i64)
                            .await
                        {
                            Ok(()) => {
                                pass.without_door += 1;
                                moved = true;
                                continue;
                            }
                            Err(failure) => KeptOutcome::Failed(failure),
                        }
                    }
                };
                moved |= !matches!(outcome, KeptOutcome::Failed(_));
                pass.count(outcome);
            }
            // Every row failed as the ledger answered: the next pass tries them again.
            if !moved {
                break;
            }
        }
        pass.log(started.elapsed(), &self.reports);
        pass
    }
}

// The hints claims owe the stores (§4), written through each store's door: the longest owed first, at most a page a
// pass, but for those waiting after a refusal. A failure every hint would meet now, as an API that does not answer,
// ends the pass and counts against no hint. Without a key for the store's API nothing is read.
pub struct StoreHintSweep {
    app_store: AppStoreDoor,
}

impl StoreHintSweep {
    pub fn new(app_store: AppStoreDoor) -> StoreHintSweep {
        StoreHintSweep { app_store }
    }

    pub async fn run(self, stop: CancellationToken, every: Duration) {
        let (sweep, stop) = (&self, &stop);
        passing(every, stop, move || sweep.pass(stop)).await;
    }

    // One pass; each hint written logs its own `store.hint` line.
    pub async fn pass(&self, stop: &CancellationToken) -> HintPass {
        let mut pass = HintPass::default();
        if !self.app_store.writes_store_hints() {
            return pass;
        }
        let hints = match self.app_store.store_hints_due(PAGE).await {
            Ok(hints) => hints,
            Err(failure) => {
                pass.unread = Some(failure);
                return pass;
            }
        };
        for hint in hints {
            if stop.is_cancelled() {
                break;
            }
            // Only the App Store has a door that writes hints; no other store's subscription binds by claim yet.
            if hint.lineage.store != Store::AppStore {
                continue;
            }
            let written = self.app_store.write_store_hint(&hint).await;
            let ends_the_pass = written.ends_the_pass();
            match written {
                HintWritten::Written => pass.written += 1,
                HintWritten::Refused(_) => pass.refused += 1,
                HintWritten::Abandoned(_) => pass.abandoned += 1,
                HintWritten::StoreApiUnavailable
                | HintWritten::WriteFailed(_)
                | HintWritten::Unrecorded(_) => pass.failed += 1,
            }
            if ends_the_pass {
                break;
            }
        }
        pass
    }
}

// What one hint pass came to: how many hints were written, refused and left to wait, refused a fifth time and
// abandoned, or met a failure that ended the pass.
#[derive(Debug, Default, PartialEq)]
pub struct HintPass {
    pub written: usize,
    pub refused: usize,
    pub abandoned: usize,
    pub failed: usize,
    pub unread: Option<StorageError>,
}

// What one pass came to: how many rows it met with each outcome, and the reportable ones by code.
#[derive(Debug, Default, PartialEq)]
pub struct Pass {
    pub applied: usize,
    pub settled: usize,
    pub awaiting: usize,
    pub duplicate: usize,
    pub failed: usize,
    // Kept notifications the ledger cannot take, settled: unsupported, or no longer verifiable.
    pub refused: usize,
    // Postponed: notifications of a store no door of this build serves.
    pub without_door: usize,
    // The first code of each kind the pass reports, in the order met.
    pub reported: Vec<(&'static str, Option<String>)>,
    pub unread: Option<StorageError>,
}

impl Pass {
    fn count(&mut self, outcome: KeptOutcome) {
        let reported = outcome.reported();
        if let (true, Some(code)) = (reported, outcome.code())
            && !self.reported.iter().any(|(met, _)| *met == code)
        {
            self.reported
                .push((code, outcome.sqlstate().map(str::to_owned)));
        }
        match outcome {
            KeptOutcome::Applied { .. } => self.applied += 1,
            KeptOutcome::Settled(_) => self.settled += 1,
            KeptOutcome::AwaitsStatus(_) => self.awaiting += 1,
            KeptOutcome::AlreadySettled => self.duplicate += 1,
            KeptOutcome::Failed(_) => self.failed += 1,
            KeptOutcome::Unsupported(_) | KeptOutcome::Unverifiable(_) => self.refused += 1,
        }
    }

    pub fn rows(&self) -> usize {
        self.applied
            + self.settled
            + self.awaiting
            + self.duplicate
            + self.failed
            + self.refused
            + self.without_door
    }

    fn log(&mut self, elapsed: Duration, reports: &Throttle) {
        if let Some(unread) = &self.unread {
            self.reported
                .insert(0, (unread.code(), unread.sqlstate().map(str::to_owned)));
        }
        let mut sentry_event_id = None;
        for (code, sqlstate) in &mut self.reported {
            let event_id =
                reports.report(sentry::Level::Error, OPERATION, code, sqlstate.as_deref());
            sentry_event_id = sentry_event_id.or(event_id);
        }
        let rows = self.rows();
        let nonzero = |count: usize| (count > 0).then_some(count);
        let (applied, settled, awaiting, duplicate, failed, refused, without_door) = (
            nonzero(self.applied),
            nonzero(self.settled),
            nonzero(self.awaiting),
            nonzero(self.duplicate),
            nonzero(self.failed),
            nonzero(self.refused),
            nonzero(self.without_door),
        );
        let code = self.reported.first().map(|(code, _)| *code);
        let sqlstate = self
            .reported
            .first()
            .and_then(|(_, sqlstate)| sqlstate.as_deref());
        let duration_ms = (elapsed.as_secs_f64() * 100_000.0).round() / 100.0;
        // tracing fixes a line's level at the call, so the line is written once, placed below.
        macro_rules! pass_line {
            ($level:ident) => {
                tracing::$level!(
                    operation = OPERATION,
                    rows,
                    applied,
                    settled,
                    awaiting,
                    duplicate,
                    failed,
                    refused,
                    without_door,
                    code,
                    sqlstate,
                    duration_ms,
                    sentry_event_id,
                    "{OPERATION}"
                )
            };
        }
        match () {
            _ if code.is_some() => pass_line!(error),
            // A pass that met nothing wrote nothing: one a minute, forever.
            _ if rows == 0 => pass_line!(debug),
            _ => pass_line!(info),
        }
    }
}
