use std::panic::AssertUnwindSafe;
use std::time::{Duration, Instant};

use domain::Store;
use futures_util::FutureExt;
use storage::{Ledger, StorageError};
use tokio::time::MissedTickBehavior;
use tokio_util::sync::CancellationToken;

use crate::store_doors::{AppStoreDoor, KeptOutcome, POSTPONED_FOR};
use crate::telemetry::Throttle;

const OPERATION: &str = "sweep.inbox";

const EVERY: Duration = Duration::from_secs(60);

// Rows read at once. A pass reads page after page while each settles or postpones some of its rows.
const PAGE: i64 = 100;

// A failure that lasts reports once in this long, though every pass meets it.
const REPORTED_EVERY: Duration = Duration::from_secs(10 * 60);

// Step 1 of the sweep (spec §7): on start and every minute, each notification the inbox holds unsettled and not
// waiting after a failed attempt is applied through its door's own step 4, so none waits on its store's redelivery
// schedule (§5.1). Steps 2 to 4 are not built.
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

    // Passes until `stop`, which also ends a pass between two rows. A pass that panics is reported by the panic hook,
    // and the next one runs on time.
    pub async fn run(self, stop: CancellationToken) {
        let mut ticks = tokio::time::interval(EVERY);
        ticks.set_missed_tick_behavior(MissedTickBehavior::Delay);
        loop {
            tokio::select! {
                _ = ticks.tick() => {}
                () = stop.cancelled() => return,
            }
            let _ = AssertUnwindSafe(self.pass(&stop)).catch_unwind().await;
        }
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
