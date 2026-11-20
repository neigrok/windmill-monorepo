#include "platform/application/WorkerPool.h"
#include "platform/adapters/postgres/PgAuthRepository.h"
#include "platform/application/sync/Admission.h"
#include "platform/application/sync/SyncService.h"
#include "platform/domain/sync/Digest.h"
#include "platform/domain/sync/Jcs.h"
#include "test/platform/adapters/postgres/PgSyncWorld.h"
#include "test/platform/application/sync/SyncCorpusRunners.h"
#include "test/testing.h"

#include <algorithm>
#include <atomic>
#include <chrono>
#include <functional>
#include <future>
#include <mutex>
#include <numeric>
#include <set>
#include <string>
#include <thread>
#include <vector>

// §6.1 under concurrency, over Postgres: seq is taken under the scope's lock and committed before it is
// released (INV-5), owner gates serialize that owner's scopes, and a tree's death and its overlays' writes
// order through the row modes of step 3 (INV-13).

using namespace wm;
using namespace wm::sync;

namespace {

constexpr Ms kNow = 1'000'000;

test::PgWorld& world() {
  static test::PgWorld pg;
  return pg;
}

std::string stamp(Ms ms, std::uint32_t counter, const std::string& actor) {
  return std::to_string(ms) + ":" + std::to_string(counter) + ":" + actor;
}

Json::Value scopeJson(const std::string& kind, const std::string& owner, Seq seq, const std::vector<Json::Value>& rows,
                      const std::string& governedBy = "") {
  Json::Value scope = test::object({{"kind", kind}, {"owner", owner}, {"state", "alive"}, {"seq", Json::UInt64(seq)}});
  scope["counters"] = Json::Value(Json::objectValue);
  scope["digest"] = scopeDigest(rows).hex();
  if (!governedBy.empty()) scope["governedBy"] = governedBy;
  return scope;
}

Json::Value rowsOf(const std::vector<Json::Value>& rows) {
  Json::Value list(Json::arrayValue);
  for (const Json::Value& row : rows) list.append(row);
  return list;
}

// A delta over wire JSON text, stamps filled in.
Json::Value intentOf(const std::string& scope, const std::string& delta) {
  Json::Value intent(Json::objectValue);
  intent["scope"] = scope;
  intent["d"].append(parseJson(delta));
  return intent;
}

// Admits until the answer is not a transient Retry.
AdmitOutcome admitSettled(Admission& admission, const Origin& origin, const Json::Value& intent) {
  for (;;) {
    AdmitOutcome outcome = admission.admit(origin, intent, kNow);
    if (!std::holds_alternative<Retry>(outcome)) return outcome;
  }
}

std::string codeOf(const AdmitOutcome& outcome) {
  const Json::Value& result = std::get<Admitted>(outcome).result;
  return result["s"].asString() == "ok" ? "ok" : result["code"].asString();
}

// Holds every saveScope of one scope until released: its admission then holds its stripe and its row locks.
class GateStore final : public fake::ForwardingStore {
public:
  GateStore(SyncStore& inner, ScopeKey gated) : ForwardingStore(inner), gated_(std::move(gated)), released_(release_.get_future().share()) {}

  void saveScope(SyncTxn& txn, const ScopeRow& row) override {
    if (row.key == gated_ && !entered_.exchange(true)) {
      arrived_.set_value();
      released_.wait();
    }
    ForwardingStore::saveScope(txn, row);
  }

  std::future<void> arrival() { return arrived_.get_future(); }
  void release() { release_.set_value(); }

private:
  ScopeKey gated_;
  std::atomic<bool> entered_{false};
  std::promise<void> arrived_;
  std::promise<void> release_;
  std::shared_future<void> released_;
};

// B's replica, which writes B's marks: the probe admits marks from replicas only.
const std::string kMarks = "rp_" + std::string(31, '0') + "b";

ReplicaOrigin markOrigin(std::uint64_t n, const Json::Value& intent) {
  return ReplicaOrigin{world().account("B"), kMarks, n, intentDigest(intent)};
}

// A's product scope with board b_0000000a alive and its public tree holding tag oak; B's mark replica.
void seedBoard() {
  const Json::Value board = parseJson(R"({"t":"board","id":"b_0000000a","life":["alive","900:0:r_aaaaaaaaaaaa"],"born":"900:0:r_aaaaaaaaaaaa","seq":1,"rc":900,"ru":900})");
  const Json::Value meta = parseJson(R"({"t":"meta","id":"meta","f":{"visibility":["public","901:0:srv"]},"seq":1,"rc":901,"ru":901})");
  const Json::Value oak = parseJson(R"({"t":"tag","id":"oak","life":["alive","902:0:r_aaaaaaaaaaaa"],"born":"902:0:r_aaaaaaaaaaaa","seq":2,"rc":902,"ru":902})");
  Json::Value state = parseJson(R"({"epoch": "ep-1", "clock": {"ms": 0, "counter": 0}, "accounts": {"A": {"name": "Ann"}, "B": {"name": "Bob"}}})");
  state["scopes"]["acct:A/probe"] = scopeJson("product", "A", 1, {board});
  state["scopes"]["tree:b_0000000a"] = scopeJson("tree", "A", 2, {meta, oak}, "acct:A/probe#board#b_0000000a");
  state["rows"]["acct:A/probe"] = rowsOf({board});
  state["rows"]["tree:b_0000000a"] = rowsOf({meta, oak});
  state["replicas"][kMarks] = test::object({{"account", "B"}, {"lastN", 0}});
  world().seed(state);
}

std::size_t aliveOverlaysOf(const std::string& tree) {
  PgLease connection{*pgTestPool()};
  pqxx::work txn{*connection};
  return txn.exec("select count(*) from sync_scopes where governed_by = $1 and state = 'alive'", pqxx::params{tree})[0][0].as<std::size_t>();
}

}

