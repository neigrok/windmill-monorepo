# History reads follow their jobs and the replica

**Status:** Reviewed, with one fix pass applied; `:gym` unit tests are green. Two `LogStateTests` that blocked the main looper with `runBlocking` while a page job waited for that looper deadlocked. They now launch and wait with a bound, and 16 similar UI-test sites were converted; production `HistoryReads` was unchanged by that fix. Not yet run on a device: leaving the log mid-page, the record page updating after a correction from another phone, and an open workout deleted elsewhere.

**Context:** history paging must survive disposal of its caller, movement records and progress must share a revision, and retained workout pages must follow authoritative deletion. Pull observation needs a cancellable lifecycle handle.

**Current implementation** (paths under `apps/android/`)
- `gym/…/store/HistoryReads.kt` registers one lazy paging Job before starting it, joins concurrent callers, and clears that job on completion or a seat change. A cancelled page does not cancel an active caller. Loading derives from that job.
- `presentation/Record.kt` carries record and movement progress in `MovementRead`. `HistoryReads.record` reads both through the seat's guarded dispatcher and routes unexpected failures through `gym.record`; the cancellation-reporting filter needs the follow-up below.
- `ui/RecordScreen.kt` retains a coherent read for its account and replica and re-reads on published engine revisions and readiness changes. `RecordRead.Superseded` preserves a good read during same-seat loading or revision churn; an initial superseded read keeps the existing Reading state.
- Retained workout details are held or gone. Reconciliation preserves device-held imports and unanswered sessions; authoritative absence marks only retained entries gone. Ordinary replica discard removes the retained entry; device-shelf discard still needs the WP-C handoff below.
- A standing workout page leaves once after a remote deletion, then says the existing line: “That workout is no longer on the log.”
- `observePulls()` returns one parent Job for both collectors, reuses it while active and replaces it after cancellation.

**Done when**
- Paging cancellation and concurrent callers, guarded record reads and account changes, retained deletion and import preservation, and observer cancellation/restart pass store regression tests.
- The open record page updates its recent sets and record tiles together after a remote correction; a remotely deleted workout leaves only when standing, exactly once.
- The orchestrator runs the Android compilation and test gates; device and local-stack verification establish the runtime behavior and telemetry delivery.

**Depends on:** WP-C/108 clears retention synchronously in the device-shelf branch of `WorkoutSession.discardWorkout`; that branch currently discards the import without `history.discarded`, so a retained shelf detail can become Gone after local discard. Package 113 (WP-G) adopts the `observePulls()` Job under its engine-observer lifecycle and updates `TrainingSeat.tried` to distinguish caller cancellation from a stray `CancellationException`. `Telemetry.unexpected` in `EngineTraining.kt` currently drops every `CancellationException`; reporting stray cancellation needs an owning-package follow-up. No edit to `TrainingStore` belongs to this package. Tree: `android-107-history-reads-follow-their-jobs-and-replica`.

**Structure observations**
- Read ownership belongs at the seat boundary; presentation accepts one coherent value rather than independently refreshed fragments.
- The required `Record.page` signature migration also touches `test/presentation/RecordTests.kt` and `test/store/SharedReadParityTests.kt`; those changes only adapt existing calls.
- Gone entries remain until the seat changes so a non-standing frame can react when it stands again.
- Refused-import retention coverage prepares adoption before signing in, matching `GymEngineSession`, and asserts the exact `gym.importSession` command before injecting the refusal. `EngineRoomFixture.select` handles the engine transition without preparing adoption.

**Review coverage**
- The 120-session concurrency regression distinguishes a shared page (100 rows) from two serialized reads (120 rows).
- The account-switch regression requires immediate Loading clearance, no old-account rows and a normal caller return; awaiting the cancelled page fails that last assertion.
- Three same-seat revision changes must return Superseded, and stray cancellation in an active caller must return NoAnswer; the previous implementation returns accountChanged or throws, respectively.
- The record-page regression covers initial loading, readiness without a revision change, and preservation of the last good read. The previous page draws the false account-change failure.
- Cancelled-scope cleanup, local discard and refused-import preservation are compatibility checks, not claims of failures in the original implementation.
- Completion cleanup is attached before starting the job so it also runs if the store scope was already cancelled and the body never starts.

**Bounded read checks**
- Record readiness, anonymous-seat checks and superseded-read classification are inside the failure boundary; `training.anonymous` reads the engine clock and can throw.
- Held-read tests release queued work in `finally` before closing their engine, even after failed assertions. Injected clock failures and revision churn reset in `finally`. Job waits use five-second bounds and every HistoryReads test has a 30-second limit.
- The full-suite hang comes from two LogStateTests blocking Robolectric’s main looper in `runOnIdle` while paging waits for a store job on that same looper. Both launch the request and pump Compose until the expected row count and settled foot arrive. Production paging remains store-owned.
- Pre-handback checks cover explicit imports, all eight cancellation guards, bounded job/page waits, guaranteed held-read cleanup, task indexing and handoffs, source-hash verification, and `git diff --check`. Direct compiler and test evidence is in `/private/tmp/rf107-review-jvm/`.

**UI main-looper audit**
- Robolectric/Compose tests never block the main looper on work that may resume on the main dispatcher. Store actions launch from the idle callback, then a bounded Compose wait pumps the looper; completed results are consumed on the test worker.
- Both paging sites in `LogStateTests` use five-second row-count/settled-foot waits. Other suspending sites in `ConnectedLogScreenTests`, `EngineNotesScreenTests`, `LoggerMovementWalkTests`, `LoggerScreenTests`, `NotesScreenTests`, `RecordStateTests`, `ReviewSheetTests`, `RoutineSaveTests`, `SessionScreenTests` and `StanceReadsTheAccountTests` use ten-second completion gates.
- `NotesScreenTests.onTheLog` runs on the test worker because it creates and connects another fixture. Worker-thread setup and already-completed-result `runBlocking` calls leave the main looper free.

Remaining `runBlocking` wrappers inside `runOnIdle` (paths under `apps/android/gym/src/test/kotlin/works/windmill/gym/ui/`):

| Sites | Why they remain safe |
| --- | --- |
| `NotesStateTests.kt:53,70,102`; `NotesLayoutTests.kt:73,74`; `NotesScreenTests.kt:119,352` | `EngineTraining.notes()` is a synchronous engine read with no suspension or dispatcher hop. |
| `ReviewSheetTests.kt:244,330,365,696` | `EngineTraining.proposal()` is a synchronous engine read. |
| `ReviewSheetTests.kt:828` | `RoutinesStore.proposal()` has a suspend signature but only reads the engine and a local map synchronously; it launches no job, takes no suspending lock and changes no dispatcher. |
| `SessionDiscardTests.kt:128` | `EngineTraining.session()` synchronously reads parsed details. |

- UI pre-handback verification: 20 targeted cases pass, all 11 changed UI test files compile with Kotlin/Compose 2.1.20 without warnings, source hashes match, no unsafe main-looper blocking remains in the audited sites, and `git diff --check` passes. Evidence: `/private/tmp/rf107-review-jvm/ui-results-final.json`, `compile-ui-current.log`, and `ui-current-sources.sha256`, with both LogState method logs beside them.
