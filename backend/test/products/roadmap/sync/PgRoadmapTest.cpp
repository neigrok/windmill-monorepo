#include "products/roadmap/sync/PgRoadmap.h"

#include "platform/application/WorkerPool.h"
#include "platform/application/sync/Admission.h"
#include "platform/application/sync/SyncService.h"
#include "platform/domain/sync/Digest.h"
#include "platform/domain/sync/Jcs.h"
#include "platform/infra/SyncProducts.h"
#include "test/platform/Fakes.h"
#include "test/platform/adapters/postgres/PgSyncWorld.h"
#include "test/testing.h"

// Roadmap in the production composition over Postgres (roadmap-on-the-engine.md §7, §8.1): withheld, as a deployment
// that leaves ROADMAP_ENGINE_ENABLED unset runs it, the account's roadmap reads as holding nothing and takes no write;
// served, as production runs it, the same tables answer what they hold and admit a person's roadmap. Gym's and
// journal's answers are their own suites': this database keeps what those wrote.

using namespace wm;
using namespace wm::sync;

TEST(the_production_composition_serves_roadmap_only_where_a_deployment_says_so) {
  if (!test::postgresEnabled()) SKIP(test::kNeedsPostgres);
  BlockingThread::Mark blocking;
  test::PgWorld world(test::WorldProduct::roadmap);
  const Json::Value root = parseJson(R"({"t": "tree", "id": "t_0000000000000001", "born": "1000:0:r_aaaaaaaaaaaa",
      "life": ["alive", "1000:0:r_aaaaaaaaaaaa"], "seq": 1, "rc": 100, "ru": 100})");
  Json::Value state = parseJson(R"({"epoch": "ep-1", "clock": {"ms": 3000, "counter": 0}, "accounts": {"A": {"name": "Ann"}},
      "scopes": {"acct:A/roadmap": {"kind": "product", "owner": "A", "state": "alive", "seq": 1, "counters": {}},
                 "tree:t_0000000000000001": {"kind": "tree", "owner": "A", "governedBy": "acct:A/roadmap#tree#t_0000000000000001",
                                             "state": "alive", "seq": 0, "counters": {},
                                             "digest": "0000000000000000000000000000000000000000000000000000000000000000"}}})");
  state["rows"]["acct:A/roadmap"].append(root);
  state["scopes"]["acct:A/roadmap"]["digest"] = scopeDigest({root}).hex();
  world.seed(state);
  const Json::Value seeded = world.dump();
  wm::fake::FakeClock clock;
  clock.now = 1'000'000;
  const Credential owner = Credential::sent(world.account("A"));
  const std::string pull = R"({"scopes": [{"scope": "self/roadmap", "cursor": null}, {"scope": "tree/t_0000000000000001", "cursor": null}]})";
  auto pushOf = [&](const std::string& replica) {
    Json::Value request(Json::objectValue);
    request["replica"] = replica;
    request["account"] = world.account("A").str();
    request["ackThrough"] = 0;
    request["intents"].append(parseJson(R"({"n": 1, "scope": "self/roadmap", "d": [{"t": "tree", "id": "t_0000000000000002",
        "born": "2000:0:r_aaaaaaaaaaaa", "life": ["alive", "2000:0:r_aaaaaaaaaaaa"]}]})"));
    request["intents"].append(parseJson(R"({"n": 2, "scope": "tree/t_0000000000000001", "d": [{"t": "meta", "id": "meta",
        "f": {"title": ["Learn Rust", "2000:0:r_aaaaaaaaaaaa"]}}]})"));
    return jcs(request);
  };
  auto kindsOf = [](const SyncReply& reply) {
    Json::Value kinds(Json::arrayValue);
    for (const Json::Value& page : reply.body["pages"]) kinds.append(page["kind"].asString() + " " + std::to_string(page["rows"].size()));
    return jcs(kinds);
  };

  const auto withheld = productCatalog(RoadmapServing::withheld);
  Admission withholding(*withheld, world.store(), world.feed, world.clock(), world.failures);
  SyncService closed(*withheld, world.store(), withholding, clock);
  TimeBudget refusedBudget(60'000);
  const SyncReply closedHello = closed.hello(owner);
  const SyncReply closedPull = closed.pull(owner, pull);
  const SyncReply closedPush = closed.push(owner, pushOf("rp_0000000000000000000000000000000a"), refusedBudget);

  CHECK_EQ(closedHello.body["holdsRecords"].getMemberNames(), (std::vector<std::string>{"gym", "journal", "roadmap"}));
  CHECK_EQ(jcs(closedHello.body["holdsRecords"]["roadmap"]), "false");
  CHECK_EQ(closedHello.body["schema"].asInt(), 13);
  CHECK_EQ(closedHello.body["minSchema"].asInt(), 11);
  CHECK_EQ(kindsOf(closedPull), jcs(parseJson(R"(["rows 0", "not-found 0"])")));
  CHECK_EQ(jcs(closedPush.body["results"]), jcs(parseJson(R"([{"n": 1, "s": "refused", "code": "forbidden"}, {"n": 2, "s": "refused", "code": "not-found"}])")));
  CHECK_EQ(jcs(world.dump()["scopes"]), jcs(seeded["scopes"]));
  CHECK_EQ(jcs(world.dump()["rows"]), jcs(seeded["rows"]));

  const auto served = productCatalog(RoadmapServing::served);
  Admission admission(*served, world.store(), world.feed, world.clock(), world.failures);
  SyncService open(*served, world.store(), admission, clock);
  TimeBudget budget(60'000);
  const SyncReply openHello = open.hello(owner);
  const SyncReply openPull = open.pull(owner, pull);
  const SyncReply openPush = open.push(owner, pushOf("rp_0000000000000000000000000000000b"), budget);

  CHECK_EQ(jcs(openHello.body["holdsRecords"]["roadmap"]), "true");
  CHECK_EQ(kindsOf(openPull), jcs(parseJson(R"(["rows 1", "rows 0"])")));
  CHECK_EQ(jcs(openPush.body["results"]), jcs(parseJson(R"([{"n": 1, "s": "ok", "seq": 2}, {"n": 2, "s": "ok", "seq": 1}])")));
  const Json::Value after = world.dump();
  CHECK_EQ(after["rows"]["tree:t_0000000000000001"][0]["f"]["title"][0].asString(), "Learn Rust");
  CHECK_EQ(after["scopes"]["tree:t_0000000000000002"]["state"].asString(), "alive");
}

// §7's activity: the binding writes one tree_ops row for each gesture that leaves a deed in a roadmap, in the
// transaction that admits it, made by the intent's account; a later intent of the same gesture folds its deed into that
// row and moves it to its own seq, and an intent that leaves no deed writes none.
TEST(a_roadmaps_activity_keeps_one_row_a_gesture_that_leaves_a_deed_with_who_made_it) {
  if (!test::postgresEnabled()) SKIP(test::kNeedsPostgres);
  BlockingThread::Mark blocking;
  test::PgWorld world(test::WorldProduct::roadmap);
  const std::string tree = "t_00000000000000d1";
  Json::Value state = parseJson(R"({"epoch": "ep-1", "clock": {"ms": 3000, "counter": 0}, "accounts": {"A": {"name": "Ann"}},
      "scopes": {"tree:t_00000000000000d1": {"kind": "tree", "owner": "A", "governedBy": "acct:A/roadmap#tree#t_00000000000000d1",
                                             "state": "alive", "seq": 0, "counters": {},
                                             "digest": "0000000000000000000000000000000000000000000000000000000000000000"}}})");
  const Json::Value root = parseJson(R"({"t": "tree", "id": "t_00000000000000d1", "born": "1000:0:r_aaaaaaaaaaaa",
      "life": ["alive", "1000:0:r_aaaaaaaaaaaa"], "seq": 1, "rc": 100, "ru": 100})");
  state["scopes"]["acct:A/roadmap"] = parseJson(R"({"kind": "product", "owner": "A", "state": "alive", "seq": 1, "counters": {}})");
  state["scopes"]["acct:A/roadmap"]["digest"] = scopeDigest({root}).hex();
  state["rows"]["acct:A/roadmap"].append(root);
  world.seed(state);
  {
    PgLease conn{*pgTestPool()};
    pqxx::work sql{*conn};
    sql.exec("delete from tree_ops where tree_id = $1", pqxx::params{tree});
    sql.commit();
  }

  const auto served = productCatalog(RoadmapServing::served);
  Admission admission(*served, world.store(), world.feed, world.clock(), world.failures);
  wm::fake::FakeClock clock;
  clock.now = 1'000'000;
  SyncService sync(*served, world.store(), admission, clock);
  TimeBudget budget(60'000);
  const std::string scope = "tree/" + tree;
  const char* stamp = "2000:0:r_aaaaaaaaaaaa";
  auto node = [&](const std::string& id, const std::string& label, const std::string& ord) {
    Json::Value delta = parseJson(R"({"t": "node", "life": ["alive", "2000:0:r_aaaaaaaaaaaa"], "born": "2000:0:r_aaaaaaaaaaaa"})");
    delta["id"] = id;
    delta["f"]["label"] = parseJson("[\"" + label + "\", \"" + stamp + "\"]");
    delta["f"]["ord"] = parseJson("[\"" + ord + "\", \"" + stamp + "\"]");
    return delta;
  };
  Json::Value request(Json::objectValue);
  request["replica"] = "rp_00000000000000000000000000000d1a";
  request["account"] = world.account("A").str();
  request["ackThrough"] = 0;
  Json::Value made = parseJson(R"({"n": 1, "gestureId": "g-made", "d": [
      {"t": "meta", "id": "meta", "f": {"title": ["Learn Rust", "2000:0:r_aaaaaaaaaaaa"]}},
      {"t": "kind", "id": "build", "born": "2000:0:r_aaaaaaaaaaaa", "life": ["alive", "2000:0:r_aaaaaaaaaaaa"],
       "f": {"hue": ["terracotta", "2000:0:r_aaaaaaaaaaaa"], "label": ["Build", "2000:0:r_aaaaaaaaaaaa"], "ord": ["a0", "2000:0:r_aaaaaaaaaaaa"]}},
      {"t": "edge", "id": ["basics", "ownership"], "life": ["alive", "2000:0:r_aaaaaaaaaaaa"]}]})");
  made["scope"] = scope;
  for (const auto& [id, label, ord] : {std::tuple{"basics", "Basics", "a0"}, std::tuple{"ownership", "Ownership", "a1"}, std::tuple{"traits", "Traits", "a2"}})
    made["d"].append(node(id, label, ord));
  request["intents"].append(made);
  Json::Value renamed = parseJson(R"({"n": 2, "gestureId": "g-two", "d": [
      {"t": "node", "id": "basics", "life": ["alive", "2100:0:r_aaaaaaaaaaaa"], "born": "2000:0:r_aaaaaaaaaaaa",
       "f": {"label": ["Foundations", "2100:0:r_aaaaaaaaaaaa"]}}]})");
  renamed["scope"] = scope;
  request["intents"].append(renamed);
  Json::Value linked = parseJson(R"({"n": 3, "gestureId": "g-two", "d": [{"t": "edge", "id": ["ownership", "traits"], "life": ["alive", "2100:0:r_aaaaaaaaaaaa"]}]})");
  linked["scope"] = scope;
  request["intents"].append(linked);
  Json::Value annotated = parseJson(R"({"n": 4, "gestureId": "g-note", "d": [
      {"t": "node", "id": "traits", "life": ["alive", "2200:0:r_aaaaaaaaaaaa"], "born": "2000:0:r_aaaaaaaaaaaa",
       "f": {"description": ["Shared behaviour", "2200:0:r_aaaaaaaaaaaa"]}}]})");
  annotated["scope"] = scope;
  request["intents"].append(annotated);

  const SyncReply pushed = sync.push(Credential::sent(world.account("A")), jcs(request), budget);

  CHECK_EQ(jcs(pushed.body["results"]), jcs(parseJson(R"([{"n": 1, "s": "ok", "seq": 1}, {"n": 2, "s": "ok", "seq": 2},
      {"n": 3, "s": "ok", "seq": 3}, {"n": 4, "s": "ok", "seq": 4}])")));
  Json::Value rows(Json::arrayValue);
  {
    PgLease conn{*pgTestPool()};
    pqxx::work sql{*conn};
    const pqxx::result kept = sql.exec("select seq, actor_id, op_id, kind, payload::text, hlc from tree_ops where tree_id = $1 order by seq", pqxx::params{tree});
    for (std::size_t i = 0; i < kept.size(); ++i) {
      Json::Value row(Json::arrayValue);
      row.append(static_cast<Json::Int64>(kept[i][0].as<long long>()));
      row.append(kept[i][1].as<std::string>() == world.account("A").str() ? "A" : "someone else");
      row.append(kept[i][2].as<std::string>());
      row.append(kept[i][3].as<std::string>());
      row.append(parseJson(kept[i][4].as<std::string>()));
      row.append(kept[i][5].as<std::string>());
      rows.append(row);
    }
  }
  CHECK_EQ(jcs(rows), jcs(parseJson(R"([
      [1, "A", "gesture:g-made", "Batch", {"commands": [
          {"kind": "CreateNode", "payload": {"id": "basics", "label": "Basics", "icon": "", "color": "terracotta"}},
          {"kind": "CreateNode", "payload": {"id": "ownership", "label": "Ownership", "icon": "", "color": "terracotta"}},
          {"kind": "CreateNode", "payload": {"id": "traits", "label": "Traits", "icon": "", "color": "terracotta"}}]}, ""],
      [3, "A", "gesture:g-two", "Batch", {"commands": [
          {"kind": "RenameNode", "payload": {"id": "basics", "label": "Foundations"}},
          {"kind": "AddEdge", "payload": {"from": "ownership", "to": "traits"}}]}, ""]])")));
}
