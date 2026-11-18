#include "products/roadmap/adapters/http/GalleryApi.h"
#include "products/roadmap/adapters/http/SharePageApi.h"
#include "products/roadmap/adapters/http/TreeApi.h"
#include "products/roadmap/adapters/postgres/PgOpLog.h"
#include "products/roadmap/adapters/postgres/PgRoadmapRecords.h"
#include "products/roadmap/application/EngineReadModels.h"

#include "platform/adapters/json/JsonText.h"
#include "platform/adapters/postgres/PgSyncStore.h"
#include "platform/application/WorkerPool.h"
#include "platform/application/sync/Admission.h"
#include "platform/application/sync/SyncService.h"
#include "platform/domain/sync/Jcs.h"
#include "platform/infra/SyncProducts.h"
#include "test/PgTestPool.h"
#include "test/platform/Fakes.h"
#include "test/platform/application/sync/SyncFakes.h"
#include "test/products/roadmap/Fakes.h"
#include "test/testing.h"

#include <filesystem>
#include <fstream>
#include <memory>
#include <string>
#include <vector>

// The read models while the engine serves roadmap (roadmap-on-the-engine.md §7): every route below is handed the engine
// reads, and the roadmaps are made by a person's gestures admitted through the engine over Postgres, so each answer
// comes from the typed tables and the activity the binding kept. The same routes handed none answer from the rooms, as
// their own suites hold them.

using namespace wm;
using namespace wm::fake;

namespace {

const char* kNeedsPostgres = "WM_PG_TEST unset — needs a live Postgres, see RUNNING.md §7";
const std::string kRoot = "t_00000000000000e1";
const std::string kSubtree = "t_00000000000000e2";
const std::string kPrivate = "t_00000000000000e3";
const std::uint64_t kStart = 1'800'000'000'000;

const std::string kShell =
    "<!doctype html>\n<html><head>\n"
    "  <!-- meta:unfurl:start -->\n"
    "  <title>Windmill root</title>\n"
    "  <!-- meta:unfurl:end -->\n"
    "</head><body></body></html>\n";

std::string webRootHolding(const std::string& shell) {
  const std::filesystem::path dir = std::filesystem::temp_directory_path() / "wm-engine-reads-test";
  std::filesystem::create_directories(dir);
  std::ofstream(dir / "index.html", std::ios::binary) << shell;
  return dir.string();
}

// Ann's roadmaps as her browser makes them, through the engine as main.cpp serves it, and the routes handed the engine
// reads; Bea reads them.
struct Engine {
  const UserId ann{"00000000-0000-4000-8000-0000000000a1"};
  const UserId bea{"00000000-0000-4000-8000-0000000000b2"};
  std::shared_ptr<sync::SyncCatalog> catalog = sync::productCatalog(sync::RoadmapServing::served);
  sync::PgSyncStore store{pgTestPool(), sync::Limits{}.lockTimeoutMs};
  sync::fake::RecordingChangeFeed feed;
  sync::fake::RecordingFailures failures;
  sync::ServerClock serverClock;
  sync::Admission admission{*catalog, store, feed, serverClock, failures};
  FakeClock clock;
  sync::SyncService sync{*catalog, store, admission, clock};
  std::uint64_t sent = 0;

  std::shared_ptr<PgRoadmapRecords> records = std::make_shared<PgRoadmapRecords>(pgTestPool());
  std::shared_ptr<PgOpLog> activity = std::make_shared<PgOpLog>(pgTestPool());
  std::shared_ptr<EngineReadModels> reads = std::make_shared<EngineReadModels>(*records, *activity);

  std::shared_ptr<FakeProgressRepository> progress = std::make_shared<FakeProgressRepository>();
  std::shared_ptr<FakeTreeRepository> trees = std::make_shared<FakeTreeRepository>(*progress);
  std::shared_ptr<FakeOpLog> ops = std::make_shared<FakeOpLog>();
  FakeBus bus;
  FakeTokens tokens;
  FakeAuthRepository authRepo;
  FakeEmail email;
  HeldRetries retries;
  std::shared_ptr<RoomRegistry> rooms = std::make_shared<RoomRegistry>(*trees, *ops, bus, retries.timer());
  FakeOAuthRepository oauthRepo;
  OAuthService oauth{oauthRepo, tokens, clock};
  FakeAccountFootprint footprint;
  FakeSessionRevocations revocations;
  std::shared_ptr<AuthService> auth =
      std::make_shared<AuthService>(authRepo, email, tokens, clock, oauth, footprint, revocations, "https://windmill.works");
  std::shared_ptr<ForkService> fork = std::make_shared<ForkService>(*rooms, *trees, tokens, clock);
  std::shared_ptr<OwnerProgress> ownerProgress = std::make_shared<OwnerProgress>(*progress, *trees, clock);
  std::shared_ptr<FakeOgVideoRepository> videos = std::make_shared<FakeOgVideoRepository>();
  TreeApi treeApi{rooms, trees, ownerProgress, ops, auth, fork, reads};
  SharePageApi sharePage{rooms, trees, auth, videos, webRootHolding(kShell), "https://share.example", reads};
  GalleryApi gallery{trees, ownerProgress, auth, "", reads};