TEST(concurrent_admissions_of_one_scope_take_every_seq_once_and_commit_in_seq_order) {
  if (!test::postgresEnabled()) SKIP(test::kNeedsPostgres);
  constexpr int kWriters = 8;
  constexpr int kEach = 200;
  const Json::Value run = parseJson(R"({"t":"run","id":"run00001","life":["alive","500:0:srv"],"born":"500:0:srv","f":{"startedAt":[500,"500:0:srv"]},"seq":1,"rc":500,"ru":500})");
  Json::Value state = parseJson(R"({"epoch": "ep-1", "clock": {"ms": 0, "counter": 0}, "accounts": {"A": {"name": "Ann"}}})");
  state["scopes"]["acct:A/probe"] = scopeJson("product", "A", 1, {run});
  state["rows"]["acct:A/probe"] = rowsOf({run});
  for (int writer = 0; writer < kWriters; ++writer) {
    state["replicas"]["rp_" + std::string(31, '0') + std::to_string(writer)] = test::object({{"account", "A"}, {"lastN", 0}});
  }
  world().seed(state);
  world().feed.published.clear();
  Admission admission(world().catalog(), world().store(), world().feed, world().clock(), world().failures);
  const UserId ann = world().account("A");
  const ScopeKey scope = ScopeKey::product(ann, "probe");

  std::mutex seqsMutex;
  std::vector<Seq> seqs;
  std::atomic<bool> writing{true};
  std::atomic<int> snapshots{0};
  std::atomic<int> holes{0};
  std::thread puller([&] {
    BlockingThread::Mark blocking;
    while (writing) {
      std::unique_ptr<SyncTxn> txn = world().store().begin(TxnMode::snapshot);
      const Seq head = world().store().scope(*txn, scope, RowLock::none)->seq;
      std::vector<Seq> lapSeqs;
      for (const Row& lap : world().catalog().store("lap").feed(*txn, scope, FeedQuery{})) lapSeqs.push_back(lap.seq);
      std::sort(lapSeqs.begin(), lapSeqs.end());
      std::vector<Seq> expected(head > 1 ? head - 1 : 0);
      std::iota(expected.begin(), expected.end(), Seq{2});
      if (lapSeqs != expected) ++holes;
      ++snapshots;
    }
  });
  std::vector<std::thread> writers;
  for (int writer = 0; writer < kWriters; ++writer) {
    writers.emplace_back([&, writer] {
      BlockingThread::Mark blocking;
      const std::string replica = "rp_" + std::string(31, '0') + std::to_string(writer);
      const std::string actor = "r_writer" + std::to_string(writer) + "xxx";
      for (int n = 1; n <= kEach; ++n) {
        const std::string at = stamp(kNow, static_cast<std::uint32_t>(n), actor);
        char id[32];
        std::snprintf(id, sizeof id, "lapW%dN%05d", writer, n);
        const Json::Value intent = intentOf("self/probe", R"({"t":"lap","id":")" + std::string(id) + R"(","born":")" + at + R"(","life":["alive",")" + at +
                                                              R"("],"f":{"runId":["run00001",")" + at + R"("]}})");
        const AdmitOutcome outcome = admitSettled(admission, ReplicaOrigin{ann, replica, static_cast<std::uint64_t>(n), intentDigest(intent)}, intent);
        std::lock_guard lock(seqsMutex);
        seqs.push_back(std::get<Admitted>(outcome).result["seq"].asUInt64());
      }
    });
  }
  for (std::thread& writer : writers) writer.join();
  writing = false;
  puller.join();

  std::sort(seqs.begin(), seqs.end());
  std::vector<Seq> everySeq(kWriters * kEach);
  std::iota(everySeq.begin(), everySeq.end(), Seq{2});
  CHECK_EQ(seqs, everySeq);
  CHECK_EQ(holes.load(), 0);
  CHECK_EQ(snapshots.load() > 0, true);

  std::unique_ptr<SyncTxn> txn = world().store().begin(TxnMode::snapshot);
  CHECK_EQ(world().store().scope(*txn, scope, RowLock::none)->seq, Seq{kWriters * kEach + 1});
  std::vector<std::int64_t> numbers;
  for (const Row& lap : world().catalog().store("lap").feed(*txn, scope, FeedQuery{})) numbers.push_back(lap.v.at("no").asInt64());
  std::sort(numbers.begin(), numbers.end());
  std::vector<std::int64_t> everyNumber(kWriters * kEach);
  std::iota(everyNumber.begin(), everyNumber.end(), std::int64_t{1});
  CHECK_EQ(numbers, everyNumber);

  std::vector<Seq> published;
  for (const CommittedChange& change : world().feed.published) {
    for (const ScopeChange& changed : change.changed) published.push_back(changed.seq);
  }
  CHECK_EQ(published, everySeq);
  test::checkDigests(world().dump());
  CHECK_EQ(world().failures.reports.size(), 0u);
}

