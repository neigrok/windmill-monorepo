# Web gym sync

The signed-in gym observes `self/gym` through the shell's browser engine, and every gym write goes
through it: `useGymApi()` answers the engine API, or nothing before the engine is bound. Sessions and
their sets are read-only live mirrors; backfills use `gym.importSession`. Routine and note editors
retain their opening values and guard touched fields through kit drafts. A routine name, movement
name or note title is written NFC-normalised, trimmed and at most 60 code points, and a blank one is
refused before it is written;
a rename to the name the store holds writes nothing. Deletes commit durable held deaths, and the engine owns
their release and restart. The room draws their Undo from the engine's `undoOffers`, so a delete
still held when the room is drawn again is offered with the deadline it already had. Coach and the
workout and log shares use their REST doors in `gymApi.js`; a Coach conversation delete is held on the
room's own clock, and when the room unmounts or the document hides it is dropped unsent and the
conversation stays. The account gate remains in `GymApp`.

Every local gym read and write uses the domain kit through `gymRuntime.js`. Training entities and rules live in
`domain/training.js`; `trainingActions.js` owns imports, corrections, set deletion and the four phone-only
actions. The web remains a live mirror and does not call StartSession, AppendSet, FinishSession or DiscardSession.
Correction and backfill helpers parse fields and arrange draft rows into domain inputs.
`trainingReads.js` owns prefill, last time, records and chart windows, and
`trainingHistory.js` composes history, reviews and screen documents.
Proposal values and decisions live in `domain/proposals.js`; their shared domain reads supply
the proposal screen and routine history. Removal receipts survive sync and restart until shown.
Catalogue reads combine `domain/seedExercises.js` with custom movements and seed-name overrides.
Routine drafts preserve target absences and order; saved-workout routines and frozen plans use the
values in `domain/routines.js`. The plan decoder refuses malformed shapes; the read boundary reports
`gym-projection` and omits the malformed plan from the read while retaining the workout facts and stored data.
Notes mask pending deletes from the kit's `drawn` list and close an editor when its note is hidden.
Undo restores the row. Capacity and empty-room stance come from `stored`. Their guarded drafts save only
touched fields, with character and byte bounds declared in `domain/notes.js`. Moves write only the
selected note's order key; a drop in its drawn place writes nothing. Coach saves reuse a stored
note with the same normalised words and count held deletes against capacity.
The bodyweight stance reads
`stored`; its reading, dots and gaps read `drawn`, with the room's pending deletes hidden before storage
settles. Reads refresh with the observation or selector inputs, at local midnight and when the tab resumes. Bodyweight labels and fields
take the current preference unit directly; changing units preserves the amount in an open field.
Its saves validate the local day and kilograms, stamp
the commit moment and retire a held delete of that day. Preference saves write only touched client fields
(units, confirmation haptic and sound); rest settings are read-only.

Training facts use the engine's drawn view: held session and set deletes leave records, last times,
progress and history immediately, and Undo restores them. Account capacity and empty-room stance
use stored facts. The room also hides a delete while the engine is still storing the hold. A write the log refuses before
storing it is a `GymRefusal` (`errors.js`) carrying the engine's code, the sentence a screen shows
and, for an overlap, the crossed session; `failureReason` finishes the sentence for any failure,
naming this device when its store could not keep the write and the network only for a REST door.

`TrainingHistory` composes typed domain reads into screen documents. The global seed catalogue
is outside sync and is checked against `schema.sql` in CI. Observation updates refresh local reads
and preserve history depth and editor drafts. Hook reads reuse results while the observation and
selector inputs stay unchanged; retry and clock refreshes invalidate them. Live sessions refresh at
their idle deadline. Each training read indexes sets by session and caches progress; record receipts
come from one chronological pass. Equal cent-load estimate scores keep the earliest record, and
bodyweight repetition records remain independent of assisted and loaded sets.
Creation and proposal chronology use the confirmed record's authoritative `rc` envelope. Command
predictions persist workout fields, correction removals and routine deaths from removal proposals
through offline restart. Set numbers arrive with server admission; a pending correction retains the
confirmed number until then. Import and correction plans preserve raw numbers and optional-key
presence; predictions and committed commands use their declared numeric quantum. Additive corrections use
`preserveOtherSets` to keep unnamed sets, their kinds and concurrent changes. Overlap, future-time
and open-session admission are server-decided.
The composition is schema v6 with minimum v4. Routine `revision` and `createdEntries`, proposal
`baseRevision`, `baseName` and `changeCount`, and note `updatedAt` come from server-authored registers.
Editors never write them. Note positions are zero-based; a move writes the moved note's `ord` alone,
right after the row drawn above it. The independent `routineCreation.snapshot` record is read-only
and survives routine deletion.

## Observability

`gymRuntime.js` owns the gym telemetry boundary. Engine-backed writes emit first-party `gym_action` events with allowlisted `operation` and
`outcome` only. Operations cover routine create/save, exercise create/rename, preferences save,
note save/reorder, bodyweight save, set/session correction, session import, proposal apply/dismiss,
delete/Undo and refusal. Outcomes are `saved-local`, `unchanged`, `failed`, `held`, `undone`,
`closed`, `refused`. A local save does not claim server admission. Unexpected boundary failures
report a static `gym-<operation>` to Sentry, without exceptions, IDs, names, bodies or field values;
a `GymRefusal` is expected and reports nothing, and a store failure is the engine's to report.
Engine telemetry owns transport, storage, authentication and admission failures. Refusal content stays on the device; the room announces
unresolved notices.

## Gates

Gym tests run through the existing `npm test`, `npm run test:sync` and `npm run build` scripts.
The full suite runs performance cases after the parallel test workers exit. Training reads cover
250 and 1,000 populated workouts, requiring unchanged renders to reuse their results within 25 ms CPU.
The gym domain claims all 13 corpus files and 587 vectors, compared by JCS and with reversed record
order. Training reads claim 112 vectors (including 36 promoted REST samples and 22 regression cases),
proposals claim 44, units claim 57 and the weight ladder claims 36. Training actions claim 126;
nothing remains pending. Harness tests exercise adopted-workout Finish, held set deletion and Undo,
failed commits, command refusals, raw receipt replay and additive correction recovery.
Screen tests run over a real browser engine for a signed-in account (`gymAccount` in
`test/products/gym/harness.mjs`) and assert what the account still owes the server. Shared training
reads run on web, Swift and Kotlin. The local stack checks domain reads over an actual disposable
backend account and persisted browser-engine observations. Chromium acceptance has twelve checks: a phone replica's `gym.start`, set and `gym.finish`
pushes arrive live; web routine edits, backfills, additive recovery, weigh-ins and unit changes converge; a held weigh-in delete can be
undone; proposal dismissal and routine removal settle with receipts; the cached log survives an offline reload.
Seven product operations reach event intake and sync writes emit their log.
Run domain-read and local-stack Playwright checks with:

```
node web/test/products/gym/stack.mjs /absolute/backend/build
```

The runner uses ports 8094/5181 and a unique database, applies `schema.sql`, and starts the server.
`WM_E2E_PORT`, `WM_E2E_WEB_PORT` and `WM_E2E_DB_PREFIX` select isolated backend/web ports and a database prefix.
It seeds the fixture through the doors production uses: MCP under a personal key for the custom
movement, the agent's routine and both proposals, and a phone replica for everything else. It
stops owned listeners by port and drops the database even on failure. A full-stack workflow
invocation requires CI configuration outside web; fixture and stalled-request/exit/crash/timeout/
shutdown tests already run in ordinary CI.
