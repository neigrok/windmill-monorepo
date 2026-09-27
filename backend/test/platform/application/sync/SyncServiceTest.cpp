#include "platform/application/sync/SyncService.h"

#include "platform/application/WorkerPool.h"
#include "platform/application/sync/Admission.h"
#include "platform/domain/sync/Digest.h"
#include "platform/domain/sync/Jcs.h"
#include "platform/domain/sync/Wire.h"
#include "platform/ports/ChangeFeed.h"

#include "test/platform/Fakes.h"
#include "test/platform/application/sync/SyncWorld.h"
#include "test/testing.h"

#include <chrono>
#include <cstdint>
#include <functional>
#include <string>
#include <thread>
#include <utility>
#include <vector>

// What the golden corpus does not pin about SyncService: the production push budget, the order a push takes
// its intents in, the pull scope limit, a scope larger than one feed read, and an intent a concurrent push of
// the same replica answered first.

using namespace wm;
using namespace wm::sync;

namespace {

// A card create in A's probe scope as a replica's intent n.
Json::Value cardIntent(std::uint64_t n, const std::string& id) {
  Json::Value intent = parseJson(R"({"scope": "self/probe", "d": [{"t": "card", "born": "2000:0:r_aaaaaaaaaaaa",
      "life": ["alive", "2000:0:r_aaaaaaaaaaaa"], "f": {"title": ["Card", "2000:0:r_aaaaaaaaaaaa"]}}]})");
  intent["n"] = Json::UInt64(n);
  intent["d"][0]["id"] = id;
  return intent;
}

// Runs `then` after each admission commits, while that admission still holds its scope: a stand-in for what
// another request does in between.
class AfterCommit final : public ChangeFeed {
public:
  explicit AfterCommit(std::function<void()> then) : then_(std::move(then)) {}
  void publish(const CommittedChange&) override { then_(); }

private:
  std::function<void()> then_;
};

}

