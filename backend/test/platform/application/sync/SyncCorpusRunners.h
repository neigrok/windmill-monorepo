#pragma once

#include "platform/application/WorkerPool.h"
#include "platform/application/sync/Admission.h"
#include "platform/application/sync/ServerCall.h"
#include "platform/domain/sync/Digest.h"
#include "platform/domain/sync/Wire.h"
#include "test/platform/application/sync/SyncWorld.h"
#include "test/testing.h"

#include <json/json.h>

#include <stdexcept>
#include <string>
#include <variant>

// The server's readings of the golden corpus (corpus/README.md, "Server files"), over any SyncWorld: the
// domain binary runs them over the fakes, the sync binary over Postgres.

namespace wm::sync::test {

// A vector's `limits` knobs over the engine's constants.
inline Limits limitsOf(const Json::Value& input) {
  Limits limits;
  const Json::Value& knobs = input["limits"];
  if (knobs.isMember("MAX_RECORD_BYTES")) limits.maxRecordBytes = knobs["MAX_RECORD_BYTES"].asUInt64();
  if (knobs.isMember("PUSH_MAX_INTENTS")) limits.pushMaxIntents = knobs["PUSH_MAX_INTENTS"].asUInt64();
  if (knobs.isMember("PUSH_MAX_BYTES")) limits.pushMaxBytes = knobs["PUSH_MAX_BYTES"].asUInt64();
  if (knobs.isMember("PULL_PAGE_BYTES")) limits.pullPageBytes = knobs["PULL_PAGE_BYTES"].asUInt64();
  return limits;
}

inline Json::Value object(std::initializer_list<std::pair<const char*, Json::Value>> members) {
  Json::Value value(Json::objectValue);
  for (const auto& [key, member] : members) value[key] = member;
  return value;
}

// §6.12 in a dumped state: every scope's stored digest is the sum over its alive rows.
inline void checkDigests(const Json::Value& state) {
  for (const std::string& key : state["scopes"].getMemberNames()) {
    const std::vector<Json::Value> rows(state["rows"][key].begin(), state["rows"][key].end());
    const std::string recomputed = scopeDigest(rows).hex();
    CHECK_EQ(recomputed, state["scopes"][key]["digest"].asString());
  }
}

// admit/*.json: §6.1 steps 1–16 for one intent, with no push bookkeeping. A replica origin is bound at n − 1
// for the admission and its binding and result are left out of the answer, as the vectors carry none.
inline Json::Value admitVector(SyncWorld& world, const Json::Value& input) {
  BlockingThread::Mark blocking;
  const Json::Value& origin = input["origin"];
  const bool replica = origin["kind"].asString() == "replica";
  const std::string replicaId = origin["replica"].asString();
  Json::Value state = input["state"];
  if (replica) state["replicas"][replicaId] = object({{"account", origin["account"]}, {"lastN", origin["n"].asUInt64() - 1}});
  world.seed(state);

  Admission admission(world.catalog(), world.store(), world.feed, world.clock(), world.failures, limitsOf(input));
  const UserId account = world.account(origin["account"].asString());
  const Origin who = replica ? Origin(ReplicaOrigin{account, replicaId, origin["n"].asUInt64(), intentDigest(input["intent"])})
                             : Origin(ServerOrigin{account, std::nullopt});
  const AdmitOutcome outcome = admission.admit(who, input["intent"], input["serverNow"].asUInt64());
  const Admitted* admitted = std::get_if<Admitted>(&outcome);
  if (!admitted) throw std::logic_error("the admission was not admitted: " + std::to_string(outcome.index()));

  Json::Value after = world.dump();
  checkDigests(after);
  if (replica) {
    after["replicas"].removeMember(replicaId);
    after["results"].removeMember(replicaId);
    if (after["replicas"].empty()) after.removeMember("replicas");
    if (after["results"].empty()) after.removeMember("results");
  }
  return object({{"result", admitted->result}, {"state", after}});
}

// admit/requests.json: §6.3 for each call in order. `crashAfter: k` stops right after part k commits;
// `transientAt: k` and `faultAt: k` fail admit k inside its own transaction (fake::FaultingStore), transiently
// or as a fault, and the call stops at the answer Admission gives.
inline Json::Value requestsVector(SyncWorld& world, const Json::Value& input) {
  BlockingThread::Mark blocking;
  world.seed(input["state"]);
  Json::Value results(Json::arrayValue);
  for (const Json::Value& call : input["calls"]) {
    fake::FaultingStore::Faults faults;
    if (call.isMember("transientAt")) faults.parts.emplace(call["transientAt"].asInt(), FaultClass::transient);
    if (call.isMember("faultAt")) faults.parts.emplace(call["faultAt"].asInt(), FaultClass::fault);
    fake::FaultingStore store(world.store(), faults);
    Admission admission(world.catalog(), store, world.feed, world.clock(), world.failures, limitsOf(input));
    const Ms serverNow = call["serverNow"].asUInt64();
    const std::optional<std::string> requestId = call.isMember("requestId") ? std::optional(call["requestId"].asString()) : std::nullopt;
    ServerCall server(admission, store, world.account(call["account"].asString()), requestId, call["tool"].asString(), call["args"]);
    Json::Value result(Json::nullValue);
    bool stopped = false;
    for (Json::ArrayIndex i = 0; i < call["intents"].size(); ++i) {
      const AdmitOutcome outcome = server.admit(call["intents"][i], serverNow);
      if (const CallAnswered* answered = std::get_if<CallAnswered>(&outcome)) {
        result = answered->result;
        stopped = true;
        break;
      }
      if (std::holds_alternative<Retry>(outcome)) {
        result = Json::Value(Json::nullValue);
        stopped = true;
        break;
      }
      result = std::get<Admitted>(outcome).result;
      if (call["crashAfter"].asInt() == static_cast<int>(i) + 1) {
        result = Json::Value(Json::nullValue);
        stopped = true;
        break;
      }
      if (result["s"].asString() == "refused") break;
    }
    if (!stopped) server.finish(result, serverNow);
    results.append(result);
  }
  return object({{"results", results}, {"state", world.dump()}});
}

}
