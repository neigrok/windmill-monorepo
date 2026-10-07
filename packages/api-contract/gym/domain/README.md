# Gym domain corpus

The shared gym vectors follow [the domain kit](../../../../docs/foundation/domain-kit.md) §15.3.
Swift `GymDomain` and Kotlin `:gym:domain` run every case over the shared v6/minimum-4 registry
composition and reproduce each `expect` by JCS equality. R118 metadata reads remain optional
for legacy records. The pinned rule book covers the nine v4 entities; `RoutineCreation` decodes separately.

## Files

| File | Cases |
|---|---|
| `rules.json` | Entity facts and the complete rule book, compared by `RuleBookParity` |
| `values.json` | Every LOCAL spec and writable entity check; action-only LOCAL rules also have violation cases in the action files |
| `notes-actions.json` | Idempotent Coach note saves, capacity and single-note moves across held deletes |
| `bodyweight-actions.json` | Whole-day weigh-in saves, corrections and held deletes |
| `routines-actions.json` | Guarded editor saves, reorder, delete, ordered targets, frozen-plan decoding |
| `catalogue-actions.json` | Create, rename, seed overrides, aliases, byte-sensitive search, decoding failures |
| `preferences-actions.json` | Draft preference saves and rest defaults |
| `training-actions.json` | Start/join, append, correct/delete set, discard, finish, import, replace completed workout; serial, time, overlap and log reads |
| `proposals-actions.json` | Propose, apply/dismiss, ordered diff, change count, provenance and optional R118 metadata reads |
| `training-reads.json` | Prefill, last time, readouts, the canonical estimate, complete progress projection, movement records, chart windows and shared history documents |
| `units.json` | Units, signed weight ladder, formatting, rounding and rep steps |
| `../rules/bodyweight.json` | Bodyweight stance, readings, chart windows and gaps |
| `../../gym-ladder.json` | The existing cross-surface ladder, also run directly by both domains |

Every JSON vector file is an array of `{name, input, expect}`. The kit's
[forms](../../domain-kit/README.md) define specs, violations, row scenes, gestures and decisions.
An action scene has `{action, input, records:{drawn, stored?}, ids?, now, offsetSeconds}`;
`stored` defaults to `drawn`. A read scene replaces `action` with `read` and may specify
`firstPullComplete:false`. That flag prevents absence and lifetime-best claims over a booting history.
Pure value reads use their input directly. Malformed decode cases return
`{decodeError:{type,field,reason}}` and never discard malformed fields silently.

## Public entities and values

`Note`, `WeighIn`, `Routine`, `Exercise`, `ExerciseName`, `Session`, `TrainingSet`,
`GymPreferences` and `Proposal` use `{id,fields}`. The writable form excludes server metadata,
exercise aliases, session fields, and a set's authoritative `setNumber`. Confirmed serials come
from scene rows; an input set's `setNumber` names the identity retained by a correction.

`RoutineEntry` has `exerciseId`, optional `sets` and optional `restSeconds`.
A `SetTarget` has optional `reps` and `weightKg`; omission means max reps or last load.
Absent sets mean an open line. `SessionPlan` freezes `{routine,entries}`.

`ImportedSet` carries `id,exerciseId,weightKg,reps,completedAt` and optional `kind,rpe,note`.
`CorrectedSet` adds required `setNumber`: kept sets keep their kind; new ones take optional `kind`,
default working. `CorrectSession` can preserve unnamed sets with `preserveOtherSets: true`.
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
| `CreateExercise` | `{exercise:{id,fields}}` | Exercise id |
| `RenameExercise` | `{id,name}` | `null`; a custom rename or seed override |
| `SaveNoteCall` | `{note:{id,fields}}` | Call id, or the stored note with the same words |
| `MoveNote` | `{id,below}`; `below:null` means the top | `null`; only the moved note's order changes, a drop in place writes nothing |
| `StartSession` | `{id,routineId?,startedAt?}` | Predicted or joined session id; always sends `joinOpenSession:true` |
| `FinishSession` | `{id,finishedAt?}` | `null` |
| `AppendSet`, `CorrectSet` | `{set:{id,fields}}` | Set id or `null` |
| `DiscardSession` | `{id}` | `null`; held, refuses an active non-stale session |
| `ImportSession` | `{id,routineId?,startedAt,finishedAt,sets:[ImportedSet]}` | Session id |
| `CorrectSession` | `{sessionId,requestId,startedAt,finishedAt,routineName,sets:[CorrectedSet],preserveOtherSets?}` | `null` |
| `ProposeRoutine` | `{id,routineId,name,entries,summary,removing?}` | Proposal id; guards routine name and entries |
| `ApplyProposal`, `DismissProposal` | `{id}` | `null` |

A decision is `{decision:{write:{gesture,result}}}`, `{decision:{unchanged:{result}}}` or
`{decision:{refuse:<GymRefusal>}}`. The gym refusal is `{invalid:<violation>}`, or
`stale/gone/taken/future:{subject,path}`, `full:{type,cap,path}`, or one of
`sessionFinished/sessionOpen/sessionOverlap/payloadConflict/unknownExercise/badInstant/proposalSettled/proposalSuperseded/other`
holding the complete `{code,subject,detail,path}`. Predicted and notice paths retain their meaning.

## Reads

`TrainingLog` draws local staleness without submitting `gym.closeStale`, hides sets with an absent
parent and orders ties by id. `SessionRules` pins the four-hour boundary, late-set admission,
finish behavior, start bounds and half-open overlap. `SetRules` pins next-number overflow.

`LastTime` selects the latest finished movement session. `Prefill` follows ordered targets,
last-time rows and today's working-set override. `SessionReadout` provides duration, working-set
and movement counts, positive working tonnage and the session estimate. `StatsProgress` groups
finished working facts in total order, with unrounded estimates for ranking. `MovementProgress`
provides twelve-week/all windows, best, heaviest, most reps, record steps, sparse-chart eligibility
and gaps. All estimates use `GymEstimate`: positive working load, 1–10 reps, supplied RPE ≥7;
one rep is the load itself, otherwise Epley. Incomplete history does not assert a best or absence.

`TrainingHistory` composes the mirror documents through the same entities and reads. Its vectors use
`input:{method,args}` and preserve catalogue and routine joins, proposal provenance, last-set selection,
session summaries, reviews, record details and weekly totals. History filters apply before summary and
facet aggregation; only the returned session page uses the cursor and limit. Equal session timestamps
sort by ascending identity, and the next page excludes identities through `beforeId`. Tonnage sums
loads in their storage quanta; estimates retain full precision. Record steps include the first baseline.
The 99 training-read cases include 36 complete mirror documents and nine adversarial read scenes.

The engines accept create/update/write/removal predictions. Omitted sets in completed-session
replacement and a proposal-removed routine disappear locally while their command is pending;
a refusal restores them. Joined session identities and pending
set parents reconcile through the engine's write map. UI callers read the view again after resolution.

Start, import and completed-session correction defer receipt-sensitive life, ownership, open state,
clock and overlap checks to the server. Import and start accept a matching stored receipt first; correction checks session life before its receipt.
Intrinsic instant bounds, payload intervals, identities and counts still validate locally.
