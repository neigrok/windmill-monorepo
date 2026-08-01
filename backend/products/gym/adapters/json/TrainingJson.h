#pragma once

#include "products/gym/application/LogService.h"

#include <json/value.h>

#include <cstdint>
#include <vector>

namespace wm::gym {

// The wire boundary for training data. A cross-surface contract — web, iOS, Android and later the
// MCP tools all speak it — so it lives in one place and changes deliberately. Instants are epoch-ms
// numbers, weights are numbers in kg. Optional fields are OMITTED when absent (rpe, finishedAt,
// routineId, plan), never null; note is always present.
//
//   session in  : { "id": "ses_…", "startedAt": ms }
//   set in      : { "id": "set_…", "exerciseId": "…", "weightKg": n, "reps": n, "completedAt": ms,
//                   "kind"?: "warmup"|"working"|"drop"|"failure", "rpe"?: n, "note"?: "…" }
//   session out : { "id", "startedAt", "finishedAt"?, "routineId"?, "plan"? }
//   set out     : { "id", "exerciseId", "setNumber", "weightKg", "reps", "kind", "rpe"?, "note",
//                   "completedAt" }
//   exercise out: { "id", "name", "pattern", "equipment", "stepKg", "custom" }

// Every instant on the wire — startedAt, completedAt, finishedAt — is parsed against the domain's
// (0, kMaxInstantMs] band, so a unit-confused device is refused here rather than at to_timestamp().
// The same ceiling is the log cursor's "no cursor: from now".

SessionStart parseSessionStart(const Json::Value& body);   // throws InvalidTraining
SetWrite parseSetWrite(const Json::Value& body);           // throws InvalidTraining
std::uint64_t parseFinish(const Json::Value& body);        // { "finishedAt": ms }; throws InvalidTraining

Json::Value toJson(const Session& session);
Json::Value toJson(const Set& set);
Json::Value toJson(const std::vector<Set>& sets);
Json::Value toJson(const Exercise& exercise);
Json::Value toJson(const std::vector<Exercise>& exercises);

}
