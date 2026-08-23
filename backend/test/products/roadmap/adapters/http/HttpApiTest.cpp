#include "products/roadmap/adapters/http/HttpApi.h"

#include "products/roadmap/adapters/json/TreeJson.h"
#include "products/roadmap/domain/Command.h"
#include "products/roadmap/domain/LooseGraph.h"
#include "test/platform/Fakes.h"
#include "test/products/roadmap/Fakes.h"
#include "test/testing.h"

#include <algorithm>
#include <memory>
#include <mutex>
#include <string>
#include <vector>

using namespace wm;
using namespace wm::fake;

namespace {

struct Harness {
  std::shared_ptr<FakeTreeRepository> trees = std::make_shared<FakeTreeRepository>();
  std::shared_ptr<FakeProgressRepository> progress = std::make_shared<FakeProgressRepository>();
  std::shared_ptr<FakeOpLog> ops = std::make_shared<FakeOpLog>();
  FakeBus bus;
  FakeTokens tokens;
  FakeClock clock;
  FakeAuthRepository authRepo;
  FakeEmail email;
  std::shared_ptr<RoomRegistry> rooms = std::make_shared<RoomRegistry>(*trees, *ops, bus);
  FakeOAuthRepository oauthRepo;
  OAuthService oauth{oauthRepo, tokens, clock};
  FakeAccountFootprint footprint;
  std::shared_ptr<AuthService> auth =
      std::make_shared<AuthService>(authRepo, email, tokens, clock, oauth, footprint, "https://windmill.works");
  std::shared_ptr<ForkService> fork = std::make_shared<ForkService>(*rooms, *trees, tokens);
  HttpApi api{rooms, trees, progress, ops, Hlc{1, 0, "genesis"}, auth, fork};

  UserId signIn(const std::string& sessionSecret, const std::string& email = "sam@example.com") {
    User user = authRepo.createUser(Email{email}, "sam");
    authRepo.insertSession(tokens.digestOf(sessionSecret), user.id, clock.now + 1'000'000, "", "", clock.now);
    return user.id;
  }

