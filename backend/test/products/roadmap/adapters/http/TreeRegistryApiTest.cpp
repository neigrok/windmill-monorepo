#include "products/roadmap/adapters/http/TreeRegistryApi.h"

#include "products/roadmap/adapters/json/TreeJson.h"
#include "products/roadmap/application/RoomRegistry.h"
#include "products/roadmap/domain/Command.h"
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
  CHECK(stored.title == (Lww<std::string>{"Learn woodworking", Hlc{}}));
  CHECK(stored.state == GraphState{});
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
  CHECK(h.trees.byId["t_0123456789abcdef"] == before);
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

// The claim path answers `id-taken` by re-planting under a fresh id, which would resurrect your own retired tree — so your own retired id gets its own code, told only to you.
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

// A retired id reads as a plain `id-taken` to everybody else, byte-identical to a live stranger's tree.
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
  CHECK(h.trees.byId.empty());
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
  h.trees.byId["t"] = StoredTree{GraphState{}, LegendState{}, {"Mine", {}}, 0, me};

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
  CHECK(h.trees.byId["t"].visibility == Visibility::private_);
}

TEST(patch_visibility_refuses_a_non_owner_with_403) {
  Harness h;
  h.signIn("s-live", "sam@example.com");
  h.trees.byId["t"] = StoredTree{GraphState{}, LegendState{}, {"Theirs", {}}, 0, uid("owner")};

  drogon::HttpResponsePtr response = sendPatch(h.api, patch(shareTo("public"), "s-live"), "t");

  CHECK_EQ(response->getStatusCode(), drogon::k403Forbidden);
  CHECK_EQ(dump(bodyOf(response)),
           std::string(R"({"code":"not-yours","error":"this tree belongs to another account"})"));
  CHECK(h.trees.byId["t"].visibility == Visibility::private_);
}

TEST(patch_visibility_of_an_unowned_tree_says_it_is_nobodys) {
  Harness h;
  h.signIn("s-live", "sam@example.com");
  h.trees.byId["t"] = StoredTree{GraphState{}, LegendState{}, {"Demo", {}}, 0, std::nullopt, Visibility::public_};

  drogon::HttpResponsePtr response = sendPatch(h.api, patch(shareTo("private"), "s-live"), "t");

  CHECK_EQ(response->getStatusCode(), drogon::k403Forbidden);
  CHECK_EQ(bodyOf(response)["code"].asString(), std::string("nobodys-tree"));
  CHECK_EQ(bodyOf(response)["error"].asString(),
           std::string("no account owns this tree, so it cannot be edited — you can still read it, or fork it into a roadmap of your own"));
  CHECK(h.trees.byId["t"].visibility == Visibility::public_);
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

TEST(create_over_the_node_ceiling_is_413_and_plants_nothing) {
  Harness h;
  h.signIn("s-me", "sam@example.com");
  Json::Value body = titled("Too big");
  body["nodes"] = Json::Value(Json::arrayValue);
  for (std::size_t i = 0; i <= kMaxNodes; ++i) {
    Json::Value node(Json::objectValue);
    node["id"] = "n" + std::to_string(i);
    body["nodes"].append(node);
  }

  drogon::HttpResponsePtr response = create(h.api, post(body, "s-me"));

  CHECK_EQ(response->getStatusCode(), drogon::k413RequestEntityTooLarge);
  CHECK_EQ((*response->getJsonObject())["error"].asString(),
           std::string("this tree would hold 10001 nodes, max 10000 — split it across roadmaps, "
                       "or delete what it has outgrown"));
  CHECK_EQ(h.trees.byId.size(), std::size_t{0});
}

TEST(create_with_an_oversized_field_is_400_naming_the_node_and_plants_nothing) {
  Harness h;
  h.signIn("s-me", "sam@example.com");
  Json::Value body = titled("Learn to sail");
  body["nodes"] = Json::Value(Json::arrayValue);
  Json::Value node(Json::objectValue);
  node["id"] = "hull";
  node["description"] = std::string(kMaxNodeDescriptionLength + 1, 'x');
  body["nodes"].append(node);

  drogon::HttpResponsePtr response = create(h.api, post(body, "s-me"));

  CHECK_EQ(response->getStatusCode(), drogon::k400BadRequest);
  CHECK_EQ((*response->getJsonObject())["error"].asString(),
           std::string("node \"hull\": description is 4001 characters, max 4000"));
  CHECK_EQ(h.trees.byId.size(), std::size_t{0});
}

TEST(create_with_a_wrong_typed_field_is_400_not_a_thrown_500) {
  Harness h;
  h.signIn("s-me", "sam@example.com");
  Json::Value body = titled("x");
  body["nodes"] = Json::Value(Json::arrayValue);
  body["nodes"].append("not an object");

  drogon::HttpResponsePtr response = create(h.api, post(body, "s-me"));

  CHECK_EQ(response->getStatusCode(), drogon::k400BadRequest);
  CHECK_EQ(dump(*response->getJsonObject()), std::string(R"({"error":"invalid json body"})"));
  CHECK_EQ(h.trees.byId.size(), std::size_t{0});
}

TEST(create_and_patch_refuse_a_non_object_json_root_with_400) {
  Harness h;
  h.signIn("s-me", "sam@example.com");
  CHECK_EQ(create(h.api, post(titled("Real"), "s-me"))->getStatusCode(), drogon::k200OK);

  for (const char* body : {"[]", "\"hello\"", "5"}) {
    auto request = drogon::HttpRequest::newHttpRequest();
    request->setMethod(drogon::Post);
    request->setContentTypeCode(drogon::CT_APPLICATION_JSON);
    request->setBody(body);
    request->addCookie("wm_session", "s-me");
    drogon::HttpResponsePtr created;
    h.api.createTree(request, [&](const drogon::HttpResponsePtr& r) { created = r; });
    CHECK_EQ(created->getStatusCode(), drogon::k400BadRequest);
    CHECK_EQ(dump(*created->getJsonObject()), std::string(R"({"error":"invalid json body"})"));

    auto patch = drogon::HttpRequest::newHttpRequest();
    patch->setMethod(drogon::Patch);
    patch->setContentTypeCode(drogon::CT_APPLICATION_JSON);
    patch->setBody(body);
    patch->addCookie("wm_session", "s-me");
    drogon::HttpResponsePtr patched;
    h.api.patchTree(patch, [&](const drogon::HttpResponsePtr& r) { patched = r; }, "t_whatever");
    CHECK_EQ(patched->getStatusCode(), drogon::k400BadRequest);
    CHECK_EQ(dump(*patched->getJsonObject()), std::string(R"({"error":"invalid json body"})"));
  }
  CHECK_EQ(h.trees.byId.size(), std::size_t{1});
}
