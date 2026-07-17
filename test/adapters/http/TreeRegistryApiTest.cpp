#include "adapters/http/TreeRegistryApi.h"

#include "adapters/json/TreeJson.h"
#include "application/RoomRegistry.h"
#include "test/application/AuthFakes.h"
#include "test/application/Fakes.h"
#include "test/testing.h"

#include <optional>
#include <string>

using namespace wm;
using namespace wm::fake;

namespace {

struct Harness {
  FakeTreeRepository trees;
  FakeProgressRepository progress;
  FakeTokens tokens;
  FakeOpLog ops;
  FakeBus bus;
  FakeClock clock;
  RoomRegistry rooms{trees, ops, bus};
  FakeAuthRepository authRepo;
  FakeEmail email;
  FakeOAuthRepository oauthRepo;
  OAuthService oauth{oauthRepo, tokens, clock};
  std::shared_ptr<AuthService> auth =
      std::make_shared<AuthService>(authRepo, email, tokens, clock, oauth, "https://windmill.works");
  std::shared_ptr<TreeRegistry> registry =
      std::make_shared<TreeRegistry>(trees, progress, tokens, Hlc{1, 0, "genesis"}, rooms, clock);
  TreeRegistryApi api{registry, auth};

  UserId signIn(const std::string& sessionSecret, const std::string& address) {
    User user = authRepo.createUser(Email{address}, "sam");
    authRepo.insertSession(tokens.digestOf(sessionSecret), user.id, clock.now + 1'000'000, "", "", clock.now);
    return user.id;
  }
};

drogon::HttpRequestPtr post(const Json::Value& body, const std::string& session = "") {
  auto request = drogon::HttpRequest::newHttpRequest();
  request->setMethod(drogon::Post);
  request->setPath("/v1/trees");
  request->setContentTypeCode(drogon::CT_APPLICATION_JSON);
  request->setBody(dump(body));
  if (!session.empty()) request->addCookie("wm_session", session);
  return request;
}

drogon::HttpResponsePtr create(TreeRegistryApi& api, const drogon::HttpRequestPtr& request) {
  drogon::HttpResponsePtr captured;
  api.createTree(request, [&](const drogon::HttpResponsePtr& response) { captured = response; });
  return captured;
}

Json::Value titled(const std::string& title) {
  Json::Value body(Json::objectValue);
  body["title"] = title;
  return body;
}

Json::Value claim(const std::string& id, const std::string& title) {
  Json::Value body = titled(title);
  body["id"] = id;
  return body;
}

Json::Value bodyOf(const drogon::HttpResponsePtr& response) { return *response->getJsonObject(); }

}

TEST(create_without_an_id_mints_one_and_reports_existed_false) {
  Harness h;
  UserId me = h.signIn("s-live", "sam@example.com");

  drogon::HttpResponsePtr response = create(h.api, post(titled("Kitchen garden"), "s-live"));

  CHECK_EQ(response->getStatusCode(), drogon::k200OK);
  CHECK_EQ(dump(bodyOf(response)), std::string(R"({"existed":false,"treeId":"t_d1"})"));
  CHECK(h.trees.byId["t_d1"].owner == std::optional<UserId>(me));
  CHECK(h.trees.byId["t_d1"].title == (Lww<std::string>{"Kitchen garden", Hlc{}}));
}

TEST(create_with_a_client_id_plants_it_empty_and_claimable) {
  Harness h;
  UserId me = h.signIn("s-live", "sam@example.com");

  drogon::HttpResponsePtr response =
      create(h.api, post(claim("t_0123456789abcdef", "Learn woodworking"), "s-live"));

  CHECK_EQ(response->getStatusCode(), drogon::k200OK);
  CHECK_EQ(dump(bodyOf(response)), std::string(R"({"existed":false,"treeId":"t_0123456789abcdef"})"));
  const StoredTree& stored = h.trees.byId["t_0123456789abcdef"];
  CHECK(stored.owner == std::optional<UserId>(me));
  CHECK(stored.title == (Lww<std::string>{"Learn woodworking", Hlc{}}));  // the stampless baseline
  CHECK(stored.state == GraphState{});  // no nodes — the client's CRDT flush brings the lattice
  CHECK(stored.legend == Legend::seededDefaults(Hlc{1, 0, "genesis"}).exportState());
}

