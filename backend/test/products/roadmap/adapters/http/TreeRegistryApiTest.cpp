#include "products/roadmap/adapters/http/TreeRegistryApi.h"

#include "products/roadmap/adapters/json/TreeJson.h"
#include "products/roadmap/application/RoomRegistry.h"
#include "products/roadmap/domain/Command.h"
#include "test/platform/Fakes.h"
#include "test/products/roadmap/Fakes.h"
#include "test/testing.h"

#include <map>
#include <mutex>
#include <optional>
#include <string>
#include <variant>
#include <vector>

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
  HeldRetries retries;
  RoomRegistry rooms{trees, ops, bus, retries.timer()};
  FakeAuthRepository authRepo;
  FakeEmail email;
  FakeOAuthRepository oauthRepo;
  OAuthService oauth{oauthRepo, tokens, clock};
  FakeAccountFootprint footprint;
  FakeSessionRevocations revocations;
  std::shared_ptr<AuthService> auth =
      std::make_shared<AuthService>(authRepo, email, tokens, clock, oauth, footprint, revocations, "https://windmill.works");
  ProgressService marks{progress, trees};
  NodeEdits edits{rooms, marks, bus, clock};
  std::shared_ptr<TreeRegistry> registry =
      std::make_shared<TreeRegistry>(trees, progress, tokens, Hlc{1, 0, "genesis"}, rooms, edits, clock);
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
  CHECK_EQ(captured->getStatusCode(), drogon::k200OK);
  CHECK_EQ(parse(std::string(captured->body())), parse(R"({"removed":[]})"));
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

