#include "platform/adapters/http/OAuthApi.h"

#include "test/platform/Fakes.h"
#include "test/testing.h"

#include <json/json.h>

#include <cstddef>
#include <map>
#include <memory>
#include <optional>
#include <string>

using namespace wm;
using namespace wm::fake;

namespace {

const std::string kRedirect = "https://client.example/cb";
const std::string kResource = "https://api.windmill.works/mcp";
const std::string kIssuer = "https://api.windmill.works";
const std::string kApp = "https://windmill.works";
const std::string kConsent = "/#/oauth/authorize";

struct Harness {
  FakeAuthRepository authRepo;
  FakeEmail email;
  FakeTokens tokens;
  std::shared_ptr<FakeClock> clock = std::make_shared<FakeClock>();
  FakeOAuthRepository oauthRepo;
  std::shared_ptr<OAuthService> oauth = std::make_shared<OAuthService>(oauthRepo, tokens, *clock);
  FakeAccountFootprint footprint;
  std::shared_ptr<AuthService> auth = std::make_shared<AuthService>(
      authRepo, email, tokens, *clock, *oauth, footprint, kApp);
  OAuthApi api{oauth, auth, kIssuer, kApp, kConsent, supportedScopes({"roadmap", "gym"})};

  UserId signIn(const std::string& sessionSecret, const std::string& address = "sam@example.com") {
    User user = authRepo.createUser(Email{address}, "sam");
    authRepo.insertSession(tokens.digestOf(sessionSecret), user.id, clock->now + 1'000'000, "", "",
                           clock->now);
    return user.id;
  }

  std::string registerClient() {
    return oauth->registerClient({kRedirect}, "Claude").client->clientId;
  }
};

drogon::HttpRequestPtr get(const std::string& path) {
  auto req = drogon::HttpRequest::newHttpRequest();
  req->setMethod(drogon::Get);
  req->setPath(path);
  return req;
}

drogon::HttpRequestPtr postJson(const std::string& path, const std::string& body,
                                const std::string& session = "") {
  auto req = drogon::HttpRequest::newHttpRequest();
  req->setMethod(drogon::Post);
  req->setPath(path);
  req->setContentTypeCode(drogon::CT_APPLICATION_JSON);
  req->setBody(body);
  if (!session.empty()) req->addCookie("wm_session", session);
  return req;
}

drogon::HttpResponsePtr authorize(Harness& h, const std::string& clientId,
                                  const std::string& redirectUri, const std::string& challenge,
                                  const std::string& method = "S256",
                                  const std::string& responseType = "code") {
  auto req = get("/oauth/authorize");
  req->setParameter("client_id", clientId);
  req->setParameter("redirect_uri", redirectUri);
  req->setParameter("code_challenge", challenge);
  req->setParameter("code_challenge_method", method);
  req->setParameter("response_type", responseType);
  req->setParameter("resource", kResource);
  req->setParameter("scope", "roadmap:write");
  req->setParameter("state", "the state & more");
  drogon::HttpResponsePtr captured;
  h.api.authorize(req, [&](const drogon::HttpResponsePtr& r) { captured = r; });
  return captured;
}

std::string decisionBody(const std::string& clientId, const std::string& redirectUri,
                         const std::string& challenge, bool approve) {
  Json::Value body(Json::objectValue);
  body["client_id"] = clientId;
  body["redirect_uri"] = redirectUri;
  body["code_challenge"] = challenge;
  body["code_challenge_method"] = "S256";
  body["resource"] = kResource;
  body["scope"] = "roadmap:write";
  body["state"] = "st8";
  body["approve"] = approve;
  return Json::writeString(Json::StreamWriterBuilder{}, body);
}

drogon::HttpResponsePtr decide(Harness& h, const std::string& session, const std::string& body) {
  drogon::HttpResponsePtr captured;
  h.api.decision(postJson("/v1/oauth/decision", body, session),
                 [&](const drogon::HttpResponsePtr& r) { captured = r; });
  return captured;
}

drogon::HttpResponsePtr exchange(Harness& h, const std::string& grantType,
                                 const std::map<std::string, std::string>& params) {
  auto req = drogon::HttpRequest::newHttpRequest();
  req->setMethod(drogon::Post);
  req->setPath("/oauth/token");
  req->setParameter("grant_type", grantType);
  for (const auto& [key, value] : params) req->setParameter(key, value);
  drogon::HttpResponsePtr captured;
  h.api.token(req, [&](const drogon::HttpResponsePtr& r) { captured = r; });
  return captured;
}

std::string location(const drogon::HttpResponsePtr& response) {
  return response->getHeader("location");
}

std::string codeIn(const std::string& redirect) {
  const std::size_t at = redirect.find("?code=");
  if (at == std::string::npos) return "";
  const std::size_t end = redirect.find('&', at);
  return redirect.substr(at + 6, end == std::string::npos ? end : end - at - 6);
}

}

