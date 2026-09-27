#include "platform/application/sync/SyncService.h"

#include "platform/application/WorkerPool.h"
#include "platform/application/sync/Admission.h"
#include "platform/domain/sync/Digest.h"
#include "platform/domain/sync/Jcs.h"
#include "platform/domain/sync/Wire.h"
#include "platform/ports/ChangeFeed.h"

#include "test/platform/Fakes.h"
#include "test/platform/application/sync/ServeCorpusRunners.h"
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
// its intents in, the pull scope limit, a scope larger than one feed read, an intent a concurrent push of the
// same replica answered first, step 4's last_n read under the replica row's lock rather than at the bind, a
// transient failure of that read, step 6 answering without the lock, a binding another account holds by the time
// its intent is admitted, and a binding a concurrent push answered under by the time a 409 would delete it.

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

// A store whose `nth` read of a replica row under its lock (replica FOR UPDATE or bindReplica, counted together)
// first runs `then` on the transaction taking it: a concurrent push that committed just before that lock was
// granted, or a lock that timed out.
class BeforeReplicaLock final : public sync::fake::ForwardingStore {
public:
  BeforeReplicaLock(SyncStore& inner, int nth, std::function<void(SyncTxn&)> then) : ForwardingStore(inner), nth_(nth), then_(std::move(then)) {}

  std::optional<ReplicaRow> replica(SyncTxn& txn, const std::string& replica, RowLock lock) override {
    if (lock != RowLock::none && ++locks_ == nth_) then_(txn);
    return ForwardingStore::replica(txn, replica, lock);
  }

  ReplicaRow bindReplica(SyncTxn& txn, const std::string& replica, const UserId& account, Ms now) override {
    if (++locks_ == nth_) then_(txn);
    return ForwardingStore::bindReplica(txn, replica, account, now);
  }

private:
  int nth_;
  int locks_ = 0;
  std::function<void(SyncTxn&)> then_;
};

// What a concurrent push committed, in the transaction about to read it and in the store every later one reads.
void committedMeanwhile(test::FakeWorld& world, SyncTxn& txn, const std::function<void(sync::fake::FakeDb&)>& change) {
  change(sync::fake::dbOf(txn));
  change(world.db());
}

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

  const SyncReply reply = service.push(world.account("A"), jcs(request), budget);

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

  const SyncReply refused = service.pull(world.account("A"), jcs(pullOf(65)));

  CHECK_EQ(refused.status, 400);
  CHECK_EQ(jcs(refused.body), jcs(parseJson(R"({"serverTime": 1000000, "epoch": "ep-1", "error": "malformed"})")));
  CHECK_EQ(jcs(world.dump()), jcs(seeded));
  CHECK(world.feed.published.empty());

  const SyncReply served = service.pull(world.account("A"), jcs(pullOf(64)));

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

  const SyncReply reply = service.pull(world.account("A"), R"({"scopes": [{"scope": "self/probe", "cursor": null}]})");

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

  const SyncReply reply = service.push(world.account("A"), jcs(request), budget);

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

    const SyncReply reply = service.push(world.account("A"), jcs(request), budget);

    CHECK_EQ(reply.status, 400);
    CHECK_EQ(jcs(reply.body), jcs(malformed));
  }
  CHECK_EQ(jcs(world.dump()), jcs(seeded));
}

