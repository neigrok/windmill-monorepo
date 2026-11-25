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
Notes wait for `signedIn`; until then Coach's tab, its History and Notes are Coach's door (`CoachDoor`, WD8.3), a sentence
and the shell's sign-in at the head of the reading column, in the reach band above the tab bar on a narrow screen, or
`Opening` while the account has yet to answer, and no share is offered. The past-workout form and a
finished workout's corrections are server commands a signed-out replica never sends (R-5): `anonymous`, their doors are
not drawn (Add past workout, Edit workout, a finished set's Fix, a routine's Log past), and their routes draw The log. The
account's open workout runs on its page, `#/gym/workout` (`workout/`), whichever device started it; past workouts are
imported with `gym.importSession`. Routine and note editors
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
`domain/training.js`; `trainingActions.js` owns the training actions every surface runs: start, append, finish, discard,
imports, corrections and set deletion.

A workout on the web (web-device-parity §4) is those actions on the browser's copy, and `domain/workoutRack.js` holds
what a phone keeps beside them: the four device rows a browser keeps for its open workout, keyed by the session —
`movementOrder` (the movements in their order), `movement` (the one in hand), `rack` (its load and reps, whether the
lifter set them, and the slot and plan entry that filled them) and `offer` (the id of the set Log set writes next).
`WorkoutRack` settles them against the workout as it stands: the plan's movements, then any other one logged or added to
a workout with no plan; the one in hand, else the latest set's; its rack, kept while its slot holds and filled again from
`Prefill` once a set lands or the plan changes a rack the lifter did not set; and the set on offer, kept while the rack
offers the same set. Every rack change reads the rows and writes them in one local write (`SettleRack`, `TurnRack`), so a
tab never writes over another's, and a step of the ladder or the reps stepper is taken from the row as it is written, so two
tabs stepping together both count; a field's Enter lands what it holds and logs nothing, Log set alone logging. A settle that
fails is tried again, backing off to every 30 s, and Log set says it is waiting meanwhile. `LogRackSet` writes the set under the id the offer row holds — a second tap on one
offer, in this tab or another, finds the set written and writes nothing — and refuses `stale` an offer the rows no
longer hold. `ReviseWorkout` is `ReviseWorkoutPlan`, refused `stale` against any plan but the one its editor opened on,
with the rows it leaves; `FinishWorkout` finishes and forgets the rows; a finished workout is discarded through the
room's held delete. `StartWorkout` refuses a routine the log no longer draws, and otherwise is `StartSession`, which
refuses a start beside an open workout. The page's clocks read the server's time (the device's corrected by its offset)
on every animation frame while the tab is shown, from the workout's start and the latest set's time, never a count; the
tab's title and favicon read them each time a timer fires. The rest reaching its target is told and toned at that instant
by the tab the sync engine leads from, when that tab draws the workout: a browser has one leading tab, and the engine gives
the lead to a tab on screen whenever one is, so two tabs tell it once.
Before the shell signs in or finishes a sign-out (`routes.sync.seatWillChange`), `saveSignedOutWorkouts` saves each
workout the anon replica holds for adoption (`AdoptWorkout` in `prepare`, kept under the device row `rack:adoption`): a
finished one becomes one import that supersedes its chain, an open one keeps a start that does not join, and an open one's
sets the replacing start folded are recorded again with it (`AppendSet` as recorded). Each workout is one composed act on
the API's binding, so it lands whole before the seat changes, or not at all when the seat moved first; one the domain
refuses or that fails leaves the others to land, and a seat that moved ends the hook. A copy an earlier sign-in saved of a
workout deleted since goes with it, so a workout deleted signed out never comes back. A bound replica holds none. Every
rack change is written as it is made, so no rack waits to be written first.
The sign-in that follows (`routes.sync`): the saved workouts and the form drafts the account refused are gym's pending
device work (`gymDeviceWork`; a pending draft's queued command is counted already), merged entry by entry into a dormant replica's own at a sign-in that joins it, the
account's standing on an entry both hold (`adoptGymDeviceRows`). An account holding gym records of its own asks the
shell's question (WD9) of any gym work the browser holds, and one holding none takes it without a question (engine
§7.10). The question counts every kind the browser holds, each with what names it (`signInWork`): its workouts, routines
and weigh-ins as WD9 draws them, and the movements it made or renamed and its settings in words of their own (*2
movements*, *your settings*); work that draws none of them any longer, a workout made and deleted, it counts by its
changes. It tells each step of the question. From the engine's opening (`prepare`, `watchBrowserCopies`), whenever gym's
scope moves on a bound replica holding copies, each proposal a copy held is issued again once the account holds its
workout, every copy the account took whole is let go, and so is every copy that holds no set and no proposal, which
loses nothing. A copy the account has not taken, and that holds a set, waits in The log's In this browser
(`recovery/InThisBrowser.jsx`, WD9.3), signed in only,
at the head of the index from 801px and above the filters below: its title, when and how many sets, the review's reason
(`WorkoutRecovery.review` over the engine's notices) in one sentence and its one answer, Keep as finished while the
account's workout is open (`AdoptWorkout` keep, an open copy finished at its last set) or Add to your log once only the
retry stands (`AdoptWorkout` restart or keep, or a landed workout's stranded sets by `RecoverStrandedSets`), each putting
away the notices it answers; *Adding…* while one is on its way; and Discard in its menu, held with Undo on the room's clock
before `DiscardSignedOutWorkout`. A start that lost a race with another device's (spec §4, WD4.3) is refused
`session-open` with its sets in its notice: the room saves them as a copy (`SaveRefusedStart`) and says so once, with
View sets; a start that holds no set, or whose workout was deleted before the refusal, loses nothing: its notice is put
away and nothing is said. The room's notice voice leaves every notice a copy owns, and every refused start, to In this
browser; a set the account refuses because its workout has finished is said in the iPhone's words, *This workout has
already finished.*
Correction and backfill helpers parse fields and arrange draft rows into domain inputs.
`trainingReads.js` owns prefill, last time, records, the log's new bests (`ProgressRecords`, read by no web screen yet) and chart windows, and
`trainingHistory.js` composes history, reviews and screen documents.
Proposal values and decisions live in `domain/proposals.js`; their shared domain reads supply
the proposal screen and routine history. `domain/proposalDiff.js` reads a routine's proposal or the open
workout's as the blocks of field lines its card shows (`ProposalDiff.ofRoutine`, `ProposalDiff.ofWorkout`). Removal receipts survive sync and restart until shown.
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
naming the network only for a REST door's (the server's answer, or fetch's `TypeError` for none) and this device for any
other, a write its copy did not keep. A write whose replica
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

Coach is open during a workout (web-device-parity §4, boards WD7): `WorkoutCoach` is the room's conversation alone, in the
workout page's rail on a desk, whose design-system `Tabs` switch *This workout* to *Coach* beside the rack, and on a phone in
a `Sheet` at its large detent that the toolbar's Coach button opens over the workout, under a head of Coach, History and
Close; Close leaves the rack as it was. The workout page holds one conversation (`useWorkoutConversation`) through a flip of
the tabs and a resize across a desk and a phone: the Coach tab shows it, a fresh chat the first time, and the phone's sheet
opens a fresh chat, as the phones do, unless the conversation it holds has a turn running or a change to this workout
waiting on the person. A question asked while a turn runs stays in the field under the busy notice. The turn reads the open
workout at its opening. Signed out, the workout page leaves Coach out. The profile offers catalog/3's
`propose_workout_change` in a group of its own, as the phones do, and its card (`WorkoutProposalCard` in
`coach/CoachProposal.jsx`) reads the copy: pending, it lists what the change changes in `ProposalDiff.ofWorkout`'s blocks
against the workout's plan, a line that stays the same left out, with Reject and the one prominent Apply, which runs
`ApplyWorkoutProposal` on the browser's copy (the runtime's `applyWorkoutProposal`): design-system Buttons in the workout's
Coach (`CoachForm`), the room's pills in History. Applied or rejected,
it is one line, which takes the focus once the decision lands; out of date (`WorkoutProposalState.outOfDate`), it says why
in one sentence and offers nothing, and so does a change whose decision the log refused, read from the refusal's notice
while the copy still takes it for current. That notice stands on the card for good, so a change the log refused keeps its
sentence even once its cause is undone; the room's notice voice says nothing of it. An Apply the copy's rules refuse for a
load under a movement's floor draws the log's sentence for that load, which takes the focus, and offers no Try again, which
could not pass the floor. While a workout is open a routine
proposal waits for next time: its count says so and its Apply steps back for the workout's, a Secondary Button in the
workout's Coach and the quiet pill in the room.

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

`gymRuntime.js` owns the gym telemetry boundary. A workout's steps tell the iPhone's events through `workoutStep`, its
properties each one of a closed set of labels and never a name or an id of a workout, a routine or a movement:
`gym_session_started` (`door`: `routine` or `empty`), `gym_set_logged`, `gym_session_finished`, `gym_workout_plan_changed`
(one per kind of edit, `action`, `door: workout`), `gym_workout_adjusted` (`field`: `weight` or `reps`),
`gym_workout_movement_chosen`, each with `outcome` `ok`, `refused` (with `code`, and `reason: stale` for a plan another tab or
device changed first) or `failed`; and from the screens `gym_rest_target_reached`, `gym_hidden_workout` (`action`: `hide`, or
`open` with `door: bar`), `gym_workout_popped_out` (`outcome` `ok` or `failed`) and `gym_receipt_plan_saved`. Their
unexpected failures report `gym-workout-start`, `gym-rack-settle`, `gym-rack-turn`, `gym-set-log`, `gym-plan-revise`,
`gym-workout-finish` and, for a pop-out window the browser would not open, `gym-pop-out`. Coach during a workout tells its steps
under the iPhone's names through `coachStep`, from the same closed sets: `gym_action` (`screen: coach`, `action: new_chat`,
`door: workout`, `outcome: ok`) from the gesture that starts a fresh chat over the workout; and `gym_proposal_outcome`
(`screen: coach`, `target` `workout` or `routine`, `action` `apply` or `reject`) once for each decision on either card or in
the routines review, from the page that made it, as the log answers it: `decided`, or `failed` with the log's `reason`;
`decided` at once for a decision that finds the proposal standing as asked while no other page's decision waits on the log;
`refused` for a value this copy's rules hold invalid, such as a load under a movement's floor, and `failed` with its
`reason` for any other refusal of them;
`failed` for a decision that broke; and `stalled` once besides for a routine's decision the log has not answered in 15 s.
A reload, a remount or another tab tells nothing of it. A workout proposal's decision that fails unexpectedly reports
`gym-workout-proposal-apply` or `gym-workout-proposal-dismiss`. Engine-backed writes otherwise emit first-party `gym_action` events with allowlisted `operation` and
`outcome` only, and a `refused` one also `code`: `not-writable` when the replica moved under the room, `domain` when the
gym's rules refused it, this device's or the server's. Operations cover routine create/save, exercise create/rename, preferences save,
note save/reorder, bodyweight save, set/session correction, session import, proposal apply/dismiss,
delete/Undo, refusal and the save of signed-out workouts for adoption (`workout-adopt`, told once when it saved something
and once for each workout refused or failed, and never stopping the seat change). Outcomes are `saved-local`, `unchanged`, `failed`, `held`, `undone`,
`closed`, `refused`. A copy's recovery ends in one `gym_recovery` with `outcome` (`saved` for a start that lost a race,
`kept`, `retried`, `discarded`, `refused`, `failed`) and the review's `reason`; one that fails, a save of a refused start
that fails and a held proposal the account refuses to issue again report `gym-workout-recover`. The sign-in question tells
`gym_signin_decision` with `step` (`shown`, `add`, `discard`, `cancel`) and `count_bucket`, what it counted as a bucket. A local save does not claim server admission. Unexpected boundary failures
report a static `gym-<operation>` to Sentry with the error's stack frames, never its message, IDs, names, bodies or field values;
a `GymRefusal` is expected and reports nothing, and a store failure is the engine's to report.
Engine telemetry owns transport, storage, authentication and admission failures. Refusal content stays on the device; the room announces
unresolved notices.

