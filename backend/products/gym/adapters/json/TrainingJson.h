#pragma once

#include "products/gym/application/LogService.h"

#include <json/value.h>

#include <cstdint>
#include <optional>
#include <vector>

namespace wm::gym {

// The wire boundary for training data. A cross-surface contract — web, iOS, Android and later the
// MCP tools all speak it — so it lives in one place and changes deliberately. Instants are epoch-ms
// numbers, weights are numbers in kg. Optional fields are OMITTED when absent (rpe, finishedAt,
// routineId, plan, lastTrainedAt, targetReps, targetWeightKg, restSeconds, topSet), never null;
// note is always present.
//
//   session in  : { "id": "ses_…", "startedAt": ms, "joinOpenSession"?: bool, "routineId"?: "rt_…" }
//   set in      : { "id": "set_…", "exerciseId": "…", "weightKg": n, "reps": n, "completedAt": ms,
//                   "kind"?: "warmup"|"working"|"drop"|"failure", "rpe"?: n, "note"?: "…" }
//   routine in  : { "id": "rt_…", "name": "…", "position": n,
//                   "entries": [ { "exerciseId": "…", "targetSets": n, "targetReps"?: n,
//                                  "targetWeightKg"?: n, "restSeconds"?: n } ] }
//   movement in : { "id": "ex_…", "name": "…", "pattern": "squat"|…, "equipment": "barbell"|…,
//                   "stepKg"?: n }
//   session out : { "id", "startedAt", "finishedAt"?, "routineId"?, "plan"? }
//   log row out : the session, plus { "setCount", "exercises": ["…"],
//                                     "topSet"?: { "weightKg", "reps" }, "closedItself": bool }
//   set out     : { "id", "exerciseId", "setNumber", "weightKg", "reps", "kind", "rpe"?, "note",
//                   "completedAt" }
//   exercise out: { "id", "name", "pattern", "equipment", "stepKg", "custom" }
//   routine out : { "id", "name", "position", "lastTrainedAt"?,
//                   "entries": [ { "position", "exerciseId", "targetSets", "targetReps"?,
//                                  "targetWeightKg"?, "restSeconds"? } ] }
//   plan        : { "routine": "Push A",
//                   "entries": [ { "exerciseId", "sets", "reps"?, "weightKg"?, "restSeconds"? } ] }
//
// An absent rep target — on a routine entry, on the frozen plan's line, and on the review's
// `planned` — is the canon's `3 × max`: the chin-up line, which a required targetReps could not
// express at all. It is an omission that MEANS something, exactly like an absent target weight,
// and every surface draws it as `max`.
//   stats out   : { "weeks": [ { "startedAt", "sessions", "workingSets" } ],
//                   "movements": [ { "exerciseId", "lastTrainedAt",
//                                    "points":    [ { "at", "weightKg", "reps", "e1rm"? } ],
//                                    "bestE1rm"?: { "weightKg", "reps", "at", "e1rm"? },
//                                    "heaviest"?: { "weightKg", "reps", "at", "e1rm"? } } ] }
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
// order they arrived in, and entries out carry the number so a client can print it. A per-entry id
// would be a second identity to keep in step with the store's key, which is (routine_id, position).
// On a replace the PATH names the routine; the body's `id` is the same routine on any read-modify-
// write and the path is what the store is asked for.

// `plan` is the one shape written at BOTH edges — jsonb on the session row and an object on the
// wire — so its codec pair lives here, once, and PgTrainingRepository serializes through it. The
// name stays a plain STRING at the top level because the prefill's SQL type-checks exactly that
// (`jsonb_typeof(plan->'routine') = 'string'`); anything else there and the card silently loses the
// day of the program it was trained on. Reading a stored plan CLAMPS the way every other stored
// value does — a blob no writer of ours can produce reads as the sane part of itself rather than
// failing the whole session read.

// Every instant on the wire — startedAt, completedAt, finishedAt — is parsed against the domain's
// (0, kMaxInstantMs] band, so a unit-confused device is refused here rather than at to_timestamp().
// The same ceiling is the log cursor's "no cursor: from now".

// The review travels ONE WAY and has no parse half: every number in it is computed from stored rows
// on each read, so there is nothing for a client to send back and nothing to keep in step. Its
// absences are the shape — `topE1rm` is absent when nothing was loaded, `record` on the ~190
// sessions in 200 that earn none, `against` for an ad-hoc session or one with no earlier match, and
// `routine` when the session it stands against carries no name — and a slight session says so in
// `slight` while omitting both of the lines it would otherwise have earned.
//
// `joinOpenSession` is the caller's intent, not a field about the session: omitted it is true, the
// Start that continues whatever workout is open (the phone's, and the handoff's). `false` is the
// Start that means "create exactly this session, which is not now" — backfill and lift-import — and
// it is refused 409 `session-already-open` rather than joined.

SessionStart parseSessionStart(const Json::Value& body);   // throws InvalidTraining
SetWrite parseSetWrite(const Json::Value& body);           // throws InvalidTraining
std::uint64_t parseFinish(const Json::Value& body);        // { "finishedAt": ms }; throws InvalidTraining
RoutineWrite parseRoutineWrite(const Json::Value& body);   // throws InvalidTraining
ExerciseWrite parseExerciseWrite(const Json::Value& body); // throws InvalidTraining

Json::Value toJson(const Session& session);
Json::Value toJson(const SessionSummary& summary);
Json::Value toJson(const Set& set);
Json::Value toJson(const std::vector<Set>& sets);
Json::Value toJson(const Exercise& exercise);
Json::Value toJson(const std::vector<Exercise>& exercises);
Json::Value toJson(const Routine& routine);
Json::Value toJson(const std::vector<Routine>& routines);
Json::Value toJson(const PlanSnapshot& plan);
Json::Value toJson(const Review& review);
// The other two one-way shapes, for the same reason the review is one: every number in them is
// computed or read on each call and there is nothing for a client to send back. The share's is
// deliberately NOT `toJson(const Session&)` — that one carries the ids and the frozen plan, and a
// reader who is not the owner gets neither (ports/TrainingRepository.h says why).
Json::Value toJson(const Statistics& statistics);
Json::Value toJson(const SharedSession& shared);
std::optional<PlanSnapshot> planFrom(const Json::Value& stored);   // clamps, never throws

}
