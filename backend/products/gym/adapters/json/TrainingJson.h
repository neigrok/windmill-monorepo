#pragma once

#include "products/gym/application/CatalogService.h"
#include "products/gym/application/ProgramService.h"
#include "products/gym/application/TrainingService.h"
#include "products/gym/domain/Preferences.h"
#include "products/gym/domain/ReadReceipt.h"
#include "products/gym/domain/Thread.h"

#include <json/value.h>

#include <cstdint>
#include <optional>
#include <vector>

namespace wm::gym {

// The wire boundary for training data, spoken by web, iOS, Android and the MCP tools. Instants are
// epoch-ms numbers, weights are numbers in kg. Optional fields are OMITTED when absent (rpe,
// finishedAt, routineId, plan, lastTrainedAt, targetReps, targetWeightKg, restSeconds, topSet,
// topE1rm), never null; note is always present.
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
// A LINE WITH NO `targetSets` IS OPEN — the absence and never a zero, on the way in and on the way
// out, in the frozen plan and in a proposal's diff. A routine holding one is savable as it stands.
//
// A routine with no `lastTrainedAt` has never been trained; there is no second field saying so.
//
// `history` rides on `GET /v1/gym/routines/{id}` and nowhere else. Its `created` row is always last
// and always present. `by` is absent when the day was the lifter's own; `movements` is absent where
// the ledger did not record it.
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
// `revision` is the routine's concurrency token: a client READS it and never sends it.
// `pendingProposal` is present only while one is waiting.
//
// A proposal's `changes` are its DIFF and its DOCUMENT at once (domain/Proposal.h): the rows up to
// the first `removed` are the run the routine takes on, in order, and the rest are the lines it
// takes away. `before` is absent on an `added` row, `after` on a `removed` one. `loggedSets` rides
// on a `removed` row alone and is counted at READ time. `connection` and `agent` are omitted while
// the transport carries neither.
//   plan        : { "routine": "Push A",
//                   "entries": [ { "exerciseId", "sets", "reps"?, "weightKg"?, "restSeconds"? } ] }
//
// An absent rep target — on a routine entry, on the frozen plan's line, and on the review's
// `planned` — means `max`, and every surface draws it that way.
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
// The record page is the one reply here whose LISTS are omitted when empty rather than sent as
// `[]`: a movement where Epley is undefined carries no `bestE1rm`, no `e1rmSeries` and no
// `records`. Both counts are always present — zero is a real answer there.
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

// A routine travels as its WHOLE document, on the create and on the replace alike, and its ENTRY
// ORDER is the routine's order: entries in carry no position, the codec numbers them 1..n from the
// order they arrived in, and entries out carry the number. On a replace the PATH names the routine.

//   threads out : { "threads": [ <thread> ] }                GET /v1/gym/threads
//   thread out  : { "id": "thr_…", "title": "…", "createdAt": ms, "askedAt": ms,
//                   "outcome": { "kind": "read-only"|"proposed"|"applied"|"dismissed"|"superseded",
//                                "changes": n, "routineId"?: "rt_…", "routine"?: "Push A" },
//                   "proposals": [ { "id", "state", "changeCount", "routineId", "routine",
//                                    "createdAt" } ],
//                   "turns"?: [ { "from": "lifter"|"ask", "text": "…", "at": ms } ] }
//                                                       GET · DELETE /v1/gym/threads/{id}
//
// `title` IS THE LIFTER'S FIRST MESSAGE, VERBATIM — stored as sent, byte for byte. Every field of
// `outcome` is something the SERVER OBSERVED: the state the ledger holds, the change count it
// stored at the mint, the routine it can name.
//
// `routineId`/`routine` are omitted where the thread's changes landed on more than one routine.
// `turns` rides on the conversation's own read alone, so its absence on the LIST means "not on this
// read". On that read, a thread with no turns is real — the row is committed before the model runs.
//
// `plan` is the one shape written at BOTH edges — jsonb on the session row and an object on the
// wire — so its codec pair lives here, once, and PgLogRepository serializes through it. The name
// stays a plain STRING at the top level because the prefill's SQL type-checks exactly that
// (`jsonb_typeof(plan->'routine') = 'string'`). Reading a stored plan CLAMPS.

// Every instant on the wire — startedAt, completedAt, finishedAt — is parsed against the domain's
// (0, kMaxInstantMs] band, so a unit-confused device is refused here rather than at to_timestamp().
// The same ceiling is the log cursor's "no cursor: from now".

// The review travels ONE WAY and has no parse half. Its absences are the shape — `topE1rm` when
// nothing was loaded, `record` on a session that earns none, `against` for an ad-hoc session or one
// with no earlier match, `routine` when the session it stands against carries no name — and a
// slight session says so in `slight` while omitting both of the lines it would otherwise carry.
//
// `joinOpenSession` is the caller's intent, not a field about the session: omitted it is true and
// the Start continues whatever workout is open. `false` means "create exactly this session" and is
// refused 409 `session-already-open` rather than joined.

SessionStart parseSessionStart(const Json::Value& body);   // throws InvalidTraining
SetWrite parseSetWrite(const Json::Value& body);           // throws InvalidTraining
// A correction carries only the fields it changes and is STRICT about the ones it does not
// (domain/Training.h names the three it refuses). `rpe: null` is the one null that means something
// — clear it — and every other field type-checks strictly. An EMPTY body is legal and changes
// nothing.
SetFix parseSetFix(const Json::Value& body);               // throws InvalidTraining
std::uint64_t parseFinish(const Json::Value& body);        // { "finishedAt": ms }; throws InvalidTraining
RoutineWrite parseRoutineWrite(const Json::Value& body);   // throws InvalidTraining
// What an agent proposes, read through the very same entry parser a routine write uses. `position`
// is not a field here (application/ProgramService.h), and the source rides beside the body.
ProposalWrite parseProposalWrite(const Json::Value& body, const ProposalSource& source);
ExerciseWrite parseExerciseWrite(const Json::Value& body); // throws InvalidTraining
// The rename carries ONE field. The id is the path's, and a movement's pattern, equipment and step
// are not this write's to touch.
std::string parseExerciseRename(const Json::Value& body);  // throws InvalidTraining
// The settings document, whole, every time. The OWNER is the caller's and never the body's.
// Every field is optional and an OMITTED one takes its default; present values type-check strictly,
// and an unknown unit is refused rather than downgraded. Every refusal is an InvalidPreference
// carrying a machine `code`.
GymPreferences parsePreferences(const Json::Value& body, const UserId& user);  // throws InvalidPreference

Json::Value toJson(const Session& session);
// `topE1rm` is the best estimate over every working set the session held; `topSet` is only its
// heaviest. Clients must not compute an e1RM of their own from `topSet`.
// Every double here leaves as a JSON number, not a decimal string. `topE1rm` is rounded to one
// decimal as a VALUE (domain/Review.h); the text is not, so `20.7` can reach a client as
// `20.699999999999999` and parse back to exactly the double the domain rounded. Clients parse and
// format; nothing re-rounds or re-derives the estimate.
Json::Value toJson(const LogRow& row);
Json::Value toJson(const Set& set);
Json::Value toJson(const std::vector<Set>& sets);
Json::Value toJson(const Exercise& exercise);
Json::Value toJson(const std::vector<Exercise>& exercises);
// One line per movement this lifter has trained and no line for any other — a movement with no row
// here is the picker's `never logged`. It rides BESIDE the catalog rather than on it.
Json::Value toJson(const std::vector<LastSet>& movements);
Json::Value toJson(const Routine& routine);
// The routine as every LIST and every single read hands it over: the plan, and the one proposal
// standing on it, travelling together so no surface needs a second round trip per routine.
Json::Value toJson(const Routine& routine, const std::optional<ProposalHead>& pending);
Json::Value toJson(const std::vector<Routine>& routines, const std::vector<ProposalHead>& pending);
Json::Value toJson(const ProposalHead& head);
Json::Value toJson(const RoutineProposal& proposal);
Json::Value toJson(const std::vector<ProposalHead>& heads);
// The list read carries no turns; the conversation's own read carries them all. The OUTCOME is
// computed here rather than stored — `outcomeOf` over the proposals riding with the thread.
Json::Value toJson(const ThreadOutcome& outcome);
Json::Value toJson(const AskThread& thread);
Json::Value toJson(const std::vector<AskThread>& threads);
// The routine's own dated ledger, both kinds of row in one list (ports/ProgramRepository.h).
// Composed onto the single-routine read by the handler; the LIST read must not carry it.
Json::Value toJson(const std::vector<RoutineEvent>& history);
Json::Value toJson(const PlanSnapshot& plan);
// The same shape parsePreferences reads in — a client PUTs back exactly what it was handed. An
// omitted `restSeconds` means the timer is off.
Json::Value toJson(const GymPreferences& preferences);
Json::Value toJson(const Review& review);
// One-way shapes, like the review. The share's is deliberately NOT `toJson(const Session&)`: that
// one carries the ids and the frozen plan, and a reader who is not the owner gets neither.
Json::Value toJson(const Statistics& statistics);
Json::Value toJson(const MovementRecord& record);
Json::Value toJson(const SharedSession& shared);
// What a read served, riding in that read's own reply — `{"sets": 214, "sessions": 34,
// "weeks": 12}`. About the CALL rather than the log (domain/ReadReceipt.h).
Json::Value toJson(const ReadTally& tally);
std::optional<PlanSnapshot> planFrom(const Json::Value& stored);   // clamps, never throws

// The one place a share token becomes a link. It takes the APP's base url — where the browser app
// is served — not the API's; in production one origin answers both.
std::string shareUrl(const std::string& appBaseUrl, const std::string& token);
// Where a lifter opens the diff and taps. It rides in every mint's receipt.
std::string proposalUrl(const std::string& appBaseUrl, const ProposalId& id);

}