TEST(create_with_the_same_id_resumes_idempotently_for_its_owner) {
  Harness h;
  h.signIn("s-live", "sam@example.com");
  create(h.api, post(claim("t_0123456789abcdef", "Learn woodworking"), "s-live"));
  StoredTree before = h.trees.byId["t_0123456789abcdef"];

  drogon::HttpResponsePtr response =
      create(h.api, post(claim("t_0123456789abcdef", "Renamed since"), "s-live"));

  CHECK_EQ(response->getStatusCode(), drogon::k200OK);
  CHECK_EQ(dump(bodyOf(response)), std::string(R"({"existed":true,"treeId":"t_0123456789abcdef"})"));
  CHECK(h.trees.byId["t_0123456789abcdef"] == before);  // the resume never touches the row
}

TEST(create_with_an_id_owned_by_another_account_is_refused_as_taken) {
  Harness h;
  UserId owner = h.signIn("s-owner", "owner@example.com");
  h.signIn("s-intruder", "intruder@example.com");
  create(h.api, post(claim("t_0123456789abcdef", "Theirs"), "s-owner"));

  drogon::HttpResponsePtr response =
      create(h.api, post(claim("t_0123456789abcdef", "Mine now"), "s-intruder"));

  CHECK_EQ(response->getStatusCode(), drogon::k409Conflict);
  CHECK_EQ(dump(bodyOf(response)),
           std::string(R"({"code":"id-taken","error":"that id already names another tree"})"));
  CHECK(h.trees.byId["t_0123456789abcdef"].owner == std::optional<UserId>(owner));
  CHECK_EQ(h.trees.byId["t_0123456789abcdef"].title.value, std::string("Theirs"));
}

TEST(create_with_a_soft_deleted_id_is_refused_as_taken) {
  Harness h;
  h.signIn("s-live", "sam@example.com");
  create(h.api, post(claim("t_0123456789abcdef", "Gone soon"), "s-live"));
  drogon::HttpResponsePtr deleted;
  auto request = drogon::HttpRequest::newHttpRequest();
  request->setMethod(drogon::Delete);
  request->addCookie("wm_session", "s-live");
  h.api.deleteTree(request, [&](const drogon::HttpResponsePtr& r) { deleted = r; }, "t_0123456789abcdef");
  CHECK_EQ(deleted->getStatusCode(), drogon::k204NoContent);

  drogon::HttpResponsePtr response =
      create(h.api, post(claim("t_0123456789abcdef", "Again"), "s-live"));

  CHECK_EQ(response->getStatusCode(), drogon::k409Conflict);
  CHECK_EQ(dump(bodyOf(response)),
           std::string(R"({"code":"id-taken","error":"that id already names another tree"})"));
}

TEST(create_rejects_every_malformed_id_shape_before_any_work) {
  Harness h;
  h.signIn("s-live", "sam@example.com");

  const std::string malformed[] = {
      "t_0123456789ABCDEF",   // uppercase hex
      "x_0123456789abcdef",   // wrong prefix
      "t_0123456789abcde",    // 15 hex chars
      "t_0123456789abcdef0",  // 17 hex chars
      "t_' OR '1'='1;--xx",   // injection junk, length-correct
      "t_0123456789abcdeg",   // non-hex letter
      "t__123456789abcdef",   // underscore inside the hex run
  };
  for (const std::string& id : malformed) {
    drogon::HttpResponsePtr response = create(h.api, post(claim(id, "Sneaky"), "s-live"));
    CHECK_EQ(response->getStatusCode(), drogon::k400BadRequest);
    CHECK_EQ(dump(bodyOf(response)),
             std::string(R"({"code":"bad-id","error":"id must be t_ followed by 16 lowercase hex characters"})"));
  }
  CHECK(h.trees.byId.empty());  // nothing was planted
}

TEST(create_with_an_id_still_requires_a_session) {
  Harness h;

  drogon::HttpResponsePtr response = create(h.api, post(claim("t_0123456789abcdef", "Ghost")));

  CHECK_EQ(response->getStatusCode(), drogon::k401Unauthorized);
  CHECK_EQ(dump(bodyOf(response)), std::string(R"({"error":"sign in to plant a roadmap"})"));
  CHECK(h.trees.byId.empty());
}