TEST(an_admission_holding_its_scope_allows_another_owners_scope) {
  if (!test::postgresEnabled()) SKIP(test::kNeedsPostgres);
  world().seed(parseJson(R"({"epoch": "ep-1", "clock": {"ms": 0, "counter": 0}, "accounts": {"A": {"name": "Ann"}, "B": {"name": "Bob"}}})"));
  const ScopeKey mine = ScopeKey::product(world().account("A"), "probe");
  const ScopeKey theirs = ScopeKey::product(world().account("B"), "probe");
  CHECK_EQ(std::hash<std::string>{}(mine.text()) % 256 != std::hash<std::string>{}(theirs.text()) % 256, true);
  GateStore gate(world().store(), mine);
  Admission admission(world().catalog(), gate, world().feed, world().clock(), world().failures);
  auto card = [](const std::string& id) {
    return intentOf("self/probe", R"({"t":"card","id":")" + id + R"(","born":null,"life":["alive",null],"f":{"title":["Held",null]}})");
  };

  std::future<void> arrived = gate.arrival();
  auto held = std::async(std::launch::async, [&] {
    BlockingThread::Mark blocking;
    return codeOf(admission.admit(ServerOrigin{world().account("A"), std::nullopt}, card("cardHELD"), kNow));
  });
  if (arrived.wait_for(std::chrono::seconds(10)) != std::future_status::ready) {
    CHECK_EQ(held.get(), std::string("held at the gate"));
    return;
  }
  BlockingThread::Mark blocking;
  CHECK_EQ(codeOf(admission.admit(ServerOrigin{world().account("B"), std::nullopt}, card("cardFREE"), kNow)), std::string("ok"));
  CHECK_EQ(held.wait_for(std::chrono::milliseconds(0)) == std::future_status::timeout, true);
  gate.release();
  CHECK_EQ(held.get(), std::string("ok"));
}

TEST(an_absent_delete_and_cross_scope_create_serialize_on_the_global_id_in_both_orders) {
  if (!test::postgresEnabled()) SKIP(test::kNeedsPostgres);
  const Json::Value create = intentOf("self/probe", R"({"t":"card","id":"cardRACE","born":"1000:0:r_aaaaaaaaaaaa","life":["alive","1000:0:r_aaaaaaaaaaaa"],"f":{"title":["Retained","1000:0:r_aaaaaaaaaaaa"]}})");
  const Json::Value remove = intentOf("self/probe", R"({"t":"card","id":"cardRACE","born":"1000:0:r_aaaaaaaaaaaa","life":["dead","2000:0:r_bbbbbbbbbbbb"]})");
  for (const bool deleteFirst : {true, false}) {
    world().seed(parseJson(R"({"epoch":"ep-1","clock":{"ms":0,"counter":0},"accounts":{"A":{"name":"Ann"},"B":{"name":"Bob"}}})"));
    world().feed.published.clear();
    world().failures.reports.clear();
    GateStore gate(world().store(), ScopeKey::product(world().account("A"), "probe"));
    Admission admission(world().catalog(), gate, world().feed, world().clock(), world().failures);
    auto arrival = gate.arrival();
    auto first = std::async(std::launch::async, [&] {
      BlockingThread::Mark blocking;
      return codeOf(admission.admit(ServerOrigin{world().account("A"), std::nullopt}, deleteFirst ? remove : create, kNow));
    });
    const bool arrived = arrival.wait_for(std::chrono::seconds(5)) == std::future_status::ready;
    if (!arrived) {
      gate.release();
      CHECK(arrived);
      CHECK_EQ(first.get(), std::string("ok"));
      continue;
    }
    auto second = std::async(std::launch::async, [&] {
      BlockingThread::Mark blocking;
      return codeOf(admission.admit(ServerOrigin{world().account("B"), std::nullopt}, deleteFirst ? create : remove, kNow));
    });
    const bool waited = second.wait_for(std::chrono::milliseconds(100)) == std::future_status::timeout;
    gate.release();
    CHECK(waited);
    CHECK_EQ(first.get(), std::string("ok"));
    CHECK_EQ(second.get(), std::string(deleteFirst ? "id-taken" : "ok"));
    const Json::Value state = world().dump();
    if (deleteFirst) {
      CHECK_FALSE(state.isMember("rows"));
      CHECK_EQ(jcs(state["spent"]), jcs(parseJson(R"({"acct:A/probe":[{"t":"card","id":"cardRACE","born":"1000:0:r_aaaaaaaaaaaa","lifeStamp":"2000:0:r_bbbbbbbbbbbb","seq":1}]})")));
      CHECK_EQ(state["scopes"]["acct:A/probe"]["counters"]["card"].asInt(), 0);
      BlockingThread::Mark blocking;
      CHECK_EQ(codeOf(admission.admit(ServerOrigin{world().account("A"), std::nullopt}, create, kNow)), std::string("ok"));
      CHECK_FALSE(world().dump().isMember("rows"));
    } else {
      CHECK_FALSE(state.isMember("spent"));
      CHECK_EQ(jcs(state["rows"]), jcs(parseJson(R"({"acct:A/probe":[{"t":"card","id":"cardRACE","born":"1000:0:r_aaaaaaaaaaaa","life":["alive","1000:0:r_aaaaaaaaaaaa"],"f":{"title":["Retained","1000:0:r_aaaaaaaaaaaa"]},"seq":1,"rc":1000000,"ru":1000000}]})")));
    }
    CHECK_EQ(state["scopes"]["acct:A/probe"]["seq"].asUInt64(), 1u);
    test::checkDigests(world().dump());
    CHECK(world().failures.reports.empty());
  }
}

