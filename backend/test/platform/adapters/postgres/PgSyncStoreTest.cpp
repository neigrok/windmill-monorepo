#include "platform/adapters/postgres/PgSyncStore.h"

#include "platform/domain/sync/Admit.h"
#include "platform/domain/sync/Jcs.h"
#include "test/platform/adapters/postgres/PgSyncWorld.h"
#include "test/testing.h"

#include <pqxx/pqxx>

#include <future>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>

using namespace wm;
using namespace wm::sync;

namespace {

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
  CHECK_EQ(store.lockReplica(*txn, replica).has_value(), false);
  const ReplicaRow bound = store.bindReplica(*txn, replica, world.account("A"), 100);
  CHECK_EQ(bound.lastN, 0u);
  store.setLastN(*txn, replica, 2);
  CHECK_EQ(store.bindReplica(*txn, replica, world.account("A"), 200).lastN, 2u);
  store.putResult(*txn, replica, StoredResult{1, digest, parseJson(R"({"s": "ok", "seq": 1, "detail": {"x": [1.5, null]}})"), 0});
  store.putResult(*txn, replica, StoredResult{2, digest, std::nullopt, 2});
  store.putResult(*txn, replica, StoredResult{3, digest, parseJson(R"({"s": "refused", "code": "internal"})"), 3});
  txn->commit();

  txn = store.begin(TxnMode::write);
  const ReplicaRow locked = *store.lockReplica(*txn, replica);
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
  CHECK_EQ(store.lockReplica(*txn, replica)->lastN, 2u);
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
  REQUIRE(store.lockReplica(*txn, unused).has_value());
  store.unbindUnused(*txn, unused);
  REQUIRE(store.lockReplica(*txn, tallied).has_value());
  store.unbindUnused(*txn, tallied);
  txn->commit();

  txn = store.begin(TxnMode::write);
  CHECK_EQ(store.lockReplica(*txn, unused).has_value(), false);
  CHECK_EQ(store.lockReplica(*txn, tallied)->lastN, 0u);
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