TEST(time_budget_is_spent_only_once_an_intent_was_admitted_and_its_work_time_passed) {
  TimeBudget unexpired(60'000);
  CHECK_FALSE(unexpired.spent(0));
  CHECK_FALSE(unexpired.spent(3));

  TimeBudget expired(1);
  std::this_thread::sleep_for(std::chrono::milliseconds(5));
  CHECK_FALSE(expired.spent(0));
  CHECK(expired.spent(1));
}

TEST(sync_service_push_takes_intents_in_ascending_n_whatever_order_the_request_carries) {
  BlockingThread::Mark blocking;
  test::FakeWorld world;
  Admission admission(world.catalog(), world.store(), world.feed, world.clock(), world.failures);
  wm::fake::FakeClock clock;
  clock.now = 1'000'000;
  SyncService service(world.catalog(), world.store(), admission, clock);
  const Json::Value first = cardIntent(1, "card0001");
  const Json::Value second = cardIntent(2, "card0002");
  Json::Value request = parseJson(R"({"replica": "rp_0000000000000000000000000000000a", "ackThrough": 0, "intents": []})");
  request["intents"].append(second);
  request["intents"].append(first);
  TimeBudget budget(60'000);

  const SyncReply reply = service.push(world.account("A"), request, budget);

  CHECK_EQ(reply.status, 200);
  CHECK_EQ(jcs(reply.body), jcs(parseJson(R"({"serverTime": 1000000, "epoch": "ep-1", "lastN": 2,
      "results": [{"n": 1, "s": "ok", "seq": 1}, {"n": 2, "s": "ok", "seq": 2}]})")));
  Json::Value stored = parseJson(R"({"rp_0000000000000000000000000000000a": [
      {"n": 1, "result": {"s": "ok", "seq": 1}, "faults": 0}, {"n": 2, "result": {"s": "ok", "seq": 2}, "faults": 0}]})");
  stored["rp_0000000000000000000000000000000a"][0]["digest"] = intentDigest(first).hex();
  stored["rp_0000000000000000000000000000000a"][1]["digest"] = intentDigest(second).hex();
  CHECK_EQ(jcs(world.dump()["results"]), jcs(stored));
}

TEST(sync_service_pull_of_more_than_pull_max_scopes_is_malformed_and_runs_no_before_pull) {
  BlockingThread::Mark blocking;
  test::FakeWorld world;
  const Json::Value openRun = parseJson(R"({"t": "run", "id": "run0000st", "life": ["alive", "400000:0:srv"], "born": "400000:0:srv",
      "f": {"startedAt": [400000, "400000:0:srv"]}, "seq": 1, "rc": 1000, "ru": 1000})");
  Json::Value state = parseJson(R"({"epoch": "ep-1", "clock": {"ms": 400000, "counter": 0},
      "scopes": {"acct:A/probe": {"kind": "product", "owner": "A", "state": "alive", "seq": 1, "counters": {}}}})");
  state["scopes"]["acct:A/probe"]["digest"] = rowHash(openRun).hex();
  state["rows"]["acct:A/probe"].append(openRun);
  world.seed(state);
  const Json::Value seeded = world.dump();
  Admission admission(world.catalog(), world.store(), world.feed, world.clock(), world.failures);
  wm::fake::FakeClock clock;
  clock.now = 1'000'000;
  SyncService service(world.catalog(), world.store(), admission, clock);
  auto pullOf = [](int scopes) {
    Json::Value request = parseJson(R"({"scopes": []})");
    for (int i = 0; i < scopes; ++i) request["scopes"].append(parseJson(R"({"scope": "self/probe", "cursor": null})"));
    return request;
  };

  const SyncReply refused = service.pull(world.account("A"), pullOf(65));

  CHECK_EQ(refused.status, 400);
  CHECK_EQ(jcs(refused.body), jcs(parseJson(R"({"serverTime": 1000000, "epoch": "ep-1", "error": "malformed"})")));
  CHECK_EQ(jcs(world.dump()), jcs(seeded));
  CHECK(world.feed.published.empty());

  const SyncReply served = service.pull(world.account("A"), pullOf(64));

  CHECK_EQ(served.status, 200);
  CHECK_EQ(served.body["pages"].size(), 64u);
  CHECK_EQ(world.feed.published.size(), 1u);
}

TEST(sync_service_boot_pages_a_scope_larger_than_one_feed_read_in_seq_then_id_order) {
  BlockingThread::Mark blocking;
  test::FakeWorld world;
  std::vector<Json::Value> rows;
  std::vector<Json::Value> bySeq(8, Json::Value(Json::arrayValue));
  for (int i = 0; i < 600; ++i) {
    Json::Value run = parseJson(R"({"t": "run", "life": ["alive", "1000:0:r_aaaaaaaaaaaa"], "born": "1000:0:r_aaaaaaaaaaaa",
        "f": {"startedAt": [999000, "1000:0:r_aaaaaaaaaaaa"]}, "rc": 1000, "ru": 1000})");
    const std::string ordinal = std::to_string(i);
    run["id"] = "run" + std::string(5 - ordinal.size(), '0') + ordinal;
    run["seq"] = i % 7 + 1;
    rows.push_back(run);
    bySeq[i % 7 + 1].append(run);
  }
  Json::Value state = parseJson(R"({"epoch": "ep-1", "clock": {"ms": 0, "counter": 0},
      "scopes": {"acct:A/probe": {"kind": "product", "owner": "A", "state": "alive", "seq": 7, "counters": {}}}})");
  state["scopes"]["acct:A/probe"]["digest"] = scopeDigest(rows).hex();
  for (const Json::Value& run : rows) state["rows"]["acct:A/probe"].append(run);
  world.seed(state);
  Admission admission(world.catalog(), world.store(), world.feed, world.clock(), world.failures);
  wm::fake::FakeClock clock;
  clock.now = 1'000'000;
  SyncService service(world.catalog(), world.store(), admission, clock);

  const SyncReply reply = service.pull(world.account("A"), parseJson(R"({"scopes": [{"scope": "self/probe", "cursor": null}]})"));

  Json::Value body = parseJson(R"({"serverTime": 1000000, "epoch": "ep-1",
      "pages": [{"scope": "self/probe", "kind": "rows", "rows": [], "more": false, "seq": 7, "total": 600}]})");
  for (int seq = 1; seq <= 7; ++seq) {
    for (const Json::Value& run : bySeq[seq]) body["pages"][0]["rows"].append(run);
  }
  body["pages"][0]["cursor"] = Cursor{.epoch = "ep-1", .live = true, .seq = 7}.encode();
  body["pages"][0]["digest"] = scopeDigest(rows).hex();
  CHECK_EQ(reply.status, 200);
  CHECK_EQ(jcs(reply.body), jcs(body));
}

