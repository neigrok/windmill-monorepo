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
// released (INV-5), stripes serialize only one scope's work, and a tree's death and its overlays' writes
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

TEST(an_admission_holding_its_scope_never_holds_up_another_scope) {
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