Json::Value guided(const std::string& guide) {
  Json::Value body(Json::objectValue);
  body["guide"] = guide;
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

// ---- PATCH guide ---------------------------------------------------------------------------

TEST(patch_guide_sets_the_owners_guide_to_five_thousand_characters_and_refuses_one_more_with_400) {
  Harness h;
  UserId me = h.signIn("s-live", "sam@example.com");
  h.trees.byId["t"] = StoredTree{GraphState{}, LegendState{}, {"Mine", {}}, 0, me};
  std::string wide;  // 5000 two-byte characters: 10000 bytes
  for (std::size_t i = 0; i < kMaxGuideChars; ++i) wide += "\xC3\xA9";

  drogon::HttpResponsePtr accepted = sendPatch(h.api, patch(guided(wide), "s-live"), "t");
  CHECK_EQ(accepted->getStatusCode(), drogon::k204NoContent);
  CHECK_EQ(h.trees.byId["t"].guide.value, wide);

  drogon::HttpResponsePtr refused = sendPatch(h.api, patch(guided(wide + "\xC3\xA9"), "s-live"), "t");
  CHECK_EQ(refused->getStatusCode(), drogon::k400BadRequest);
  CHECK_EQ(dump(bodyOf(refused)), std::string(R"({"error":"the guide would be 5001 characters, 1 over the 5000 cap"})"));
  CHECK_EQ(h.trees.byId["t"].guide.value, wide);
  CHECK_EQ(h.trees.byId["t"].title.value, std::string("Mine"));
}

// A guide or a title whose save fails is set in the room and on every open page, so the PATCH is no error: 202, with a
// body that says the change is applied, held and not in need of sending again, where a stored one answers 204; the same
// guide sent again answers 202 too. The registry's retry stores both with no further request.
TEST(patch_whose_save_fails_answers_202_applied_and_unsaved_and_the_retry_stores_it) {
  Harness h;
  UserId me = h.signIn("s-live", "sam@example.com");
  h.trees.byId["t"] = StoredTree{GraphState{}, LegendState{}, {"Mine", {}}, 0, me};
  Json::Value unsaved(Json::objectValue);
  unsaved["saved"] = false;
  unsaved["code"] = "held-unsaved";
  unsaved["message"] = kHeldUnsavedSentence;

  h.trees.savesFail = true;
  const drogon::HttpResponsePtr guide = sendPatch(h.api, patch(guided("Trunk first."), "s-live"), "t");
  CHECK_EQ(guide->getStatusCode(), drogon::k202Accepted);
  CHECK_EQ(bodyOf(guide), unsaved);
  const drogon::HttpResponsePtr title = sendPatch(h.api, patch(titled("Renamed"), "s-live"), "t");
  CHECK_EQ(title->getStatusCode(), drogon::k202Accepted);
  CHECK_EQ(bodyOf(title), unsaved);
  CHECK_EQ(h.trees.byId["t"].guide.value, std::string(""));
  CHECK_EQ(h.trees.byId["t"].title.value, std::string("Mine"));
  const drogon::HttpResponsePtr again = sendPatch(h.api, patch(guided("Trunk first."), "s-live"), "t");
  CHECK_EQ(again->getStatusCode(), drogon::k202Accepted);
  CHECK_EQ(bodyOf(again), unsaved);

  h.trees.savesFail = false;
  REQUIRE_EQ(h.retries.set.size(), 1u);
  h.retries.set[0].run();
  CHECK_EQ(h.trees.byId["t"].guide.value, std::string("Trunk first."));
  CHECK_EQ(h.trees.byId["t"].title.value, std::string("Renamed"));
}

TEST(patch_guide_stores_a_guide_of_only_whitespace_as_no_guide_and_keeps_a_real_guides_spaces) {
  Harness h;
  UserId me = h.signIn("s-live", "sam@example.com");
  h.trees.byId["t"] = StoredTree{GraphState{}, LegendState{}, {"Mine", {}}, 0, me};

  CHECK_EQ(sendPatch(h.api, patch(guided("  Rig first.\n"), "s-live"), "t")->getStatusCode(), drogon::k204NoContent);
  CHECK_EQ(h.trees.byId["t"].guide.value, std::string("  Rig first.\n"));
  CHECK_EQ(sendPatch(h.api, patch(guided(" \n\t\r "), "s-live"), "t")->getStatusCode(), drogon::k204NoContent);
  CHECK_EQ(h.trees.byId["t"].guide.value, std::string(""));
}

TEST(patch_guide_on_a_fork_makes_the_copied_guide_its_owners_own) {
  Harness h;
  UserId me = h.signIn("s-live", "sam@example.com");
  h.trees.byId["t"] = StoredTree{GraphState{}, LegendState{}, {"Forked", {}}, 0, me};
  h.trees.byId["t"].guide = Lww<std::string>{"Delete what you do not need.", Hlc{500, 0, "srv"}};
  h.trees.byId["t"].guideInherited = true;

  CHECK_EQ(sendPatch(h.api, patch(guided("Prune with care."), "s-live"), "t")->getStatusCode(), drogon::k204NoContent);
  CHECK_EQ(h.trees.byId["t"].guide.value, std::string("Prune with care."));
  CHECK_FALSE(h.trees.byId["t"].guideInherited);
}

TEST(patch_guide_refuses_a_non_owner_with_403_and_a_guide_that_is_not_a_string_with_400) {
  Harness h;
  h.signIn("s-live", "sam@example.com");
  h.trees.byId["t"] = StoredTree{GraphState{}, LegendState{}, {"Theirs", {}}, 0, uid("owner"), Visibility::unlisted};

  drogon::HttpResponsePtr stranger = sendPatch(h.api, patch(guided("Mine now"), "s-live"), "t");
  CHECK_EQ(stranger->getStatusCode(), drogon::k403Forbidden);
  CHECK_EQ(dump(bodyOf(stranger)),
           std::string(R"({"code":"not-yours","error":"this tree belongs to another account"})"));

  Json::Value numeric(Json::objectValue);
  numeric["guide"] = 42;
  drogon::HttpResponsePtr typed = sendPatch(h.api, patch(numeric, "s-live"), "t");
  CHECK_EQ(typed->getStatusCode(), drogon::k400BadRequest);
  CHECK_EQ(dump(bodyOf(typed)), std::string(R"({"error":"guide must be a string"})"));
  CHECK(h.trees.byId["t"].guide == Lww<std::string>{});
}

TEST(patch_guide_on_a_private_tree_of_another_account_is_404) {
  Harness h;
  h.signIn("s-live", "sam@example.com");
  h.trees.byId["t"] = StoredTree{GraphState{}, LegendState{}, {"Theirs", {}}, 0, uid("owner")};

  drogon::HttpResponsePtr response = sendPatch(h.api, patch(guided("Mine now"), "s-live"), "t");

  CHECK_EQ(response->getStatusCode(), drogon::k404NotFound);
  CHECK_EQ(dump(bodyOf(response)), std::string(R"({"error":"no such tree"})"));
  CHECK(h.trees.byId["t"].guide == Lww<std::string>{});
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

// A subtree is shared as its root is: aimed at a subtree, the change is refused 409 `not-a-root`, naming the step it hangs
// from and its root, and nothing is written.
TEST(patch_visibility_of_a_subtree_is_refused_409_not_a_root_naming_where_it_hangs) {
  Harness h;
  UserId me = h.signIn("s-live", "sam@example.com");
  h.trees.byId["t_root"] = StoredTree{GraphState{}, LegendState{}, {"Mine", {}}, 0, me};
  h.trees.byId["t_sub"] = StoredTree{GraphState{}, LegendState{}, {"", {}}, 0, me};
  h.trees.subtrees["t_sub"] = Subtree{tid("t_sub"), tid("t_root"), OwningStep{tid("t_root"), nid("rig")}, 1, 0};

  drogon::HttpResponsePtr response = sendPatch(h.api, patch(shareTo("public"), "s-live"), "t_sub");

  CHECK_EQ(response->getStatusCode(), drogon::k409Conflict);
  CHECK_EQ(bodyOf(response), parse(R"({"code":"not-a-root","error":"this tree hangs from step \"rig\" of t_root and is )"
                                   R"(shared as its root t_root is: set the root's visibility",)"
                                   R"("parent":{"tree":"t_root","step":"rig"},"root":"t_root"})"));
  CHECK(h.trees.byId["t_root"].visibility == Visibility::private_);
  CHECK(h.trees.byId["t_sub"].visibility == Visibility::private_);
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

// A tree the caller may read and not write; one they may not read is answered as absent (below).
TEST(patch_visibility_refuses_a_non_owner_with_403) {
  Harness h;
  h.signIn("s-live", "sam@example.com");
  h.trees.byId["t"] = StoredTree{GraphState{}, LegendState{}, {"Theirs", {}}, 0, uid("owner"), Visibility::unlisted};

  drogon::HttpResponsePtr response = sendPatch(h.api, patch(shareTo("public"), "s-live"), "t");

  CHECK_EQ(response->getStatusCode(), drogon::k403Forbidden);
  CHECK_EQ(dump(bodyOf(response)),
           std::string(R"({"code":"not-yours","error":"this tree belongs to another account"})"));
  CHECK(h.trees.byId["t"].visibility == Visibility::unlisted);
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
           std::string("node \"hull\": description would be 16001 characters, 1 over the 16000 cap"));
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

// A node has no stored position: a document that still sends one with a node, of any shape, plants exactly what its
// twin without it plants.
TEST(create_takes_a_node_that_still_sends_a_position_and_plants_its_twin_without_it) {
  Harness h;
  h.signIn("s-me", "sam@example.com");
  const auto planted = [&](const char* id, const char* nodes) {
    Json::Value body = claim(id, "Learn to sail");
    body["nodes"] = parse(nodes);
    drogon::HttpResponsePtr response = create(h.api, post(body, "s-me"));
    CHECK_EQ(response->getStatusCode(), drogon::k200OK);
    return dump(toJson(h.trees.byId[id].state));
  };

  const std::string plain = planted("t_00000000000000a1", R"([{"id":"hull","label":"Hull"}])");

  CHECK_EQ(planted("t_00000000000000a2", R"([{"id":"hull","label":"Hull","position":{"x":3,"y":4}}])"), plain);
  CHECK_EQ(planted("t_00000000000000a3", R"([{"id":"hull","label":"Hull","position":"left of the mast"}])"), plain);
  CHECK_EQ(plain, dump(parse(R"({"edges":[],"nodes":[{"color":"terracotta","colorAt":"1700000000000:0:srv",
    "createdAt":"1700000000000:0:srv","deletedAt":"0:0:","description":"","descriptionAt":"0:0:","icon":"",
    "iconAt":"1700000000000:0:srv","id":"hull","label":"Hull","labelAt":"1700000000000:0:srv","links":[],
    "linksAt":"0:0:","opens":"","opensAt":"0:0:","order":"","orderAt":"0:0:","statusAt":"0:0:"}]})")));
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

TEST(patch_refuses_a_guide_or_a_title_carrying_a_nul_character_with_400_and_keeps_both) {
  Harness h;
  UserId me = h.signIn("s-live", "sam@example.com");
  h.trees.byId["t"] = StoredTree{GraphState{}, LegendState{}, {"Mine", {}}, 0, me};
  const std::string nul("before\0after", 12);

  drogon::HttpResponsePtr guide = sendPatch(h.api, patch(guided(nul), "s-live"), "t");
  REQUIRE_EQ(guide->getStatusCode(), drogon::k400BadRequest);
  CHECK_EQ(dump(bodyOf(guide)), std::string(R"({"error":"the guide contains a NUL character"})"));

  drogon::HttpResponsePtr title = sendPatch(h.api, patch(titled(nul), "s-live"), "t");
  REQUIRE_EQ(title->getStatusCode(), drogon::k400BadRequest);
  CHECK_EQ(dump(bodyOf(title)), std::string(R"({"error":"the title contains a NUL character"})"));

  CHECK(h.trees.byId["t"].guide == Lww<std::string>{});
  CHECK(h.trees.byId["t"].title == (Lww<std::string>{"Mine", {}}));
}

TEST(patch_naming_more_than_one_register_is_400_and_changes_none_of_them) {
  Harness h;
  UserId me = h.signIn("s-live", "sam@example.com");
  h.trees.byId["t"] = StoredTree{GraphState{}, LegendState{}, {"Mine", {}}, 0, me};
  Json::Value titleAndGuide = titled("Renamed");
  titleAndGuide["guide"] = "Guided";
  Json::Value visibilityAndGuide = shareTo("public");
  visibilityAndGuide["guide"] = "Guided";
  Json::Value visibilityAndTitle = shareTo("public");
  visibilityAndTitle["title"] = "Renamed";
  Json::Value all = visibilityAndTitle;
  all["guide"] = "Guided";

  for (const Json::Value& body : {titleAndGuide, visibilityAndGuide, visibilityAndTitle, all}) {
    drogon::HttpResponsePtr response = sendPatch(h.api, patch(body, "s-live"), "t");
    REQUIRE_EQ(response->getStatusCode(), drogon::k400BadRequest);
    CHECK_EQ(dump(bodyOf(response)),
             std::string(R"({"error":"a PATCH sets one register per call: send visibility, guide or title alone"})"));
  }
  CHECK(h.trees.byId["t"].title == (Lww<std::string>{"Mine", {}}));
  CHECK(h.trees.byId["t"].guide == Lww<std::string>{});
  CHECK(h.trees.byId["t"].visibility == Visibility::private_);
}

TEST(patch_with_a_body_that_does_not_parse_as_json_is_400_and_an_empty_one_still_asks_for_a_name) {
  Harness h;
  UserId me = h.signIn("s-live", "sam@example.com");
  h.trees.byId["t"] = StoredTree{GraphState{}, LegendState{}, {"Mine", {}}, 0, me};
  auto raw = [&](const std::string& body, drogon::ContentType type) {
    auto request = drogon::HttpRequest::newHttpRequest();
    request->setMethod(drogon::Patch);
    request->setContentTypeCode(type);
    request->setBody(body);
    request->addCookie("wm_session", "s-live");
    return sendPatch(h.api, request, "t");
  };

  for (const std::string& body : {std::string(R"({"guide": "unterminated)"), std::string(R"({"guide":"x \ud83d"})"),
                                  std::string("not json at all")}) {
    drogon::HttpResponsePtr response = raw(body, drogon::CT_APPLICATION_JSON);
    REQUIRE_EQ(response->getStatusCode(), drogon::k400BadRequest);
    CHECK_EQ(dump(bodyOf(response)), std::string(R"({"error":"invalid json body"})"));
  }
  drogon::HttpResponsePtr plain = raw(R"({"title":"Renamed"})", drogon::CT_TEXT_PLAIN);
  REQUIRE_EQ(plain->getStatusCode(), drogon::k400BadRequest);
  CHECK_EQ(dump(bodyOf(plain)), std::string(R"({"error":"invalid json body"})"));

  drogon::HttpResponsePtr empty = raw("", drogon::CT_APPLICATION_JSON);
  REQUIRE_EQ(empty->getStatusCode(), drogon::k400BadRequest);
  CHECK_EQ(dump(bodyOf(empty)), std::string(R"({"error":"a tree always has a name"})"));
  CHECK(h.trees.byId["t"].title == (Lww<std::string>{"Mine", {}}));
  CHECK(h.trees.byId["t"].guide == Lww<std::string>{});
}

// ---- openers and what a removal takes ---------------------------------------------------

// Every row of the list carries `openers`, [] when nothing opens the tree, which is how a client knows a removal takes
// the steps that open it; the delete answers 200 with what became of those steps, `unsaved` and `incomplete` only when
// a tree is one, and 503 with nothing removed when they cannot be read.
TEST(list_rows_carry_their_openers_and_delete_answers_the_steps_that_went_with_the_tree) {
  Harness h;
  UserId me = h.signIn("s-live", "sam@example.com");
  const auto plant = [&](const char* id, const std::vector<std::pair<const char*, const char*>>& steps) {
    TreeData data;
    data.id = TreeId{std::string(id)};
    for (const auto& [step, opens] : steps) {
      NodeSpec node;
      node.id = NodeId{std::string(step)};
      node.label = step;
      node.opens = TreeId{std::string(opens)};
      data.nodes.push_back(node);
    }
    h.trees.byId[id] = StoredTree{LooseGraph(data, Hlc{1, 0, "seed"}).exportState(), LegendState{}, {id, {}}, 0, me};
  };
  plant("t_target", {{"t1", ""}});
  plant("t_a", {{"a1", "t_target"}, {"a2", ""}});
  plant("t_b", {{"b1", "t_target"}, {"b2", "t_target"}});
  plant("t_two", {{"w1", ""}});
  plant("t_c", {{"c1", "t_two"}});
  const auto request = [](drogon::HttpMethod method) {
    auto made = drogon::HttpRequest::newHttpRequest();
    made->setMethod(method);
    made->addCookie("wm_session", "s-live");
    return made;
  };
  const auto remove = [&](const std::string& id) {
    drogon::HttpResponsePtr captured;
    h.api.deleteTree(request(drogon::Delete), [&](const drogon::HttpResponsePtr& response) { captured = response; }, id);
    return captured;
  };

  drogon::HttpResponsePtr listed;
  h.api.listTrees(request(drogon::Get), [&](const drogon::HttpResponsePtr& response) { listed = response; });
  CHECK_EQ(listed->getStatusCode(), drogon::k200OK);
  const Json::Value rows = bodyOf(listed)["trees"];
  Json::Value openers(Json::objectValue);
  for (const Json::Value& row : rows) openers[row["id"].asString()] = row["openers"];
  CHECK_EQ(openers, parse(R"({"t_target":[{"treeId":"t_a","steps":1},{"treeId":"t_b","steps":2}],
                              "t_a":[],"t_b":[],"t_two":[{"treeId":"t_c","steps":1}],"t_c":[]})"));

  const drogon::HttpResponsePtr removed = remove("t_target");
  CHECK_EQ(removed->getStatusCode(), drogon::k200OK);
  CHECK_EQ(bodyOf(removed), parse(R"({"removed":[{"treeId":"t_a","nodeIds":["a1"]},{"treeId":"t_b","nodeIds":["b1","b2"]}]})"));

  h.trees.latticeLoadsFailFor.insert("t_c");
  const drogon::HttpResponsePtr kept = remove("t_two");
  CHECK_EQ(kept->getStatusCode(), drogon::k200OK);
  CHECK_EQ(bodyOf(kept), parse(R"({"removed":[],"incomplete":["t_c"]})"));

  plant("t_three", {{"x1", ""}});
  plant("t_d", {{"d1", "t_three"}});
  h.trees.duringSave = [](const TreeId&) { throw std::runtime_error("the write was refused"); };
  const drogon::HttpResponsePtr unsaved = remove("t_three");
  CHECK_EQ(unsaved->getStatusCode(), drogon::k200OK);
  CHECK_EQ(bodyOf(unsaved), parse(R"({"removed":[],"unsaved":["t_d"]})"));
  h.trees.duringSave = nullptr;

  plant("t_four", {{"y1", ""}});
  h.trees.openingReadsFail = true;
  const drogon::HttpResponsePtr refused = remove("t_four");
  CHECK_EQ(refused->getStatusCode(), drogon::k503ServiceUnavailable);
  CHECK_EQ(bodyOf(refused), parse(R"({"error":"nothing was removed: the steps that open this roadmap could not be read; try again",
                                     "code":"cascade-unavailable"})"));
  CHECK_FALSE(h.trees.deletedIds.count("t_four"));
}

// The list holds roots alone: a subtree is no row, and counts in its parent as the one step that owns it, done when the
// subtree is. Renaming a subtree with PATCH {title} renames that step, which names the subtree.
TEST(list_holds_roots_alone_and_patch_renames_a_subtree_through_its_owning_step) {
  Harness h;
  const UserId me = h.signIn("s-live", "sam@example.com");
  const auto plant = [&](const char* id, const char* title, const std::vector<const char*>& steps) {
    TreeData data;
    data.id = TreeId{std::string(id)};
    data.title = title;
    for (const char* step : steps) {
      NodeSpec node;
      node.id = NodeId{std::string(step)};
      node.label = step;
      data.nodes.push_back(node);
    }
    h.trees.byId[id] = StoredTree{LooseGraph(data, Hlc{1, 0, "seed"}).exportState(), LegendState{}, {title, {}}, 0, me};
  };
  plant("t_a", "My year", {"sail", "coast"});
  plant("t_b", "Work", {"ship"});
  const TreeId sailing{"t_00000000000000c1"};
  REQUIRE(std::holds_alternative<SubtreeCreation>(
      h.registry->createSubtree(TreeId{"t_a"}, NodeId{"sail"}, me, {sailing, std::nullopt})));
  const auto rows = [&] {
    auto request = drogon::HttpRequest::newHttpRequest();
    request->setMethod(drogon::Get);
    request->addCookie("wm_session", "s-live");
    drogon::HttpResponsePtr listed;
    h.api.listTrees(request, [&](const drogon::HttpResponsePtr& response) { listed = response; });
    const Json::Value body = bodyOf(listed);
    std::map<std::string, std::string> doneOfTotal;
    for (const Json::Value& row : body["trees"])
      doneOfTotal[row["id"].asString()] = row["done"].asString() + "/" + row["total"].asString();
    return doneOfTotal;
  };

  CHECK(rows() == (std::map<std::string, std::string>{{"t_a", "0/2"}, {"t_b", "0/1"}}));
  {
    std::unique_lock<std::mutex> strand(h.rooms.strandFor(sailing));
    h.rooms.open(sailing)->applyCommand(CreateNode{NodeId{"knot"}, "Knot", "", NodeColor::sky}, h.clock.nowMs(), me);
    PendingSave saving = h.rooms.persist(sailing);
    strand.unlock();
    REQUIRE(saving.wait() == Saved::saved);
  }
  CHECK(rows() == (std::map<std::string, std::string>{{"t_a", "0/2"}, {"t_b", "0/1"}}));
  h.progress.setStatuses(sailing, me, {{NodeId{"knot"}, ProgressStatus::complete, false, Hlc{5, 0, "r_a"}}},
                         StampedBy::replica, 5);
  CHECK(rows() == (std::map<std::string, std::string>{{"t_a", "1/2"}, {"t_b", "0/1"}}));

  CHECK_EQ(sendPatch(h.api, patch(titled("Learn to sail"), "s-live"), sailing.str())->getStatusCode(),
           drogon::k204NoContent);
  std::lock_guard<std::mutex> strand(h.rooms.strandFor(TreeId{"t_a"}));
  CHECK(h.rooms.open(TreeId{"t_a"})->labelOf(NodeId{"sail"}) == std::optional<std::string>("Learn to sail"));
  CHECK_EQ(h.trees.byId[sailing.str()].title.value, std::string(""));
}

// A write refusal never confirms a private id: a stranger's rename or visibility change of a private tree, a root or a
// subtree at any depth, answers exactly as one aimed at an id no row holds, and the tree is left as it was.
TEST(patch_from_a_stranger_answers_a_private_tree_as_an_absent_one_at_every_depth) {
  Harness h;
  const UserId me = h.signIn("s-live", "sam@example.com");
  h.signIn("s-stranger", "stranger@example.com");
  TreeData data;
  data.id = TreeId{"t_a"};
  data.title = "Private year";
  NodeSpec sail;
  sail.id = NodeId{"sail"};
  sail.label = "sail";
  data.nodes = {sail};
  h.trees.byId["t_a"] = StoredTree{LooseGraph(data, Hlc{1, 0, "seed"}).exportState(), LegendState{}, {"Private year", {}}, 0, me};
  REQUIRE(std::holds_alternative<SubtreeCreation>(
      h.registry->createSubtree(TreeId{"t_a"}, NodeId{"sail"}, me, {TreeId{"t_00000000000000c1"}, std::nullopt})));
  {
    std::unique_lock<std::mutex> strand(h.rooms.strandFor(TreeId{"t_00000000000000c1"}));
    h.rooms.open(TreeId{"t_00000000000000c1"})->applyCommand(CreateNode{NodeId{"rig"}, "Rig", "", NodeColor::sky},
                                                            h.clock.nowMs(), me);
    PendingSave saving = h.rooms.persist(TreeId{"t_00000000000000c1"});
    strand.unlock();
    REQUIRE(saving.wait() == Saved::saved);
  }
  REQUIRE(std::holds_alternative<SubtreeCreation>(h.registry->createSubtree(
      TreeId{"t_00000000000000c1"}, NodeId{"rig"}, me, {TreeId{"t_00000000000000c2"}, std::nullopt})));
  const auto answered = [&](const drogon::HttpResponsePtr& response) {
    return std::to_string(response->getStatusCode()) + " " + std::string(response->getBody());
  };
  const std::string absent = answered(sendPatch(h.api, patch(titled("Mine now"), "s-stranger"), "t_00000000000000ff"));
  CHECK_EQ(absent, std::string(R"(404 {"error":"no such tree"})"));

  for (const char* tree : {"t_a", "t_00000000000000c1", "t_00000000000000c2"}) {
    CHECK_EQ(answered(sendPatch(h.api, patch(titled("Mine now"), "s-stranger"), tree)), absent);
    CHECK_EQ(answered(sendPatch(h.api, patch(shareTo("public"), "s-stranger"), tree)), absent);
  }
  CHECK_EQ(h.trees.byId["t_a"].title.value, std::string("Private year"));
  CHECK(h.trees.byId["t_a"].visibility == Visibility::private_);
  CHECK_EQ(sendPatch(h.api, patch(titled("My year"), "s-live"), "t_a")->getStatusCode(), drogon::k204NoContent);
  CHECK_EQ(sendPatch(h.api, patch(shareTo("unlisted"), "s-live"), "t_a")->getStatusCode(), drogon::k204NoContent);
}
