# Gym domain corpus

The shared gym vectors follow [the domain kit](../../../../docs/foundation/domain-kit.md) §15.3.
Swift `GymDomain`, Kotlin `:gym:domain` and the web's gym domain run every case over the shared
v12/minimum-11 registry composition and reproduce each `expect` by JCS equality; `recovery-actions.json` runs in
Swift and Kotlin and does not apply on the web (its row says why); every other file runs in all three.
`workout-plan-actions.json` and `workout-proposals-actions.json` hold the open workout's editable plan and its
workout proposals. R118 metadata reads remain optional
for legacy records. The pinned rule book covers ten entities, `WorkoutProposal` the newest; `RoutineCreation`
decodes separately.

The server claims the `training-reads.json` cases that make an estimate, by the one e1RM rule it holds as
`Estimate` (`backend/products/gym/domain/Progress.h`): every `GymEstimate` and `GymEstimateScore` case in its domain suite
(`backend/test/products/gym/domain/ProgressTest.cpp`), and every `StatsProgress` case and `TrainingHistory` review and
stats case over Postgres (`backend/test/products/gym/application/TrainingReadsCorpusTest.cpp`), which seeds each case's
records into the engine's stores and reads them through `TrainingService`. The server's wire states a review's and the
statistics' estimates to a tenth, so those expectations are stated the same way before the bytes are compared. That
test names the cases the server answers otherwise, each by the rule it reads differently, and the one case its
store cannot hold (a set without its session).

The ability conformance corpus beside this one, `../abilities/` ([README](../../README.md)), is claimed by the Swift replica
executor (`apps/ios/Domain/Sources/GymDomain/Coach/`, `CoachAbilitiesTests`): each case runs through `RunAbility` over its
given records as the case's seat at its moment, and the result's JCS bytes, its SHA-256 and the records the gesture writes
are compared with the server's golden. The Coach `thread` and `message` entities keep a rule book of their own
(`CoachRules.book`) until every gym implementation carries them, so `rules.json` stays the book the three share.

## Files

