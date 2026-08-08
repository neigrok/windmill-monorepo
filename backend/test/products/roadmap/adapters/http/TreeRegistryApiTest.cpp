#include "products/roadmap/adapters/http/TreeRegistryApi.h"

#include "products/roadmap/adapters/json/TreeJson.h"
#include "products/roadmap/application/RoomRegistry.h"
#include "test/platform/Fakes.h"
#include "test/products/roadmap/Fakes.h"
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
  FakeAccountFootprint footprint;
  std::shared_ptr<AuthService> auth =
      std::make_shared<AuthService>(authRepo, email, tokens, clock, oauth, footprint, "https://windmill.works");
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

// Delete a tree the way a switcher does, asserting the 204 — the setup step for every case
// about what an id means AFTER its tree is gone.
void retire(TreeRegistryApi& api, const std::string& id, const std::string& session) {
  auto request = drogon::HttpRequest::newHttpRequest();
  request->setMethod(drogon::Delete);
  request->addCookie("wm_session", session);
  drogon::HttpResponsePtr captured;
  api.deleteTree(request, [&](const drogon::HttpResponsePtr& response) { captured = response; }, id);
  CHECK_EQ(captured->getStatusCode(), drogon::k204NoContent);
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

drogon::HttpRequestPtr patch(const Json::Value& body, const std::string& session = "") {
  auto request = drogon::HttpRequest::newHttpRequest();
  request->setMethod(drogon::Patch);
  request->setPath("/v1/trees/t");
  request->setContentTypeCode(drogon::CT_APPLICATION_JSON);
  request->setBody(dump(body));
  if (!session.empty()) request->addCookie("wm_session", session);
  return request;
}

drogon::HttpResponsePtr sendPatch(TreeRegistryApi& api, const drogon::HttpRequestPtr& request,
                                  const std::string& id) {
  drogon::HttpResponsePtr captured;
  api.patchTree(request, [&](const drogon::HttpResponsePtr& response) { captured = response; }, id);
  return captured;
}

Json::Value shareTo(const char* visibility) {
  Json::Value body(Json::objectValue);
  body["visibility"] = visibility;
  return body;
}

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

// The claim path answers `id-taken` by re-planting under a fresh id — right for a stranger's id,
// catastrophic for your own retired one: it resurrects the tree you just deleted, once per boot,
// forever. So your own retired id gets its own code, and only you are ever told.
TEST(create_with_your_own_soft_deleted_id_is_refused_as_retired) {
  Harness h;
  h.signIn("s-live", "sam@example.com");
  create(h.api, post(claim("t_0123456789abcdef", "Gone soon"), "s-live"));
  retire(h.api, "t_0123456789abcdef", "s-live");

  drogon::HttpResponsePtr response =
      create(h.api, post(claim("t_0123456789abcdef", "Again"), "s-live"));

  CHECK_EQ(response->getStatusCode(), drogon::k409Conflict);
  CHECK_EQ(dump(bodyOf(response)),
           std::string(R"({"code":"id-retired","error":"that id names a roadmap you deleted"})"));
}

// The other half of the same rule: a retired id still reads as a plain `id-taken` to everybody
// else, byte-identical to a live stranger's tree. Whether an id is dead is the owner's business.
TEST(create_with_another_accounts_soft_deleted_id_is_still_refused_as_taken) {
  Harness h;
  h.signIn("s-owner", "owner@example.com");
  h.signIn("s-intruder", "intruder@example.com");
  create(h.api, post(claim("t_0123456789abcdef", "Theirs"), "s-owner"));
  retire(h.api, "t_0123456789abcdef", "s-owner");

  drogon::HttpResponsePtr response =
      create(h.api, post(claim("t_0123456789abcdef", "Mine now"), "s-intruder"));

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

// ---- PATCH visibility (the share seam) ---------------------------------------------------

TEST(patch_visibility_owner_flip_returns_204_and_reshares) {
  Harness h;
  UserId me = h.signIn("s-live", "sam@example.com");
  h.trees.byId["t"] = StoredTree{GraphState{}, LegendState{}, {"Mine", {}}, 0, me};  // born private

  drogon::HttpResponsePtr response = sendPatch(h.api, patch(shareTo("unlisted"), "s-live"), "t");

  CHECK_EQ(response->getStatusCode(), drogon::k204NoContent);
  CHECK(h.trees.byId["t"].visibility == Visibility::unlisted);
}

TEST(patch_visibility_rejects_an_unknown_value_with_400) {
  Harness h;
  UserId me = h.signIn("s-live", "sam@example.com");
  h.trees.byId["t"] = StoredTree{GraphState{}, LegendState{}, {"Mine", {}}, 0, me};

  drogon::HttpResponsePtr response = sendPatch(h.api, patch(shareTo("world-readable"), "s-live"), "t");

  CHECK_EQ(response->getStatusCode(), drogon::k400BadRequest);
  CHECK_EQ(dump(bodyOf(response)),
           std::string(R"({"error":"visibility must be private, unlisted, or public"})"));
  CHECK(h.trees.byId["t"].visibility == Visibility::private_);  // untouched
}

TEST(patch_visibility_refuses_a_non_owner_with_403) {
  Harness h;
  h.signIn("s-live", "sam@example.com");  // u1 — not the owner
  h.trees.byId["t"] = StoredTree{GraphState{}, LegendState{}, {"Theirs", {}}, 0, uid("owner")};

  drogon::HttpResponsePtr response = sendPatch(h.api, patch(shareTo("public"), "s-live"), "t");

  CHECK_EQ(response->getStatusCode(), drogon::k403Forbidden);
  CHECK(h.trees.byId["t"].visibility == Visibility::private_);
}

TEST(patch_visibility_without_a_session_is_401) {
  Harness h;
  h.trees.byId["t"] = StoredTree{GraphState{}, LegendState{}, {"X", {}}, 0, uid("owner")};

  drogon::HttpResponsePtr response = sendPatch(h.api, patch(shareTo("unlisted")), "t");

  CHECK_EQ(response->getStatusCode(), drogon::k401Unauthorized);
  CHECK(h.trees.byId["t"].visibility == Visibility::private_);
}

TEST(patch_visibility_of_an_absent_tree_is_404) {
  Harness h;
  h.signIn("s-live", "sam@example.com");

  drogon::HttpResponsePtr response = sendPatch(h.api, patch(shareTo("unlisted"), "s-live"), "t_ghost");

  CHECK_EQ(response->getStatusCode(), drogon::k404NotFound);
}