TEST(sync_service_push_answers_an_n_a_concurrent_push_answered_with_the_result_it_stored) {
  BlockingThread::Mark blocking;
  test::FakeWorld world;
  const Json::Value first = cardIntent(1, "card0001");
  const Json::Value second = cardIntent(2, "card0002");
  AfterCommit concurrentPush([&world, &second] {
    world.db().replicas.at("rp_0000000000000000000000000000000a").lastN = 2;
    world.db().results[{"rp_0000000000000000000000000000000a", 2}] =
        StoredResult{2, intentDigest(second), parseJson(R"({"s": "ok", "seq": 7})"), 0};
  });
  Admission admission(world.catalog(), world.store(), concurrentPush, world.clock(), world.failures);
  wm::fake::FakeClock clock;
  clock.now = 1'000'000;
  SyncService service(world.catalog(), world.store(), admission, clock);
  Json::Value request = parseJson(R"({"replica": "rp_0000000000000000000000000000000a", "ackThrough": 0, "intents": []})");
  request["intents"].append(first);
  request["intents"].append(second);
  TimeBudget budget(60'000);

  const SyncReply reply = service.push(world.account("A"), request, budget);

  CHECK_EQ(reply.status, 200);
  CHECK_EQ(jcs(reply.body), jcs(parseJson(R"({"serverTime": 1000000, "epoch": "ep-1", "lastN": 2,
      "results": [{"n": 1, "s": "ok", "seq": 1}, {"n": 2, "s": "ok", "seq": 7}]})")));
  CHECK_EQ(world.dump()["scopes"]["acct:A/probe"]["seq"].asUInt64(), 1u);
}

TEST(sync_service_push_from_a_replica_id_outside_d3_is_malformed_and_binds_nothing) {
  BlockingThread::Mark blocking;
  test::FakeWorld world;
  const Json::Value seeded = world.dump();
  Admission admission(world.catalog(), world.store(), world.feed, world.clock(), world.failures);
  wm::fake::FakeClock clock;
  clock.now = 1'000'000;
  SyncService service(world.catalog(), world.store(), admission, clock);
  const Json::Value malformed = parseJson(R"({"serverTime": 1000000, "epoch": "ep-1", "error": "malformed"})");

  for (const char* replica : {"rp_0000000000000000000000000000000A", "rp_000000000000000000000000000000a", "r_aaaaaaaaaaaa"}) {
    Json::Value request = parseJson(R"({"ackThrough": 0, "intents": []})");
    request["replica"] = replica;
    request["intents"].append(cardIntent(1, "card0001"));
    TimeBudget budget(60'000);

    const SyncReply reply = service.push(world.account("A"), request, budget);

    CHECK_EQ(reply.status, 400);
    CHECK_EQ(jcs(reply.body), jcs(malformed));
  }
  CHECK_EQ(jcs(world.dump()), jcs(seeded));
}
