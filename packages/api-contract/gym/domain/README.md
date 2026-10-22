# Gym domain corpus

The shared gym vectors follow [the domain kit](../../../../docs/foundation/domain-kit.md) §15.3.
Swift `GymDomain`, Kotlin `:gym:domain` and the web's gym domain run every case over the shared
v7/minimum-4 registry composition and reproduce each `expect` by JCS equality; `recovery-actions.json` runs in
Swift and Kotlin and does not apply on the web (its row says why); every other file runs in all three.
R118 metadata reads remain optional
for legacy records. The pinned rule book covers the nine v4 entities; `RoutineCreation` decodes separately.

## Files

| File | Cases |
|---|---|
| `rules.json` | Entity facts and the complete rule book, compared by `RuleBookParity` |
| `values.json` | Every LOCAL spec and writable entity check; action-only LOCAL rules also have violation cases in the action files |
| `notes-actions.json` | Idempotent Coach note saves, capacity and single-note moves across held deletes |
| `bodyweight-actions.json` | Whole-day weigh-in saves, corrections and held deletes |
| `routines-actions.json` | Guarded editor saves, reorder, delete, ordered targets, frozen-plan decoding |
| `catalogue-actions.json` | Create (a dumbbell movement's count included), rename, seed overrides, aliases, byte-sensitive search, decoding failures |
| `preferences-actions.json` | Draft preference saves and rest defaults |
| `training-actions.json` | Start/join, append, correct/delete set, discard, finish, import, replace completed workout; serial, time, overlap and log reads |
| `recovery-actions.json` | A saved signed-out workout the account has not taken: its review row and reason, the fix editor's live line, which notices it owns, keep/restart adoption, stranded-set recovery and discard. Runs in Swift `GymDomain` and Kotlin `:gym:domain`; the web holds no signed-out workout, so it records the file as not applying |
| `proposals-actions.json` | Propose, apply/dismiss, the proposal state's refusals and out of date, ordered diff, change count, the card's change blocks, provenance and optional R118 metadata reads |
| `training-reads.json` | Prefill, last time, readouts, the canonical estimate, complete progress projection, movement records, the log's new bests, chart windows and shared history documents |
| `units.json` | Units, signed weight ladder, formatting, rounding and rep steps |
| `../rules/bodyweight.json` | Bodyweight stance, readings, chart windows and gaps |
| `../../gym-ladder.json` | The existing cross-surface ladder, also run directly by both domains |

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
`GymPreferences` and `Proposal` use `{id,fields}`. The writable form excludes server metadata,
exercise aliases, session fields, and a set's authoritative `setNumber`. Confirmed serials come
from scene rows; an input set's `setNumber` names the identity retained by a correction.
Sets have no type: every set is a working set. A stored row's `kind` is read and ignored, and no
writable form, command argument or read document carries one.

`ExerciseName` is a metadata override keyed by a movement: a seed's carries `name`, `equipment` and
`loadCount`, a custom movement's only `equipment` and `loadCount` (its name lives on `exercise.name`). Its
writable form omits every null field, `name` included.

**Load count.** Volume and tonnage count each set as `max(0, weightKg) × reps × count`: a load is
entered per dumbbell, so `count` is the resolved `loadCount` for a movement whose resolved equipment is
`dumbbell` (the override's `loadCount`, else the seed's, else two; `goblet-squat`, `dumbbell-row`,
`suitcase-carry` and `overhead-triceps-extension` hold one), and one for every other equipment, a
`loadCount` left on a non-dumbbell override included. A bodyweight set counts only positive added load;
an assisted set counts nothing. Every volume read takes the resolved catalogue.

`RoutineEntry` has `exerciseId`, optional `sets` and optional `restSeconds`.
A `SetTarget` has optional `reps` and `weightKg`; omission means max reps or last load.
Absent sets mean an open line. `SessionPlan` freezes `{routine,entries}`. A session's malformed
frozen plan stays in its fields through closure and correction and cannot block editing sets or removal.

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

A decision is `{decision:{write:{gesture,result}}}`, `{decision:{unchanged:{result}}}` or
`{decision:{refuse:<GymRefusal>}}`. The gym refusal is `{invalid:<violation>}`, or
`stale/gone/taken/future:{subject,path}`, `full:{type,cap,path}`, or one of
`sessionFinished/sessionOpen/sessionOverlap/payloadConflict/unknownExercise/badInstant/proposalSettled/proposalSuperseded/other`
holding the complete `{code,subject,detail,path}`. Predicted and notice paths retain their meaning.

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
proposal is pending: a movement keeps its place when it stands in the longest run that keeps the routine's order — of
equal runs, the one whose routine places come first — and every other kept movement moved, *Order 3rd → 1st*. A moved
and retargeted movement is one changed block with its order first. A field is `{label, before, after, state}`: no
before is new, no after is gone, equal is same. While every set on both sides is the same a movement reads *Sets*,
*Reps* (*Max* with none) and *Load* (only when a side has a weight; *Last time* with none); once sets differ it reads
*Set N* per set, *5 × 80 kg* (*8 reps* unweighted); an open side reads one *Target* line, *None* against *3 × 10* or
*3 × 5 at 80 kg*; a changed rest reads *Rest*, *90 s*, *2 min* or *Default*. Loads format through `Readout.weight` in the
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
last-time rows and today's sets. `SessionReadout` provides duration, working-set (every set)
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