TEST(an_absent_delete_retries_after_id_lock_timeout_and_rolls_back_an_uncommitted_death) {
  if (!test::postgresEnabled()) SKIP(test::kNeedsPostgres);
  BlockingThread::Mark blocking;
  world().seed(parseJson(R"({"epoch":"ep-1","clock":{"ms":0,"counter":0},"accounts":{"A":{"name":"Ann"}},"replicas":{"rp_0000000000000000000000000000000a":{"account":"A","lastN":0}}})"));
  world().feed.published.clear();
  world().failures.reports.clear();
  const Json::Value before = world().dump();
  const Json::Value remove = intentOf("self/probe", R"({"t":"card","id":"cardDEAD","born":"1000:0:r_aaaaaaaaaaaa","life":["dead","2000:0:r_bbbbbbbbbbbb"]})");
  const ReplicaOrigin origin{world().account("A"), "rp_0000000000000000000000000000000a", 1, intentDigest(remove)};
  PgSyncStore store(pgTestPool(), 20);
  fake::FaultingStore fault(store, fake::FaultingStore::Faults{.intents = {{1, FaultClass::transient}}});
  Admission failing(world().catalog(), fault, world().feed, world().clock(), world().failures);
  auto held = world().store().begin(TxnMode::write);
  world().store().lockIds(*held, {{"card", "cardDEAD"}});
  const AdmitOutcome timedOut = failing.admit(origin, remove, kNow);
  held.reset();
  REQUIRE(std::holds_alternative<Retry>(timedOut));
  CHECK_EQ(jcs(world().dump()), jcs(before));

  const AdmitOutcome rolledBack = failing.admit(origin, remove, kNow);
  REQUIRE(std::holds_alternative<Retry>(rolledBack));
  CHECK_EQ(jcs(world().dump()), jcs(before));
  CHECK(world().feed.published.empty());

  Admission recovered(world().catalog(), store, world().feed, world().clock(), world().failures);
  const AdmitOutcome retried = recovered.admit(origin, remove, kNow);
  REQUIRE(std::holds_alternative<Admitted>(retried));
  CHECK_EQ(jcs(std::get<Admitted>(retried).result), R"({"s":"ok","seq":1})");
  const Json::Value state = world().dump();
  CHECK_FALSE(state.isMember("rows"));
  CHECK_EQ(jcs(state["spent"]), jcs(parseJson(R"({"acct:A/probe":[{"t":"card","id":"cardDEAD","born":"1000:0:r_aaaaaaaaaaaa","lifeStamp":"2000:0:r_bbbbbbbbbbbb","seq":1}]})")));
  CHECK_EQ(state["replicas"][origin.replica]["lastN"].asUInt64(), 1u);
  CHECK_EQ(world().feed.published.size(), 1u);
  test::checkDigests(state);
  CHECK(world().failures.reports.empty());
}

TEST(a_tree_write_never_waits_on_an_overlay_write_and_a_death_waits_for_it_then_kills_the_overlay) {
  if (!test::postgresEnabled()) SKIP(test::kNeedsPostgres);
  seedBoard();
  const UserId ann = world().account("A");
  const UserId bob = world().account("B");
  GateStore gate(world().store(), ScopeKey::overlay(bob, "b_0000000a"));
  Admission admission(world().catalog(), gate, world().feed, world().clock(), world().failures);
  const Json::Value mark = intentOf("self/overlay/b_0000000a", R"({"t":"mark","id":"oak","f":{"done":[true,"1000:0:r_bbbbbbbbbbbb"]}})");
  const Json::Value tag = intentOf("tree/b_0000000a", R"({"t":"tag","id":"ash","born":"1000:1:r_aaaaaaaaaaaa","life":["alive","1000:1:r_aaaaaaaaaaaa"]})");
  const Json::Value death = intentOf("self/probe", R"({"t":"board","id":"b_0000000a","born":"900:0:r_aaaaaaaaaaaa","life":["dead","1000:2:r_aaaaaaaaaaaa"]})");

  std::future<void> arrived = gate.arrival();
  auto overlayWrite = std::async(std::launch::async, [&] {
    BlockingThread::Mark blocking;
    return codeOf(admission.admit(markOrigin(1, mark), mark, kNow));
  });
  if (arrived.wait_for(std::chrono::seconds(10)) != std::future_status::ready) {
    CHECK_EQ(overlayWrite.get(), std::string("held at the gate"));
    return;
  }
  BlockingThread::Mark blocking;
  CHECK_EQ(codeOf(admission.admit(ServerOrigin{ann, std::nullopt}, tag, kNow)), std::string("ok"));

  auto boardDeath = std::async(std::launch::async, [&] {
    BlockingThread::Mark blocking;
    return codeOf(admission.admit(ServerOrigin{ann, std::nullopt}, death, kNow));
  });
  CHECK_EQ(boardDeath.wait_for(std::chrono::milliseconds(300)) == std::future_status::timeout, true);
  gate.release();
  CHECK_EQ(overlayWrite.get(), std::string("ok"));
  CHECK_EQ(boardDeath.get(), std::string("ok"));

  std::vector<std::string> killed;
  for (const ScopeKey& key : world().feed.published.back().killed) killed.push_back(world().aliasKey(key));
  CHECK_EQ(killed, (std::vector<std::string>{"acct:B/overlay/b_0000000a", "tree:b_0000000a"}));
  CHECK_EQ(aliveOverlaysOf("tree:b_0000000a"), 0u);
  CHECK_EQ(codeOf(admission.admit(markOrigin(2, mark), mark, kNow)), std::string("not-found"));
  CHECK_EQ(codeOf(admission.admit(ServerOrigin{ann, std::nullopt}, tag, kNow)), std::string("scope-dead"));
}