TEST(oauth_discovery_advertises_s256_only_and_a_client_secret_nobody_holds) {
  Harness h;
  drogon::HttpResponsePtr captured;
  h.api.metadata(get("/.well-known/oauth-authorization-server"),
                 [&](const drogon::HttpResponsePtr& r) { captured = r; });

  const Json::Value body = *captured->getJsonObject();
  CHECK_EQ(body["issuer"].asString(), kIssuer);
  CHECK_EQ(body["authorization_endpoint"].asString(), kIssuer + "/oauth/authorize");
  CHECK_EQ(body["token_endpoint"].asString(), kIssuer + "/oauth/token");
  CHECK_EQ(body["registration_endpoint"].asString(), kIssuer + "/oauth/register");
  REQUIRE_EQ(body["code_challenge_methods_supported"].size(), 1u);
  CHECK_EQ(body["code_challenge_methods_supported"][0].asString(), std::string("S256"));
  REQUIRE_EQ(body["token_endpoint_auth_methods_supported"].size(), 1u);
  CHECK_EQ(body["token_endpoint_auth_methods_supported"][0].asString(), std::string("none"));
  CHECK_EQ(body["response_types_supported"][0].asString(), std::string("code"));
  CHECK_EQ(body["grant_types_supported"].size(), 2u);
}

TEST(oauth_discovery_publishes_every_scope_the_tool_surface_honours) {
  Harness h;
  drogon::HttpResponsePtr captured;
  h.api.metadata(get("/.well-known/oauth-authorization-server"),
                 [&](const drogon::HttpResponsePtr& r) { captured = r; });

  const Json::Value supported = (*captured->getJsonObject())["scopes_supported"];
  REQUIRE_EQ(supported.size(), 6u);
  CHECK_EQ(supported[0].asString(), std::string("roadmap:read"));
  CHECK_EQ(supported[1].asString(), std::string("roadmap:write"));
  CHECK_EQ(supported[2].asString(), std::string("roadmap:delete"));
  CHECK_EQ(supported[3].asString(), std::string("gym:read"));
  CHECK_EQ(supported[4].asString(), std::string("gym:write"));
  CHECK_EQ(supported[5].asString(), std::string("gym:delete"));
}

