# Web gym sync

The gym room draws from whichever replica the shell's browser engine holds (`useSyncReplica`), and every gym write goes
through it: `useGymApi()` answers the API over that replica, bound or anon, from the moment the engine opens, and
nothing before. `GymApp` opens the training room on a bound replica without waiting for the account's answer, its
session paused or not; a paused session is offered sign-in by the account seat beside the room. The room is keyed by the
replica's binding, so a re-identify keeps it and what is typed in it. While the shell has settled an account the
engine's replica is not bound to (another tab signed in someone else), the room is `Opening` until the shell catches up.
Signed out, the room is the room on the browser's anon replica (web-device-parity §3, boards WD8): routines, movements,
workouts and weigh-ins, saying nothing of where the work is kept (R-6). `seat.js`'s `useGymSeat()` answers the seat:
`signedIn`, an account the shell has settled (auth `status` is `signed-in`: online, or offline from its last answer) that
the drawn replica is bound to, and `anonymous`, the browser's own copy. Shares, log shares, the connected log, Coach and
Notes wait for `signedIn`; until then Coach's tab, its History and Notes are Coach's door, a sentence and the shell's
sign-in (WD8.3), or `Opening` while the account has yet to answer, and no share is offered. The past-workout form and a
finished workout's corrections are server commands a signed-out replica never sends (R-5): `anonymous`, their doors are
not drawn (Add past workout, Edit workout, a finished set's Fix, a routine's Log past), and their routes draw The log. Sessions and
their sets are read-only live mirrors; backfills use `gym.importSession`. Routine and note editors
retain their opening values and guard touched fields through kit drafts. A routine name, movement
name or note title is written NFC-normalised, trimmed and at most 60 code points, and a blank one is
refused before it is written;
a rename to the name the store holds writes nothing. Deletes commit durable held deaths, and the engine owns
their release and restart. The room draws their Undo from the engine's `undoOffers`, so a delete
still held when the room is drawn again is offered with the deadline it already had. The workout and log
shares use their REST doors in `gymApi.js`; a Coach conversation delete is held on the room's own clock, then
deletes the conversation's records, and when the room unmounts or the document hides it is dropped unsent and the
conversation stays.