TEST(racing_overlay_writes_tree_writes_and_the_tree_death_leave_no_overlay_alive) {
  if (!test::postgresEnabled()) SKIP(test::kNeedsPostgres);
  for (int round = 0; round < 5; ++round) {
    seedBoard();
    world().failures.reports.clear();
    const UserId ann = world().account("A");
    Admission admission(world().catalog(), world().store(), world().feed, world().clock(), world().failures);
    std::set<std::string> answers;
    std::mutex answersMutex;
    auto note = [&](const AdmitOutcome& outcome) {
      std::lock_guard lock(answersMutex);
      answers.insert(codeOf(outcome));
    };
    std::thread marks([&] {
      BlockingThread::Mark blocking;
      for (std::uint32_t i = 1; i <= 60; ++i) {
        const Json::Value mark = intentOf("self/overlay/b_0000000a", R"({"t":"mark","id":"oak","f":{"done":[)" + std::string(i % 2 ? "true" : "false") +
                                                                          R"(,")" + stamp(1000, i, "r_bbbbbbbbbbbb") + R"("]}})");
        note(admitSettled(admission, markOrigin(i, mark), mark));
      }
    });
    std::thread tags([&] {
      BlockingThread::Mark blocking;
      for (std::uint32_t i = 1; i <= 60; ++i) {
        const std::string at = stamp(1000, i, "r_aaaaaaaaaaaa");
        note(admitSettled(admission, ServerOrigin{ann, std::nullopt},
                          intentOf("tree/b_0000000a", R"({"t":"tag","id":"t)" + std::to_string(i) + R"(","born":")" + at + R"(","life":["alive",")" + at + R"("]})")));
      }
    });
    std::thread death([&] {
      BlockingThread::Mark blocking;
      std::this_thread::sleep_for(std::chrono::milliseconds(5 * round));
      note(admitSettled(admission, ServerOrigin{ann, std::nullopt},
                        intentOf("self/probe", R"({"t":"board","id":"b_0000000a","born":"900:0:r_aaaaaaaaaaaa","life":["dead","2000:0:r_aaaaaaaaaaaa"]})")));
    });
    marks.join();
    tags.join();
    death.join();

    CHECK_EQ(aliveOverlaysOf("tree:b_0000000a"), 0u);
    for (const std::string& answer : answers) CHECK_EQ(answer == "ok" || answer == "not-found" || answer == "scope-dead", true);
    CHECK_EQ(world().failures.reports.size(), 0u);
    test::checkDigests(world().dump());
  }
}

