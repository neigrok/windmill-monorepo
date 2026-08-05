#include "platform/adapters/http/McpKeyApi.h"

#include "test/platform/Fakes.h"
#include "test/testing.h"

#include <json/json.h>

#include <memory>
#include <string>

// The personal-MCP-key surface, at the edge. McpKeyServiceTest pins the minting and the name rules;
// this file is about the two things the HTTP layer decides on its own, and both are the kind of
// mistake that reads as working software:
//
//   · The secret leaves in the CREATE reply and nowhere else. A token that also appeared in the
//     list would turn every settings page load into a fresh copy of a live credential.
//   · A key id that belongs to somebody else is a 404, identical to an id that never existed —
//     the same not-an-oracle rule the sessions endpoint follows, for the same reason.
using namespace wm;
using namespace wm::fake;

namespace {

struct Harness {
  FakeAuthRepository authRepo;
  FakeEmail email;
  FakeTokens tokens;
  std::shared_ptr<FakeClock> clock = std::make_shared<FakeClock>();
  FakeOAuthRepository oauthRepo;
  OAuthService oauth{oauthRepo, tokens, *clock};
  FakeAccountFootprint footprint;
  std::shared_ptr<AuthService> auth = std::make_shared<AuthService>(
      authRepo, email, tokens, *clock, oauth, footprint, "https://windmill.works");
  FakeMcpKeyRepository keyRepo;
  std::shared_ptr<McpKeyService> keys = std::make_shared<McpKeyService>(keyRepo, tokens, *clock);
  McpKeyApi api{auth, keys};

  UserId signIn(const std::string& sessionSecret, const std::string& address = "sam@example.com") {
    User user = authRepo.createUser(Email{address}, "sam");
    authRepo.insertSession(tokens.digestOf(sessionSecret), user.id, clock->now + 1'000'000, "", "",
                           clock->now);
    return user.id;
  }
};

drogon::HttpRequestPtr request(drogon::HttpMethod method, const std::string& path,
                               const std::string& body = "", const std::string& session = "") {
  auto req = drogon::HttpRequest::newHttpRequest();
  req->setMethod(method);
  req->setPath(path);
  if (!body.empty()) {
    req->setContentTypeCode(drogon::CT_APPLICATION_JSON);
    req->setBody(body);
  }
  if (!session.empty()) req->addCookie("wm_session", session);
  return req;
}

drogon::HttpResponsePtr create(Harness& h, const std::string& session, const std::string& body) {
  drogon::HttpResponsePtr captured;
  h.api.createKey(request(drogon::Post, "/v1/mcp/keys", body, session),
                  [&](const drogon::HttpResponsePtr& r) { captured = r; });
  return captured;
}

drogon::HttpResponsePtr list(Harness& h, const std::string& session) {
  drogon::HttpResponsePtr captured;
  h.api.listKeys(request(drogon::Get, "/v1/mcp/keys", "", session),
                 [&](const drogon::HttpResponsePtr& r) { captured = r; });
  return captured;
}

drogon::HttpResponsePtr revoke(Harness& h, const std::string& session, const std::string& id) {
  drogon::HttpResponsePtr captured;
  h.api.revokeKey(request(drogon::Delete, "/v1/mcp/keys/" + id, "", session),
                  [&](const drogon::HttpResponsePtr& r) { captured = r; }, id);
  return captured;
}

}

TEST(mcp_key_every_route_refuses_a_caller_with_no_session) {
  Harness h;
  h.signIn("s-live");

  CHECK_EQ(create(h, "", R"({"name":"laptop"})")->getStatusCode(), drogon::k401Unauthorized);
  CHECK_EQ(list(h, "")->getStatusCode(), drogon::k401Unauthorized);
  CHECK_EQ(revoke(h, "", "key1")->getStatusCode(), drogon::k401Unauthorized);
  CHECK(h.keyRepo.keys.empty());
}

