#pragma once

#include "platform/application/WorkerPool.h"
#include "platform/application/sync/Admission.h"
#include "platform/application/sync/SyncService.h"
#include "platform/domain/sync/Jcs.h"
#include "platform/domain/sync/Wire.h"
#include "test/SyncCorpus.h"
#include "test/platform/Fakes.h"
#include "test/platform/application/sync/SyncCorpusRunners.h"
#include "test/platform/application/sync/SyncWorld.h"

#include <json/json.h>

#include <cstddef>
#include <cstdint>
#include <map>
#include <optional>

// The server's readings of push/serve.json, pull/serve.json and pull/hello.json (corpus/README.md) through
// SyncService, over any SyncWorld. Accounts in an input are the corpus's aliases.

namespace wm::sync::test {

// A vector's `budget`: the admissions a push makes before it answers retry; none is no bound.
class CountBudget final : public PushBudget {
public:
  explicit CountBudget(std::optional<std::size_t> admissions) : admissions_(admissions) {}
  bool spent(std::size_t admitted) override { return admissions_ && admitted >= *admissions_; }

private:
  std::optional<std::size_t> admissions_;
};

inline std::optional<UserId> callerOf(const SyncWorld& world, const Json::Value& alias) {
  if (alias.isNull()) return std::nullopt;
  return world.account(alias.asString());
}

inline Json::Value responseOf(const SyncReply& reply) {
  return object({{"status", reply.status}, {"body", reply.body}});
}

// §6.8's live events of every change the world's feed received: a change frame per scope an admission wrote,
// then a death event per scope it killed.
inline Json::Value liveEventsOf(SyncWorld& world, const Limits& limits) {
  Json::Value events(Json::arrayValue);
  for (const CommittedChange& change : world.feed.published) {
    for (const ScopeChange& scope : change.changed) {
      const Json::Value frame = changeFrame(change.epoch, scope.key, scope.seq, scope.digest, scope.rows, limits.liveInlineBytes);
      events.append(object({{"key", world.aliasKey(scope.key)}, {"frame", frame}}));
    }
    for (const ScopeKey& killed : change.killed) events.append(object({{"key", world.aliasKey(killed)}, {"dead", true}}));
  }
  return events;
}

// push/serve.json: §6.2 once, under the vector's budget, faults and limits.
inline Json::Value pushVector(SyncWorld& world, const Json::Value& input) {
  BlockingThread::Mark blocking;
  world.seed(input["state"]);
  const Limits limits = limitsOf(input);
  std::map<std::uint64_t, FaultClass> faults;
  for (const Json::Value& fault : input["faults"]) {
    faults.emplace(fault["n"].asUInt64(), fault["kind"].asString() == "transient" ? FaultClass::transient : FaultClass::fault);
  }
  fake::FaultingStore store(world.store(), faults);
  Admission admission(world.catalog(), store, world.feed, world.clock(), world.failures, limits);
  wm::fake::FakeClock clock;
  clock.now = input["serverNow"].asUInt64();
  SyncService service(world.catalog(), store, admission, clock);
  CountBudget budget(input.isMember("budget") ? std::optional<std::size_t>(input["budget"].asUInt64()) : std::nullopt);

  world.feed.published.clear();
  const SyncReply reply = service.push(callerOf(world, input["account"]), input["request"], budget);
  return object({{"response", responseOf(reply)}, {"state", world.dump()}, {"frames", liveEventsOf(world, limits)}});
}

// pull/serve.json: §6.7 once. The state joins the answer when the beforePull admissions changed it, and their
// live events when there are any.
inline Json::Value pullVector(SyncWorld& world, const Json::Value& input) {
  BlockingThread::Mark blocking;
  world.seed(input["state"]);
  const Json::Value before = world.dump();
  const Limits limits = limitsOf(input);
  Admission admission(world.catalog(), world.store(), world.feed, world.clock(), world.failures, limits);
  wm::fake::FakeClock clock;
  clock.now = input["serverNow"].asUInt64();
  SyncService service(world.catalog(), world.store(), admission, clock);

  world.feed.published.clear();
  const SyncReply reply = service.pull(callerOf(world, input["account"]), input["request"]);
  Json::Value answer = object({{"response", responseOf(reply)}});
  const Json::Value after = world.dump();
  if (jcs(after) != jcs(before)) answer["state"] = after;
  const Json::Value live = liveEventsOf(world, limits);
  if (!live.empty()) answer["live"] = live;
  return answer;
}

// protocol/*.jsonl, the server's half (corpus/README.md "protocol/*.jsonl"): seed the store from the header,
// replay every HTTP exchange with its account, serverNow and inject and compare its response, apply every
// server load, and compare the final store with the end line's. Client actions and frames are the client's.
inline void protocolTranscript(SyncWorld& world, const std::vector<Json::Value>& lines) {
  BlockingThread::Mark blocking;
  world.seed(lines.front()["server"]);
  for (std::size_t i = 1; i < lines.size(); ++i) {
    const Json::Value& line = lines[i];
    if (line.isMember("http")) {
      std::map<std::uint64_t, FaultClass> faults;
      for (const Json::Value& n : line["inject"]["fault"]) faults.emplace(n.asUInt64(), FaultClass::fault);
      fake::FaultingStore store(world.store(), faults);
      Admission admission(world.catalog(), store, world.feed, world.clock(), world.failures);
      wm::fake::FakeClock clock;
      clock.now = line["serverNow"].asUInt64();
      SyncService service(world.catalog(), store, admission, clock);
      const std::optional<UserId> caller = callerOf(world, line["account"]);
      const std::string http = line["http"].asString();
      CountBudget budget(line["inject"].isMember("budget") ? std::optional<std::size_t>(line["inject"]["budget"].asUInt64()) : std::nullopt);
      const SyncReply reply = http == "push" ? service.push(caller, line["request"], budget)
                              : http == "pull" ? service.pull(caller, line["request"])
                                               : service.hello(caller);
      corpus::checkSame(responseOf(reply), line["response"], __FILE__, __LINE__);
      continue;
    }
    if (line["server"].isString() && line["server"].asString() == "load") world.seed(line["state"]);
    if (line["end"].asBool()) corpus::checkSame(world.dump(), line["server"], __FILE__, __LINE__);
  }
}

// pull/hello.json: §9.2 at the vector's serverTime.
inline Json::Value helloVector(SyncWorld& world, const Json::Value& input) {
  BlockingThread::Mark blocking;
  world.seed(input["state"]);
  Admission admission(world.catalog(), world.store(), world.feed, world.clock(), world.failures);
  wm::fake::FakeClock clock;
  clock.now = input["serverTime"].asUInt64();
  SyncService service(world.catalog(), world.store(), admission, clock);
  return object({{"response", responseOf(service.hello(callerOf(world, input["account"])))}});
}

}