TEST(apple_takeover_finishes_while_an_unrelated_sync_push_holds_its_replica) {
  if (!test::postgresEnabled()) SKIP(test::kNeedsPostgres);
  world().seed(parseJson(R"({"epoch":"ep-1","clock":{"ms":0,"counter":0},"accounts":{"AX":{"name":"Ann"},"BX":{"name":"Bob"},"CX":{"name":"Cam"}}})"));
  auto footprint = std::make_shared<PgAccountFootprint>(pgTestPool(), std::vector<OwnedTable>{
      {"journal_page","user_id"}, {"gym_sessions","user_id"}, {"sync_replicas","account"}, {"sync_scopes","owner"}});
  PgAuthRepository auth{pgTestPool(), footprint};
  const ProviderIdentity identity{Provider::apple,"pg-sync-takeover",Email{"pg-sync-takeover@example.test"},"",true,false};
  {
    PgLease lease{*pgTestPool()}; pqxx::work txn{*lease};
    txn.exec("DELETE FROM user_identities WHERE provider='apple' AND subject='pg-sync-takeover'");
    txn.commit();
  }
  CHECK(auth.tryBindIdentity(identity, world().account("AX")));
  class ReplicaGate : public fake::ForwardingStore {
  public:
    std::promise<void> arrived, release;
    explicit ReplicaGate(SyncStore& store) : ForwardingStore(store), released(release.get_future().share()) {}
    ReplicaRow bindReplica(SyncTxn& txn, const std::string& replica, const UserId& account, Ms now) override {
      auto row = ForwardingStore::bindReplica(txn, replica, account, now);
      if (++bindings == 2) {
        arrived.set_value();
        released.wait_for(std::chrono::seconds(10));
      }
      return row;
    }
  private:
    std::shared_future<void> released;
    int bindings = 0;
  } gate{world().store()};
  Admission admission(world().catalog(), gate, world().feed, world().clock(), world().failures);
  auto intent = intentOf("self/probe", R"({"t":"card","id":"card0001","born":"1000:0:r_aaaaaaaaaaaa","life":["alive","1000:0:r_aaaaaaaaaaaa"],"f":{"title":["Unrelated","1000:0:r_aaaaaaaaaaaa"]}})");
  intent["n"] = Json::UInt64{1};
  auto request = parseJson(R"({"replica":"rp_000000000000000000000000000000cc","ackThrough":0,"intents":[]})");
  request["account"] = world().account("CX").str();
  request["intents"].append(intent);
  struct PushClock : Clock { UnixMs nowMs() override { return kNow; } } clock;
  SyncService service(world().catalog(), gate, admission, clock);
  auto arrival = gate.arrived.get_future();
  auto push = std::async(std::launch::async, [&] {
    BlockingThread::Mark blocking;
    TimeBudget budget{60'000};
    return service.push(Credential::sent(world().account("CX")), jcs(request), budget);
  });
  const auto arrived = arrival.wait_for(std::chrono::seconds(5));
  CHECK(arrived == std::future_status::ready);
  auto takeover = std::async(std::launch::async, [&] {
    return auth.takeOverIdentity(identity, world().account("AX"), world().account("BX"));
  });
  const auto completed = takeover.wait_for(std::chrono::seconds(2));
  gate.release.set_value();
  CHECK(completed == std::future_status::ready);
  CHECK(takeover.get());
  const auto outcome = push.get();
  CHECK_EQ(outcome.status, 200);
  CHECK_EQ(outcome.body["lastN"].asUInt64(), 1u);
  CHECK_EQ(outcome.body["results"][0]["s"].asString(), std::string("ok"));
  CHECK(!auth.findUserById(world().account("AX")));
  CHECK_EQ(auth.findIdentity(Provider::apple, identity.subject), std::optional<UserId>{world().account("BX")});
  CHECK(world().failures.reports.empty());
}

TEST(pg_admission_opposite_owned_scope_effects_commit_and_publish_in_order) {
  if (!test::postgresEnabled()) SKIP(test::kNeedsPostgres);
  test::PgWorld world;
  auto state = parseJson(R"({"epoch":"ep-1","accounts":{"A":{"name":"Ann"}},"scopes":{
    "tree:b_00000001":{"kind":"tree","owner":"A","seq":0,"state":"alive","counters":{}},
    "tree:b_00000002":{"kind":"tree","owner":"A","seq":0,"state":"alive","counters":{}}}})");
  for (const auto& key : state["scopes"].getMemberNames()) state["scopes"][key]["digest"] = Digest256{}.hex();
  world.seed(state);
  struct Opposite final : TypeRules {
    std::set<ScopeKey> discoverEffectScopes(const CheckCtx&) override {
      return {ScopeKey::tree("b_00000001"), ScopeKey::tree("b_00000002")};
    }
    Effects effects(const CheckCtx& ctx, const std::vector<Change>&) override {
      const ScopeKey other = ScopeKey::tree(ctx.scope.key.treeId() == "b_00000001" ? "b_00000002" : "b_00000001");
      Delta delta{.t = "meta", .id = RecordId(std::string("meta"))};
      delta.lattice.f.emplace("title", Reg("Effect", Stamp{}));
      return Effects{{{other, {delta}}}};
    }
  } rules;
  SyncCatalog catalog(world.catalog().registry());
  for (const auto& type : catalog.registry().types()) catalog.bindType(world.catalog().store(type.name), type.name == "meta" ? &rules : world.catalog().rules(type.name));
  for (const auto& command : catalog.registry().commands()) if (!command.engine) catalog.bindCommand(command.name, world.catalog().command(command.name));
  catalog.seal();
  fake::RecordingChangeFeed feed;
  Admission admission(catalog, world.store(), feed, world.clock(), world.failures);
  std::promise<void> start;
  auto ready = start.get_future().share();
  auto run = [&](const std::string& scope) {
    BlockingThread::Mark blocking;
    if (ready.wait_for(std::chrono::seconds(1)) != std::future_status::ready) throw std::runtime_error("concurrency test timed out");
    auto intent = parseJson(R"({"scope":"","d":[{"t":"meta","id":"meta","f":{"title":["Origin",null]}}]})");
    intent["scope"] = scope;
    return admission.admit(ServerOrigin{world.account("A"), std::nullopt}, intent, 1'000'000);
  };
  auto first = std::async(std::launch::async, run, "tree/b_00000001");
  auto second = std::async(std::launch::async, run, "tree/b_00000002");
  start.set_value();
  CHECK(first.wait_for(std::chrono::seconds(3)) == std::future_status::ready);
  CHECK(second.wait_for(std::chrono::seconds(3)) == std::future_status::ready);
  for (const auto& outcome : {first.get(), second.get()}) {
    REQUIRE(std::holds_alternative<Admitted>(outcome));
    CHECK_EQ(std::get<Admitted>(outcome).result["s"].asString(), "ok");
  }
  REQUIRE_EQ(feed.published.size(), 2u);
  for (std::size_t i = 0; i != 2; ++i) {
    const auto& change = feed.published[i];
    REQUIRE_EQ(change.changed.size(), 2u);
    CHECK(change.changed[0].key != change.changed[1].key);
    CHECK_EQ(change.changed[0].seq, i + 1);
    CHECK_EQ(change.changed[1].seq, i + 1);
  }
  const auto after = world.dump();
  CHECK_EQ(after["scopes"]["tree:b_00000001"]["seq"].asUInt64(), 2u);
  CHECK_EQ(after["scopes"]["tree:b_00000002"]["seq"].asUInt64(), 2u);
  CHECK(world.failures.reports.empty());
}

