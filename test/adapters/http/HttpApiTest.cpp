#include "adapters/http/HttpApi.h"

#include "adapters/json/TreeJson.h"
#include "domain/LooseGraph.h"
#include "test/application/AuthFakes.h"
#include "test/application/Fakes.h"
#include "test/testing.h"

#include <memory>
#include <string>

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
  std::shared_ptr<AuthService> auth =
      std::make_shared<AuthService>(authRepo, email, tokens, clock, oauth, "https://windmill.works");
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