// The secret is shown once, at mint, and the list never carries it — a list that did would hand a
// live credential to anything that could read one page of settings HTML.
TEST(mcp_key_the_secret_is_handed_over_once_and_never_appears_in_the_list) {
  Harness h;
  h.signIn("s-live");

  const drogon::HttpResponsePtr created = create(h, "s-live", R"({"name":"laptop"})");
  CHECK_EQ(created->getStatusCode(), drogon::k201Created);
  const Json::Value minted = *created->getJsonObject();
  CHECK_EQ(minted["name"].asString(), std::string("laptop"));
  CHECK(!minted["id"].asString().empty());
  CHECK(!minted["token"].asString().empty());
  CHECK_EQ(minted["createdMs"].asInt64(), static_cast<Json::Int64>(h.clock->now));

  const Json::Value rows = *list(h, "s-live")->getJsonObject();
  REQUIRE(rows["keys"].size() == 1u);
  CHECK_EQ(rows["keys"][0]["id"].asString(), minted["id"].asString());
  CHECK_EQ(rows["keys"][0]["name"].asString(), std::string("laptop"));
  CHECK_EQ(rows["keys"][0]["createdMs"].asInt64(), static_cast<Json::Int64>(h.clock->now));
  CHECK(rows["keys"][0]["lastUsedMs"].isNull());  // null, not absent — the client renders "never"
  CHECK_FALSE(rows["keys"][0].isMember("token"));

  // The token really is the credential: it authenticates as the account that minted it, and the
  // list starts reporting when — the one thing about a key the owner can watch for a stranger in.
  h.clock->now += 5000;
  CHECK(h.keys->resolveKey(minted["token"].asString()).has_value());
  const Json::Value used = *list(h, "s-live")->getJsonObject();
  REQUIRE(used["keys"].size() == 1u);
  CHECK_EQ(used["keys"][0]["lastUsedMs"].asInt64(), static_cast<Json::Int64>(h.clock->now));
  CHECK_FALSE(used["keys"][0].isMember("token"));
}

// A name is display text from a text field, so every shape it can arrive in has to be a 201 rather
// than a 500 — jsoncpp's asString() throws on an array or an object.
TEST(mcp_key_a_name_of_any_shape_still_mints_a_key) {
  Harness h;
  h.signIn("s-live");

  for (const std::string& body : {std::string("{}"), std::string(R"({"name":""})"),
                                  std::string(R"({"name":7})"), std::string(R"({"name":[]})"),
                                  std::string(R"({"name":{"a":1}})"), std::string(R"({"name":null})"),
                                  std::string("")}) {
    const drogon::HttpResponsePtr created = create(h, "s-live", body);
    CHECK_EQ(created->getStatusCode(), drogon::k201Created);
    CHECK_EQ((*created->getJsonObject())["name"].asString(), std::string("MCP key"));
  }
  CHECK_EQ(h.keyRepo.keys.size(), std::size_t{7});
}

// Owner-scoped, and the refusal says nothing about whose it is: an unknown id and another account's
// id are the same 404, so this endpoint cannot be used to test whether a key id exists.
TEST(mcp_key_a_key_that_is_not_yours_is_a_404_and_never_a_403) {
  Harness h;
  h.signIn("s-mine", "sam@example.com");
  h.signIn("s-theirs", "ada@example.com");

  const std::string theirId =
      (*create(h, "s-theirs", R"({"name":"their laptop"})")->getJsonObject())["id"].asString();
  const std::string myId =
      (*create(h, "s-mine", R"({"name":"my laptop"})")->getJsonObject())["id"].asString();

  const drogon::HttpResponsePtr unknown = revoke(h, "s-mine", "key-never-existed");
  CHECK_EQ(unknown->getStatusCode(), drogon::k404NotFound);
  CHECK_EQ((*unknown->getJsonObject())["error"].asString(), std::string("no such key"));

  const drogon::HttpResponsePtr foreign = revoke(h, "s-mine", theirId);
  CHECK_EQ(foreign->getStatusCode(), drogon::k404NotFound);
  CHECK_EQ(std::string(foreign->getBody()), std::string(unknown->getBody()));  // byte-identical
  CHECK_EQ((*list(h, "s-theirs")->getJsonObject())["keys"].size(), 1u);  // and it survived

  CHECK_EQ(revoke(h, "s-mine", myId)->getStatusCode(), drogon::k204NoContent);
  CHECK_EQ((*list(h, "s-mine")->getJsonObject())["keys"].size(), 0u);
  // Revoking it twice is the same 404 as any other id that is no longer there.
  CHECK_EQ(revoke(h, "s-mine", myId)->getStatusCode(), drogon::k404NotFound);
  CHECK_EQ((*list(h, "s-theirs")->getJsonObject())["keys"].size(), 1u);
}

// The list is the caller's own, newest first — the order the settings screen shows without sorting.
TEST(mcp_key_the_list_is_the_caller_s_own_newest_first) {
  Harness h;
  h.signIn("s-mine", "sam@example.com");
  h.signIn("s-theirs", "ada@example.com");

  create(h, "s-mine", R"({"name":"first"})");
  h.clock->now += 1000;
  create(h, "s-mine", R"({"name":"second"})");
  create(h, "s-theirs", R"({"name":"theirs"})");

  const Json::Value mine = *list(h, "s-mine")->getJsonObject();
  REQUIRE(mine["keys"].size() == 2u);
  CHECK_EQ(mine["keys"][0]["name"].asString(), std::string("second"));
  CHECK_EQ(mine["keys"][1]["name"].asString(), std::string("first"));

  const Json::Value theirs = *list(h, "s-theirs")->getJsonObject();
  REQUIRE(theirs["keys"].size() == 1u);
  CHECK_EQ(theirs["keys"][0]["name"].asString(), std::string("theirs"));
}