TEST(pg_foreign_overlay_effect_publication_cannot_follow_tree_death_with_live_rows) {
  if (!test::postgresEnabled()) SKIP(test::kNeedsPostgres);
  BlockingThread::Mark blocking;
  test::PgWorld world;
  auto state = parseJson(R"({"epoch":"ep-1","accounts":{"A":{"name":"Ann"},"B":{"name":"Bob"}},
    "scopes":{"acct:A/probe":{"kind":"product","owner":"A","seq":1,"state":"alive","counters":{}},
      "acct:B/probe":{"kind":"product","owner":"B","seq":0,"state":"alive","counters":{}},
      "tree:b_00000001":{"kind":"tree","owner":"A","seq":1,"state":"alive","counters":{},"governedBy":"acct:A/probe#board#b_00000001"}},
    "rows":{"acct:A/probe":[{"t":"board","id":"b_00000001","life":["alive","1000:0:srv"],"born":"1000:0:srv","seq":1,"rc":1000,"ru":1000}],
      "tree:b_00000001":[{"t":"meta","id":"meta","f":{"visibility":["public","1000:0:srv"]},"seq":1,"rc":1000,"ru":1000}]}})");
  for (const auto& key : state["scopes"].getMemberNames()) {
    const auto& rows = state["rows"][key];
    state["scopes"][key]["digest"] = scopeDigest(std::vector<Json::Value>(rows.begin(), rows.end())).hex();
  }
  state["replicas"][kMarks] = test::object({{"account", "B"}, {"lastN", 0}});
  world.seed(state);
  struct MarkRules final : TypeRules {
    std::set<ScopeKey> discoverEffectScopes(const CheckCtx& ctx) override { return {ScopeKey::product(ctx.caller.account, "probe")}; }
    Effects effects(const CheckCtx& ctx, const std::vector<Change>&) override {
      Delta day{.t = "day", .id = RecordId(std::string("2026-11-17"))};
      day.lattice.life = Life(LifeState::alive, Stamp{});
      day.lattice.f.emplace("score", Reg(1, Stamp{}));
      return Effects{{{ScopeKey::product(ctx.caller.account, "probe"), {day}}}};
    }
  } rules;
  SyncCatalog catalog(world.catalog().registry());
  for (const auto& type : catalog.registry().types()) catalog.bindType(world.catalog().store(type.name), type.name == "mark" ? &rules : world.catalog().rules(type.name));
  for (const auto& command : catalog.registry().commands()) if (!command.engine) catalog.bindCommand(command.name, world.catalog().command(command.name));
  catalog.seal();
  SyncLive live(catalog, world.store(), Limits{});
  auto bob = std::make_shared<fake::RecordingSocket>();
  live.open(bob, world.account("B"));
  live.subscribe(*bob, parseJson(R"(["tree/b_00000001","self/overlay/b_00000001"])"));
  struct DelayedFeed final : ChangeFeed {
    explicit DelayedFeed(SyncLive& live) : live(live) {}
    SyncLive& live;
    std::promise<void> committed;
    std::promise<void> release;
    void publish(const CommittedChange& change) override {
      committed.set_value();
      if (release.get_future().wait_for(std::chrono::seconds(4)) != std::future_status::ready) throw std::runtime_error("publication test timed out");
      live.publish(change);
    }
  } delayed(live);
  Admission overlay(catalog, world.store(), delayed, world.clock(), world.failures);
  Admission death(catalog, world.store(), live, world.clock(), world.failures);
  auto write = std::async(std::launch::async, [&] {
    BlockingThread::Mark worker;
    const auto intent = parseJson(R"({"scope":"self/overlay/b_00000001","d":[{"t":"mark","id":"oak","f":{"done":[true,"1000000:0:r_aaaaaaaaaaaa"]}}]})");
    return overlay.admit(ReplicaOrigin{world.account("B"), kMarks, 1, intentDigest(intent)}, intent, 1'000'000);
  });
  auto committed = delayed.committed.get_future();
  const bool ready = committed.wait_for(std::chrono::seconds(2)) == std::future_status::ready;
  const auto killed = death.admit(ServerOrigin{world.account("A"), std::nullopt},
    parseJson(R"({"scope":"self/probe","d":[{"t":"board","id":"b_00000001","born":"1000:0:srv","life":["dead",null]}]})"), 1'000'001);
  delayed.release.set_value();
  const auto written = write.get();
  REQUIRE(ready);
  REQUIRE(std::holds_alternative<Admitted>(written));
  REQUIRE(std::holds_alternative<Admitted>(killed));
  CHECK_EQ(std::get<Admitted>(written).result["s"].asString(), "ok");
  CHECK_EQ(std::get<Admitted>(killed).result["s"].asString(), "ok");
  auto expected = parseJson(R"([{"op":"not-found","as":"","scope":"self/overlay/b_00000001"},{"op":"not-found","as":"","scope":"tree/b_00000001"}])");
  for (auto& frame : expected) frame["as"] = world.account("B").str();
  CHECK_EQ(jcs(bob->frames), jcs(expected));
  const auto after = world.dump();
  CHECK_EQ(after["scopes"]["acct:B/probe"]["seq"].asUInt64(), 1u);
  CHECK_EQ(after["scopes"]["acct:B/overlay/b_00000001"]["state"].asString(), "dead");
  CHECK(world.failures.reports.empty());
}