TEST(sync_service_push_spends_no_budget_on_an_n_a_concurrent_push_answered) {
  BlockingThread::Mark blocking;
  test::FakeWorld world;
  const Json::Value second = cardIntent(2, "card0002");
  bool answered = false;
  AfterCommit concurrentPush([&world, &second, &answered] {
    if (std::exchange(answered, true)) return;
    world.db().replicas.at("rp_0000000000000000000000000000000a").lastN = 2;
    world.db().results[{"rp_0000000000000000000000000000000a", 2}] =
        StoredResult{2, intentDigest(second), parseJson(R"({"s": "ok", "seq": 7})"), 0};
  });
  Admission admission(world.catalog(), world.store(), concurrentPush, world.clock(), world.failures);
  wm::fake::FakeClock clock;
  clock.now = 1'000'000;
  SyncService service(world.catalog(), world.store(), admission, clock);
  Json::Value request = parseJson(R"({"replica": "rp_0000000000000000000000000000000a", "ackThrough": 0, "intents": []})");
  request["intents"].append(cardIntent(1, "card0001"));
  request["intents"].append(second);
  request["intents"].append(cardIntent(3, "card0003"));
  test::CountBudget twoAdmissions(2);

  const SyncReply reply = service.push(world.account("A"), jcs(request), twoAdmissions);

  CHECK_EQ(reply.status, 200);
  CHECK_EQ(jcs(reply.body), jcs(parseJson(R"({"serverTime": 1000000, "epoch": "ep-1", "lastN": 3,
      "results": [{"n": 1, "s": "ok", "seq": 1}, {"n": 2, "s": "ok", "seq": 7}, {"n": 3, "s": "ok", "seq": 2}]})")));
}

TEST(sync_service_push_compares_each_n_with_last_n_read_under_the_replica_lock_never_the_one_it_bound_at) {
  BlockingThread::Mark blocking;
  test::FakeWorld world;
  world.seed(parseJson(R"({"epoch": "ep-1", "clock": {"ms": 0, "counter": 0},
      "replicas": {"rp_0000000000000000000000000000000a": {"account": "A", "lastN": 0}}})"));
  // Between the bind (reads 1 and 2) and step 4's read of n 3 (read 3), an overlapping push admits n 1 and 2.
  BeforeReplicaLock store(world.store(), 3, [&world](SyncTxn& txn) {
    committedMeanwhile(world, txn, [](sync::fake::FakeDb& db) {
      db.replicas.at("rp_0000000000000000000000000000000a").lastN = 2;
      db.results[{"rp_0000000000000000000000000000000a", 2}] = StoredResult{2, Digest256{}, parseJson(R"({"s": "ok", "seq": 7})"), 0};
    });
  });
  Admission admission(world.catalog(), store, world.feed, world.clock(), world.failures);
  wm::fake::FakeClock clock;
  clock.now = 1'000'000;
  SyncService service(world.catalog(), store, admission, clock);
  Json::Value request = parseJson(R"({"replica": "rp_0000000000000000000000000000000a", "ackThrough": 2, "intents": []})");
  request["intents"].append(cardIntent(3, "card0003"));
  TimeBudget budget(60'000);

  const SyncReply reply = service.push(world.account("A"), jcs(request), budget);

  CHECK_EQ(reply.status, 200);
  CHECK_EQ(jcs(reply.body), jcs(parseJson(R"({"serverTime": 1000000, "epoch": "ep-1", "lastN": 3, "results": [{"n": 3, "s": "ok", "seq": 1}]})")));
}

TEST(sync_service_push_answers_the_results_so_far_with_a_retry_when_step_4_s_read_times_out) {
  BlockingThread::Mark blocking;
  test::FakeWorld world;
  // Reads 1 and 2 bind, 3 is n 1's turn, 4 its admission, 5 n 2's turn.
  BeforeReplicaLock store(world.store(), 5, [](SyncTxn&) { throw sync::fake::InjectedTransient("lock_timeout on sync_replicas"); });
  Admission admission(world.catalog(), store, world.feed, world.clock(), world.failures);
  wm::fake::FakeClock clock;
  clock.now = 1'000'000;
  SyncService service(world.catalog(), store, admission, clock);
  Json::Value request = parseJson(R"({"replica": "rp_0000000000000000000000000000000a", "ackThrough": 0, "intents": []})");
  request["intents"].append(cardIntent(1, "card0001"));
  request["intents"].append(cardIntent(2, "card0002"));
  TimeBudget budget(60'000);

  const SyncReply reply = service.push(world.account("A"), jcs(request), budget);

  CHECK_EQ(reply.status, 200);
  CHECK_EQ(jcs(reply.body), jcs(parseJson(R"({"serverTime": 1000000, "epoch": "ep-1", "lastN": 1,
      "results": [{"n": 1, "s": "ok", "seq": 1}], "retry": {"n": 2, "retryAfterMs": 1000}})")));
}

TEST(sync_service_push_prunes_and_answers_last_n_without_waiting_on_the_replica_lock) {
  BlockingThread::Mark blocking;
  test::FakeWorld world;
  // Reads 1 and 2 bind, 3 is n 1's turn, 4 its admission: a fifth lock, a slow overlapping admission's, times out.
  BeforeReplicaLock store(world.store(), 5, [](SyncTxn&) { throw sync::fake::InjectedTransient("lock_timeout on sync_replicas"); });
  Admission admission(world.catalog(), store, world.feed, world.clock(), world.failures);
  wm::fake::FakeClock clock;
  clock.now = 1'000'000;
  SyncService service(world.catalog(), store, admission, clock);
  Json::Value request = parseJson(R"({"replica": "rp_0000000000000000000000000000000a", "ackThrough": 1, "intents": []})");
  request["intents"].append(cardIntent(1, "card0001"));
  TimeBudget budget(60'000);

  const SyncReply reply = service.push(world.account("A"), jcs(request), budget);

  CHECK_EQ(reply.status, 200);
  CHECK_EQ(jcs(reply.body), jcs(parseJson(R"({"serverTime": 1000000, "epoch": "ep-1", "lastN": 1, "results": [{"n": 1, "s": "ok", "seq": 1}]})")));
  CHECK_EQ(jcs(world.dump()["replicas"]), jcs(parseJson(R"({"rp_0000000000000000000000000000000a": {"account": "A", "lastN": 1}})")));
  CHECK_FALSE(world.dump().isMember("results"));
}

TEST(sync_service_push_answers_replica_foreign_when_another_account_holds_the_binding_by_the_admission) {
  BlockingThread::Mark blocking;
  test::FakeWorld world;
  world.seed(parseJson(R"({"epoch": "ep-1", "clock": {"ms": 0, "counter": 0},
      "replicas": {"rp_0000000000000000000000000000000a": {"account": "A", "lastN": 0}}})"));
  // The admission's step 3.3 (read 4) finds the binding B's: a 409 took it from A and B's push bound it again.
  BeforeReplicaLock store(world.store(), 4, [&world](SyncTxn& txn) {
    committedMeanwhile(world, txn, [&world](sync::fake::FakeDb& db) { db.replicas.at("rp_0000000000000000000000000000000a").account = world.account("B"); });
  });
  Admission admission(world.catalog(), store, world.feed, world.clock(), world.failures);
  wm::fake::FakeClock clock;
  clock.now = 1'000'000;
  SyncService service(world.catalog(), store, admission, clock);
  Json::Value request = parseJson(R"({"replica": "rp_0000000000000000000000000000000a", "ackThrough": 0, "intents": []})");
  request["intents"].append(cardIntent(1, "card0001"));
  TimeBudget budget(60'000);

  const SyncReply reply = service.push(world.account("A"), jcs(request), budget);

  CHECK_EQ(reply.status, 409);
  CHECK_EQ(jcs(reply.body), jcs(parseJson(R"({"serverTime": 1000000, "epoch": "ep-1", "error": "replica-foreign"})")));
  CHECK_EQ(jcs(world.dump()["replicas"]), jcs(parseJson(R"({"rp_0000000000000000000000000000000a": {"account": "B", "lastN": 0}})")));
  CHECK(world.feed.published.empty());
}

TEST(sync_service_push_409_keeps_a_binding_it_inserted_once_a_concurrent_push_tallied_a_fault_under_it) {
  BlockingThread::Mark blocking;
  test::FakeWorld world;
  const Json::Value first = cardIntent(1, "card0001");
  // Reads 1 and 2 bind, read 3 finds n 2 a gap, read 4 is the 409's.
  BeforeReplicaLock store(world.store(), 4, [&first](SyncTxn& txn) {
    sync::fake::dbOf(txn).results[{"rp_0000000000000000000000000000000a", 1}] = StoredResult{1, intentDigest(first), std::nullopt, 1};
  });
  Admission admission(world.catalog(), store, world.feed, world.clock(), world.failures);
  wm::fake::FakeClock clock;
  clock.now = 1'000'000;
  SyncService service(world.catalog(), store, admission, clock);
  Json::Value request = parseJson(R"({"replica": "rp_0000000000000000000000000000000a", "ackThrough": 0, "intents": []})");
  request["intents"].append(cardIntent(2, "card0002"));
  TimeBudget budget(60'000);

  const SyncReply reply = service.push(world.account("A"), jcs(request), budget);

  CHECK_EQ(reply.status, 409);
  CHECK_EQ(jcs(reply.body), jcs(parseJson(R"({"serverTime": 1000000, "epoch": "ep-1", "error": "gap"})")));
  Json::Value tallied = parseJson(R"({"rp_0000000000000000000000000000000a": [{"n": 1, "result": null, "faults": 1}]})");
  tallied["rp_0000000000000000000000000000000a"][0]["digest"] = intentDigest(first).hex();
  CHECK_EQ(jcs(world.dump()["replicas"]), jcs(parseJson(R"({"rp_0000000000000000000000000000000a": {"account": "A", "lastN": 0}})")));
  CHECK_EQ(jcs(world.dump()["results"]), jcs(tallied));
}