  Engine() {
    PgLease conn{*pgTestPool()};
    pqxx::work sql{*conn};
    const pqxx::params accounts{ann.str(), bea.str()};
    sql.exec("delete from tree_ops where tree_id in ('" + kRoot + "', '" + kSubtree + "', '" + kPrivate + "')");
    sql.exec("delete from sync_spent where scope_key in (select key from sync_scopes where owner in ($1::uuid, $2::uuid))", accounts);
    sql.exec("delete from sync_scopes where owner in ($1::uuid, $2::uuid)", accounts);
    sql.exec("delete from sync_replicas where account in ($1::uuid, $2::uuid)", accounts);
    sql.exec("insert into users (id, email, name) values ($1::uuid, 'engine-reads-ann@example.com', 'Ann'), "
             "($2::uuid, 'engine-reads-bea@example.com', 'Bea') on conflict (id) do nothing",
             accounts);
    sql.commit();
    for (const auto& [account, session] : {std::pair{ann, std::string("ann-session")}, std::pair{bea, std::string("bea-session")}}) {
      const User user{account, Email{account == ann ? "engine-reads-ann@example.com" : "engine-reads-bea@example.com"}, "", std::nullopt, std::nullopt};
      authRepo.usersById[account.str()] = user;
      authRepo.usersByEmail[user.email.value] = user;
      authRepo.insertSession(tokens.digestOf(session), account, clock.now + 1'000'000'000'000, "", "", clock.now);
    }
  }

  // One push of Ann's replica at `at`, each intent in `scope` holding the records given, its stamps a moment before.
  Json::Value push(std::uint64_t at, const std::vector<Json::Value>& intents) {
    BlockingThread::Mark blocking;
    clock.now = at;
    Json::Value request(Json::objectValue);
    request["replica"] = "rp_000000000000000000000000000000a1";
    request["account"] = ann.str();
    request["ackThrough"] = 0;
    for (Json::Value intent : intents) {
      intent["n"] = Json::UInt64(++sent);
      request["intents"].append(intent);
    }
    sync::TimeBudget budget(60'000);
    return sync.push(sync::Credential::sent(ann), sync::jcs(request), budget).body["results"];
  }

  static std::string stamp(std::uint64_t at) { return std::to_string(at - 10) + ":0:r_aaaaaaaaaaaa"; }

  // `@` stands for the gesture's stamp and `#` for the born of the steps plant() makes in the roadmap.
  static Json::Value intent(const std::string& scope, const std::string& gesture, std::uint64_t at, const std::string& deltas) {
    std::string text = deltas;
    for (std::size_t found = text.find("@"); found != std::string::npos; found = text.find("@", found)) text.replace(found, 1, stamp(at));
    for (std::size_t found = text.find("#"); found != std::string::npos; found = text.find("#", found)) text.replace(found, 1, stamp(kStart + 60'000));
    Json::Value intent = parse("{\"d\": " + text + "}");
    intent["scope"] = scope;
    intent["gestureId"] = gesture;
    return intent;
  }

  static Json::Value step(const std::string& id, const std::string& label, const std::string& ord) {
    return parse(R"({"t": "node", "id": ")" + id + R"(", "born": "@", "life": ["alive", "@"], "f": {"label": [")" + label +
                 R"(", "@"], "ord": [")" + ord + R"(", "@"]}})");
  }

  static Json::Value mark(const std::string& step) {
    return parse(R"({"t": "progress", "id": ")" + step + R"(", "f": {"mark": [{"status": "complete", "outOfOrder": false}, "@"]}})");
  }

  static std::string deltas(const std::vector<Json::Value>& records) {
    Json::Value list(Json::arrayValue);
    for (const Json::Value& record : records) list.append(record);
    return sync::jcs(list);
  }