TEST(oauth_registration_refuses_a_redirect_that_is_neither_https_nor_loopback) {
  Harness h;
  drogon::HttpResponsePtr captured;
  auto post = [&](const std::string& body) {
    h.api.registerClient(postJson("/oauth/register", body),
                         [&](const drogon::HttpResponsePtr& r) { captured = r; });
    return captured;
  };

  CHECK_EQ(post(R"({"redirect_uris":["http://evil.example/cb"],"client_name":"Nope"})")
               ->getStatusCode(),
           drogon::k400BadRequest);
  CHECK_EQ((*captured->getJsonObject())["error"].asString(), std::string("invalid_redirect_uri"));
  CHECK_EQ(post(R"({"redirect_uris":[],"client_name":"Nope"})")->getStatusCode(),
           drogon::k400BadRequest);
  CHECK_EQ(post(R"({"client_name":"Nope"})")->getStatusCode(), drogon::k400BadRequest);
  CHECK_EQ(post(R"({"redirect_uris":[7,{}],"client_name":"Nope"})")->getStatusCode(),
           drogon::k400BadRequest);

  const drogon::HttpResponsePtr created =
      post(R"({"redirect_uris":["https://client.example/cb"],"client_name":"Claude"})");
  CHECK_EQ(created->getStatusCode(), drogon::k201Created);
  const Json::Value body = *created->getJsonObject();
  CHECK_EQ(body["client_name"].asString(), std::string("Claude"));
  REQUIRE_EQ(body["redirect_uris"].size(), 1u);
  CHECK_EQ(body["redirect_uris"][0].asString(), kRedirect);
  CHECK_EQ(body["token_endpoint_auth_method"].asString(), std::string("none"));
  CHECK(!body["client_id"].asString().empty());
  CHECK(!body.isMember("client_secret"));
}

TEST(oauth_registration_needs_a_json_body_at_all) {
  Harness h;
  drogon::HttpResponsePtr captured;
  h.api.registerClient(postJson("/oauth/register", "not json"),
                       [&](const drogon::HttpResponsePtr& r) { captured = r; });
  CHECK_EQ(captured->getStatusCode(), drogon::k400BadRequest);
  CHECK_EQ((*captured->getJsonObject())["error"].asString(),
           std::string("invalid_client_metadata"));
}

// Until the redirect_uri is known-registered an error is answered on THIS host: bouncing to it would make this an open redirector (OAuth 2.1 §7.12).
TEST(oauth_an_unregistered_redirect_is_answered_here_and_never_bounced_to) {
  Harness h;
  const std::string clientId = h.registerClient();
  const std::string challenge = h.tokens.s256Challenge("v");

  const drogon::HttpResponsePtr forged =
      authorize(h, clientId, "https://evil.example/steal", challenge);
  CHECK_EQ(forged->getStatusCode(), drogon::k400BadRequest);
  CHECK_EQ(std::string(forged->getBody()), std::string("invalid client_id or redirect_uri"));
  CHECK_EQ(location(forged), std::string(""));

  // A registered redirect with an extra path segment is still not that redirect (exact match only).
  const drogon::HttpResponsePtr suffixed = authorize(h, clientId, kRedirect + "/../x", challenge);
  CHECK_EQ(suffixed->getStatusCode(), drogon::k400BadRequest);
  CHECK_EQ(location(suffixed), std::string(""));

  const drogon::HttpResponsePtr unknown = authorize(h, "cli_nobody", kRedirect, challenge);
  CHECK_EQ(unknown->getStatusCode(), drogon::k400BadRequest);
  CHECK_EQ(std::string(unknown->getBody()), std::string("invalid client_id or redirect_uri"));
  CHECK_EQ(location(unknown), std::string(""));
}

// Loopback is port-agnostic (RFC 8252 §7.3): a native client binds a fresh ephemeral port each flow.
TEST(oauth_a_loopback_client_may_come_back_on_a_different_port_each_flow) {
  Harness h;
  const std::string clientId =
      h.oauth->registerClient({"http://127.0.0.1:1234/cb"}, "Local").client->clientId;
  const std::string challenge = h.tokens.s256Challenge("v");

  const drogon::HttpResponsePtr moved =
      authorize(h, clientId, "http://127.0.0.1:57391/cb", challenge);
  CHECK_EQ(moved->getStatusCode(), drogon::k302Found);
  CHECK_EQ(location(moved).rfind(kApp + kConsent, 0), std::size_t{0});

  // A different loopback PATH is still a different redirect.
  CHECK_EQ(authorize(h, clientId, "http://127.0.0.1:57391/other", challenge)->getStatusCode(),
           drogon::k400BadRequest);
}

TEST(oauth_a_downgraded_or_absent_pkce_challenge_never_reaches_consent) {
  Harness h;
  const std::string clientId = h.registerClient();

  const drogon::HttpResponsePtr plain =
      authorize(h, clientId, kRedirect, "a-plain-challenge", "plain");
  CHECK_EQ(plain->getStatusCode(), drogon::k302Found);
  CHECK_EQ(location(plain),
           kRedirect + "?error=invalid_request&error_description=PKCE+S256+required"
                       "&state=the+state+%26+more");

  const drogon::HttpResponsePtr none = authorize(h, clientId, kRedirect, "", "S256");
  CHECK_EQ(none->getStatusCode(), drogon::k302Found);
  CHECK_EQ(location(none),
           kRedirect + "?error=invalid_request&error_description=PKCE+S256+required"
                       "&state=the+state+%26+more");
}

TEST(oauth_an_implicit_style_response_type_is_refused_back_to_the_client) {
  Harness h;
  const std::string clientId = h.registerClient();

  const drogon::HttpResponsePtr response =
      authorize(h, clientId, kRedirect, h.tokens.s256Challenge("v"), "S256", "token");
  CHECK_EQ(response->getStatusCode(), drogon::k302Found);
  CHECK_EQ(location(response),
           kRedirect + "?error=unsupported_response_type&state=the+state+%26+more");
}

// Pinned byte-for-byte; the state carries an ampersand on purpose, so the encoder must be `urlEncodeComponent` and not a form encoder.
TEST(oauth_a_valid_request_reaches_the_consent_screen_with_every_parameter_escaped) {
  Harness h;
  const std::string clientId = h.registerClient();
  const std::string challenge = h.tokens.s256Challenge("v");

  const drogon::HttpResponsePtr response = authorize(h, clientId, kRedirect, challenge);
  CHECK_EQ(response->getStatusCode(), drogon::k302Found);
  CHECK_EQ(location(response),
           kApp + kConsent + "?client_id=" + clientId +
               "&redirect_uri=https%3A%2F%2Fclient.example%2Fcb"
               "&code_challenge=c%3Av&code_challenge_method=S256"
               "&resource=https%3A%2F%2Fapi.windmill.works%2Fmcp"
               "&scope=roadmap%3Awrite&state=the+state+%26+more");
}

TEST(oauth_the_consent_screen_reads_the_registered_client_and_never_a_supplied_one) {
  Harness h;
  const std::string clientId = h.registerClient();

  auto req = get("/v1/oauth/client");
  req->setParameter("client_id", clientId);
  drogon::HttpResponsePtr captured;
  h.api.clientInfo(req, [&](const drogon::HttpResponsePtr& r) { captured = r; });
  const Json::Value body = *captured->getJsonObject();
  CHECK_EQ(captured->getStatusCode(), drogon::k200OK);
  CHECK_EQ(body["client_id"].asString(), clientId);
  CHECK_EQ(body["client_name"].asString(), std::string("Claude"));
  REQUIRE_EQ(body["redirect_uris"].size(), 1u);
  CHECK_EQ(body["redirect_uris"][0].asString(), kRedirect);

  auto unknown = get("/v1/oauth/client");
  unknown->setParameter("client_id", "cli_nobody");
  h.api.clientInfo(unknown, [&](const drogon::HttpResponsePtr& r) { captured = r; });
  CHECK_EQ(captured->getStatusCode(), drogon::k404NotFound);
  CHECK_EQ((*captured->getJsonObject())["error"].asString(), std::string("invalid_client"));
}

TEST(oauth_a_consent_decision_from_nobody_is_refused) {
  Harness h;
  const std::string clientId = h.registerClient();

  const drogon::HttpResponsePtr response =
      decide(h, "", decisionBody(clientId, kRedirect, h.tokens.s256Challenge("v"), true));
  CHECK_EQ(response->getStatusCode(), drogon::k401Unauthorized);
  CHECK_EQ((*response->getJsonObject())["error"].asString(), std::string("login_required"));
  CHECK(h.oauthRepo.codes.empty());
}

TEST(oauth_a_decision_re_validates_the_client_and_redirect_it_was_handed) {
  Harness h;
  const std::string clientId = h.registerClient();
  h.signIn("s-live");
  const std::string challenge = h.tokens.s256Challenge("v");

  const drogon::HttpResponsePtr forged =
      decide(h, "s-live", decisionBody(clientId, "https://evil.example/steal", challenge, true));
  CHECK_EQ(forged->getStatusCode(), drogon::k400BadRequest);
  CHECK_EQ((*forged->getJsonObject())["error"].asString(), std::string("invalid_request"));

  const drogon::HttpResponsePtr unknownClient =
      decide(h, "s-live", decisionBody("cli_nobody", kRedirect, challenge, true));
  CHECK_EQ(unknownClient->getStatusCode(), drogon::k400BadRequest);

  // And a challenge that would not have passed /authorize does not pass here either.
  const drogon::HttpResponsePtr noChallenge =
      decide(h, "s-live", decisionBody(clientId, kRedirect, "", true));
  CHECK_EQ(noChallenge->getStatusCode(), drogon::k400BadRequest);

  CHECK(h.oauthRepo.codes.empty());
}

TEST(oauth_a_decision_needs_a_json_body_at_all) {
  Harness h;
  h.signIn("s-live");
  drogon::HttpResponsePtr captured;
  h.api.decision(postJson("/v1/oauth/decision", "not json", "s-live"),
                 [&](const drogon::HttpResponsePtr& r) { captured = r; });
  CHECK_EQ(captured->getStatusCode(), drogon::k400BadRequest);
  CHECK_EQ((*captured->getJsonObject())["error"].asString(), std::string("invalid_request"));
}

TEST(oauth_a_refused_consent_sends_the_client_a_denial_and_mints_no_code) {
  Harness h;
  const std::string clientId = h.registerClient();
  h.signIn("s-live");

  const drogon::HttpResponsePtr response =
      decide(h, "s-live", decisionBody(clientId, kRedirect, h.tokens.s256Challenge("v"), false));
  CHECK_EQ(response->getStatusCode(), drogon::k200OK);
  CHECK_EQ((*response->getJsonObject())["redirect"].asString(),
           kRedirect + "?error=access_denied&state=st8");
  CHECK(h.oauthRepo.codes.empty());
}

TEST(oauth_an_approved_consent_yields_a_code_the_client_spends_once_for_that_account) {
  Harness h;
  const std::string clientId = h.registerClient();
  const UserId user = h.signIn("s-live");
  const std::string verifier = "the-code-verifier";
  const std::string challenge = h.tokens.s256Challenge(verifier);

  const drogon::HttpResponsePtr approved =
      decide(h, "s-live", decisionBody(clientId, kRedirect, challenge, true));
  CHECK_EQ(approved->getStatusCode(), drogon::k200OK);
  const std::string redirect = (*approved->getJsonObject())["redirect"].asString();
  CHECK_EQ(redirect.rfind(kRedirect + "?code=", 0), std::size_t{0});
  CHECK(redirect.find("&state=st8") != std::string::npos);

  const std::string code = codeIn(redirect);
  REQUIRE(!code.empty());

  const drogon::HttpResponsePtr granted =
      exchange(h, "authorization_code",
               {{"code", code}, {"client_id", clientId}, {"redirect_uri", kRedirect},
                {"code_verifier", verifier}, {"resource", kResource}});
  CHECK_EQ(granted->getStatusCode(), drogon::k200OK);
  const Json::Value body = *granted->getJsonObject();
  CHECK_EQ(body["token_type"].asString(), std::string("Bearer"));
  CHECK_EQ(body["expires_in"].asInt64(), 3600);
  CHECK(!body["access_token"].asString().empty());
  CHECK(!body["refresh_token"].asString().empty());
  CHECK_EQ(granted->getHeader("Cache-Control"), std::string("no-store"));
  // The scope the token actually carries, echoed at issue (RFC 6749 §5.1).
  CHECK_EQ(body["scope"].asString(), std::string("roadmap:write"));

  const std::optional<ToolCaller> resolved =
      h.oauth->resolveAccessToken(body["access_token"].asString(), kResource);
  REQUIRE(resolved.has_value());
  CHECK_EQ(resolved->user, user);
  CHECK(resolved->scope.allows("roadmap", Access::write));
  CHECK_FALSE(resolved->scope.allows("roadmap", Access::read));
  CHECK_FALSE(resolved->scope.allows("roadmap", Access::del));

  const drogon::HttpResponsePtr replay =
      exchange(h, "authorization_code",
               {{"code", code}, {"client_id", clientId}, {"redirect_uri", kRedirect},
                {"code_verifier", verifier}, {"resource", kResource}});
  CHECK_EQ(replay->getStatusCode(), drogon::k400BadRequest);
  CHECK_EQ((*replay->getJsonObject())["error"].asString(), std::string("invalid_grant"));
}

TEST(oauth_every_failed_grant_is_the_same_invalid_grant_and_carries_no_token) {
  Harness h;
  const std::string clientId = h.registerClient();
  h.signIn("s-live");
  const std::string verifier = "the-code-verifier";
  const std::string challenge = h.tokens.s256Challenge(verifier);
  const std::string code =
      codeIn((*decide(h, "s-live", decisionBody(clientId, kRedirect, challenge, true))
                   ->getJsonObject())["redirect"]
                 .asString());
  REQUIRE(!code.empty());

  for (const std::map<std::string, std::string>& attempt :
       {std::map<std::string, std::string>{{"code", code}, {"client_id", clientId},
                                           {"redirect_uri", kRedirect},
                                           {"code_verifier", "wrong"}, {"resource", kResource}},
        std::map<std::string, std::string>{{"code", code}, {"client_id", clientId},
                                           {"redirect_uri", "https://evil.example/steal"},
                                           {"code_verifier", verifier}, {"resource", kResource}},
        std::map<std::string, std::string>{{"code", code}, {"client_id", clientId},
                                           {"redirect_uri", kRedirect},
                                           {"code_verifier", verifier},
                                           {"resource", "https://evil.example"}},
        std::map<std::string, std::string>{{"code", "not-a-code"}, {"client_id", clientId},
                                           {"redirect_uri", kRedirect},
                                           {"code_verifier", verifier}, {"resource", kResource}}}) {
    const drogon::HttpResponsePtr refused = exchange(h, "authorization_code", attempt);
    CHECK_EQ(refused->getStatusCode(), drogon::k400BadRequest);
    const Json::Value body = *refused->getJsonObject();
    CHECK_EQ(body["error"].asString(), std::string("invalid_grant"));
    CHECK(!body.isMember("access_token"));
    CHECK(!body.isMember("refresh_token"));
  }

  const drogon::HttpResponsePtr unsupported = exchange(h, "password", {{"username", "sam"}});
  CHECK_EQ(unsupported->getStatusCode(), drogon::k400BadRequest);
  CHECK_EQ((*unsupported->getJsonObject())["error"].asString(),
           std::string("unsupported_grant_type"));
  const drogon::HttpResponsePtr none = exchange(h, "", {});
  CHECK_EQ((*none->getJsonObject())["error"].asString(), std::string("unsupported_grant_type"));
}

TEST(oauth_the_connected_tools_list_is_the_caller_s_own_and_disconnecting_is_idempotent) {
  Harness h;
  const std::string clientId = h.registerClient();
  const UserId mine = h.signIn("s-mine", "sam@example.com");
  h.signIn("s-theirs", "ada@example.com");
  h.oauthRepo.recordGrant(mine, clientId, h.clock->now, "roadmap:read");

  drogon::HttpResponsePtr captured;
  auto list = [&](const std::string& session) {
    auto req = get("/v1/oauth/grants");
    if (!session.empty()) req->addCookie("wm_session", session);
    h.api.listGrants(req, [&](const drogon::HttpResponsePtr& r) { captured = r; });
    return captured;
  };

  const Json::Value body = *list("s-mine")->getJsonObject();
  REQUIRE_EQ(body["grants"].size(), 1u);
  CHECK_EQ(body["grants"][0]["clientId"].asString(), clientId);
  CHECK_EQ(body["grants"][0]["name"].asString(), std::string("Claude"));
  CHECK_EQ(body["grants"][0]["grantedMs"].asInt64(), static_cast<Json::Int64>(h.clock->now));
  CHECK_EQ(body["grants"][0]["lastUsedMs"].asInt64(), static_cast<Json::Int64>(h.clock->now));
  CHECK_EQ(body["grants"][0]["scope"].asString(), std::string("roadmap:read"));

  CHECK_EQ((*list("s-theirs")->getJsonObject())["grants"].size(), 0u);
  CHECK_EQ(list("")->getStatusCode(), drogon::k401Unauthorized);
  CHECK_EQ((*captured->getJsonObject())["error"].asString(), std::string("login_required"));

  auto disconnect = [&](const std::string& session, const std::string& target) {
    auto req = drogon::HttpRequest::newHttpRequest();
    req->setMethod(drogon::Delete);
    req->setPath("/v1/oauth/grants/" + target);
    if (!session.empty()) req->addCookie("wm_session", session);
    h.api.disconnectGrant(req, [&](const drogon::HttpResponsePtr& r) { captured = r; }, target);
    return captured;
  };

  CHECK_EQ(disconnect("", clientId)->getStatusCode(), drogon::k401Unauthorized);
  CHECK_EQ((*list("s-mine")->getJsonObject())["grants"].size(), 1u);

  CHECK_EQ(disconnect("s-theirs", clientId)->getStatusCode(), drogon::k204NoContent);
  CHECK_EQ((*list("s-mine")->getJsonObject())["grants"].size(), 1u);

  CHECK_EQ(disconnect("s-mine", clientId)->getStatusCode(), drogon::k204NoContent);
  CHECK_EQ((*list("s-mine")->getJsonObject())["grants"].size(), 0u);
  CHECK_EQ(disconnect("s-mine", clientId)->getStatusCode(), drogon::k204NoContent);
  CHECK_EQ(disconnect("s-mine", "cli_never_existed")->getStatusCode(), drogon::k204NoContent);
}

// The two refusals are different facts and the door says which: a full burst ceiling is not invalid metadata.
TEST(oauth_a_registration_over_the_burst_ceiling_is_a_503_and_says_so) {
  Harness h;
  for (int i = 0; i < OAuthPolicy::maxUnattachedClients; ++i) {
    const std::string id = "burst" + std::to_string(i);
    h.oauthRepo.clients[id] = OAuthClient{id, {kRedirect}, ""};
  }

  drogon::HttpResponsePtr captured;
  h.api.registerClient(postJson("/oauth/register",
                                R"({"redirect_uris":["https://client.example/cb"],"client_name":"Claude"})"),
                       [&](const drogon::HttpResponsePtr& r) { captured = r; });

  CHECK_EQ(captured->getStatusCode(), drogon::k503ServiceUnavailable);
  const Json::Value body = *captured->getJsonObject();
  CHECK_EQ(body["error"].asString(), std::string("temporarily_unavailable"));
  CHECK_EQ(body["error_description"].asString(),
           std::string("too many clients have registered here recently; try again shortly"));
  CHECK(!body.isMember("client_id"));
}
