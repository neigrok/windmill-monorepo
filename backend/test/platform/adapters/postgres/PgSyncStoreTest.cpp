#include "platform/adapters/postgres/PgSyncStore.h"

#include "platform/domain/sync/Admit.h"
#include "platform/domain/sync/Jcs.h"
#include "platform/application/WorkerPool.h"
#include "platform/application/sync/SyncService.h"
#include "platform/infra/SyncProducts.h"
#include "products/gym/sync/adapters/postgres/PgGymBackfill.h"
#include "products/journal/sync/adapters/postgres/PgJournalBackfill.h"
#include "test/platform/Fakes.h"
#include "test/platform/adapters/postgres/PgSyncWorld.h"
#include "test/testing.h"

#include <pqxx/pqxx>

#include <future>
#include <optional>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>

using namespace wm;
using namespace wm::sync;

namespace {

struct WriteFreeze {
  const char* name;
  std::optional<std::string> previous;
  explicit WriteFreeze(const char* name) : name(name) {
    if (const char* value = std::getenv(name)) previous = value;
    setenv(name, "1", 1);
  }
  ~WriteFreeze() {
    if (previous) setenv(name, previous->c_str(), 1);
    else unsetenv(name);
  }
};

// An empty engine: the probe world seeded with nothing but accounts A and B.
test::PgWorld& emptyWorld() {
  static test::PgWorld world;
  world.seed(parseJson(R"({"epoch": "ep-7", "clock": {"ms": 0, "counter": 0}, "accounts": {"A": {"name": "Ann"}, "B": {"name": "Bob"}}})"));
  return world;
}

Stamp stamp(const char* text) {
  return *parseHlc(text);
}

// The FaultClass PgSyncStore gives the exception `act` throws.
template <typename Act>
FaultClass classOf(PgSyncStore& store, Act act) {
  try {
    act();
  } catch (const std::exception& error) {
    return store.classify(error);
  }
  throw std::logic_error("the act threw nothing");
}

}