TEST(pg_declared_absent_target_keeps_foreign_creation_out_until_authority_is_proven) {
  if (!test::postgresEnabled()) SKIP(test::kNeedsPostgres);
  test::PgWorld pg;
  for (bool creates : {false, true}) {
    pg.seed(parseJson(R"({"epoch":"ep-1","accounts":{"A":{"name":"Ann"},"B":{"name":"Bob"}}})"));
    struct Creation final : SyncCommand {
      explicit Creation(bool creates) : creates(creates) {}
      bool creates;
      std::promise<void> reached;
      std::promise<void> release;
      bool isReplay(CommandCtx&) override { return false; }
      std::set<ScopeKey> discoverEffectScopes(const CommandCtx&) override { return {ScopeKey::tree("b_00000009")}; }
      CommandOutcome run(CommandCtx&) override {
        reached.set_value();
        if (release.get_future().wait_for(std::chrono::seconds(2)) != std::future_status::ready) throw std::runtime_error("creation test timed out");
        CommandOutcome result;
        if (creates) {
          Delta board{.t = "board", .id = RecordId(std::string("b_00000009"))};
          board.lattice.born = Stamp{};
          board.lattice.life = Life(LifeState::alive, Stamp{});
          result.deltas.push_back(board);
        }
        Delta meta{.t = "meta", .id = RecordId(std::string("meta"))};
        meta.lattice.f.emplace("title", Reg("Effect", Stamp{}));
        result.into.push_back(IntoScope{ScopeKey::tree("b_00000009"), {meta}});
        return result;
      }
    } command(creates);
    SyncCatalog catalog(pg.catalog().registry());
    for (const auto& type : catalog.registry().types()) catalog.bindType(pg.catalog().store(type.name), pg.catalog().rules(type.name));
    for (const auto& def : catalog.registry().commands()) if (!def.engine) catalog.bindCommand(def.name, def.name == "probe.tick" ? command : pg.catalog().command(def.name));
    catalog.seal();
    fake::RecordingChangeFeed feed;
    Admission admission(catalog, pg.store(), feed, pg.clock(), pg.failures);
    auto first = std::async(std::launch::async, [&] {
      BlockingThread::Mark blocking;
      return admission.admit(ServerOrigin{pg.account("A"), std::nullopt},
        parseJson(R"({"scope":"self/probe","cmd":{"name":"probe.tick","args":{}}})"), kNow);
    });
    auto reached = command.reached.get_future();
    const bool ready = reached.wait_for(std::chrono::seconds(1)) == std::future_status::ready;
    auto foreign = std::async(std::launch::async, [&] {
      BlockingThread::Mark blocking;
      return admission.admit(ServerOrigin{pg.account("B"), std::nullopt},
        parseJson(R"({"scope":"self/probe","d":[{"t":"board","id":"b_00000009","born":null,"life":["alive",null]}]})"), kNow);
    });
    const bool held = foreign.wait_for(std::chrono::milliseconds(100)) == std::future_status::timeout;
    command.release.set_value();
    const auto mine = first.get();
    const auto theirs = foreign.get();
    REQUIRE(ready);
    CHECK(held);
    CHECK_EQ(codeOf(mine), creates ? "ok" : "not-found");
    CHECK_EQ(codeOf(theirs), creates ? "id-taken" : "ok");
    const auto state = pg.dump();
    CHECK_EQ(state["scopes"]["tree:b_00000009"]["owner"].asString(), creates ? "A" : "B");
    CHECK_EQ(state["scopes"].isMember(creates ? "acct:B/probe" : "acct:A/probe"), false);
    if (!creates) CHECK(state["rows"]["tree:b_00000009"].empty());
    REQUIRE_EQ(feed.published.size(), 1u);
    CHECK(pg.failures.reports.empty());
  }
}