  void seedSource(const char* id, const char* title) {
    seed(id, title, UserId{"owner"}, Visibility::unlisted);
  }
  void seed(const char* id, const char* title, const UserId& owner, Visibility visibility) {
    TreeData data;
    data.id = TreeId{std::string(id)};
    data.title = title;
    NodeSpec root;
    root.id = NodeId{"root"};
    root.label = "Root";
    data.nodes = {root};
    GraphState state = LooseGraph(data, Hlc{1, 0, "seed"}).exportState();
    trees->byId[id] = StoredTree{state, LegendState{}, {title, {}}, 0, owner, visibility};
  }
};

drogon::HttpRequestPtr getRequest(const std::string& session) {
  auto request = drogon::HttpRequest::newHttpRequest();
  request->setMethod(drogon::Get);
  if (!session.empty()) request->addCookie("wm_session", session);
  return request;
}

drogon::HttpResponsePtr sendGetTree(HttpApi& api, const std::string& session, const std::string& id) {
  drogon::HttpResponsePtr captured;
  api.getTree(getRequest(session), [&](const drogon::HttpResponsePtr& r) { captured = r; }, id);
  return captured;
}

drogon::HttpResponsePtr sendGetDiagnostics(HttpApi& api, const std::string& session, const std::string& id) {
  drogon::HttpResponsePtr captured;
  api.getDiagnostics(getRequest(session), [&](const drogon::HttpResponsePtr& r) { captured = r; }, id);
  return captured;
}

drogon::HttpResponsePtr sendGetActivity(HttpApi& api, const std::string& session, const std::string& id) {
  drogon::HttpResponsePtr captured;
  api.getActivity(getRequest(session), [&](const drogon::HttpResponsePtr& r) { captured = r; }, id);
  return captured;
}

drogon::HttpResponsePtr sendGetProgress(HttpApi& api, const std::string& session, const std::string& id) {
  drogon::HttpResponsePtr captured;
  api.getProgress(getRequest(session), [&](const drogon::HttpResponsePtr& r) { captured = r; }, id);
  return captured;
}

Json::Value document(const std::string& title, const std::string& nodeId) {
  Json::Value node(Json::objectValue);
  node["id"] = nodeId;
  node["label"] = nodeId;
  Json::Value body(Json::objectValue);
  body["title"] = title;
  body["nodes"] = Json::Value(Json::arrayValue);
  body["nodes"].append(node);
  return body;
}

drogon::HttpResponsePtr sendPut(HttpApi& api, const std::string& session, const std::string& id,
                                const Json::Value& body) {
  auto request = drogon::HttpRequest::newHttpRequest();
  request->setMethod(drogon::Put);
  request->setContentTypeCode(drogon::CT_APPLICATION_JSON);
  request->setBody(dump(body));
  if (!session.empty()) request->addCookie("wm_session", session);
  drogon::HttpResponsePtr captured;
  api.putTree(request, [&](const drogon::HttpResponsePtr& r) { captured = r; }, id);
  return captured;
}

void editInTheLiveRoom(Harness& h, const char* id, const char* nodeId, const UserId& actor) {
  std::lock_guard<std::mutex> lock(h.rooms->strandFor(TreeId{id}));
  h.rooms->open(TreeId{id})->applyCommand(createNode(nodeId), 5'000, actor);
}

std::vector<std::string> storedNodeIds(FakeTreeRepository& trees, const std::string& id) {
  std::vector<std::string> out;
  for (const NodeId& node : LooseGraph(trees.byId[id].state).presentNodeIds()) out.push_back(node.str());
  return out;
}

drogon::HttpRequestPtr forkRequest(const Json::Value& body, const std::string& session) {
  auto request = drogon::HttpRequest::newHttpRequest();
  request->setMethod(drogon::Post);
  request->setContentTypeCode(drogon::CT_APPLICATION_JSON);
  request->setBody(dump(body));
  if (!session.empty()) request->addCookie("wm_session", session);
  return request;
}

drogon::HttpResponsePtr sendFork(HttpApi& api, const drogon::HttpRequestPtr& request,
                                 const std::string& source) {
  drogon::HttpResponsePtr captured;
  api.forkTree(request, [&](const drogon::HttpResponsePtr& response) { captured = response; }, source);
  return captured;
}

Json::Value withId(const std::string& id) {
  Json::Value body(Json::objectValue);
  body["id"] = id;
  return body;
}

Json::Value bodyOf(const drogon::HttpResponsePtr& response) { return *response->getJsonObject(); }

// The single completed id in a progress body, or "" for none; the body is a lattice frame of stamped registers.
std::string soleCompleted(const drogon::HttpResponsePtr& response) {
  // Bind the body to a named local: a range-for over bodyOf(response)["marks"] walks a destroyed temporary.
  const Json::Value body = bodyOf(response);
  std::string found;
  for (const Json::Value& mark : body["marks"]) {
    if (mark["status"].asString() != "complete") continue;
    if (!found.empty()) return "";  // more than one: the callers all seed exactly one
    found = mark["node"].asString();
  }
  return found;
}

}

TEST(fork_rejects_a_malformed_requested_id_before_touching_the_source) {
  Harness h;
  h.signIn("s-live");
  h.seedSource("t_src", "Learn to sail");

  const std::string malformed[] = {
      "t_0123456789ABCDEF",   // uppercase hex
      "x_0123456789abcdef",   // wrong prefix
      "t_0123456789abcde",    // 15 hex chars
      "t_0123456789abcdef0",  // 17 hex chars
      "t_' OR '1'='1;--xx",   // injection junk, length-correct
  };
  for (const std::string& id : malformed) {
    drogon::HttpResponsePtr response = sendFork(h.api, forkRequest(withId(id), "s-live"), "t_src");
    CHECK_EQ(response->getStatusCode(), drogon::k400BadRequest);
    CHECK_EQ(dump(bodyOf(response)),
             std::string(R"({"code":"bad-id","error":"id must be t_ followed by 16 lowercase hex characters"})"));
  }
  CHECK_EQ(h.trees->byId.size(), 1u);
  CHECK(h.trees->forkedFrom.empty());
}

TEST(fork_accepts_a_well_formed_requested_id) {
  Harness h;
  UserId me = h.signIn("s-live");
  h.seedSource("t_src", "Learn to sail");

  drogon::HttpResponsePtr response =
      sendFork(h.api, forkRequest(withId("t_0123456789abcdef"), "s-live"), "t_src");

  CHECK_EQ(response->getStatusCode(), drogon::k201Created);
  Json::Value body = bodyOf(response);
  CHECK_EQ(body["seq"].asInt64(), 0);
  CHECK_EQ(body["data"]["id"].asString(), std::string("t_0123456789abcdef"));
  CHECK_EQ(h.trees->forkedFrom["t_0123456789abcdef"], std::string("t_src"));
  CHECK(h.trees->byId["t_0123456789abcdef"].owner == std::optional<UserId>(me));
}

TEST(fork_without_an_id_still_mints_one) {
  Harness h;
  h.signIn("s-live");
  h.seedSource("t_src", "Learn to sail");

  drogon::HttpResponsePtr response =
      sendFork(h.api, forkRequest(Json::Value(Json::objectValue), "s-live"), "t_src");

  CHECK_EQ(response->getStatusCode(), drogon::k201Created);
  CHECK_EQ(bodyOf(response)["data"]["id"].asString(), std::string("t_d1"));
  CHECK_EQ(h.trees->forkedFrom["t_d1"], std::string("t_src"));
}

// ---- read enforcement (tree-visibility) --------------------------------------------------

TEST(get_tree_owner_reads_a_private_tree_with_mine_true) {
  Harness h;
  UserId me = h.signIn("s-me");
  h.seed("t_priv", "My private plan", me, Visibility::private_);

  drogon::HttpResponsePtr response = sendGetTree(h.api, "s-me", "t_priv");

  CHECK_EQ(response->getStatusCode(), drogon::k200OK);
  Json::Value body = bodyOf(response);
  CHECK_EQ(body["visibility"].asString(), std::string("private"));
  CHECK(body["mine"].asBool());
  CHECK(body.isMember("data"));
  CHECK(body.isMember("state"));
  CHECK_EQ(body["seq"].asInt64(), 0);
}

TEST(get_tree_serves_the_planting_time_and_zero_when_there_is_none) {
  Harness h;
  UserId me = h.signIn("s-me");
  h.seed("t_plant", "Sourdough", me, Visibility::private_);
  h.seed("t_undated", "Ancient", me, Visibility::private_);
  h.trees->byId["t_plant"].createdAt = 1'753'400'000'000;  // epoch ms

  Json::Value planted = bodyOf(sendGetTree(h.api, "s-me", "t_plant"));
  Json::Value undated = bodyOf(sendGetTree(h.api, "s-me", "t_undated"));

  CHECK_EQ(planted["createdAt"].asInt64(), 1'753'400'000'000);
  CHECK(undated.isMember("createdAt"));  // present and 0 — never missing, never null
  CHECK_EQ(undated["createdAt"].asInt64(), 0);
}

TEST(get_tree_private_denial_is_404_byte_identical_to_absent) {
  Harness h;
  h.signIn("s-other", "other@example.com");
  h.seed("t_priv", "Secret", UserId{"owner"}, Visibility::private_);

  drogon::HttpResponsePtr anon = sendGetTree(h.api, "", "t_priv");
  drogon::HttpResponsePtr nonOwner = sendGetTree(h.api, "s-other", "t_priv");
  drogon::HttpResponsePtr absent = sendGetTree(h.api, "s-other", "t_ghost");

  CHECK_EQ(anon->getStatusCode(), drogon::k404NotFound);
  CHECK_EQ(nonOwner->getStatusCode(), drogon::k404NotFound);
  CHECK_EQ(absent->getStatusCode(), drogon::k404NotFound);
  const std::string absentBody = dump(bodyOf(absent));
  CHECK_EQ(dump(bodyOf(anon)), absentBody);
  CHECK_EQ(dump(bodyOf(nonOwner)), absentBody);
  CHECK_EQ(absentBody, std::string(R"({"error":"no such tree"})"));
}

TEST(get_tree_unlisted_is_readable_by_anyone_but_not_mine_for_a_stranger) {
  Harness h;
  h.seed("t_shared", "Shared plan", UserId{"owner"}, Visibility::unlisted);

  drogon::HttpResponsePtr anon = sendGetTree(h.api, "", "t_shared");
  CHECK_EQ(anon->getStatusCode(), drogon::k200OK);
  Json::Value body = bodyOf(anon);
  CHECK_EQ(body["visibility"].asString(), std::string("unlisted"));
  CHECK_FALSE(body["mine"].asBool());
}

TEST(get_tree_public_is_world_readable) {
  Harness h;
  h.seed("t_demo", "The demo", UserId{"owner"}, Visibility::public_);

  drogon::HttpResponsePtr anon = sendGetTree(h.api, "", "t_demo");
  CHECK_EQ(anon->getStatusCode(), drogon::k200OK);
  CHECK_EQ(bodyOf(anon)["visibility"].asString(), std::string("public"));
}

TEST(get_diagnostics_private_denial_is_404_byte_identical_to_absent) {
  Harness h;
  UserId me = h.signIn("s-me");
  h.seed("t_mine", "Mine", me, Visibility::private_);
  h.seed("t_priv", "Secret", UserId{"owner"}, Visibility::private_);

  CHECK_EQ(sendGetDiagnostics(h.api, "s-me", "t_mine")->getStatusCode(), drogon::k200OK);
  drogon::HttpResponsePtr anon = sendGetDiagnostics(h.api, "", "t_priv");
  drogon::HttpResponsePtr absent = sendGetDiagnostics(h.api, "", "t_ghost");
  CHECK_EQ(anon->getStatusCode(), drogon::k404NotFound);
  CHECK_EQ(absent->getStatusCode(), drogon::k404NotFound);
  CHECK_EQ(dump(bodyOf(anon)), dump(bodyOf(absent)));
}

TEST(get_diagnostics_unlisted_is_readable_by_anyone) {
  Harness h;
  h.seed("t_shared", "Shared", UserId{"owner"}, Visibility::unlisted);
  CHECK_EQ(sendGetDiagnostics(h.api, "", "t_shared")->getStatusCode(), drogon::k200OK);
}

TEST(get_activity_private_denial_is_404_byte_identical_to_absent) {
  Harness h;
  UserId me = h.signIn("s-me");
  h.seed("t_mine", "Mine", me, Visibility::private_);
  h.seed("t_priv", "Secret", UserId{"owner"}, Visibility::private_);

  CHECK_EQ(sendGetActivity(h.api, "s-me", "t_mine")->getStatusCode(), drogon::k200OK);
  drogon::HttpResponsePtr anon = sendGetActivity(h.api, "", "t_priv");
  drogon::HttpResponsePtr absent = sendGetActivity(h.api, "", "t_ghost");
  CHECK_EQ(anon->getStatusCode(), drogon::k404NotFound);
  CHECK_EQ(absent->getStatusCode(), drogon::k404NotFound);
  CHECK_EQ(dump(bodyOf(anon)), dump(bodyOf(absent)));
}

TEST(get_activity_unlisted_is_readable_by_anyone) {
  Harness h;
  h.seed("t_shared", "Shared", UserId{"owner"}, Visibility::unlisted);
  CHECK_EQ(sendGetActivity(h.api, "", "t_shared")->getStatusCode(), drogon::k200OK);
}

// ---- shared-tree progress follows ownership (the share shows the owner's journey) --------

TEST(get_progress_shows_the_owners_journey_to_an_anonymous_visitor) {
  Harness h;
  h.seed("t_shared", "Shared plan", UserId{"owner"}, Visibility::unlisted);
  h.progress->setStatus(TreeId{"t_shared"}, UserId{"owner"}, NodeId{"root"}, ProgressStatus::complete, Hlc{2, 0, "owner"}, 2);

  drogon::HttpResponsePtr anon = sendGetProgress(h.api, "", "t_shared");
  CHECK_EQ(anon->getStatusCode(), drogon::k200OK);
  CHECK_EQ(soleCompleted(anon), std::string("root"));
}

TEST(get_progress_shows_the_same_journey_to_owner_and_stranger) {
  Harness h;
  UserId me = h.signIn("s-me", "me@example.com");
  h.seed("t_shared", "Shared plan", UserId{"owner"}, Visibility::public_);
  h.progress->setStatus(TreeId{"t_shared"}, UserId{"owner"}, NodeId{"root"}, ProgressStatus::complete, Hlc{2, 0, "owner"}, 2);
  h.progress->setStatus(TreeId{"t_shared"}, me, NodeId{"root"}, ProgressStatus::none, Hlc{2, 0, "me"}, 2);

  CHECK_EQ(soleCompleted(sendGetProgress(h.api, "s-me", "t_shared")), std::string("root"));
  CHECK_EQ(soleCompleted(sendGetProgress(h.api, "", "t_shared")), std::string("root"));
}

TEST(get_progress_of_a_private_tree_is_404_for_a_non_owner_and_200_for_its_owner) {
  Harness h;
  UserId owner = h.signIn("s-owner", "owner-acct@example.com");
  h.signIn("s-other", "other@example.com");
  h.seed("t_priv", "Secret", owner, Visibility::private_);
  h.progress->setStatus(TreeId{"t_priv"}, owner, NodeId{"root"}, ProgressStatus::complete, Hlc{2, 0, "o"}, 2);

  CHECK_EQ(sendGetProgress(h.api, "s-other", "t_priv")->getStatusCode(), drogon::k404NotFound);
  CHECK_EQ(sendGetProgress(h.api, "", "t_priv")->getStatusCode(), drogon::k404NotFound);
  CHECK_EQ(soleCompleted(sendGetProgress(h.api, "s-owner", "t_priv")), std::string("root"));
}

TEST(fork_of_a_private_source_you_dont_own_is_404_like_absent) {
  Harness h;
  h.signIn("s-me");
  h.seed("t_priv", "Someone's private plan", UserId{"owner"}, Visibility::private_);

  drogon::HttpResponsePtr denied = sendFork(h.api, forkRequest(Json::Value(Json::objectValue), "s-me"), "t_priv");
  drogon::HttpResponsePtr absent = sendFork(h.api, forkRequest(Json::Value(Json::objectValue), "s-me"), "t_ghost");

  CHECK_EQ(denied->getStatusCode(), drogon::k404NotFound);
  CHECK_EQ(absent->getStatusCode(), drogon::k404NotFound);
  CHECK_EQ(dump(bodyOf(denied)), dump(bodyOf(absent)));
  CHECK(h.trees->forkedFrom.empty());
}

TEST(fork_of_your_own_private_source_succeeds) {
  Harness h;
  UserId me = h.signIn("s-me");
  h.seed("t_priv", "My private plan", me, Visibility::private_);

  drogon::HttpResponsePtr response = sendFork(h.api, forkRequest(Json::Value(Json::objectValue), "s-me"), "t_priv");
  CHECK_EQ(response->getStatusCode(), drogon::k201Created);
  CHECK_EQ(h.trees->forkedFrom["t_d1"], std::string("t_priv"));
}

// ---- PUT /v1/trees/{id} : the write gate, and a tree born owned -----------------------------

TEST(put_by_an_anonymous_caller_is_401_and_writes_nothing) {
  Harness h;

  drogon::HttpResponsePtr response = sendPut(h.api, "", "t_00000000000000e0", document("Mine", "a"));

  CHECK_EQ(response->getStatusCode(), drogon::k401Unauthorized);
  CHECK_EQ(dump(bodyOf(response)), std::string(R"({"error":"sign in to edit"})"));
  CHECK_EQ(h.trees->byId.count("t_00000000000000e0"), std::size_t{0});
}

TEST(put_to_an_unowned_tree_is_403_and_leaves_it_unowned_and_unmodified) {
  Harness h;
  h.signIn("s-visitor", "visitor@example.com");
  h.seed("t_00000000000000de", "Learn to sail", UserId{"placeholder"}, Visibility::public_);
  h.trees->byId["t_00000000000000de"].owner = std::nullopt;  // the demo row: owner NULL, visibility public
  const StoredTree before = h.trees->byId["t_00000000000000de"];

  drogon::HttpResponsePtr response = sendPut(h.api, "s-visitor", "t_00000000000000de", document("Mine now", "seized"));

  CHECK_EQ(response->getStatusCode(), drogon::k403Forbidden);
  CHECK_EQ(bodyOf(response)["code"].asString(), std::string("nobodys-tree"));
  CHECK_EQ(bodyOf(response)["error"].asString(),
           std::string("no account owns this tree, so it cannot be edited — you can still read it, or fork it into a roadmap of your own"));
  CHECK_FALSE(h.trees->byId["t_00000000000000de"].owner.has_value());
  CHECK(h.trees->byId["t_00000000000000de"] == before);
  CHECK_EQ(storedNodeIds(*h.trees, "t_00000000000000de"), std::vector<std::string>{"root"});
}

TEST(put_to_someone_elses_readable_tree_is_403_and_writes_nothing) {
  Harness h;
  h.signIn("s-other", "other@example.com");
  h.seed("t_000000000000ffee", "Theirs", UserId{"owner"}, Visibility::unlisted);
  const StoredTree before = h.trees->byId["t_000000000000ffee"];

  drogon::HttpResponsePtr response = sendPut(h.api, "s-other", "t_000000000000ffee", document("Mine now", "seized"));

  CHECK_EQ(response->getStatusCode(), drogon::k403Forbidden);
  CHECK_EQ(dump(bodyOf(response)), std::string(R"({"code":"not-yours","error":"this tree belongs to another account"})"));
  CHECK(h.trees->byId["t_000000000000ffee"] == before);
  CHECK(h.trees->byId["t_000000000000ffee"].owner == std::optional<UserId>(UserId{"owner"}));
}

TEST(put_to_a_private_tree_you_cannot_read_is_404_and_writes_nothing) {
  Harness h;
  h.signIn("s-other", "other@example.com");
  h.seed("t_00000000000000aa", "Secret", UserId{"owner"}, Visibility::private_);
  const StoredTree before = h.trees->byId["t_00000000000000aa"];

  drogon::HttpResponsePtr response = sendPut(h.api, "s-other", "t_00000000000000aa", document("Mine now", "seized"));

  CHECK_EQ(response->getStatusCode(), drogon::k404NotFound);
  CHECK_EQ(dump(bodyOf(response)), std::string(R"({"error":"no such tree"})"));
  CHECK(h.trees->byId["t_00000000000000aa"] == before);
}

TEST(put_to_an_unowned_private_tree_is_404_and_writes_nothing) {
  Harness h;
  h.signIn("s-me");
  h.seed("t_0000000000000bbb", "Orphan", UserId{"placeholder"}, Visibility::private_);
  h.trees->byId["t_0000000000000bbb"].owner = std::nullopt;
  const StoredTree before = h.trees->byId["t_0000000000000bbb"];

  drogon::HttpResponsePtr response = sendPut(h.api, "s-me", "t_0000000000000bbb", document("Mine now", "seized"));

  CHECK_EQ(response->getStatusCode(), drogon::k404NotFound);
  CHECK(h.trees->byId["t_0000000000000bbb"] == before);
  CHECK_FALSE(h.trees->byId["t_0000000000000bbb"].owner.has_value());
}

TEST(put_to_an_absent_id_creates_a_tree_owned_by_the_caller) {
  Harness h;
  UserId me = h.signIn("s-me");

  drogon::HttpResponsePtr response = sendPut(h.api, "s-me", "t_00000000000000e0", document("Learn to sail", "hull"));

  CHECK_EQ(response->getStatusCode(), drogon::k200OK);
  Json::Value body = bodyOf(response);
  CHECK_EQ(body["seq"].asInt64(), 0);
  CHECK_EQ(body["data"]["id"].asString(), std::string("t_00000000000000e0"));
  CHECK_EQ(body["data"]["title"].asString(), std::string("Learn to sail"));
  CHECK_EQ(body["data"]["kinds"].size(), 3u);

  REQUIRE_EQ(h.trees->byId.count("t_00000000000000e0"), std::size_t{1});
  CHECK(h.trees->byId["t_00000000000000e0"].owner == std::optional<UserId>(me));
  CHECK(h.trees->byId["t_00000000000000e0"].visibility == Visibility::private_);
  CHECK_EQ(h.trees->byId["t_00000000000000e0"].title.value, std::string("Learn to sail"));
  CHECK_EQ(storedNodeIds(*h.trees, "t_00000000000000e0"), std::vector<std::string>{"hull"});
}

TEST(put_by_the_owner_overwrites_the_document_and_keeps_the_owner) {
  Harness h;
  UserId me = h.signIn("s-me");
  h.seed("t_00000000000000cc", "Old name", me, Visibility::unlisted);

  drogon::HttpResponsePtr response = sendPut(h.api, "s-me", "t_00000000000000cc", document("New name", "mast"));

  CHECK_EQ(response->getStatusCode(), drogon::k200OK);
  CHECK_EQ(bodyOf(response)["data"]["title"].asString(), std::string("New name"));
  CHECK(h.trees->byId["t_00000000000000cc"].owner == std::optional<UserId>(me));
  CHECK(h.trees->byId["t_00000000000000cc"].visibility == Visibility::unlisted);
  CHECK_EQ(h.trees->byId["t_00000000000000cc"].title.value, std::string("New name"));
  // The lattice is entry-grow-only: a save adds and overwrites entries, never deletes rows.
  std::vector<std::string> ids = storedNodeIds(*h.trees, "t_00000000000000cc");
  std::sort(ids.begin(), ids.end());
  CHECK_EQ(ids, (std::vector<std::string>{"mast", "root"}));
}

TEST(put_to_a_malformed_id_is_400_bad_id_and_creates_nothing) {
  Harness h;
  h.signIn("s-me");

  drogon::HttpResponsePtr response = sendPut(h.api, "s-me", "audit-weird-id", document("Mine", "a"));

  CHECK_EQ(response->getStatusCode(), drogon::k400BadRequest);
  CHECK_EQ(dump(bodyOf(response)),
           std::string(R"({"code":"bad-id","error":"id must be t_ followed by 16 lowercase hex characters"})"));
  CHECK_EQ(h.trees->byId.count("audit-weird-id"), std::size_t{0});
}

TEST(put_with_a_wrong_typed_field_is_400_not_500_and_creates_nothing) {
  Harness h;
  h.signIn("s-me");
  Json::Value body(Json::objectValue);
  body["title"] = "x";
  body["nodes"] = Json::Value(Json::arrayValue);
  body["nodes"].append(1);

  drogon::HttpResponsePtr response = sendPut(h.api, "s-me", "t_00000000000000e1", body);

  CHECK_EQ(response->getStatusCode(), drogon::k400BadRequest);
  CHECK_EQ(dump(bodyOf(response)), std::string(R"({"error":"invalid json body"})"));
  CHECK_EQ(h.trees->byId.count("t_00000000000000e1"), std::size_t{0});
}

TEST(put_with_an_oversized_field_is_400_naming_the_node_and_creates_nothing) {
  Harness h;
  h.signIn("s-me");
  Json::Value body = document("Mine", "hull");
  body["nodes"][0]["label"] = std::string(kMaxNodeLabelLength + 1, 'x');

  drogon::HttpResponsePtr response = sendPut(h.api, "s-me", "t_00000000000000e2", body);

  CHECK_EQ(response->getStatusCode(), drogon::k400BadRequest);
  CHECK_EQ(dump(bodyOf(response)),
           std::string(R"({"error":"node \"hull\": label is 201 characters, max 200"})"));
  CHECK_EQ(h.trees->byId.count("t_00000000000000e2"), std::size_t{0});
}

TEST(put_over_the_edge_ceiling_is_413_and_creates_nothing) {
  Harness h;
  h.signIn("s-me");
  Json::Value body(Json::objectValue);
  body["title"] = "Too tangled";
  body["nodes"] = Json::Value(Json::arrayValue);
  // Five hubs and 4001 steps requiring all five: 20005 edges over 4006 nodes — under the node ceiling, over the edge one.
  for (int hub = 0; hub < 5; ++hub) {
    Json::Value node(Json::objectValue);
    node["id"] = "hub" + std::to_string(hub);
    body["nodes"].append(node);
  }
  for (std::size_t i = 0; i <= kMaxEdges / 5; ++i) {
    Json::Value node(Json::objectValue);
    node["id"] = "n" + std::to_string(i);
    node["prerequisites"] = Json::Value(Json::arrayValue);
    for (int hub = 0; hub < 5; ++hub) node["prerequisites"].append("hub" + std::to_string(hub));
    body["nodes"].append(node);
  }

  drogon::HttpResponsePtr response = sendPut(h.api, "s-me", "t_0000000000000b17", body);

  CHECK_EQ(response->getStatusCode(), drogon::k413RequestEntityTooLarge);
  CHECK_EQ(bodyOf(response)["error"].asString(),
           std::string("this tree would hold 20005 edges, max 20000 — call tidy to drop the edges "
                       "a longer path already implies"));
  CHECK_EQ(h.trees->byId.count("t_0000000000000b17"), std::size_t{0});
}

TEST(put_over_the_node_ceiling_is_413_and_creates_nothing) {
  Harness h;
  h.signIn("s-me");
  Json::Value body(Json::objectValue);
  body["title"] = "Too big";
  body["nodes"] = Json::Value(Json::arrayValue);
  for (std::size_t i = 0; i <= kMaxNodes; ++i) {
    Json::Value node(Json::objectValue);
    node["id"] = "n" + std::to_string(i);
    body["nodes"].append(node);
  }

  drogon::HttpResponsePtr response = sendPut(h.api, "s-me", "t_0000000000000b16", body);

  CHECK_EQ(response->getStatusCode(), drogon::k413RequestEntityTooLarge);
  CHECK_EQ(h.trees->byId.count("t_0000000000000b16"), std::size_t{0});
}

// ---- PUT and the live room: gate first, evict second ---------------------------------------

TEST(a_refused_put_leaves_the_owners_live_room_open_and_untouched) {
  Harness h;
  UserId owner = h.signIn("s-owner", "owner-acct@example.com");
  h.signIn("s-stranger", "stranger@example.com");
  h.seed("t_000000000000ffee", "Theirs", owner, Visibility::unlisted);
  editInTheLiveRoom(h, "t_000000000000ffee", "owner-step", owner);
  const StoredTree before = h.trees->byId["t_000000000000ffee"];

  drogon::HttpResponsePtr response = sendPut(h.api, "s-stranger", "t_000000000000ffee", document("Mine now", "seized"));

  CHECK_EQ(response->getStatusCode(), drogon::k403Forbidden);
  CHECK(h.rooms->isOpen(TreeId{"t_000000000000ffee"}));
  CHECK(h.trees->savedNodeCounts.empty());
  CHECK(h.trees->byId["t_000000000000ffee"] == before);
}

TEST(a_put_to_a_private_tree_you_cannot_read_leaves_its_live_room_open_and_untouched) {
  Harness h;
  h.signIn("s-stranger", "stranger@example.com");
  h.seed("t_00000000000000aa", "Secret", UserId{"owner"}, Visibility::private_);
  editInTheLiveRoom(h, "t_00000000000000aa", "private-step", UserId{"owner"});
  const StoredTree before = h.trees->byId["t_00000000000000aa"];

  drogon::HttpResponsePtr response = sendPut(h.api, "s-stranger", "t_00000000000000aa", document("Mine now", "seized"));

  CHECK_EQ(response->getStatusCode(), drogon::k404NotFound);
  CHECK_EQ(dump(bodyOf(response)), std::string(R"({"error":"no such tree"})"));
  CHECK(h.rooms->isOpen(TreeId{"t_00000000000000aa"}));
  CHECK(h.trees->savedNodeCounts.empty());
  CHECK(h.trees->byId["t_00000000000000aa"] == before);
}

TEST(put_over_a_live_room_saves_at_the_rooms_head_so_no_op_tail_replays_over_it) {
  Harness h;
  UserId me = h.signIn("s-me");
  h.seed("t_00000000000000cc", "Old name", me, Visibility::unlisted);
  editInTheLiveRoom(h, "t_00000000000000cc", "socket-step", me);
  CHECK_EQ(h.trees->byId["t_00000000000000cc"].head, Seq{0});  // the row is behind the room by one op
  CHECK_EQ(h.ops->byTree["t_00000000000000cc"].size(), 1u);

  drogon::HttpResponsePtr response = sendPut(h.api, "s-me", "t_00000000000000cc", document("New name", "mast"));

  CHECK_EQ(response->getStatusCode(), drogon::k200OK);
  CHECK_EQ(h.trees->byId["t_00000000000000cc"].head, Seq{1});
  CHECK_EQ(bodyOf(response)["seq"].asInt64(), 1);
  CHECK(h.ops->since(TreeId{"t_00000000000000cc"}, h.trees->byId["t_00000000000000cc"].head).empty());
}

TEST(put_over_a_live_room_mints_its_title_past_the_rooms_rename_not_the_stale_row) {
  Harness h;
  UserId me = h.signIn("s-me");
  h.seed("t_00000000000000cc", "Old name", me, Visibility::unlisted);
  {
    std::lock_guard<std::mutex> lock(h.rooms->strandFor(TreeId{"t_00000000000000cc"}));
    h.rooms->open(TreeId{"t_00000000000000cc"})->rename("Renamed over the socket", 5'000);
  }
  CHECK_EQ(h.trees->byId["t_00000000000000cc"].title.value, std::string("Old name"));

  drogon::HttpResponsePtr response = sendPut(h.api, "s-me", "t_00000000000000cc", document("Posted name", "mast"));

  CHECK_EQ(response->getStatusCode(), drogon::k200OK);
  CHECK_EQ(bodyOf(response)["data"]["title"].asString(), std::string("Posted name"));
  CHECK_EQ(h.trees->byId["t_00000000000000cc"].title.value, std::string("Posted name"));
  CHECK(h.trees->byId["t_00000000000000cc"].title.stamp == (Hlc{5'000, 1, "srv"}));
}

TEST(repeated_puts_of_fresh_ids_cannot_walk_a_tree_past_the_node_ceiling) {
  Harness h;
  h.signIn("s-me");
  const std::string id = "t_0000000000000c01";
  auto batch = [](std::size_t from, std::size_t count) {
    Json::Value body(Json::objectValue);
    body["title"] = "Growing";
    body["nodes"] = Json::Value(Json::arrayValue);
    for (std::size_t i = from; i < from + count; ++i) {
      Json::Value node(Json::objectValue);
      node["id"] = "n" + std::to_string(i);
      body["nodes"].append(node);
    }
    return body;
  };

  CHECK_EQ(sendPut(h.api, "s-me", id, batch(0, 6000))->getStatusCode(), drogon::k200OK);
  drogon::HttpResponsePtr second = sendPut(h.api, "s-me", id, batch(6000, 6000));

  CHECK_EQ(second->getStatusCode(), drogon::k413RequestEntityTooLarge);
  CHECK_EQ(bodyOf(second)["error"].asString(),
           std::string("this tree would hold 12000 nodes, max 10000 — split it across roadmaps, "
                       "or delete what it has outgrown"));
  CHECK_EQ(storedNodeIds(*h.trees, id).size(), std::size_t{6000});
}

TEST(a_put_that_re_sends_the_nodes_already_stored_is_still_admitted) {
  Harness h;
  h.signIn("s-me");
  const std::string id = "t_0000000000000c02";
  Json::Value body(Json::objectValue);
  body["title"] = "Steady";
  body["nodes"] = Json::Value(Json::arrayValue);
  for (std::size_t i = 0; i < kMaxNodes; ++i) {
    Json::Value node(Json::objectValue);
    node["id"] = "n" + std::to_string(i);
    body["nodes"].append(node);
  }

  CHECK_EQ(sendPut(h.api, "s-me", id, body)->getStatusCode(), drogon::k200OK);
  CHECK_EQ(sendPut(h.api, "s-me", id, body)->getStatusCode(), drogon::k200OK);
  CHECK_EQ(storedNodeIds(*h.trees, id).size(), kMaxNodes);
}

// The id shape is a MINT rule: it binds the PUT that creates and nothing else — slug ids (`windmill-roadmap`, `demo`) are the contract in db/schema.sql.
TEST(put_to_an_existing_slug_id_tree_is_still_the_owners_to_write) {
  Harness h;
  UserId me = h.signIn("s-me");
  h.seed("windmill-roadmap", "The roadmap", me, Visibility::unlisted);

  drogon::HttpResponsePtr response = sendPut(h.api, "s-me", "windmill-roadmap", document("Renamed", "mast"));

  CHECK_EQ(response->getStatusCode(), drogon::k200OK);
  CHECK_EQ(h.trees->byId["windmill-roadmap"].title.value, std::string("Renamed"));
}

TEST(put_and_fork_refuse_a_non_object_json_root_with_400) {
  Harness h;
  h.signIn("s-me");
  h.seedSource("t_src", "Learn to sail");

  for (const char* body : {"[]", "\"hello\"", "5"}) {
    auto request = drogon::HttpRequest::newHttpRequest();
    request->setMethod(drogon::Put);
    request->setContentTypeCode(drogon::CT_APPLICATION_JSON);
    request->setBody(body);
    request->addCookie("wm_session", "s-me");
    drogon::HttpResponsePtr captured;
    h.api.putTree(request, [&](const drogon::HttpResponsePtr& r) { captured = r; }, "t_0000000000000c03");
    CHECK_EQ(captured->getStatusCode(), drogon::k400BadRequest);
    CHECK_EQ(dump(bodyOf(captured)), std::string(R"({"error":"invalid json body"})"));

    auto fork = drogon::HttpRequest::newHttpRequest();
    fork->setMethod(drogon::Post);
    fork->setContentTypeCode(drogon::CT_APPLICATION_JSON);
    fork->setBody(body);
    fork->addCookie("wm_session", "s-me");
    drogon::HttpResponsePtr forked;
    h.api.forkTree(fork, [&](const drogon::HttpResponsePtr& r) { forked = r; }, "t_src");
    CHECK_EQ(forked->getStatusCode(), drogon::k400BadRequest);
    CHECK_EQ(dump(bodyOf(forked)), std::string(R"({"error":"invalid json body"})"));
  }
  CHECK_EQ(h.trees->byId.count("t_0000000000000c03"), std::size_t{0});
}
