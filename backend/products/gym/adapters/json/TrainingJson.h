#pragma once

#include "products/gym/application/CatalogService.h"
#include "products/gym/application/ProgramService.h"
#include "products/gym/application/TrainingService.h"
#include "products/gym/domain/Bodyweight.h"
#include "products/gym/domain/Note.h"
#include "products/gym/domain/Preferences.h"
#include "products/gym/domain/ReadReceipt.h"
#include "products/gym/domain/Thread.h"

#include <json/value.h>

#include <cstdint>
#include <optional>
#include <vector>

namespace wm::gym {

// Instants are epoch-ms numbers, weights are numbers in kg. Optional fields are omitted when absent,
// never null; note is always present.
//
//   session in  : { "id": "ses_…", "startedAt": ms, "joinOpenSession"?: bool, "routineId"?: "rt_…" }
//   set in      : { "id": "set_…", "exerciseId": "…", "weightKg": n, "reps": n, "completedAt": ms,
//                   "kind"?: "warmup"|"working"|"drop"|"failure", "rpe"?: n, "note"?: "…" }
//   fix in      : { "weightKg"?: n, "reps"?: n, "kind"?: "…", "rpe"?: n|null, "note"?: "…" }
//                                                       PATCH /v1/gym/sessions/{id}/sets/{setId}
//   routine in  : { "id": "rt_…", "name": "…", "position": n,
//                   "entries": [ { "exerciseId": "…", "targetSets"?: n, "targetReps"?: n,
//                                  "targetWeightKg"?: n, "restSeconds"?: n } ] }
//   movement in : { "id": "ex_…", "name": "…", "pattern": "squat"|…, "equipment": "barbell"|…,
//                   "stepKg"?: n }
//   rename in   : { "name": "…" }                       PATCH /v1/gym/exercises/{id}
//   settings i/o: { "units": "kg"|"lb", "restSeconds"?: n,
//                   "restSound": bool, "confirmHaptic": bool, "confirmSound": bool }
//                                                       GET · PUT /v1/gym/preferences
//   session out : { "id", "startedAt", "finishedAt"?, "routineId"?, "plan"? }
//   log row out : the session, plus { "setCount", "workingSetCount", "tonnageKg",
//                                     "exercises": ["…"], "topSet"?: { "weightKg", "reps" },
//                                     "topE1rm"?: n, "record": bool, "closedItself": bool }
//   set out     : { "id", "exerciseId", "setNumber", "weightKg", "reps", "kind", "rpe"?, "note",
//                   "completedAt" }
//   exercise out: { "id", "name", "pattern", "equipment", "stepKg", "custom",
//                   "aliases"?: ["…"] }        what this account used to call it, newest first
//   last sets out: { "movements": [ { "exerciseId", "weightKg", "reps", "at" } ] }
//                                                       GET /v1/gym/exercises/last
//   routine out : { "id", "name", "position", "revision", "lastTrainedAt"?,
//                   "entries": [ { "position", "exerciseId", "targetSets"?, "targetReps"?,
//                                  "targetWeightKg"?, "restSeconds"? } ],
//                   "pendingProposal"?: <proposal head>,
//                   "history"?: [ … ] }        the single read only; the list omits it
//   history out : [ { "kind": "created", "at": ms, "by"?: "mcp"|"ask", "movements"?: n },
//                   { "kind": "proposal", "at": ms, "proposal": <proposal head> } ]  newest first
//
// A line with no `targetSets` is open: the absence, never a zero, in both directions.
// A routine with no `lastTrainedAt` has never been trained.
// `history` rides on GET /v1/gym/routines/{id} alone; its `created` row is always last and always
// present. `by` is absent when the day was the lifter's own.
//   proposal in : { "id": "prop_…", "routineId": "rt_…", "name"?: "…", "summary"?: "…",
//                   "entries": [ <the same entry shape a routine takes> ] }
//   proposal head out: { "id", "routineId", "intent": "revise"|"remove",
//                        "state": "pending"|"applied"|"dismissed"|"superseded",
//                        "summary", "changeCount": n, "createdAt": ms, "settledAt"?: ms,
//                        "source": { "door": "mcp"|"ask", "connection"?: "…", "agent"?: "…",
//                                    "thread"?: "thr_…" } }
//   proposal out: the head, plus { "baseRevision": n, "baseName": "…", "name": "…",
//                   "changes": [ { "position", "kind": "kept"|"added"|"removed"|"retargeted",
//                                  "exerciseId",
//                                  "before"?: { "sets", "reps"?, "weightKg"?, "restSeconds"? },
//                                  "after"?:  { "sets", "reps"?, "weightKg"?, "restSeconds"? },
//                                  "loggedSets"?: n } ] }
//
// `revision` is the routine's concurrency token: a client reads it and never sends it.
// `pendingProposal` is present only while one is waiting.
// In `changes`, the rows up to the first `removed` are the run the routine takes on, in order, and
// the rest are the lines it takes away. `before` is absent on an `added` row, `after` on a `removed`
// one; `loggedSets` rides on a `removed` row alone.
//   plan        : { "routine": "Push A",
//                   "entries": [ { "exerciseId", "sets", "reps"?, "weightKg"?, "restSeconds"? } ] }
//
// An absent rep target means `max`.
//   stats out   : { "weeks": [ { "startedAt", "sessions", "workingSets" } ],
//                   "movements": [ { "exerciseId", "lastTrainedAt",
//                                    "points":    [ { "at", "weightKg", "reps", "e1rm"? } ],
//                                    "bestE1rm"?: { "weightKg", "reps", "at", "e1rm"? },
//                                    "heaviest"?: { "weightKg", "reps", "at", "e1rm"? } } ] }
//   record out  : { "exercise": { "id", "name", … },  "routineCount": n,  "sessionCount": n,
//                   "routines"?: ["Push A", "Legs"],   the days that name it; count == length
//                   "bestE1rm"?: { "weightKg", "reps", "at", "e1rm" },
//                   "heaviest"?: { "weightKg", "reps", "at", "e1rm"? },
//                   "e1rmSeries"?: [ { "at", "weightKg", "reps", "e1rm" } ],   oldest first
//                   "records"?:    [ { "at", "weightKg", "reps", "e1rm" } ],   newest first
//                   "recentDays"?: [ { "sessionId", "startedAt", "sets": [ … ] } ] }
//
// The record reply omits empty lists rather than sending `[]`; both counts are always present.
//   shared out  : { "startedAt", "finishedAt"?, "routine"?,
//                   "sets": [ { "exercise", "setNumber", "weightKg", "reps", "kind", "rpe"?,
//                               "note", "completedAt" } ] }
//   review out  : { "stats": { "durationMs", "workingSets", "topE1rm"? }, "slight": bool,
//                   "record"?: { "kind": "e1rm"|"heaviest"|"reps-at-weight", "exerciseId", "value",
//                                "weightKg", "reps", "previous", "previousAt" },
//                   "against"?: { "sessionId", "routine"?, "startedAt",
//                                 "movements": [ { "exerciseId",
//                                                  "now":     { "weightKg", "reps", "sets" },
//                                                  "before"?: { "weightKg", "reps", "sets" },
//                                                  "planned"?: { "sets", "reps"?, "weightKg"? } } ] } }

// Entry order is the routine's order: entries in carry no position, the codec numbers them 1..n in
// arrival order, and entries out carry the number.

//   note in     : { "title": "…", "body": "…" }          PUT /v1/gym/notes/{id}
//   note out    : { "id": "note_…", "position": n, "title": "…", "body": "…", "updatedAt": ms }
//   notes out   : { "notes": [ <note> ] }                  GET /v1/gym/notes, position ascending
//   order in    : { "order": [ "note_…", … ] }             PUT /v1/gym/notes — every note, once
//
// A note's id is the client's to mint (`note_<hex>`), the same discipline as `thr_<hex>`. Position
// is precedence and the store's to assign: a new id lands last, and the whole order is replaced
// with one write.
//   weigh-in in : { "weightKg": n, "recordedAt": ms }     PUT /v1/gym/bodyweight/{dateLocal}
//   weigh-in out: { "dateLocal": "YYYY-MM-DD", "weightKg": n, "recordedAt": ms }
//   weigh-ins out: { "entries": [ <weigh-in> ], "latest": <weigh-in> | null }
//                                                       GET /v1/gym/bodyweight?from=&to=
//
// The day is the identity — the lifter's own calendar, never an instant — and kilograms are the
// only unit on the wire, rounded to two decimals as the column stores them. `recordedAt` is the
// device's clock at the save and decides only which of two writes to one day is newer. `latest` is
// the account's newest day whatever window was asked for.
//   threads out : { "threads": [ <thread> ] }                GET /v1/gym/threads
//   thread out  : { "id": "thr_…", "title": "…", "createdAt": ms, "askedAt": ms,
//                   "outcome": { "kind": "read-only"|"proposed"|"applied"|"dismissed"|"superseded",
//                                "changes": n, "routineId"?: "rt_…", "routine"?: "Push A" },
//                   "proposals": [ { "id", "state", "changeCount", "routineId", "routine",
//                                    "createdAt" } ],
//                   "turns"?: [ { "from": "lifter"|"ask", "text": "…", "at": ms } ] }
//                                                       GET · DELETE /v1/gym/threads/{id}
//
// `title` is the lifter's first message, verbatim. `routineId`/`routine` are omitted where the
// thread's changes landed on more than one routine. `turns` ride on the conversation's own read
// alone, so their absence on the list read means "not on this read".
//
// `plan` is jsonb on the session row and an object on the wire; PgLogRepository serializes through
// this codec pair. The routine name stays a plain string at the top level: the prefill's SQL
// type-checks `jsonb_typeof(plan->'routine') = 'string'`. Reading a stored plan clamps.

// Every instant on the wire is parsed against the domain's (0, kMaxInstantMs] band.

// `joinOpenSession` omitted is true: the start continues whatever workout is open. `false` is
// refused 409 `session-already-open` rather than joined.

SessionStart parseSessionStart(const Json::Value& body);   // throws InvalidTraining
SetWrite parseSetWrite(const Json::Value& body);           // throws InvalidTraining
// A correction carries only the fields it changes. `rpe: null` clears it; an empty body is legal.
SetFix parseSetFix(const Json::Value& body);               // throws InvalidTraining
std::uint64_t parseFinish(const Json::Value& body);        // { "finishedAt": ms }; throws InvalidTraining
RoutineWrite parseRoutineWrite(const Json::Value& body);   // throws InvalidTraining
// `position` is not a field here.
ProposalWrite parseProposalWrite(const Json::Value& body, const ProposalSource& source);
ExerciseWrite parseExerciseWrite(const Json::Value& body); // throws InvalidTraining
std::string parseExerciseRename(const Json::Value& body);  // throws InvalidTraining
// The whole document. The owner is the caller's, never the body's; omitted fields take their
// defaults, and every refusal carries a machine `code`.
GymPreferences parsePreferences(const Json::Value& body, const UserId& user);  // throws InvalidPreference
// The id is the path's and the owner the caller's; the entity applies the three bounds.
Note parseNoteWrite(const Json::Value& body, const NoteId& id, const UserId& user);  // throws InvalidTraining
std::vector<NoteId> parseNotesOrder(const Json::Value& body);                        // throws InvalidTraining
// The day is the path's and the owner the caller's; the entity applies the band and the calendar.
Bodyweight parseBodyweightWrite(const Json::Value& body, const std::string& dateLocal,
                                const UserId& user);   // throws InvalidTraining

Json::Value toJson(const Session& session);
// `topE1rm` is the best estimate over every working set; `topSet` is only the heaviest, and no e1RM
// may be computed from it. `topE1rm` is rounded as a value, so 20.7 can reach a client as
// 20.699999999999999: clients format and never re-round.
Json::Value toJson(const LogRow& row);
Json::Value toJson(const Set& set);
Json::Value toJson(const std::vector<Set>& sets);
Json::Value toJson(const Exercise& exercise);
Json::Value toJson(const std::vector<Exercise>& exercises);
// One line per movement this lifter has trained; a movement with no row has never been logged.
Json::Value toJson(const std::vector<LastSet>& movements);
Json::Value toJson(const Routine& routine);
Json::Value toJson(const Routine& routine, const std::optional<ProposalHead>& pending);
Json::Value toJson(const std::vector<Routine>& routines, const std::vector<ProposalHead>& pending);
Json::Value toJson(const ProposalHead& head);
Json::Value toJson(const RoutineProposal& proposal);
Json::Value toJson(const std::vector<ProposalHead>& heads);
// The outcome is computed here rather than stored.
Json::Value toJson(const ThreadOutcome& outcome);
Json::Value toJson(const AskThread& thread);
Json::Value toJson(const std::vector<AskThread>& threads);
// Composed onto the single-routine read by the handler; the list read must not carry it.
Json::Value toJson(const std::vector<RoutineEvent>& history);
Json::Value toJson(const PlanSnapshot& plan);
// An omitted `restSeconds` means the timer is off.
Json::Value toJson(const GymPreferences& preferences);
Json::Value toJson(const Note& note);
Json::Value toJson(const std::vector<Note>& notes);   // the array; the handler wraps it
Json::Value toJson(const Bodyweight& entry);
Json::Value toJson(const std::vector<Bodyweight>& entries);   // the array; the handler wraps it
Json::Value toJson(const Review& review);
// The share omits the ids and the frozen plan: a reader who is not the owner gets neither.
Json::Value toJson(const Statistics& statistics);
Json::Value toJson(const MovementRecord& record);
Json::Value toJson(const SharedSession& shared);
Json::Value toJson(const ReadTally& tally);
std::optional<PlanSnapshot> planFrom(const Json::Value& stored);   // clamps, never throws

// Takes the app's base url — where the browser app is served — not the API's.
std::string shareUrl(const std::string& appBaseUrl, const std::string& token);
std::string proposalUrl(const std::string& appBaseUrl, const ProposalId& id);

}