| File | Cases |
|---|---|
| `rules.json` | Entity facts and the complete rule book, compared by `RuleBookParity` |
| `values.json` | Every LOCAL spec and writable entity check; action-only LOCAL rules also have violation cases in the action files |
| `notes-actions.json` | Idempotent Coach note saves, capacity and single-note moves across held deletes |
| `bodyweight-actions.json` | Whole-day weigh-in saves, corrections and held deletes |
| `routines-actions.json` | Guarded editor saves, atomic routine/catalogue plans, reorder, delete, ordered targets, frozen-plan decoding |
| `coach-onboarding-actions.json` | One batch of preassigned routines and required custom movements with a transactional per-result replay receipt; Kotlin and Swift claim the cases, while web carries no anonymous import door |
| `catalogue-actions.json` | Create (a dumbbell movement's count included), rename, seed overrides, aliases, byte-sensitive search, decoding failures |
| `preferences-actions.json` | Draft preference saves and rest defaults |
| `training-actions.json` | Start/join, append, correct/delete set, discard, finish, import, replace completed workout; serial, time, overlap and log reads |
| `recovery-actions.json` | A saved signed-out workout the account has not taken: its review row and reason, the fix editor's live line, which notices it owns, keep/restart adoption, stranded-set recovery and discard. Runs in Swift `GymDomain` and Kotlin `:gym:domain`; the web holds no signed-out workout, so it records the file as not applying |
| `proposals-actions.json` | Propose, apply/dismiss, the proposal state's refusals and out of date, ordered diff, change count, the card's change blocks, provenance and optional R118 metadata reads |
| `workout-plan-actions.json` | Every `ReviseWorkoutPlan` operation, the logged-movement refusal per operation, stale bases, closed and missing workouts, unknown and duplicate movements, bounds; and the reads over an edited plan: prefill, the workout and review documents, the receipt's plan changes |
| `workout-proposals-actions.json` | Propose a workout change (diff, swap, reorder, unchanged, refusals), apply/dismiss with every out-of-date reason, and the card's `WorkoutOutOfDate` |
| `training-reads.json` | Prefill, the rest target, last time, readouts, the canonical estimate, complete progress projection, movement records, the log's new bests, chart windows and shared history documents |
| `units.json` | Units, signed weight ladder, formatting, rounding and rep steps |
| `../rules/bodyweight.json` | Bodyweight stance, readings, chart windows and gaps |
| `../../gym-ladder.json` | The existing cross-surface ladder, also run directly by both domains |

Entity vectors may name `nonFinite: {path, value}` with `NaN`, `Infinity` or `-Infinity` to exercise the declared field check on a typed draft value. The harness exercises that check before completing whole-entity validation, keeping non-finite numbers outside wire JSON and production decoders.

Every JSON vector file is an array of `{name, input, expect}`. The kit's
[forms](../../domain-kit/README.md) define specs, violations, row scenes, gestures and decisions.
An action scene has `{action, input, records:{drawn, stored?, device?}, ids?, now, offsetSeconds}`;
`stored` defaults to `drawn`, and `device` lists device keys with their values (the saved
workouts under `rack:adoption`); `ids` are minted in order, a correction's `requestId` included. A read scene replaces `action` with `read` and may specify
`firstPullComplete:false`. That flag prevents absence and lifetime-best claims over a booting history.
Pure value reads use their input directly. Malformed decode cases return
`{decodeError:{type,field,reason}}`. An unreadable frozen session plan is retained as exact JSON,
with `planUnreadable` marking its absent presentation; other session facts and writes remain available.

## Public entities and values

`Note`, `WeighIn`, `Routine`, `Exercise`, `ExerciseName`, `Session`, `TrainingSet`,
`GymPreferences`, `Proposal` and `WorkoutProposal` use `{id,fields}`. The writable form excludes server metadata,
exercise aliases, session fields, and a set's authoritative `setNumber`. Confirmed serials come
from scene rows; an input set's `setNumber` names the identity retained by a correction.
Sets have no type: every logged set counts. No stored row, writable form, command argument or read
document carries one.

`ExerciseName` is a metadata override keyed by a movement: a seed's carries `name`, `equipment` and
`loadCount`, a custom movement's only `equipment` and `loadCount` (its name lives on `exercise.name`). Its
writable form omits every null field, `name` included.

**Load count.** Volume and tonnage count each set as `max(0, weightKg) × reps × count`: a load is
entered per dumbbell, so `count` is the resolved `loadCount` for a movement whose resolved equipment is
`dumbbell` (the override's `loadCount`, else the seed's, else two; `goblet-squat`, `dumbbell-row`,
`suitcase-carry` and `overhead-triceps-extension` hold one), and one for every other equipment, a
`loadCount` left on a non-dumbbell override included. A bodyweight set counts only positive added load;
an assisted set counts nothing. Every volume read takes the resolved catalogue.

**Load unit.** `Readout.loadUnit` takes resolved `equipment` and `loadCount`: two dumbbells read
`kg each`, one reads `kg`; barbell and machine read `kg total`; bodyweight reads `kg added`, including
negative loads. Cable, kettlebell, unknown equipment and a missing exercise read `kg`. This is a
presentation read: it does not convert loads or volume. Its shared read cases use
`{operation:"loadUnit", equipment?, loadCount}`. Screen formatters insert a space before this unit;
Coach action and review presentation keeps its existing formatter.

`RoutineEntry` has `exerciseId`, optional `sets` and optional `restSeconds`.
`ImportCoachRoutineBatch` takes the captured replica, full result identity, a supplied SHA-256 fingerprint of the normalized payload, a bounded device receipt key, preassigned routine identities and required custom movements. The adapter derives `rack:coachImport` plus 48 lowercase hexadecimal SHA-256 digits from the result identity; its 59-character rack suffix fits the existing device-key grammar. One Plan writes every record and that receipt together. A matching receipt returns the same identities without writes; a full result-identity or fingerprint conflict refuses. Receipt keys are separate per result so Add preserves unrelated account and anonymous receipts. Record-identity adoption rewrites the receipt's routine and movement references while retaining its fingerprint. Swift also replays, without writing, a result an earlier iOS build imported under the single `rack:coachOnboarding` key.
A `SetTarget` has optional `reps` and `weightKg`; omission means max reps or last load.
Absent sets mean an open line. `SessionPlan` is `{routine,entries}`: the routine's as the start took them, then
as the lifter and applied workout proposals revise it while the workout is open. `plan` is a session's one
writable field; its check bounds `entries` to 0–50 (`session.plan.entries`), and a revision validates the
entries its operations wrote as routine entries (`routine.*` rules, at `plan.entries.<i>`). An untouched entry
stands as stored. `planRevision` and `routineRevision` are server fields outside the session's fields.
`WorkoutProposal` carries `sessionId`, `summary`, `changes`, `door`, `connection` and `agent`, with a
proposal's specs under `workoutProposal.*`. A session's malformed
frozen plan stays in its fields through closure and correction and cannot block editing sets or removal.

**Rest target.** `RestTarget` (`{planEntry?, sinceMs}`, the rest preference read from the drawn `prefs` record) is the
plan entry's `restSeconds`, else the preference's `restSeconds`, else none: `{seconds, reached}` or `null`. `reached`
turns true the moment `sinceMs` comes to `seconds × 1000`, and stays true past it.

`ImportedSet` carries `id,exerciseId,weightKg,reps,completedAt` and optional `rpe,note`.
`CorrectedSet` adds required `setNumber`. `CorrectSession` can preserve unnamed sets with `preserveOtherSets: true`.
Command arguments retain their raw loads and omitted versus explicit null `rpe` for
receipt identity. Predictions use checked, rounded values and never invent serials.

Optional read-only fields are `Routine.revision/createdEntries/createdDoor`,
`Proposal.baseRevision/baseName/changeCount/threadId/state/supersededBy/settledAt`,
`Note.updatedAt` and `RoutineCreation.snapshot` (exact JSON). `RoutineCreation` is decoded
separately and is outside the v4 rule book because v4 has no such type.

## Actions

| Action | Input | Result |
|---|---|---|
| `SaveRoutine`, `SavePreferences` | Editor fields; vectors open the drawn entity or a new blank draft | `{values,exists}` from the draft save |
| `SaveRoutinePlan` | `{base,current,isNew,movements:[{base,current}]}`; routine values use `{id,fields}`, movement values use `{id,fields,loadCount?}`, and a new movement has `base:null`. Omitted count means two for dumbbells; other equipment always uses one. | Routine id; one atomic gesture for touched routine fields and staged catalogue identity. Checks captured bases, guards changed fields and target load units, omits removed movements. Device-only former names are excluded from the shared gesture. |
| `SaveWeighIn` | `{day,kg}`; vectors open the drawn day or a new blank draft | `{id,fields}`; every save writes the whole fact with the save's moment |
| `DeleteRoutine`, `DeleteSet`, `DeleteWeighIn` | `{id}` or `{day}` | `null`; held, with Undo on a real engine |
| `ReorderRoutines` | `{order:[routineId]}` | `null`; a complete permutation, changed positions only |
| `CreateExercise` | `{exercise:{id,fields},loadCount?}`; `loadCount` is how many dumbbells a dumbbell movement holds, two when absent | Exercise id; a dumbbell movement holding one also writes `exerciseName` `{loadCount:1}` under the new id in the same gesture |
| `RenameExercise` | `{id,name}` | `null`; a custom rename, or a seed override writing `{name}` alone over any equipment or count it holds |
| `SaveNoteCall` | `{note:{id,fields}}` | Call id, or the stored note with the same words |
| `MoveNote` | `{id,below}`; `below:null` means the top | `null`; only the moved note's order changes, a drop in place writes nothing |
| `StartSession` | `{id,routineId?,startedAt?}` | Predicted or joined session id; always sends `joinOpenSession:true` |
| `FinishSession` | `{id,finishedAt?}` | `null` |
| `AppendSet`, `CorrectSet` | `{set:{id,fields}}` | Set id or `null` |
| `DiscardSession` | `{id}` | `null`; held, refuses an active non-stale session |
| `ImportSession` | `{id,routineId?,startedAt,finishedAt,sets:[ImportedSet]}` | Session id |
| `CorrectSession` | `{sessionId,requestId,startedAt,finishedAt,routineName,sets:[CorrectedSet],preserveOtherSets?}` | `null` |
| `AdoptWorkout` | `{id, mode: "keep" \| "restart", revised?}` over the saved copy under `rack:adoption` | `null`; keep imports the copy after the phone's checks (window, past now, movements, crossing); restart queues the start and every set in one plan or refuses the first set the phone would |
| `RecoverStrandedSets` | `{id, placement: "intoWorkout" \| "separately", revised?}` | `null`; the window's sets append to an open workout or correct into a finished one; the rest become a saved copy of their own with its import queued |
| `DiscardSignedOutWorkout` | `{id}` | `null`; the copy leaves the device key |
| `ProposeRoutine` | `{id,routineId,name,entries,summary,removing?}` | Proposal id; guards routine name and entries |
| `ApplyProposal`, `DismissProposal` | `{id}` | `null` |
| `ReviseWorkoutPlan` | `{sessionId,base,operations}`; `base` is the plan the editor read, `operations` a non-empty list applied in order (below) | `null`; one guarded write of the whole `plan`, or nothing when the plan stands |
| `ProposeWorkout` | `{id,sessionId,entries,summary}`; `entries` is the whole plan proposed | Proposal id; the diff against the stored plan, guarding `plan`; the stored plan makes no proposal |
| `ApplyWorkoutProposal`, `DismissWorkoutProposal` | `{id}` | `null`; apply predicts the settled state and the session's `plan` |

**Plan operations.** Each names an entry by its `index` in the plan and a planned set by `set`, both from 0:
`{op:"retarget",index,set,target:{reps?,weightKg?}}` replaces one planned set's target;
`{op:"add_set",index}` appends a copy of the last target, `{}` on an open line; `{op:"remove_set",index,set}`
removes one, and the last one leaves an open line; `{op:"swap",index,exerciseId}` puts a movement in the entry's
place with its planned sets and rest, keeping loads only when `Readout.loadUnit` of the two movements is equal
and otherwise dropping every `weightKg`; `{op:"add_movement",exerciseId}` appends an open line;
`{op:"remove_movement",index}`; `{op:"set_rest",index,restSeconds}`, null for the rest preference.

**Plan rules.** In order: a session `drawn` lacks is `gone`; a finished session, or one the client stale rule
closes over its `stored` sets (a held delete of its last set keeps it open), is `sessionFinished`; a session with no plan is `session.plan.absent`; a stored plan unequal to
`base` is `stale`. Then per operation: an index or set the entry
lacks is `session.plan.operation` (`outOfRange`, at `operations.<k>`); an entry whose movement has a set alive
in `drawn` or `stored` is `planLogged` with `{exerciseId}`; a target movement neither a seed nor drawn is
`unknownExercise`; one the plan already names is `session.plan.duplicate` (at `operations.<k>.exerciseId`);
one with a logged set is `planLogged`. Then the bounds. `ProposeWorkout` reads the same session rules, then
validates the proposal, then refuses an unknown movement, a duplicate entry (at `entries.<i>.exerciseId`) and a
changed logged movement, the first in the order the stored and then the proposed plan name movements, its
refusals about the proposal. Applying a pending workout proposal is refused `proposalSuperseded` with reason
`workout-finished` when its session is closed, `workout-changed` when `planRevision` (1 when unset) is not its
`baseRevision` or when its diff, recomputed against the `stored` plan, is not its `changes` (kept lines included),
and `workout-moved` when a movement it changes has a logged set; `replaced` and `workout-changed` name a superseded one with and without `supersededBy`.
The recomputed diff is INV-9 applied to a plan edit the server has not confirmed: `stored` holds that edit and
moves no `planRevision`, so it still decides, and the phone omits an Apply the server would refuse once the edit
lands. No plan operation reorders movements; an unsent Apply of a proposal that only reorders them leaves an
identical diff, so a second proposal reads current until the server's revision arrives.

A decision is `{decision:{write:{gesture,result}}}`, `{decision:{unchanged:{result}}}` or
`{decision:{refuse:<GymRefusal>}}`. The gym refusal is `{invalid:<violation>}`, or
`stale/gone/taken/future:{subject,path}`, `full:{type,cap,path}`, or one of
`sessionFinished/sessionOpen/sessionOverlap/payloadConflict/unknownExercise/badInstant/proposalSettled/proposalSuperseded/other`
holding the complete `{code,subject,detail,path}`; `planLogged` is `plan-logged`'s, its detail
`{exerciseId}`. Predicted and notice paths retain their meaning.

## Proposal state

`StateRefusal` (`{proposal, routine?, confirmedRoutine?, routineVisible?, applying}` → `{refusal}`) and `OutOfDate`
(the same input without `applying` → `{outOfDate}`) read a proposal with its routine as the phone stores it, as the log
last confirmed it (`confirmedRoutine`, the stored routine when absent) and whether it is in sight (`routineVisible`,
true when absent). Applying a pending proposal is refused `proposalSuperseded` with reason `routine-changed` when the
routine's revision moved or its name or movements differ from the confirmed copy, an edit the log will count before it
reads the decision; a reorder alone does not refuse. It is refused `gone` when the routine is absent or out of sight.
Turning down ignores both. A proposal is out of date when it is superseded, replaced, or pending with its Apply refused.

## Change blocks

`ChangeBlocks` (`{proposal, routine?, units?, each?}` → `{blocks, unchanged}`) reads a proposal as its card draws it.
Blocks list a new name, then movements that only moved, changed movements, removals and additions, each kind in the
proposal's order; `unchanged` counts the movements it keeps in place. A move is read against the routine only while the
proposal is pending: a movement whose place is the same in the routine and the proposal never moved; of the rest, those
in the longest run that keeps the routine's order stand — of equal runs, the one whose routine places come first — and
every other kept movement moved, *Order 3rd → 1st*. A moved
and retargeted movement is one changed block with its order first. A field is `{label, before, after, state}`: no
before is new, no after is gone, equal is same. While every set on both sides is the same a movement reads *Sets*,
*Reps* (*Max* with none) and *Load* (only when a side has a weight; *Last time* with none); once sets differ it reads
*Set N* per set, *5 × 80 kg* (*8 reps* unweighted); an open side reads one *Target* line, *None* against *3 × 10* or
*3 × 5 at 80 kg*; a changed rest reads *Rest*, in seconds under two minutes (*60 s*, *90 s*), whole minutes from two (*2 min*), else seconds, or *Default*. Loads format through `Readout.weight` in the
requested units, *each* for a movement in `each`. A removal proposal has no blocks.

## Reads

`WorkoutRecovery` (read scene with `input.notices` in the kit's notice form, `dismissed?` added) lists a row per
saved copy the account has not taken: the newest live notice it owns names the reason, else the phone's import
checks, else `unsent`; a landed copy's row holds the saved sets the log does not draw, and none when every set is
drawn. `owns` answers whether a notice is the copy's: its import, start or correction, or the creation of one of its
sets. `WorkoutFix` opens the review's row (a landed copy edits its stranded sets alone) and reports its live refusal.

`TrainingLog` draws local staleness without submitting `gym.closeStale`, hides sets with an absent
parent and orders ties by id. `SessionRules` pins the four-hour boundary, late-set admission,
finish behavior, start bounds and half-open overlap. `SetRules` pins next-number overflow.

`LastTime` selects the latest finished movement session. `Prefill` follows ordered targets,
last-time rows and today's sets. `SessionReadout` provides duration, set
and movement counts, volume and the session estimate. `StatsProgress` groups
finished facts in total order, with full-precision estimate values. `MovementProgress`
provides twelve-week/all windows, best, heaviest, most reps, record steps, sparse-chart eligibility
and gaps. All estimates use `GymEstimate`: positive load, 1–10 reps, supplied RPE ≥7;
one rep is the load itself, otherwise Epley. Incomplete history does not assert a best or absence.
Estimate ordering compares exact cent-load scores: load in cents multiplied by 30 for one rep or
by `30 + reps` otherwise. Equal scores retain the earliest session, then lowest session identity;
within a session, the lowest set identity wins.
`BodyweightReps` exposes the independent zero-load repetition fact of each session and its best
in the requested window. Higher assisted repetitions or equally repeated added load never replace
that fact; the all-load `mostReps` read retains its own ordering. Partial history has facts but no best.
`ProgressRecords` (`input:{}`) is the log's new bests. A movement's first estimate is its baseline, never a new best;
a later estimate is a new best when, stated to a tenth of a kilogram, it beats the best before it as stated. Each names
its session, the best it beat (`previous`), its stated `estimate` and its `gain` over that best to a tenth; the read
also lists the sessions that set one. Partial history has none. It runs in all three; the web's log weaves no new
bests yet.

`PlanChanges` (`{sessionId}` → `{changes,changeCount,offer}`) is the receipt's card, drawn only for a workout whose
own plan changed: the server's `planRevision` is set. It is the proposal diff of the session's plan against its
routine as drawn, with R118's count and no name term; `offer` is `save` when the routine's `revision` equals the
session's `routineRevision`, `routineChanged` when both are known and differ, and `none` when either is unknown — the
changes still listed, neither save nor sentence offered. With no changes it is `none` when `planRevision` is unset
(a routine that moved under an unedited plan, or a plan edit the server has not stamped yet), when the plan matches,
has no routine or does not exist. `WorkoutOutOfDate` (`{id}` →
`{outOfDate}`) is null for a current, applied or dismissed proposal, else `{reason}` with apply's reasons,
`workout-moved` naming the movement as `exerciseId`.

`TrainingHistory` composes the mirror documents through the same entities and reads. Its vectors use
`input:{method,args}` and preserve catalogue and routine joins, proposal provenance, last-set selection,
session summaries, reviews, record details and weekly totals. History filters apply before summary and
facet aggregation; only the returned session page uses the cursor and limit. Equal session timestamps
sort by ascending identity, and the next page excludes identities through `beforeId`. Tonnage sums
loads in their storage quanta; estimates retain full precision. Record steps include the first baseline.
The training-read cases include complete mirror documents, adversarial read scenes and one override scene
read through history, session summaries, exercise documents, `SessionReadout` and `TrainingLog`.

The engines accept create/update/write/removal predictions. Omitted sets in completed-session
replacement and a proposal-removed routine disappear locally while their command is pending;
a refusal restores them. Joined session identities and pending
set parents reconcile through the engine's write map. UI callers read the view again after resolution.

Start, import and completed-session correction defer receipt-sensitive life, ownership, open state,
clock and overlap checks to the server. Import and start accept a matching stored receipt first; correction checks session life before its receipt.
Intrinsic instant bounds, payload intervals, identities and counts still validate locally.