A routine Coach creates exists the moment its call commits, as the lifter's own New routine would; its card links the
routine. A routine proposal and a workout proposal, this browser's or a phone's, each stand under the answer whose call
made them, with Reject and Apply, the lifter's gestures and the server's commands.

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
harness) writes to as well: the signed-out room with its routines, workouts and weigh-ins and without the account's doors,
whose addresses draw The log or the workout as logged, no copy offered, and Coach's door where WD8.3 draws it at 1440 and
390 (WD8); a sign-in into an account holding training, its question in gym's count, Add joining the work and the open
workout the account cannot take kept as finished from In this browser (WD9.1, WD9.3); Discard after its confirmation
(WD9.2); a question of movements and settings alone, whose Discard leaves the account's names and settings as they were;
a workout deleted signed out, counted by its changes, whose start the account refuses after Add with nothing saved or
said; and a start that lost the race to the phone's, its toast clear of the rack at 1440 and 390 and its sets kept
(WD4.3). `WM_GYM_SHOTS` names a folder for their screenshots.
`workout.browser.test.js` runs a workout in Chromium the same way: started from a routine and empty, a set logged and
corrected, a plan edit, Finish and the discard; Log set tapped in two tabs on one offer logs one set and the second tap is
quiet; a plan edit another tab made stale is refused with its draft kept, and Save mine writes it; a set logged with no
connection is kept through a reload, taken by the reference server once it answers and drawn after; the tab's title and
favicon follow the rest clock; Enter lands a field and logs nothing; a step of the ladder and of the reps in each of two tabs
both count; the rest is told once across two tabs; a settle that fails is reported, said and tried again; Edit sets closes
when a set lands on its movement; and Pop out's open is told and its refusal reported. Its page loads the app's fonts, and
`WM_WORKOUT_SHOTS` names a folder for the logging page at 1440 and 390. Coach during a workout has a file of
its own, `coach/coachDuringWorkout.browser.test.js`, over the engine's reference server with a phone of the account, its AI
service played round by round: Coach in the rail beside the rack, its change applied and the conversation kept through a flip
of the tabs (WD7.1, WD7.2); a resize from a desk to a phone and back, which keeps it; the sheet at a phone's width, its change
rejected there, its Close and the fresh chat after (WD7.1 · 390); Coach closed mid-answer and reopened on it, a question
asked meanwhile kept under the busy notice; a change out of date once the phone logs its movement, and current again once
the phone deletes it (WD7.3); an Apply the log refuses as `invalid` or `plan-logged`, its sentence standing in two tabs and
told once; and a phone's workout proposal in History, applied in two tabs at once and told once. `WM_COACH_SHOTS` names a
folder for Coach's states at 1440 and 390, and the rail's foot at 1440 × 1000 and 1440 × 900. Shared training
reads run on web, Swift and Kotlin. The local stack checks domain reads over an actual disposable
backend account and persisted browser-engine observations. Chromium acceptance has twelve checks: a phone replica's open workout draws the bar, its page
continues it, the phone's set lands in its ledger and the phone's `gym.finish` closes it; web routine edits, backfills, additive recovery, weigh-ins and unit changes converge; a held weigh-in delete can be
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