Every local gym read and write uses the domain kit through `gymRuntime.js`. Training entities and rules live in
`domain/training.js`; `trainingActions.js` owns imports, corrections, set deletion and the four phone-only
actions. The web remains a live mirror and does not call StartSession, FinishSession or DiscardSession; AppendSet runs
only before the seat changes, below.
Before the shell signs in or finishes a sign-out (`routes.sync.seatWillChange`), `saveSignedOutWorkouts` saves each
workout the anon replica holds for adoption (`AdoptWorkout` in `prepare`, kept under the device row `rack:adoption`): a
finished one becomes one import that supersedes its chain, an open one keeps a start that does not join, and an open one's
sets the replacing start folded are recorded again with it (`AppendSet` as recorded). Each workout is one composed act on
the API's binding, so it lands whole before the seat changes, or not at all when the seat moved first; one the domain
refuses or that fails leaves the others to land, and a seat that moved ends the hook. A bound replica holds none. The web
holds no rack, so nothing of one is written first.
The sign-in that follows (`routes.sync`): the saved workouts and the form drafts the account refused are gym's pending
device work (`gymDeviceWork`; a pending draft's queued command is counted already), merged entry by entry into a dormant replica's own at a sign-in that joins it, the
account's standing on an entry both hold (`adoptGymDeviceRows`). An account holding training of its own asks the shell's
question (WD9), which counts the browser's workouts, routines and weigh-ins with what names each (`signInWork`) and tells
the decision; work naming none of them, a movement or a setting, joins without a question (`adoptionAnswer`). From the
engine's opening (`prepare`, `watchBrowserCopies`), whenever gym's scope moves on a bound replica holding copies, each
proposal a copy held is issued again once the account holds its workout and every copy the account took whole is let go.
A copy the account has not taken waits in The log's In this browser (`recovery/InThisBrowser.jsx`, WD9.3), signed in only,
at the head of the index from 801px and above the filters below: its title, when and how many sets, the review's reason
(`WorkoutRecovery.review` over the engine's notices) in one sentence and its one answer, Keep as finished while the
account's workout is open (`AdoptWorkout` keep, an open copy finished at its last set) or Add to your log once only the
retry stands (`AdoptWorkout` restart or keep, or a landed workout's stranded sets by `RecoverStrandedSets`), each putting
away the notices it answers; *Adding…* while one is on its way; and Discard in its menu, held with Undo on the room's clock
before `DiscardSignedOutWorkout`. A start that lost a race with another device's (spec §4, WD4.3) is refused
`session-open` with its sets in its notice: the room saves them as a copy (`SaveRefusedStart`) and says so once, with
View sets; a start that holds no set loses nothing and its notice is put away. The room's notice voice leaves every notice
a copy owns, and every refused start, to In this browser.
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
use stored facts. The room also hides a delete while the engine is still storing the hold. Until the replica's first
pull of `self/gym` completes (the engine's `firstPullComplete`, which every read's `firstPullComplete()` answers), the
copy may hold part of the account's history: the runtime reads no last time (`lastTime` answers null, `lastSets` none)
and the domain claims no record, and nothing is drawn in their place. A refused write
is a `GymRefusal` (`errors.js`) carrying the engine's code, the sentence a screen shows
and, for an overlap, the crossed session; `failureReason` finishes the sentence for any failure,
naming this device when its store could not keep the write and the network only for a REST door. A write whose replica
changed under the room, a sign-in or a sign-out having moved the engine to another replica or bound the anon one in
place, is refused `not-writable`, in words that ask no one to sign in; the API stands on the engine's binding, so a
re-identify of the account's replica refuses nothing.

Coach's records as the engine holds them live in `domain/coach/`: `conversation.js` holds the `thread` and `message`
entities, a call's record and the receipt the calls derive; `turn.js` the writes of a turn (open, text, round, end,
withdraw, a conversation's delete), the `runningTurn` and `runningRound` mark and the `picture:<id>` rows, and
`ForgetCoachAtSignOut`. `runAbility.js` is the replica executor: `RunAbility` gates a call against `catalog/3` and
the bounds strict mode cannot state, runs the ability of `abilityReads.js` or `abilityWrites.js` over the gym domain, and
records the call on the Coach message in the same write; `RunAbility.ordinal` names a new record from the turn's id
and the admitted minting calls before it, as the server's gate does; `RecordShareCall` records a share the Share door made.

The Coach room runs each turn in the browser (`coach/`). `CoachTurns` admits a send, opens its records, and runs the turn on
the Coach engine (`platform/agent`) with `GymTurnHost` and `GymProfile`, each model round a call to the AI service
(`platform/ai`); the host writes the text about once a second and the round's mark, runs each call through
`RunAbility` or a share through the Share door, and ends, withdraws or recovers the turn, every write under the seat the
turn opened on, the engine's binding, which a re-identify keeps and an account change ends. One turn
runs at a time in a browser across its tabs, the mark refusing a second; a tab that opens on a turn in its last round
recovers its answer; a send opens under a browser-wide lock until the engine holds the turn's own, so another tab's
recovery never meets a fresh turn. Pictures stay in the browser's `picture:<id>` rows, their model copy uploaded once a
turn. As a sign-out begins (`routes.sync.signOutBegins`) a running turn ends `interrupted`; the mark and the pictures no
unsent question names go in the write that finishes the sign-out (`routes.sync.signOutForgets`), so a cancelled one keeps
them. Whenever the page's account changes, in this tab or another, `CoachTurns.leaveSeat` drops the pass, the allowance,
the field's words and a question taken back, and the room starts Coach afresh for the new seat. The server Coach's
storage under `windmill.gym.coach.` and its photos' database are deleted at gym boot and at sign-out
(`coach/retiredCoach.js`). `conversations.js` reads History and a conversation from the records, so a
phone's conversations open here as the browser's do.

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

## Localization

Gym copy lives under `gym.<area>.*`, one area per screen or module (`gym.log.*`, `gym.routines.*`, `gym.coach.*`,
`gym.landing.*`, `gym.landingHead.*`, `gym.product.*` for the shell registry's words, `gym.common.*` for a word
several screens share). The files the brand root loads — the route table,
the landing head, the brand root's scenes and the runtime the route table's sync hooks import — read `t` from
`i18n/entry/index.js`, with their copy in `i18n/entry/en.json`; the home card reads `i18n/app/`, the settings
section and what it imports `i18n/settings/`, the landing page and its scenes `i18n/landing/`; every other file
reads `i18n/index.js` and `i18n/en.json`. A shared phrase keeps its exported constant (`COACH_TITLE`, `UNDO_LABEL`), whose value is a `t()`
call. A weight is a number and a word: the caller formats the number and passes the wire unit, and the message
spells it, `{weight} {unit, select, lb {lb} other {kg}}`; `unitSymbol` in `units.js` shows the symbol alone. The
day labels in `log.js` take weekday and month names and their order from the catalog, never from the system
locale; the date jump and the history filter read month names from `Intl` in English. Exercise, routine and note
names, Coach answers and server refusals are shown as received. The domain's display strings (`Readout` in
`domain/trainingReads.js`, `ProposalDiff` in `domain/proposalDiff.js`) are pinned by the shared vectors and are not
in the catalog.

## Observability

`gymRuntime.js` owns the gym telemetry boundary. Engine-backed writes emit first-party `gym_action` events with allowlisted `operation` and
`outcome` only, and a `refused` one also `code`: `not-writable` when the replica moved under the room, `domain` when the
gym's rules refused it, this device's or the server's. Operations cover routine create/save, exercise create/rename, preferences save,
note save/reorder, bodyweight save, set/session correction, session import, proposal apply/dismiss,
delete/Undo, refusal and the save of signed-out workouts for adoption (`workout-adopt`, told once when it saved something
and once for each workout refused or failed, and never stopping the seat change). Outcomes are `saved-local`, `unchanged`, `failed`, `held`, `undone`,
`closed`, `refused`. A copy's recovery ends in one `gym_recovery` with `outcome` (`saved` for a start that lost a race,
`kept`, `retried`, `discarded`, `refused`, `failed`) and the review's `reason`; one that fails, a save of a refused start
that fails and a held proposal the account refuses to issue again report `gym-workout-recover`. The sign-in question tells
`gym_signin_decision` with `choice` (`add`, `discard`, `cancel`) and `count_bucket`, the workouts, routines and weigh-ins
it counted as a bucket. A local save does not claim server admission. Unexpected boundary failures
report a static `gym-<operation>` to Sentry with the error's stack frames, never its message, IDs, names, bodies or field values;
a `GymRefusal` is expected and reports nothing, and a store failure is the engine's to report.
Engine telemetry owns transport, storage, authentication and admission failures. Refusal content stays on the device; the room announces
unresolved notices.

A routine Coach creates exists the moment its call commits, as the lifter's own New routine would; its card links the
routine. A routine proposal stands under the answer whose call made it, with Reject and Apply, the lifter's gestures and
the server's commands; a workout proposal a phone made stands as a read-only row.

## Gates

Gym tests run through the existing `npm test`, `npm run test:sync` and `npm run build` scripts.
The full suite runs performance cases after the parallel test workers exit. Training reads cover
250 and 1,000 populated workouts, counting domain reads: unchanged renders do no recomputation,
and a replica change recomputes each read once. These render checks have no timing budget.
The gym domain claims every corpus file but those of catalog/2, the server's turn wire and the words Coach's model
reads, which the web never speaks or which are no vectors; it runs every vector it claims, compared by JCS and with
reversed record order; the weight ladder runs directly too. Nothing remains pending.
The proposal review reads `outOfDate` from `ProposalState` through the runtime's proposal document, never from the
proposal's state alone: a pending proposal whose routine moved on the log, in an edit the log has not confirmed, or out
of sight has no Apply and no Turn this down, and says so where they stood. Harness tests exercise adopted-workout Finish, held set deletion and Undo,
failed commits, command refusals, raw receipt replay and additive correction recovery.
Screen tests run over a real browser engine for a signed-in account (`gymAccount` in
`test/products/gym/harness.mjs`) and assert what the account still owes the server. `boot.browser.test.js` boots the
account provider, the sign-in door and the shell over a browser copy an earlier visit seeded, in Chromium: the room draws
with `/v1/me` held and reports how long it took, keeps the room for a paused session, draws the room signed out, keeps
the room and what is typed in it through a re-identify and through a page restored from the back/forward cache, its scroll
too, and draws `Opening`, never another tab's account, under the account this tab's shell has settled.
`signedOut.browser.test.js` serves `/v1` from the engine's reference server, which a phone of the account (the domain
harness) writes to as well: the signed-out room with its routines, workouts and weigh-ins and without the account's doors
(WD8); a sign-in into an account holding training, its question in gym's count, Add joining the work and the open
workout the account cannot take kept as finished from In this browser (WD9.1, WD9.3); Discard after its confirmation
(WD9.2); and a start that lost the race to the phone's, its toast and its sets kept (WD4.3). `WM_GYM_SHOTS` names a folder
for their screenshots. Shared training
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
