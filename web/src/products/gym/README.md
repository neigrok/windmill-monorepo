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
`trainingReads.js` owns prefill, last time, records, the log's new bests (`ProgressRecords`, read by no web screen yet) and chart windows, and
`trainingHistory.js` composes history, reviews and screen documents.
Proposal values and decisions live in `domain/proposals.js`; their shared domain reads supply
the proposal screen and routine history. `domain/proposalDiff.js` reads a proposal as the blocks of field lines
its card shows; no web screen reads it yet. Removal receipts survive sync and restart until shown.
Catalogue reads combine `domain/seedExercises.js` with custom movements and seed-name overrides.
Routine drafts preserve target absences and order; saved-workout routines and frozen plans use the
values in `domain/routines.js`. Session decoding marks malformed plans as unreadable presentation
and preserves their JSON. Reads, set corrections and workout deletion remain available; the boundary
reports `gym-projection` without plan content.
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
use stored facts. The room also hides a delete while the engine is still storing the hold. A refused write
is a `GymRefusal` (`errors.js`) carrying the engine's code, the sentence a screen shows
and, for an overlap, the crossed session; `failureReason` finishes the sentence for any failure,
naming this device when its store could not keep the write and the network only for a REST door.

`TrainingHistory` composes typed domain reads into screen documents. The global seed catalogue
is outside sync and is checked against `schema.sql` in CI. Observation updates refresh local reads
and preserve history depth and editor drafts. Hook reads reuse results while the observation and
selector inputs stay unchanged; retry and clock refreshes invalidate them. Live sessions refresh at
their idle deadline. Each training read indexes sets by session and caches progress; record receipts
come from one chronological pass. Equal cent-load estimate scores keep the earliest record, and
bodyweight repetition records remain independent of assisted and loaded sets. Equipment and load-count overrides
resolve through the current catalogue for old and new sets. Dumbbell entries are per dumbbell; volume
multiplies by the configured one or two dumbbells. Other equipment counts the entered external load once. Estimates
retain the entered unit. Seed and custom names continue to identify the same movement throughout history. Set rows,
the fix sheet, workout corrections and past-workout entry name each load's basis from the catalogue: `kg each` for
a pair of dumbbells, `kg added` for bodyweight (`assisted` below zero on a row), `kg total` for barbells and the
plain unit for one dumbbell and otherwise; rows read in the display unit, typed fields in kilograms. Every volume
read takes the catalogue.
Creation and proposal chronology use the confirmed record's authoritative `rc` envelope. Command
predictions persist workout fields, correction removals and routine deaths from removal proposals
through offline restart. Set numbers arrive with server admission; a pending correction retains the
confirmed number until then. Import and correction plans preserve raw numbers and optional-key
presence; predictions and committed commands use their declared numeric quantum. Additive corrections use
`preserveOtherSets` to keep unnamed sets and concurrent changes. The server decides
admission. Workout forms preflight known conflicts in their commit transaction and retain the exact
submitted draft in `rack:workoutDrafts` until admission succeeds. Pending saves stay on the form;
refusals keep it editable, survive reload, and offer a route back from the log. Only acceptance shows
Saved or leaves the editor. HTTP refusals also recover through the engine's durable notices.
The composition is schema v8 with minimum v8. Other is an explicit one-load category; received signed weights remain unchanged. Existing creation selectors keep their approved choices. Routine `revision` and `createdEntries`, proposal
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

Every ask sends `routineReview: true`, so Coach drafts new routines for review instead of saving them. The review card
lists movements, targets in the display unit with their load basis, and equipment; a movement the log has not synced yet
reads "New movement" with no basis. Only **Save routine** confirms its persisted operation. Drafts survive interrupted
responses and thread history; confirmation retries retain the thread, request and operation identity. Saved state and its
receipt survive older streamed or paged snapshots. An unsaved confirmation answers inside its card: a missing draft (404)
or one the server cannot write (400, 422) closes the card's Save; signed out (401) asks for sign-in; a busy lease (409),
an unavailable engine (5xx) or a lost reply offers a retry without asserting the routine was not saved. New chat waits
while a routine saves and clears the card's note. `gym_coach_routine_confirm` reports only `outcome`: `started`, `saved`
(even after the room unmounts), `refused` (a 4xx answer) or `failed` (5xx, network or a reply naming another draft).
Only `failed` reports static `gym-coach-routine-confirm` to Sentry. Neither report contains routine or conversation content.
A step receipt says `drafted a routine for your review` on a turn that carries drafts, `created a routine` on an older
turn that saved directly, and `updated a movement` for a catalogue change Coach applied.

## Gates

Gym tests run through the existing `npm test`, `npm run test:sync` and `npm run build` scripts.
The full suite runs performance cases after the parallel test workers exit. Training reads cover
250 and 1,000 populated workouts, counting domain reads: unchanged renders do no recomputation,
and a replica change recomputes each read once. These render checks have no timing budget.
The gym domain claims every corpus file but `recovery-actions.json`, which does not apply since the web holds no
signed-out workout, and every vector in them, compared by JCS and with reversed record order; the weight ladder runs
directly too. Nothing remains pending.
The proposal review reads `outOfDate` from `ProposalState` through the runtime's proposal document, never from the
proposal's state alone: a pending proposal whose routine moved on the log, in an edit the log has not confirmed, or out
of sight has no Apply and no Turn this down, and says so where they stood. Harness tests exercise adopted-workout Finish, held set deletion and Undo,
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