TEST(product_sync_unadopted_history_is_unavailable_and_never_consumes_a_native_intent) {
  if (!test::postgresEnabled()) SKIP(test::kNeedsPostgres);
  BlockingThread::Mark blocking;
  test::PgWorld gymWorld(true);
  test::PgWorld journalWorld(false, true);
  const auto accounts = parseJson(R"({"accounts":{"A":{"name":"Ann"},"B":{"name":"Bob"}}})");
  for (const std::string product : {"gym", "journal"}) {
    for (int partial = 0; partial < 3; ++partial) {
      gymWorld.seed(accounts);
      journalWorld.seed(accounts);
      auto catalog = productCatalog();
      auto& store = gymWorld.store();
      const auto user = gymWorld.account("A");
      const auto scope = ScopeKey::product(user, product);
      SyncLive live(*catalog, store, Limits{});
      Admission admission(*catalog, store, live, gymWorld.clock(), gymWorld.failures);
      wm::fake::FakeClock clock;
      clock.now = 1'000'000;
      SyncService service(*catalog, store, admission, clock);
      const auto credential = Credential::sent(user);
      const auto pull = jcs(parseJson("{\"scopes\":[{\"scope\":\"self/" + product + "\",\"cursor\":null}]}"));
      const auto intent = product == "gym"
          ? parseJson(R"({"n":1,"scope":"self/gym","d":[{"t":"prefs","id":"prefs","f":{"units":["kg","1000000:0:r_aaaaaaaaaaaa"]}}]})")
          : parseJson(R"({"n":1,"scope":"self/journal","d":[{"t":"journalState","id":"journalState","f":{"placeholder":["retired","1000000:0:r_aaaaaaaaaaaa"]}}]})");
      auto push = parseJson(R"({"replica":"rp_000000000000000000000000000000aa","account":"","ackThrough":0,"intents":[]})");
      push["account"] = user.str();
      push["intents"].append(intent);
      TimeBudget budget(60'000);
      if (partial == 0) {
        auto txn = store.begin(TxnMode::snapshot);
        sqlOf(*txn).exec("set local search_path to pg_temp");
        bool missingSchema = false;
        try { catalog->requireReady(*txn, scope); }
        catch (const ProductScopeUnavailable&) { missingSchema = true; }
        CHECK(missingSchema);
      }
      CHECK_EQ(service.hello(credential).status, 200);
      CHECK_EQ(service.pull(credential, pull).body["pages"][0]["kind"].asString(), "rows");
      if (partial == 0 && product == "gym") {
        const auto fresh = gymWorld.account("B");
        auto freshPush = push;
        freshPush["account"] = fresh.str();
        freshPush["replica"] = "rp_000000000000000000000000000000ab";
        const auto freshCredential = Credential::sent(fresh);
        for (std::uint64_t n = 1; n <= 2; ++n) {
          freshPush["intents"][0]["n"] = Json::UInt64(n);
          freshPush["intents"][0]["d"][0]["f"]["units"][0] = n == 1 ? "kg" : "lb";
          freshPush["intents"][0]["d"][0]["f"]["units"][1] = n == 1 ? "1000000:0:r_aaaaaaaaaaaa" : "1000000:1:r_aaaaaaaaaaaa";
          const auto written = service.push(freshCredential, jcs(freshPush), budget);
          CHECK_EQ(written.status, 200);
          REQUIRE_EQ(written.body["results"][0]["s"].asString(), "ok");
          CHECK_EQ(written.body["lastN"].asUInt64(), n);
          CHECK_EQ(service.hello(freshCredential).status, 200);
          const auto fetched = service.pull(freshCredential, pull);
          CHECK_EQ(fetched.status, 200);
          REQUIRE_EQ(fetched.body["pages"][0]["rows"].size(), 1u);
          const auto& fields = fetched.body["pages"][0]["rows"][0]["f"];
          CHECK_EQ(fields["units"][0].asString(), n == 1 ? "kg" : "lb");
          CHECK_FALSE(fields.isMember("restSound"));
        }
        const auto current = gym::engine::PgGymBackfill(pgTestPool()).auditCurrent(fresh.str());
        REQUIRE_EQ(current.size(), 1u);
        CHECK(current[0]["audit"].asBool());
        const auto beforeRerun = gymWorld.dump();
        const auto rerun = gym::engine::PgGymBackfill(pgTestPool()).run(600'000, false, fresh.str());
        REQUIRE_EQ(rerun.size(), 1u);
        CHECK(rerun[0]["skipped"].asBool());
        CHECK_EQ(jcs(gymWorld.dump()), jcs(beforeRerun));
      }
      {
        auto txn = store.begin(TxnMode::write);
        auto& sql = sqlOf(*txn);
        if (product == "gym")
          sql.exec("insert into gym_notes(id,user_id,title,body,position) values('syncadopt001',$1::uuid,'History','Keep history',0)", pqxx::params{user.str()});
        else {
          sql.exec("insert into journal_page(user_id,day,body) values($1::uuid,'2026-10-01','Keep history')", pqxx::params{user.str()});
          sql.exec("insert into journal_page_revision(user_id,day,body) values($1::uuid,'2026-10-01','Old history')", pqxx::params{user.str()});
        }
        if (partial == 1) store.insertScope(*txn, scope, user, std::nullopt);
        txn->commit();
      }
      const auto backfill = [&] {
        if (product == "gym") gym::engine::PgGymBackfill(pgTestPool()).run(500'000, false, user.str());
        else journal::engine::PgJournalBackfill(pgTestPool()).run(500'000, false, user.str());
      };
      if (partial == 2) {
        backfill();
        auto txn = store.begin(TxnMode::write);
        sqlOf(*txn).exec("delete from sync_scopes where key=$1", pqxx::params{scope.text()});
        txn->commit();
      }
      Json::Value unavailable = SyncReply::envelope(clock.now, "ep-1");
      unavailable["as"] = user.str();
      unavailable["error"] = "unavailable";
      unavailable["retryAfterMs"] = Json::UInt(Retry::kTransientMs);
      const auto hello = service.hello(credential);
      CHECK_EQ(hello.status, 503);
      CHECK_EQ(jcs(hello.body), jcs(unavailable));
      const auto read = service.pull(credential, pull);
      CHECK_EQ(read.status, 503);
      CHECK_EQ(jcs(read.body), jcs(unavailable));
      CHECK_EQ(service.pull(Credential::none(), pull).body["pages"][0]["kind"].asString(), "not-found");
      for (int attempt = 0; attempt < 4; ++attempt) {
        const auto reply = service.push(credential, jcs(push), budget);
        auto expected = SyncReply::envelope(clock.now, "ep-1");
        expected["as"] = user.str();
        expected["lastN"] = Json::UInt64(0);
        expected["results"] = Json::Value(Json::arrayValue);
        expected["retry"]["n"] = Json::UInt64(1);
        expected["retry"]["retryAfterMs"] = Json::UInt(Retry::kTransientMs);
        CHECK_EQ(reply.status, 200);
        CHECK_EQ(jcs(reply.body), jcs(expected));
      }
      {
        auto txn = store.begin(TxnMode::snapshot);
        CHECK_FALSE(store.storedResult(*txn, push["replica"].asString(), 1).has_value());
        CHECK_EQ(store.replica(*txn, push["replica"].asString(), RowLock::none)->lastN, 0u);
        CHECK_EQ(store.scope(*txn, scope, RowLock::none).has_value(), partial == 1);
      }
      const auto socket = std::make_shared<sync::fake::RecordingSocket>();
      live.open(socket, user);
      Json::Value refs(Json::arrayValue);
      refs.append("self/" + product);
      bool refused = false;
      try { live.subscribe(*socket, refs); }
      catch (const ProductScopeUnavailable&) { refused = true; }
      CHECK(refused);
      live.publish(CommittedChange{"ep-1", {ScopeChange{scope, user, false, 1, {}, {}}}, {}});
      CHECK_EQ(jcs(socket->frames), "[]");
      if (partial != 0) continue;
      backfill();
      CHECK_EQ(service.hello(credential).body["holdsRecords"][product].asBool(), true);
      const auto adopted = service.pull(credential, pull);
      CHECK_EQ(adopted.status, 200);
      REQUIRE_EQ(adopted.body["pages"][0]["kind"].asString(), "rows");
      CHECK_FALSE(adopted.body["pages"][0]["rows"].empty());
      live.subscribe(*socket, refs);
      {
        WriteFreeze frozen(product == "gym" ? "GYM_WRITE_FREEZE" : "JOURNAL_WRITE_FREEZE");
        for (int attempt = 0; attempt < 4; ++attempt) {
          CHECK_EQ(service.hello(credential).status, 200);
          CHECK_EQ(service.pull(credential, pull).status, 200);
          live.subscribe(*socket, refs);
          const auto retry = service.push(credential, jcs(push), budget);
          CHECK_EQ(retry.status, 200);
          CHECK_EQ(retry.body["lastN"].asUInt64(), 0u);
          CHECK_EQ(jcs(retry.body["results"]), "[]");
          CHECK_EQ(jcs(retry.body["retry"]), R"({"n":1,"retryAfterMs":1000})");
        }
        auto txn = store.begin(TxnMode::snapshot);
        CHECK_FALSE(store.storedResult(*txn, push["replica"].asString(), 1).has_value());
        CHECK_EQ(jcs(socket->frames), "[]");
        CHECK(gymWorld.failures.reports.empty());
      }
      const auto answer = service.push(credential, jcs(push), budget);
      CHECK_EQ(answer.body["lastN"].asUInt64(), 1u);
      CHECK_EQ(answer.body["results"][0]["s"].asString(), "ok");
      CHECK_EQ(socket->frames.size(), 1u);
      CHECK_EQ(socket->frames[0]["op"].asString(), "change");
      CHECK_EQ(socket->frames[0]["as"].asString(), user.str());
      CHECK_EQ(socket->frames[0]["scope"].asString(), "self/" + product);
    }
  }
}

TEST(pg_sync_store_inserts_reads_saves_and_kills_scopes) {
  if (!test::postgresEnabled()) SKIP(test::kNeedsPostgres);
  test::PgWorld& world = emptyWorld();
  auto& store = dynamic_cast<PgSyncStore&>(world.store());
  const UserId ann = world.account("A");
  const UserId bob = world.account("B");
  const ScopeKey tree = ScopeKey::tree("b_0000000a");

  std::unique_ptr<SyncTxn> txn = store.begin(TxnMode::write);
  CHECK_EQ(store.epoch(*txn), std::string("ep-7"));
  CHECK_EQ(store.ownerName(*txn, ann), std::string("Ann"));
  CHECK_EQ(store.insertScope(*txn, tree, ann, world.storeGovernedBy("acct:A/probe#board#b_0000000a")), true);
  CHECK_EQ(store.insertScope(*txn, tree, ann, std::nullopt), false);
  CHECK_EQ(store.insertScope(*txn, ScopeKey::overlay(bob, "b_0000000a"), bob, tree.text()), true);
  CHECK_EQ(store.insertScope(*txn, ScopeKey::overlay(ann, "b_0000000a"), ann, tree.text()), true);
  CHECK_EQ(store.insertScope(*txn, ScopeKey::overlay(ann, "b_0000000b"), ann, std::string("tree:b_0000000b")), true);

  ScopeRow row = *store.scope(*txn, tree, RowLock::noKeyUpdate);
  row.seq = 4;
  row.counters = {{"card", 2}};
  row.digest = sha256("rows");
  row.open = true;
  store.saveScope(*txn, row);
  const std::vector<ScopeKey> killed = store.killTree(*txn, tree, 9000);
  txn->commit();

  CHECK_EQ(killed, (std::vector<ScopeKey>{ScopeKey::overlay(ann, "b_0000000a"), ScopeKey::overlay(bob, "b_0000000a"), tree}));
  std::unique_ptr<SyncTxn> read = store.begin(TxnMode::snapshot);
  const ScopeRow stored = *store.scope(*read, tree, RowLock::none);
  CHECK_EQ(jcs(world.scopeJson(stored)), jcs(parseJson(R"({"kind": "tree", "owner": "A", "state": "dead", "seq": 4, "counters": {"card": 2},
    "digest": ")" + sha256("rows").hex() + R"(", "governedBy": "acct:A/probe#board#b_0000000a", "deadAt": 9000})")));
  CHECK_EQ(stored.open, true);
  CHECK_EQ(store.scope(*read, ScopeKey::overlay(ann, "b_0000000b"), RowLock::none)->dead, false);
  CHECK_EQ(store.scope(*read, ScopeKey::tree("b_absent00"), RowLock::none).has_value(), false);
}

TEST(pg_sync_store_binds_replicas_and_keeps_their_results_until_pruned) {
  if (!test::postgresEnabled()) SKIP(test::kNeedsPostgres);
  test::PgWorld& world = emptyWorld();
  SyncStore& store = world.store();
  const std::string replica = "rp_000000000000000000000000000000aa";
  const Digest256 digest = sha256("intent");

  std::unique_ptr<SyncTxn> txn = store.begin(TxnMode::write);
  CHECK_EQ(store.replica(*txn, replica, RowLock::update).has_value(), false);
  const ReplicaRow bound = store.bindReplica(*txn, replica, world.account("A"), 100);
  CHECK_EQ(bound.lastN, 0u);
  store.setLastN(*txn, replica, 2);
  CHECK_EQ(store.bindReplica(*txn, replica, world.account("A"), 200).lastN, 2u);
  store.putResult(*txn, replica, StoredResult{1, digest, parseJson(R"({"s": "ok", "seq": 1, "detail": {"x": [1.5, null]}})"), 0});
  store.putResult(*txn, replica, StoredResult{2, digest, std::nullopt, 2});
  store.putResult(*txn, replica, StoredResult{3, digest, parseJson(R"({"s": "refused", "code": "internal"})"), 3});
  txn->commit();

  txn = store.begin(TxnMode::write);
  const ReplicaRow locked = *store.replica(*txn, replica, RowLock::update);
  CHECK_EQ(locked.account, world.account("A"));
  CHECK_EQ(locked.lastN, 2u);
  const StoredResult first = *store.storedResult(*txn, replica, 1);
  CHECK_EQ(jcs(*first.result), std::string(R"({"detail":{"x":[1.5,null]},"s":"ok","seq":1})"));
  CHECK_EQ(first.digest, digest);
  CHECK_EQ(store.storedResult(*txn, replica, 2)->result.has_value(), false);
  CHECK_EQ(store.storedResult(*txn, replica, 2)->faults, 2);
  store.pruneResults(*txn, replica, 2);
  CHECK_EQ(store.storedResult(*txn, replica, 1).has_value(), false);
  CHECK_EQ(store.storedResult(*txn, replica, 3)->faults, 3);
  store.unbindUnused(*txn, replica);
  CHECK_EQ(store.storedResult(*txn, replica, 3)->faults, 3);
  CHECK_EQ(store.replica(*txn, replica, RowLock::update)->lastN, 2u);
  txn->commit();
}

TEST(pg_sync_store_unbinds_only_a_replica_that_answered_nothing) {
  if (!test::postgresEnabled()) SKIP(test::kNeedsPostgres);
  test::PgWorld& world = emptyWorld();
  SyncStore& store = world.store();
  const std::string unused = "rp_000000000000000000000000000000b1";
  const std::string tallied = "rp_000000000000000000000000000000b2";

  std::unique_ptr<SyncTxn> txn = store.begin(TxnMode::write);
  store.bindReplica(*txn, unused, world.account("A"), 100);
  store.bindReplica(*txn, tallied, world.account("A"), 100);
  store.putResult(*txn, tallied, StoredResult{1, sha256("intent"), std::nullopt, 1});
  txn->commit();

  txn = store.begin(TxnMode::write);
  REQUIRE(store.replica(*txn, unused, RowLock::update).has_value());
  store.unbindUnused(*txn, unused);
  REQUIRE(store.replica(*txn, tallied, RowLock::update).has_value());
  store.unbindUnused(*txn, tallied);
  txn->commit();

  txn = store.begin(TxnMode::write);
  CHECK_EQ(store.replica(*txn, unused, RowLock::update).has_value(), false);
  CHECK_EQ(store.replica(*txn, tallied, RowLock::update)->lastN, 0u);
  CHECK_EQ(store.storedResult(*txn, tallied, 1)->faults, 1);
}

TEST(pg_sync_store_keeps_spent_ids_in_jcs_order_and_finds_them_in_other_scopes) {
  if (!test::postgresEnabled()) SKIP(test::kNeedsPostgres);
  test::PgWorld& world = emptyWorld();
  SyncStore& store = world.store();
  const TypeDef& card = *world.catalog().registry().type("card");
  const TypeDef& day = *world.catalog().registry().type("day");
  const ScopeKey mine = ScopeKey::product(world.account("A"), "probe");
  const ScopeKey theirs = ScopeKey::product(world.account("B"), "probe");

  std::unique_ptr<SyncTxn> txn = store.begin(TxnMode::write);
  store.insertScope(*txn, mine, world.account("A"), std::nullopt);
  store.insertScope(*txn, theirs, world.account("B"), std::nullopt);
  store.addSpent(*txn, mine, spentRow("card", RecordId(std::string("card-b01")), stamp("10:0:r_a"), stamp("20:0:r_a"), 3));
  store.addSpent(*txn, mine, spentRow("card", RecordId(std::string("card-a02")), stamp("11:0:r_a"), stamp("21:0:r_a"), 3));
  store.addSpent(*txn, mine, spentRow("card", RecordId(std::string("card-a01")), stamp("12:0:r_a"), stamp("22:0:r_a"), 5));
  store.addSpent(*txn, mine, spentRow("day", RecordId(std::string("2026-09-02")), std::nullopt, stamp("23:0:r_a"), 4));
  store.addSpent(*txn, theirs, spentRow("card", RecordId(std::string("card-zzz")), stamp("13:0:r_b"), stamp("24:0:r_b"), 1));
  txn->commit();

  txn = store.begin(TxnMode::write);
  auto ids = [](const std::vector<Row>& rows) {
    std::vector<std::string> out;
    for (const Row& row : rows) out.push_back(jcs(row.thin()));
    return out;
  };
  CHECK_EQ(ids(store.feedSpent(*txn, mine, card, FeedQuery{})),
           (std::vector<std::string>{R"({"born":"11:0:r_a","id":"card-a02","life":["dead","21:0:r_a"],"seq":3,"t":"card"})",
                                     R"({"born":"10:0:r_a","id":"card-b01","life":["dead","20:0:r_a"],"seq":3,"t":"card"})",
                                     R"({"born":"12:0:r_a","id":"card-a01","life":["dead","22:0:r_a"],"seq":5,"t":"card"})"}));
  CHECK_EQ(ids(store.feedSpent(*txn, mine, card, FeedQuery{.afterSeq = 3, .afterKey = jcs(Json::Value("card-a02"))})),
           (std::vector<std::string>{R"({"born":"10:0:r_a","id":"card-b01","life":["dead","20:0:r_a"],"seq":3,"t":"card"})",
                                     R"({"born":"12:0:r_a","id":"card-a01","life":["dead","22:0:r_a"],"seq":5,"t":"card"})"}));
  CHECK_EQ(store.countSpent(*txn, mine, card, FeedQuery{.throughSeq = 3}), 2u);
  CHECK_EQ(ids(store.feedSpent(*txn, mine, day, FeedQuery{})),
           (std::vector<std::string>{R"({"id":"2026-09-02","life":["dead","23:0:r_a"],"seq":4,"t":"day"})"}));

  const std::vector<RecordId> asked{RecordId(std::string("card-zzz")), RecordId(std::string("card-a01")), RecordId(std::string("card-new"))};
  const std::map<std::string, Row> here = store.spentIn(*txn, mine, card, asked);
  CHECK_EQ(here.size(), 1u);
  CHECK_EQ(jcs(here.at(jcs(Json::Value("card-a01"))).thin()),
           std::string(R"({"born":"12:0:r_a","id":"card-a01","life":["dead","22:0:r_a"],"seq":5,"t":"card"})"));
  CHECK_EQ(store.spentElsewhere(*txn, mine, card, asked), (std::set<std::string>{jcs(Json::Value("card-zzz"))}));
  store.removeSpent(*txn, mine, day, RecordId(std::string("2026-09-02")));
  CHECK_EQ(store.feedSpent(*txn, mine, day, FeedQuery{}).size(), 0u);
  txn->commit();
}

TEST(pg_sync_store_round_trips_requests) {
  if (!test::postgresEnabled()) SKIP(test::kNeedsPostgres);
  test::PgWorld& world = emptyWorld();
  SyncStore& store = world.store();
  const UserId ann = world.account("A");

  std::unique_ptr<SyncTxn> txn = store.begin(TxnMode::write);
  store.lockRequest(*txn, ann, "req-1");
  CHECK_EQ(store.request(*txn, ann, "req-1").has_value(), false);
  store.putRequest(*txn, ann, RequestRow{"req-1", sha256("call"), true, std::nullopt, 1000});
  store.putRequest(*txn, ann, RequestRow{"req-1#1", sha256("call"), false, parseJson(R"({"s":"ok","seq":1})"), 1000});
  store.putRequest(*txn, ann, RequestRow{"req-1", sha256("call"), false, parseJson(R"({"s":"ok","seq":1})"), 2000});
  txn->commit();

  txn = store.begin(TxnMode::snapshot);
  const RequestRow call = *store.request(*txn, ann, "req-1");
  CHECK_EQ(call.running, false);
  CHECK_EQ(call.startedAt, 2000u);
  CHECK_EQ(call.digest, sha256("call"));
  CHECK_EQ(jcs(*call.result), std::string(R"({"s":"ok","seq":1})"));
  CHECK_EQ(store.request(*txn, world.account("B"), "req-1").has_value(), false);
}

TEST(pg_sync_store_classifies_lock_timeout_and_deadlock_as_transient_and_statement_timeout_as_a_fault) {
  if (!test::postgresEnabled()) SKIP(test::kNeedsPostgres);
  test::PgWorld& world = emptyWorld();
  PgSyncStore store(pgTestPool(), 200);
  const ScopeKey one = ScopeKey::product(world.account("A"), "probe");
  const ScopeKey two = ScopeKey::product(world.account("B"), "probe");
  {
    std::unique_ptr<SyncTxn> txn = store.begin(TxnMode::write);
    store.insertScope(*txn, one, world.account("A"), std::nullopt);
    store.insertScope(*txn, two, world.account("B"), std::nullopt);
    txn->commit();
  }

  std::unique_ptr<SyncTxn> holder = store.begin(TxnMode::write);
  store.scope(*holder, one, RowLock::update);
  CHECK_EQ(classOf(store, [&] {
             std::unique_ptr<SyncTxn> waiter = store.begin(TxnMode::write);
             store.scope(*waiter, one, RowLock::noKeyUpdate);
           }),
           FaultClass::transient);
  holder.reset();

  PgSyncStore patient(pgTestPool(), 5000);
  std::promise<void> firstHolds;
  std::promise<void> secondHolds;
  auto crossing = [&](const ScopeKey& mine, const ScopeKey& theirs, std::promise<void>& holding, std::future<void> other) {
    return std::async(std::launch::async, [&patient, mine, theirs, &holding, other = std::move(other)]() mutable -> std::optional<FaultClass> {
      try {
        std::unique_ptr<SyncTxn> txn = patient.begin(TxnMode::write);
        patient.scope(*txn, mine, RowLock::update);
        holding.set_value();
        other.wait();
        patient.scope(*txn, theirs, RowLock::update);
        return std::nullopt;
      } catch (const std::exception& error) {
        return patient.classify(error);
      }
    });
  };
  auto first = crossing(one, two, firstHolds, secondHolds.get_future());
  auto second = crossing(two, one, secondHolds, firstHolds.get_future());
  const std::optional<FaultClass> firstClass = first.get();
  const std::optional<FaultClass> secondClass = second.get();
  CHECK_EQ(firstClass.has_value() != secondClass.has_value(), true);
  CHECK_EQ(firstClass.value_or(FaultClass::transient), FaultClass::transient);
  CHECK_EQ(secondClass.value_or(FaultClass::transient), FaultClass::transient);

  CHECK_EQ(classOf(store, [&] {
             std::unique_ptr<SyncTxn> txn = store.begin(TxnMode::write);
             sqlOf(*txn).exec("set local statement_timeout = '20ms'");
             sqlOf(*txn).exec("select pg_sleep(1)");
           }),
           FaultClass::fault);
}