  // Ann's roadmap "A roadmap", unlisted: Basics (olive), then Ownership, then Traits; under Basics a subtree of Rig and
  // Knot. Every push a minute after the one before, from kStart.
  void plant() {
    push(kStart, {intent("self/roadmap", "g-root", kStart, R"([{"t": "tree", "id": ")" + kRoot + R"(", "born": "@", "life": ["alive", "@"]}])")});
    Json::Value basics = step("basics", "Basics", "a0");
    basics["f"]["color"] = parse(R"(["olive", "@"])");
    push(kStart + 60'000,
         {intent("tree/" + kRoot, "g-made", kStart + 60'000,
                 deltas({parse(R"({"t": "meta", "id": "meta", "f": {"title": ["A roadmap", "@"]}})"), basics,
                         step("ownership", "Ownership", "a1"), step("traits", "Traits", "a2"),
                         parse(R"({"t": "edge", "id": ["basics", "ownership"], "life": ["alive", "@"]})"),
                         parse(R"({"t": "edge", "id": ["ownership", "traits"], "life": ["alive", "@"]})")}))});
    push(kStart + 120'000, {intent("tree/" + kRoot, "g-unlisted", kStart + 120'000,
                                   R"([{"t": "meta", "id": "meta", "f": {"visibility": ["unlisted", "@"]}}])")});
    Json::Value subtree = parse(R"({"scope": "self/roadmap", "gestureId": "g-subtree", "d": [], "cmd": {"name": "roadmap.createSubtree"}})");
    subtree["cmd"]["args"] = parse(R"({"tree": ")" + kRoot + R"(", "root": ")" + kRoot + R"(", "step": "basics", "subtree": ")" + kSubtree + R"("})");
    push(kStart + 180'000, {subtree});
    push(kStart + 240'000, {intent("tree/" + kSubtree, "g-rig", kStart + 240'000, deltas({step("rig", "Rig", "a0"), step("knot", "Knot", "a1")}))});
  }

  void deleteBasics(std::uint64_t at) {
    push(at, {intent("tree/" + kRoot, "g-delete-basics", at, R"([{"t": "node", "id": "basics", "born": "#", "life": ["dead", "@"]}])")});
  }

  drogon::HttpRequestPtr get(const std::string& session) const {
    auto request = drogon::HttpRequest::newHttpRequest();
    request->setMethod(drogon::Get);
    if (!session.empty()) request->addCookie("wm_session", session);
    return request;
  }

  drogon::HttpResponsePtr activityOf(const std::string& session, const std::string& tree) {
    drogon::HttpResponsePtr answered;
    treeApi.getActivity(get(session), [&](const drogon::HttpResponsePtr& response) { answered = response; }, tree);
    return answered;
  }

  drogon::HttpResponsePtr progressOf(const std::string& session, const std::string& tree) {
    drogon::HttpResponsePtr answered;
    treeApi.getProgress(get(session), [&](const drogon::HttpResponsePtr& response) { answered = response; }, tree);
    return answered;
  }

  std::string pageOf(const std::string& session, const std::string& tree) {
    drogon::HttpResponsePtr answered;
    sharePage.page(get(session), [&](const drogon::HttpResponsePtr& response) { answered = response; }, tree);
    return std::string(answered->body());
  }

  Json::Value galleryIndex(const std::string& session) {
    drogon::HttpResponsePtr answered;
    auto request = get(session);
    request->setPath("/v1/gallery");
    gallery.index(request, [&](const drogon::HttpResponsePtr& response) { answered = response; });
    return *answered->getJsonObject();
  }
};

// The events as the route answers them, each `at` checked to be when the server received its gesture and then left out.
Json::Value eventsOf(const drogon::HttpResponsePtr& response, std::uint64_t notBefore) {
  Json::Value events = (*response->getJsonObject())["events"];
  for (Json::Value& event : events) {
    CHECK(event["at"].asUInt64() >= notBefore);
    event.removeMember("at");
  }
  return events;
}

}

TEST(engine_activity_tells_each_gesture_once_by_the_roadmaps_present_steps_and_only_to_who_may_read_it) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  const std::uint64_t before = static_cast<std::uint64_t>(
      std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch()).count()) - 1'000;
  Engine engine;
  engine.plant();
  engine.push(kStart + 300'000, {Engine::intent("tree/" + kRoot, "g-rename", kStart + 300'000,
                                                R"([{"t": "node", "id": "basics", "born": "#", "life": ["alive", "@"], "f": {"label": ["Foundations", "@"]}}])")});
  engine.push(kStart + 360'000, {Engine::intent("tree/" + kRoot, "g-traits", kStart + 360'000, R"([{"t": "node", "id": "traits", "born": "#", "life": ["dead", "@"]}])")});

  const drogon::HttpResponsePtr owner = engine.activityOf("ann-session", kRoot);
  const drogon::HttpResponsePtr reader = engine.activityOf("bea-session", kRoot);

  CHECK_EQ(owner->statusCode(), drogon::k200OK);
  const Json::Value expected = parse(R"([
      {"id": "1", "seq": 1, "actor": "", "verb": "added", "nodeId": "basics", "label": "Foundations", "kind": "olive", "summary": "added 3 nodes"},
      {"id": "4", "seq": 4, "actor": "", "verb": "renamed", "nodeId": "basics", "label": "Foundations", "kind": "olive", "summary": "renamed to Foundations"},
      {"id": "5", "seq": 5, "actor": "", "verb": "removed", "nodeId": "traits", "label": "traits", "kind": "", "summary": "removed traits"}])");
  CHECK_EQ(sync::jcs(eventsOf(owner, before)), sync::jcs(expected));
  CHECK_EQ(reader->statusCode(), drogon::k200OK);
  CHECK_EQ(sync::jcs(eventsOf(reader, before)), sync::jcs(expected));

  engine.push(kStart + 420'000, {Engine::intent("tree/" + kRoot, "g-private", kStart + 420'000,
                                                R"([{"t": "meta", "id": "meta", "f": {"visibility": ["private", "@"]}}])")});
  CHECK_EQ(engine.activityOf("bea-session", kRoot)->statusCode(), drogon::k404NotFound);
  CHECK_EQ(engine.activityOf("", kRoot)->statusCode(), drogon::k404NotFound);
  CHECK_EQ(engine.activityOf("ann-session", kSubtree)->statusCode(), drogon::k200OK);

  engine.deleteBasics(kStart + 480'000);
  CHECK_EQ(engine.activityOf("ann-session", kSubtree)->statusCode(), drogon::k404NotFound);
  CHECK_EQ(engine.activityOf("ann-session", "t_00000000000000ff")->statusCode(), drogon::k404NotFound);
}

