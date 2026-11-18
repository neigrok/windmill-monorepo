#pragma once

#include "platform/application/WorkerPool.h"
#include "platform/application/sync/Admission.h"
#include "platform/application/sync/ServerCall.h"
#include "platform/domain/sync/Digest.h"
#include "platform/domain/sync/Wire.h"
#include "test/platform/application/sync/SyncWorld.h"
#include "test/testing.h"

#include <json/json.h>

#include <cstddef>
#include <map>
#include <stdexcept>
#include <string>
#include <variant>

// The server's readings of the golden corpus (corpus/README.md, "Server files"), over any SyncWorld: the
// domain binary runs them over the fakes, the sync binary over Postgres.

namespace wm::sync::test {

// A vector's `limits` knobs over the engine's constants. A knob this runner cannot configure fails the vector
// rather than leaving it to run under the default.
inline Limits limitsOf(const Json::Value& input) {
  Limits limits;
  const std::map<std::string, std::size_t*> knobs{{"MAX_RECORD_BYTES", &limits.maxRecordBytes},
                                                  {"PUSH_MAX_INTENTS", &limits.pushMaxIntents},
                                                  {"PUSH_MAX_BYTES", &limits.pushMaxBytes},
                                                  {"EFFECT_MAX_BYTES", &limits.effectMaxBytes},
                                                  {"RECEIPT_MAX_BYTES", &limits.receiptMaxBytes},
                                                  {"SCOPED_RESPONSE_MAX_BYTES", &limits.scopedResponseMaxBytes},
                                                  {"PULL_PAGE_BYTES", &limits.pullPageBytes},
                                                  {"PULL_MAX_BYTES", &limits.pullMaxBytes}};
  for (const std::string& name : input["limits"].getMemberNames()) {
    const auto knob = knobs.find(name);
    if (knob == knobs.end()) throw std::logic_error("the runner configures no limit " + name);
    *knob->second = input["limits"][name].asUInt64();
    if (name == "RECEIPT_MAX_BYTES" && (*knob->second == 0 || *knob->second > Limits{}.receiptMaxBytes)) throw std::logic_error("receipt budget only shrinks");
    if (name == "SCOPED_RESPONSE_MAX_BYTES" && (*knob->second == 0 || *knob->second > Limits{}.scopedResponseMaxBytes)) throw std::logic_error("response budget only shrinks");
    if (name == "EFFECT_MAX_BYTES" && (*knob->second == 0 || *knob->second > Limits{}.effectMaxBytes)) throw std::logic_error("effect budget only shrinks");
  }
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

class EffectPlanRules final : public TypeRules {
public:
  EffectPlanRules(SyncWorld& world, const Json::Value& plan) : world_(world), plan_(plan) {}

  std::set<ScopeKey> discoverEffectScopes(const CheckCtx& ctx) override {
    std::set<ScopeKey> targets;
    std::set<TypeRules*> seen;
    for (const Delta& delta : ctx.intent.d) {
      TypeRules* rule = world_.catalog().rules(delta.t);
      if (!rule || !seen.insert(rule).second) continue;
      const auto own = rule->discoverEffectScopes(ctx);
      targets.insert(own.begin(), own.end());
    }
    for (const auto& key : plan_["declared"]) targets.insert(world_.storeKey(key.asString()));
    return targets;
  }

  Effects effects(const CheckCtx& ctx, const std::vector<Change>& changes) override {
    if (plan_.isMember("legacyTypes")) {
      CheckCtx local = ctx;
      local.localScopes.clear();
      for (const auto& change : changes) {
        for (const auto& type : plan_["legacyTypes"]) {
          if (change.type->name == type.asString()) local.localScopes.insert(change.scope);
        }
      }
      for (const auto& delta : ctx.intent.d) {
        for (const auto& type : plan_["legacyTypes"]) {
          if (delta.t == type.asString()) local.localScopes.insert(ctx.scope.key);
        }
      }
      return TypeRules::effects(local, changes);
    }
    Effects result;
    std::set<TypeRules*> seen;
    for (const Change& change : changes) {
      TypeRules* rule = world_.catalog().rules(change.type->name);
      if (!rule || !seen.insert(rule).second) continue;
      CheckCtx local = ctx;
      local.localScopes.clear();
      for (const auto& change : changes) {
        if (world_.catalog().rules(change.type->name) == rule) local.localScopes.insert(change.scope);
      }
      for (const auto& delta : ctx.intent.d) {
        if (world_.catalog().rules(delta.t) == rule) local.localScopes.insert(ctx.scope.key);
      }
      const Effects own = rule->effects(local, changes);
      for (const auto& [key, deltas] : own.byScope) result.byScope[key].insert(result.byScope[key].end(), deltas.begin(), deltas.end());
    }
    append(result, "check", ctx.caller.account, ctx.serverNow);
    return result;
  }

  void append(Effects& result, const std::string& phase, const UserId& account, Ms now) {
    for (const std::string& key : plan_[phase].getMemberNames()) {
      const ScopeKey scope = world_.storeKey(key);
      for (const Json::Value& delta : plan_[phase][key]) {
        Json::Value wire(Json::objectValue);
        wire["scope"] = scope.ref();
        wire["d"].append(delta);
        wire["d"][0].removeMember("v");
        std::map<std::string, TextWrite> replacements;
        for (const std::string& name : delta["x"].getMemberNames()) {
          const auto& text = delta["x"][name];
          if (text["replace"] != Json::Value(true)) continue;
          const auto archive = text.get("archive", Json::Value(Json::objectValue));
          if (phase != "command" || !text["text"].isString() || !archive.isObject()) throw Refusal(code::invalid);
          replacements.emplace(name, TextWrite{.text = text["text"].asString(), .replacement = true,
            .archiveNonempty = text["archiveNonempty"] == Json::Value(true), .archive = archive});
          wire["d"][0]["x"][name] = object({{"text", text["text"]}, {"base", object({{"rev", 0}})}});
        }
        auto shaped = shapeIntent(world_.catalog().registry(), wire, Sender{account, true}, now, 300'000);
        for (auto& [name, text] : replacements) shaped.intent.d.front().x[name] = std::move(text);
        for (const std::string& name : delta["v"].getMemberNames()) shaped.intent.d.front().v[name] = delta["v"][name];
        result.byScope[scope].push_back(std::move(shaped.intent.d.front()));
      }
    }
  }

private:
  SyncWorld& world_;
  const Json::Value& plan_;
};

class EffectPlanCommand final : public SyncCommand {
public:
  EffectPlanCommand(SyncCommand& command, EffectPlanRules& effects, SyncWorld& world, const Json::Value& plan)
      : command_(command), effects_(effects), world_(world), plan_(plan) {}

  bool isReplay(CommandCtx& ctx) override { return command_.isReplay(ctx); }

  std::set<ScopeKey> discoverEffectScopes(const CommandCtx& ctx) override {
    auto targets = command_.discoverEffectScopes(ctx);
    for (const auto& key : plan_["declared"]) targets.insert(world_.storeKey(key.asString()));
    return targets;
  }

  CommandOutcome run(CommandCtx& ctx) override {
    auto result = command_.run(ctx);
    Effects effects;
    effects_.append(effects, "command", ctx.caller.account, ctx.serverNow);
    for (auto& [key, deltas] : effects.byScope) result.into.push_back(IntoScope{key, std::move(deltas)});
    if (plan_.isMember("detail")) result.detail = plan_["detail"];
    return result;
  }

private:
  SyncCommand& command_;
  EffectPlanRules& effects_;
  SyncWorld& world_;
  const Json::Value& plan_;
};

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

  const SyncCatalog* catalog = &world.catalog();
  SyncCatalog planned(catalog->registry());
  EffectPlanRules effects(world, input["effectPlan"]);
  std::vector<std::unique_ptr<EffectPlanCommand>> commands;
  if (input.isMember("effectPlan")) {
    for (const TypeDef& type : catalog->registry().types()) planned.bindType(catalog->store(type.name), &effects);
    for (const CommandDef& command : catalog->registry().commands()) {
      if (command.engine) continue;
      commands.push_back(std::make_unique<EffectPlanCommand>(catalog->command(command.name), effects, world, input["effectPlan"]));
      planned.bindCommand(command.name, *commands.back());
    }
    planned.seal();
    catalog = &planned;
  }
  Admission admission(*catalog, world.store(), world.feed, world.clock(), world.failures, limitsOf(input));
  const UserId account = world.account(origin["account"].asString());
  const Origin who = replica ? Origin(ReplicaOrigin{account, replicaId, origin["n"].asUInt64(), intentDigest(input["intent"])})
                             : Origin(ServerOrigin{account, std::nullopt});
  const auto reportsBefore = world.failures.reports.size();
  const auto publicationsBefore = world.feed.published.size();
  const AdmitOutcome outcome = admission.admit(who, input["intent"], input["serverNow"].asUInt64());
  const Admitted* admitted = std::get_if<Admitted>(&outcome);
  if (!admitted && !input["effectPlan"]["fault"].asBool()) throw std::logic_error("the admission was not admitted: " + std::to_string(outcome.index()));

  Json::Value after = world.dump();
  checkDigests(after);
  if (replica) {
    after["replicas"].removeMember(replicaId);
    after["results"].removeMember(replicaId);
    if (after["replicas"].empty()) after.removeMember("replicas");
    if (after["results"].empty()) after.removeMember("results");
  }
  if (input["effectPlan"]["fault"].asBool()) {
    CHECK(world.failures.reports.size() > reportsBefore);
    CHECK_EQ(world.feed.published.size(), publicationsBefore);
    if (admitted) CHECK_EQ(jcs(admitted->result), R"({"code":"internal","s":"refused"})");
    else CHECK(std::holds_alternative<Retry>(outcome));
    return object({{"fault", true}, {"state", after}});
  }
  return object({{"result", admitted->result}, {"state", after}});
}

inline Json::Value gymAdmitVector(SyncWorld& world, const Json::Value& input) {
  Json::Value answer = admitVector(world, input);
  if (answer["result"]["s"] != "ok") return answer;
  const std::string scope = "acct:" + input["origin"]["account"].asString() + "/gym";
  Json::Value& product = answer["state"]["product"];
  // The reference's empty book namespaces have no SQL rows.
  if (input["intent"]["cmd"]["name"] == "gym.start" && !product["starts"].isMember(scope)) product["starts"][scope] = Json::Value(Json::objectValue);
  return answer;
}

inline Json::Value journalAdmitVector(SyncWorld& world, const Json::Value& input) {
  return admitVector(world, input);
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
