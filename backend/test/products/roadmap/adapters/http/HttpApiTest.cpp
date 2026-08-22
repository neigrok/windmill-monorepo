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

  // A shared (unlisted) source, forkable and readable by anyone with the id.
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

// A posted document: the exact body a PUT carries — a title and one node.
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

// A live room that has run past its stored row: one server-minted edit, logged at the next seq
// and broadcast, but not yet flushed — exactly the window every write path leaves open between
// appending its op and saving the snapshot.
void editInTheLiveRoom(Harness& h, const char* id, const char* nodeId, const UserId& actor) {
  std::lock_guard<std::mutex> lock(h.rooms->strandFor(TreeId{id}));
  h.rooms->open(TreeId{id})->applyCommand(createNode(nodeId), 5'000, actor);
}

// The ids a stored tree's lattice still has present — what "was it overwritten?" reads as.
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

// The single completed id in a progress body (these tests seed exactly one), or "" for none. The
// body is a lattice frame of stamped registers, so "completed" is a status to look for among the
// marks, not an array to index.
std::string soleCompleted(const drogon::HttpResponsePtr& response) {
  // The body is bound to a named local, NOT iterated as bodyOf(response)["marks"]: a range-for
  // does not extend the lifetime of a temporary the range expression only reaches THROUGH, so
  // that spelling walks a destroyed Json::Value and silently finds nothing.
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
  CHECK_EQ(h.trees->byId.size(), 1u);  // only the source — nothing was forked
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
  h.trees->byId["t_plant"].createdAt = 1'753'400'000'000;  // epoch ms, exactly like updatedAt

  Json::Value planted = bodyOf(sendGetTree(h.api, "s-me", "t_plant"));
  Json::Value undated = bodyOf(sendGetTree(h.api, "s-me", "t_undated"));

  CHECK_EQ(planted["createdAt"].asInt64(), 1'753'400'000'000);
  CHECK(undated.isMember("createdAt"));  // present and 0 — never a missing key, never null
  CHECK_EQ(undated["createdAt"].asInt64(), 0);
}

TEST(get_tree_private_denial_is_404_byte_identical_to_absent) {
  Harness h;
  h.signIn("s-other", "other@example.com");  // a signed-in non-owner (u1)
  h.seed("t_priv", "Secret", UserId{"owner"}, Visibility::private_);

  drogon::HttpResponsePtr anon = sendGetTree(h.api, "", "t_priv");
  drogon::HttpResponsePtr nonOwner = sendGetTree(h.api, "s-other", "t_priv");
  drogon::HttpResponsePtr absent = sendGetTree(h.api, "s-other", "t_ghost");

  CHECK_EQ(anon->getStatusCode(), drogon::k404NotFound);
  CHECK_EQ(nonOwner->getStatusCode(), drogon::k404NotFound);
  CHECK_EQ(absent->getStatusCode(), drogon::k404NotFound);
  // No existence leak: a private-denied read is indistinguishable from a missing tree.
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
  CHECK_FALSE(body["mine"].asBool());  // an anonymous reader owns nothing
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

  CHECK_EQ(sendGetDiagnostics(h.api, "s-me", "t_mine")->getStatusCode(), drogon::k200OK);  // owner reads
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

  CHECK_EQ(sendGetActivity(h.api, "s-me", "t_mine")->getStatusCode(), drogon::k200OK);  // owner reads
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
  CHECK_EQ(soleCompleted(anon), std::string("root"));  // the lit tree the share promised, not empty
}

TEST(get_progress_shows_the_same_journey_to_owner_and_stranger) {
  Harness h;
  UserId me = h.signIn("s-me", "me@example.com");  // a signed-in NON-owner
  h.seed("t_shared", "Shared plan", UserId{"owner"}, Visibility::public_);
  h.progress->setStatus(TreeId{"t_shared"}, UserId{"owner"}, NodeId{"root"}, ProgressStatus::complete, Hlc{2, 0, "owner"}, 2);
  // A stranger has their own (empty) row set for the same tree — it must NOT shadow the owner's.
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

  CHECK_EQ(sendGetProgress(h.api, "s-other", "t_priv")->getStatusCode(), drogon::k404NotFound);  // never leaked
  CHECK_EQ(sendGetProgress(h.api, "", "t_priv")->getStatusCode(), drogon::k404NotFound);
  CHECK_EQ(soleCompleted(sendGetProgress(h.api, "s-owner", "t_priv")), std::string("root"));  // owner reads
}

TEST(fork_of_a_private_source_you_dont_own_is_404_like_absent) {
  Harness h;
  h.signIn("s-me");
  h.seed("t_priv", "Someone's private plan", UserId{"owner"}, Visibility::private_);

  drogon::HttpResponsePtr denied = sendFork(h.api, forkRequest(Json::Value(Json::objectValue), "s-me"), "t_priv");
  drogon::HttpResponsePtr absent = sendFork(h.api, forkRequest(Json::Value(Json::objectValue), "s-me"), "t_ghost");

  CHECK_EQ(denied->getStatusCode(), drogon::k404NotFound);
  CHECK_EQ(absent->getStatusCode(), drogon::k404NotFound);
  CHECK_EQ(dump(bodyOf(denied)), dump(bodyOf(absent)));  // no existence leak through the fork endpoint
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
//
// This route had no read gate, no ownership gate that meant anything (it refused only a tree
// someone ELSE owned), and no test. It saved an ownerless row and then claimed it — so a PUT to
// the seeded demo id would have replaced the demo wholesale and handed it to the caller.

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
  // Not "belongs to another account" — that sends the reader looking for an account that does not
  // exist. This route is public and reachable by any client, so the sentence has to be true here.
  CHECK_EQ(bodyOf(response)["code"].asString(), std::string("nobodys-tree"));
  CHECK_EQ(bodyOf(response)["error"].asString(),
           std::string("no account owns this tree, so it cannot be edited — you can still read it, or fork it into a roadmap of your own"));
  CHECK_FALSE(h.trees->byId["t_00000000000000de"].owner.has_value());   // nobody took it
  CHECK(h.trees->byId["t_00000000000000de"] == before);                 // and nothing was written over it
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

// The read gate this route never had: a private tree the caller cannot read answers "no such
// tree", the same sentence every other read on this surface gives — a refusal must never state
// that a private id belongs to someone.
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

// An unowned PRIVATE row — a legacy orphan — fails the read gate before the write gate, so it
// reads as absent and is neither overwritten nor seized.
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

// Create-if-absent: the row is born OWNED, in the one insert that creates it. There is no
// instant at which it exists ownerless, so no other account can ever reach it.
TEST(put_to_an_absent_id_creates_a_tree_owned_by_the_caller) {
  Harness h;
  UserId me = h.signIn("s-me");

  drogon::HttpResponsePtr response = sendPut(h.api, "s-me", "t_00000000000000e0", document("Learn to sail", "hull"));

  CHECK_EQ(response->getStatusCode(), drogon::k200OK);
  Json::Value body = bodyOf(response);
  CHECK_EQ(body["seq"].asInt64(), 0);
  CHECK_EQ(body["data"]["id"].asString(), std::string("t_00000000000000e0"));
  CHECK_EQ(body["data"]["title"].asString(), std::string("Learn to sail"));
  CHECK_EQ(body["data"]["kinds"].size(), 3u);  // a brand-new tree gets the three seeded defaults

  REQUIRE_EQ(h.trees->byId.count("t_00000000000000e0"), std::size_t{1});
  CHECK(h.trees->byId["t_00000000000000e0"].owner == std::optional<UserId>(me));
  CHECK(h.trees->byId["t_00000000000000e0"].visibility == Visibility::private_);  // born private, like every tree
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
  CHECK(h.trees->byId["t_00000000000000cc"].visibility == Visibility::unlisted);  // an overwrite never reshares
  CHECK_EQ(h.trees->byId["t_00000000000000cc"].title.value, std::string("New name"));
  // The posted document is the new baseline: its node lands beside the seeded one (the lattice
  // is entry-grow-only — a save adds and overwrites entries, it never deletes rows).
  std::vector<std::string> ids = storedNodeIds(*h.trees, "t_00000000000000cc");
  std::sort(ids.begin(), ids.end());
  CHECK_EQ(ids, (std::vector<std::string>{"mast", "root"}));
}

// PUT creates a tree at whatever id the path names, so the id must be the shape fork and create
// already demand. Without this the route planted trees at any string at all — a 20KB primary key
// copied into every child row after it.
TEST(put_to_a_malformed_id_is_400_bad_id_and_creates_nothing) {
  Harness h;
  h.signIn("s-me");

  drogon::HttpResponsePtr response = sendPut(h.api, "s-me", "audit-weird-id", document("Mine", "a"));

  CHECK_EQ(response->getStatusCode(), drogon::k400BadRequest);
  CHECK_EQ(dump(bodyOf(response)),
           std::string(R"({"code":"bad-id","error":"id must be t_ followed by 16 lowercase hex characters"})"));
  CHECK_EQ(h.trees->byId.count("audit-weird-id"), std::size_t{0});
}

// A wrong-typed field used to throw jsoncpp's LogicError out of the handler: a 500, a
// server_errors row and a Sentry event, per request, for what is plainly a bad body.
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

// The per-field caps the command path enforces, on the document path too — a 200KB label was
// persisted here for as long as this route checked only the node count.
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

// Edges were never counted on this route at all: 10000 legal nodes could carry half a million
// prerequisites, and every later read — and every health pass — paid for them.
TEST(put_over_the_edge_ceiling_is_413_and_creates_nothing) {
  Harness h;
  h.signIn("s-me");
  Json::Value body(Json::objectValue);
  body["title"] = "Too tangled";
  body["nodes"] = Json::Value(Json::arrayValue);
  // Five hubs, and 4001 steps that each require all five: 20005 edges over 4006 nodes, so the
  // document is under the node ceiling and over the edge one.
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
//
// `evict` flushes a room to the database and closes it, under the one registry mutex every room
// in the process shares. Above the gates it would be a lever anyone could pull: a signed-in
// caller could force a flush-and-close of ANY id — a private tree they cannot read, the hot demo
// room — serializing every other room behind the write and making the victim's next frame pay a
// cold reopen. Below them, a refusal costs its victim nothing.

TEST(a_refused_put_leaves_the_owners_live_room_open_and_untouched) {
  Harness h;
  UserId owner = h.signIn("s-owner", "owner-acct@example.com");
  h.signIn("s-stranger", "stranger@example.com");
  h.seed("t_000000000000ffee", "Theirs", owner, Visibility::unlisted);
  editInTheLiveRoom(h, "t_000000000000ffee", "owner-step", owner);
  const StoredTree before = h.trees->byId["t_000000000000ffee"];

  drogon::HttpResponsePtr response = sendPut(h.api, "s-stranger", "t_000000000000ffee", document("Mine now", "seized"));

  CHECK_EQ(response->getStatusCode(), drogon::k403Forbidden);
  CHECK(h.rooms->isOpen(TreeId{"t_000000000000ffee"}));  // the victim's room was never flushed and closed
  CHECK(h.trees->savedNodeCounts.empty());     // and a refusal writes nothing, not even a flush
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
  CHECK(h.rooms->isOpen(TreeId{"t_00000000000000aa"}));  // an unreadable id is no lever on its owner's room
  CHECK(h.trees->savedNodeCounts.empty());
  CHECK(h.trees->byId["t_00000000000000aa"] == before);
}

// The other half of the ordering: once authorized, the write must read the row the eviction just
// flushed, never one read before it. Taking `head` from a row the room has already run past
// rewinds head_seq under the op log — the row says 0 while the log holds seq 1 — and the next
// open replays that tail straight back over the document this PUT wrote.
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
  CHECK(h.ops->since(TreeId{"t_00000000000000cc"}, h.trees->byId["t_00000000000000cc"].head).empty());  // nothing left to replay
}

// The same staleness, one field over, and this one loses data silently: the room was renamed at
// ms 5000, so a title minted past the row's untouched stamp lands at {0,1,srv} and loses the
// repository's LWW guard against {5000,0,srv}. The reply would say 200 "Posted name" while the
// row kept the socket's name — the worst shape a write can take.
TEST(put_over_a_live_room_mints_its_title_past_the_rooms_rename_not_the_stale_row) {
  Harness h;
  UserId me = h.signIn("s-me");
  h.seed("t_00000000000000cc", "Old name", me, Visibility::unlisted);
  {
    std::lock_guard<std::mutex> lock(h.rooms->strandFor(TreeId{"t_00000000000000cc"}));
    h.rooms->open(TreeId{"t_00000000000000cc"})->rename("Renamed over the socket", 5'000);
  }
  CHECK_EQ(h.trees->byId["t_00000000000000cc"].title.value, std::string("Old name"));  // not flushed yet

  drogon::HttpResponsePtr response = sendPut(h.api, "s-me", "t_00000000000000cc", document("Posted name", "mast"));

  CHECK_EQ(response->getStatusCode(), drogon::k200OK);
  CHECK_EQ(bodyOf(response)["data"]["title"].asString(), std::string("Posted name"));
  CHECK_EQ(h.trees->byId["t_00000000000000cc"].title.value, std::string("Posted name"));  // the row says what the reply did
  CHECK(h.trees->byId["t_00000000000000cc"].title.stamp == (Hlc{5'000, 1, "srv"}));       // minted one past the rename
}

// A document of N nodes is a JOIN into whatever the row already holds — save upserts the entries
// the document names and deletes nothing — so a per-request ceiling is no ceiling at all: five
// individually-legal PUTs of fresh ids each left 45000 nodes standing on a 10000 cap.
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
  CHECK_EQ(storedNodeIds(*h.trees, id).size(), std::size_t{6000});  // the refused batch wrote nothing
}

// The same document twice is an upsert, not growth — the tree it would leave behind is the
// measure, so re-PUTting what is already there stays admissible at any size.
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

// The id shape is a MINT rule, so it binds the PUT that creates and nothing else. Slug ids
// (`windmill-roadmap`, `demo`) predate the mint and are the documented contract in db/schema.sql;
// gating every PUT locked 12 of 68 trees on a real database out of their own owners' writes.
TEST(put_to_an_existing_slug_id_tree_is_still_the_owners_to_write) {
  Harness h;
  UserId me = h.signIn("s-me");
  h.seed("windmill-roadmap", "The roadmap", me, Visibility::unlisted);

  drogon::HttpResponsePtr response = sendPut(h.api, "s-me", "windmill-roadmap", document("Renamed", "mast"));

  CHECK_EQ(response->getStatusCode(), drogon::k200OK);
  CHECK_EQ(h.trees->byId["windmill-roadmap"].title.value, std::string("Renamed"));
}

// A root that parsed but is not an object throws out of every keyed read jsoncpp does — which
// reached the global handler as a 500, a server_errors row and a Sentry event, per request.
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