TEST(engine_progress_shows_its_owner_the_marks_as_stored_and_a_reader_a_step_complete_when_its_subtree_is) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  Engine engine;
  engine.plant();
  engine.push(kStart + 300'000, {Engine::intent("self/overlay/" + kRoot, "g-own", kStart + 300'000, Engine::deltas({Engine::mark("ownership")}))});
  engine.push(kStart + 360'000, {Engine::intent("self/overlay/" + kSubtree, "g-sub", kStart + 360'000,
                                                Engine::deltas({Engine::mark("rig"), Engine::mark("knot")}))});

  const drogon::HttpResponsePtr owner = engine.progressOf("ann-session", kRoot);
  const drogon::HttpResponsePtr reader = engine.progressOf("", kRoot);

  const std::string ownership = Engine::stamp(kStart + 300'000);
  const std::string subtree = R"("subtrees": [{"node": "basics", "tree": ")" + kSubtree + R"(", "done": 2, "total": 2}])";
  CHECK_EQ(owner->statusCode(), drogon::k200OK);
  CHECK_EQ(sync::jcs(*owner->getJsonObject()),
           sync::jcs(parse(R"({"marks": [{"node": "ownership", "status": "complete", "at": ")" + ownership + R"(", "markedAt": )" +
                           std::to_string(kStart + 300'000) + "}], " + subtree + "}")));
  CHECK_EQ(reader->statusCode(), drogon::k200OK);
  CHECK_EQ(sync::jcs(*reader->getJsonObject()),
           sync::jcs(parse(R"({"marks": [{"node": "basics", "status": "complete", "at": "0:0:", "markedAt": )" +
                           std::to_string(kStart + 360'000) + R"(}, {"node": "ownership", "status": "complete", "at": ")" + ownership +
                           R"(", "markedAt": )" + std::to_string(kStart + 300'000) + "}], " + subtree + "}")));

  engine.deleteBasics(kStart + 420'000);
  CHECK_EQ(engine.progressOf("ann-session", kSubtree)->statusCode(), drogon::k404NotFound);
  CHECK_EQ(sync::jcs((*engine.progressOf("", kRoot)->getJsonObject())["subtrees"]), "[]");
}

TEST(engine_share_page_names_a_readable_roadmap_and_its_standing_subtree_and_serves_the_shell_for_the_rest) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  Engine engine;
  engine.plant();
  engine.push(kStart + 300'000, {Engine::intent("self/roadmap", "g-private-root", kStart + 300'000,
                                                R"([{"t": "tree", "id": ")" + kPrivate + R"(", "born": "@", "life": ["alive", "@"]}])"),
                                 Engine::intent("tree/" + kPrivate, "g-private-made", kStart + 300'000,
                                                Engine::deltas({parse(R"({"t": "meta", "id": "meta", "f": {"title": ["Mine alone", "@"]}})"),
                                                                Engine::step("one", "One", "a0")}))});

  CHECK_EQ(engine.pageOf("", kRoot),
           SharePageApi::renderShell(kShell, "https://share.example", "A roadmap", 3, Visibility::unlisted, kRoot, ForkLineage{}, false));
  CHECK_EQ(engine.pageOf("", kSubtree),
           SharePageApi::renderShell(kShell, "https://share.example", "Basics", 2, Visibility::unlisted, kSubtree, ForkLineage{}, false));
  CHECK_EQ(engine.pageOf("", kPrivate), kShell);
  CHECK_EQ(engine.pageOf("bea-session", kPrivate), kShell);
  CHECK_EQ(engine.pageOf("ann-session", kPrivate),
           SharePageApi::renderShell(kShell, "https://share.example", "Mine alone", 1, Visibility::private_, kPrivate, ForkLineage{}, false));

  engine.deleteBasics(kStart + 360'000);
  CHECK_EQ(engine.pageOf("ann-session", kSubtree), kShell);
  CHECK_EQ(engine.pageOf("", kRoot),
           SharePageApi::renderShell(kShell, "https://share.example", "A roadmap", 2, Visibility::unlisted, kRoot, ForkLineage{}, false));
}

TEST(engine_gallery_lists_a_public_root_with_its_owners_progress_and_no_subtree) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  Engine engine;
  engine.plant();
  engine.push(kStart + 300'000, {Engine::intent("self/overlay/" + kRoot, "g-own", kStart + 300'000, Engine::deltas({Engine::mark("ownership")}))});
  engine.push(kStart + 360'000, {Engine::intent("tree/" + kRoot, "g-public", kStart + 360'000,
                                                R"([{"t": "meta", "id": "meta", "f": {"visibility": ["public", "@"]}}])")});

  const Json::Value anonymous = engine.galleryIndex("");
  const Json::Value owner = engine.galleryIndex("ann-session");

  const auto mine = [&](bool owned) {
    Json::Value row = parse(R"({"id": ")" + kRoot + R"(", "title": "A roadmap", "total": 3, "done": 1, "dominantKind": "terracotta",
        "forks": 0, "forked": false})");
    row["updatedAt"] = Json::Int64(kStart + 360'000);
    row["mine"] = owned;
    Json::Value index(Json::objectValue);
    index["entries"].append(row);
    index["count"] = 1;
    return index;
  };
  CHECK_EQ(sync::jcs(anonymous), sync::jcs(mine(false)));
  CHECK_EQ(sync::jcs(owner), sync::jcs(mine(true)));
}

TEST(engine_readiness_names_each_roots_steps_whose_prerequisites_are_met_through_its_subtree) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  Engine engine;
  engine.plant();
  engine.push(kStart + 300'000, {Engine::intent("self/overlay/" + kSubtree, "g-sub", kStart + 300'000,
                                                Engine::deltas({Engine::mark("rig"), Engine::mark("knot")}))});

  const std::vector<TreeReadiness> readiness = engine.reads->readiness(engine.ann);

  REQUIRE_EQ(readiness.size(), std::size_t{1});
  CHECK_EQ(readiness[0].id, TreeId{kRoot});
  CHECK_EQ(readiness[0].title, std::string("A roadmap"));
  CHECK_EQ(readiness[0].lastActivityAtMs, kStart + 180'000);
  CHECK_EQ(readiness[0].total, 3);
  CHECK_EQ(readiness[0].done, 1);
  REQUIRE_EQ(readiness[0].ready.size(), std::size_t{1});
  CHECK_EQ(readiness[0].ready[0].id, NodeId{"ownership"});
  CHECK_EQ(readiness[0].ready[0].label, std::string("Ownership"));
  CHECK_EQ(readiness[0].ready[0].color, NodeColor::terracotta);
}
