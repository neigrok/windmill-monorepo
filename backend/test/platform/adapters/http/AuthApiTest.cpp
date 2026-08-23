#include "platform/adapters/http/AuthApi.h"

#include "test/platform/Fakes.h"
#include "test/testing.h"

#include <json/json.h>

#include <memory>
#include <optional>
#include <string>
#include <vector>

using namespace wm;
using namespace wm::fake;

namespace {

const std::string kApp = "https://windmill.works";
const std::string kDomain = ".windmill.works";

struct FakeSignupFork : SignupFork {
  std::optional<ForkDescription> description;
  std::optional<std::string> planted;
  std::vector<std::string> plantedFor;

  std::optional<ForkDescription> describe(const std::string&) override { return description; }
  std::optional<std::string> plant(const std::string& source, const UserId&) override {
    plantedFor.push_back(source);
    return planted;
  }
};

struct Harness {
  FakeAuthRepository authRepo;
  FakeEmail email;
  FakeTokens tokens;
  std::shared_ptr<FakeClock> clock = std::make_shared<FakeClock>();
  FakeOAuthRepository oauthRepo;
  OAuthService oauth{oauthRepo, tokens, *clock};
  FakeAccountFootprint footprint;
  std::shared_ptr<AuthService> auth = std::make_shared<AuthService>(
      authRepo, email, tokens, *clock, oauth, footprint, kApp);
  std::shared_ptr<FakeSignupFork> fork = std::make_shared<FakeSignupFork>();
  std::shared_ptr<GoogleOAuthClient> google;
  std::shared_ptr<AuthApi> api;

  explicit Harness(bool secure = true, std::string domain = kDomain,
                   std::shared_ptr<GoogleOAuthClient> googleClient = nullptr)
      : google(std::move(googleClient)),
        api(std::make_shared<AuthApi>(auth, fork, secure, std::move(domain), google, kApp)) {}

  UserId signIn(const std::string& sessionSecret, const std::string& address = "sam@example.com") {
    User user = authRepo.createUser(Email{address}, "sam");
    authRepo.insertSession(tokens.digestOf(sessionSecret), user.id, clock->now + 1'000'000, "", "",
                           clock->now);
    return user.id;
  }

  std::string linkFor(const std::string& address, const std::string& forkSource = "") {
    std::string secret;
    auth->requestLink(address, forkSource, fork->description, "",
                      [&](AuthService::RequestResult) { secret = email.sent.back().url; });
    return secret.substr(secret.rfind('=') + 1);
  }

  std::string codeFor(const std::string& address) {
    auth->requestLink(address, "", std::nullopt, "app", [](AuthService::RequestResult) {});
    return email.sent.back().code;
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

bool hasCookie(const drogon::HttpResponsePtr& response, const std::string& name) {
  return response->cookies().find(name) != response->cookies().end();
}

void checkSessionCookie(const drogon::Cookie& cookie, bool secure, const std::string& domain,
                        int maxAge) {
  CHECK(cookie.isHttpOnly());
  CHECK_EQ(cookie.getPath(), std::string("/"));
  CHECK(cookie.getSameSite() == drogon::Cookie::SameSite::kLax);
  CHECK_EQ(cookie.isSecure(), secure);
  CHECK_EQ(cookie.getDomain(), domain);
  CHECK_EQ(cookie.getMaxAge(), std::optional<int>(maxAge));
}

drogon::HttpResponsePtr call(Harness& h, void (AuthApi::*route)(const drogon::HttpRequestPtr&, HttpCallback&&),
                             const drogon::HttpRequestPtr& req) {
  drogon::HttpResponsePtr captured;
  (h.api.get()->*route)(req, [&](const drogon::HttpResponsePtr& r) { captured = r; });
  return captured;
}

drogon::HttpResponsePtr revoke(Harness& h, const std::string& session, const std::string& id) {
  drogon::HttpResponsePtr captured;
  h.api->revokeSession(request(drogon::Delete, "/v1/sessions/" + id, "", session),
                       [&](const drogon::HttpResponsePtr& r) { captured = r; }, id);
  return captured;
}

const std::string kVerified = R"({"token":")";

}

TEST(auth_every_account_endpoint_refuses_a_caller_with_no_session) {
  Harness h;
  h.signIn("s-live");

  CHECK_EQ(call(h, &AuthApi::me, request(drogon::Get, "/v1/me"))->getStatusCode(),
           drogon::k401Unauthorized);
  CHECK_EQ(call(h, &AuthApi::patchMe, request(drogon::Patch, "/v1/me", R"({"name":"Ada"})"))
               ->getStatusCode(),
           drogon::k401Unauthorized);
  CHECK_EQ(call(h, &AuthApi::deleteMe, request(drogon::Delete, "/v1/me"))->getStatusCode(),
           drogon::k401Unauthorized);
  CHECK_EQ(call(h, &AuthApi::listSessions, request(drogon::Get, "/v1/sessions"))->getStatusCode(),
           drogon::k401Unauthorized);
  CHECK_EQ(call(h, &AuthApi::signOutEverywhere, request(drogon::Delete, "/v1/sessions"))
               ->getStatusCode(),
           drogon::k401Unauthorized);
  CHECK_EQ(call(h, &AuthApi::link, request(drogon::Post, "/v1/auth/link", R"({"token":"t"})"))
               ->getStatusCode(),
           drogon::k401Unauthorized);
  CHECK_EQ(revoke(h, "", "sess1")->getStatusCode(), drogon::k401Unauthorized);

  CHECK_EQ(call(h, &AuthApi::me, request(drogon::Get, "/v1/me", "", "s-forged"))->getStatusCode(),
           drogon::k401Unauthorized);
  CHECK_EQ(h.authRepo.sessions.size(), std::size_t{1});
}

TEST(auth_the_identity_probe_refuses_with_an_empty_body_and_every_other_route_explains_itself) {
  Harness h;

  const drogon::HttpResponsePtr probe = call(h, &AuthApi::me, request(drogon::Get, "/v1/me"));
  CHECK_EQ(probe->getStatusCode(), drogon::k401Unauthorized);
  CHECK_EQ((*probe->getJsonObject()).size(), 0u);

  CHECK_EQ((*call(h, &AuthApi::patchMe, request(drogon::Patch, "/v1/me", R"({"name":"Ada"})"))
                 ->getJsonObject())["error"]
               .asString(),
           std::string("sign in to edit your profile"));
  CHECK_EQ((*call(h, &AuthApi::deleteMe, request(drogon::Delete, "/v1/me"))
                 ->getJsonObject())["error"]
               .asString(),
           std::string("sign in to close your account"));
  CHECK_EQ((*call(h, &AuthApi::listSessions, request(drogon::Get, "/v1/sessions"))
                 ->getJsonObject())["error"]
               .asString(),
           std::string("sign in to see your devices"));
  CHECK_EQ((*revoke(h, "", "sess1")->getJsonObject())["error"].asString(),
           std::string("sign in to revoke a device"));
}

TEST(auth_a_session_id_that_is_not_yours_is_a_404_and_never_a_403) {
  Harness h;
  const UserId mine = h.signIn("s-mine", "sam@example.com");
  h.signIn("s-theirs", "ada@example.com");
  const std::string theirId = h.authRepo.sessions[h.tokens.digestOf("s-theirs")].id;

  const drogon::HttpResponsePtr unknown = revoke(h, "s-mine", "sess-never-existed");
  CHECK_EQ(unknown->getStatusCode(), drogon::k404NotFound);
  CHECK_EQ((*unknown->getJsonObject())["error"].asString(), std::string("no such session"));

  const drogon::HttpResponsePtr foreign = revoke(h, "s-mine", theirId);
  CHECK_EQ(foreign->getStatusCode(), drogon::k404NotFound);
  CHECK_EQ((*foreign->getJsonObject())["error"].asString(), std::string("no such session"));
  CHECK_EQ(std::string(foreign->getBody()), std::string(unknown->getBody()));

  CHECK_EQ(h.authRepo.sessions.count(h.tokens.digestOf("s-theirs")), std::size_t{1});
  CHECK_EQ(h.authRepo.sessions.count(h.tokens.digestOf("s-mine")), std::size_t{1});
  CHECK_EQ(h.authRepo.listSessions(mine).size(), std::size_t{1});
}

TEST(auth_a_spent_link_is_gone_and_a_non_empty_account_is_a_conflict) {
  Harness h;
  const std::string token = h.linkFor("sam@example.com");

  const drogon::HttpResponsePtr first =
      call(h, &AuthApi::verify, request(drogon::Post, "/v1/auth/verify", kVerified + token + "\"}"));
  CHECK_EQ(first->getStatusCode(), drogon::k200OK);

  const drogon::HttpResponsePtr replay =
      call(h, &AuthApi::verify, request(drogon::Post, "/v1/auth/verify", kVerified + token + "\"}"));
  CHECK_EQ(replay->getStatusCode(), drogon::k410Gone);
  const Json::Value gone = *replay->getJsonObject();
  CHECK_EQ(gone["error"].asString(), std::string("That link has expired"));
  CHECK_EQ(gone["detail"].asString(), std::string("Links work once and last 15 minutes."));
  CHECK_EQ(gone["code"].asString(), std::string("expired"));
  CHECK_FALSE(hasCookie(replay, "wm_session"));

  CHECK_EQ(call(h, &AuthApi::verify,
                request(drogon::Post, "/v1/auth/verify", R"({"token":"never-minted"})"))
               ->getStatusCode(),
           drogon::k410Gone);
  CHECK_EQ(call(h, &AuthApi::verify, request(drogon::Post, "/v1/auth/verify", "{}"))
               ->getStatusCode(),
           drogon::k400BadRequest);
  CHECK_EQ(call(h, &AuthApi::verify, request(drogon::Post, "/v1/auth/verify", "not json"))
               ->getStatusCode(),
           drogon::k400BadRequest);

  const UserId caller = h.signIn("s-live", "ada@example.com");
  h.footprint.withData.insert(caller.str());
  const std::string second = h.linkFor("sam@example.com");
  const drogon::HttpResponsePtr conflict = call(
      h, &AuthApi::link, request(drogon::Post, "/v1/auth/link", kVerified + second + "\"}", "s-live"));
  CHECK_EQ(conflict->getStatusCode(), drogon::k409Conflict);
  CHECK_EQ((*conflict->getJsonObject())["code"].asString(), std::string("account-not-empty"));
}

TEST(auth_the_link_door_refuses_a_request_carrying_no_token_before_it_spends_anything) {
  Harness h;
  h.signIn("s-live");
  const drogon::HttpResponsePtr response =
      call(h, &AuthApi::link, request(drogon::Post, "/v1/auth/link", "{}", "s-live"));
  CHECK_EQ(response->getStatusCode(), drogon::k400BadRequest);
  CHECK_EQ((*response->getJsonObject())["error"].asString(), std::string("missing token"));
}

TEST(auth_signing_in_mints_the_session_cookie_with_every_flag_it_needs) {
  Harness h;
  const std::string token = h.linkFor("sam@example.com");

  const drogon::HttpResponsePtr response =
      call(h, &AuthApi::verify, request(drogon::Post, "/v1/auth/verify", kVerified + token + "\"}"));
  CHECK_EQ(response->getStatusCode(), drogon::k200OK);
  REQUIRE(hasCookie(response, "wm_session"));

  const drogon::Cookie& cookie = response->getCookie("wm_session");
  CHECK(!cookie.getValue().empty());
  checkSessionCookie(cookie, true, kDomain, 7776000);  // 90 days

  const drogon::HttpResponsePtr me =
      call(h, &AuthApi::me, request(drogon::Get, "/v1/me", "", cookie.getValue()));
  CHECK_EQ(me->getStatusCode(), drogon::k200OK);
  CHECK_EQ((*me->getJsonObject())["user"]["email"].asString(), std::string("sam@example.com"));

  Harness local(false, "");
  const std::string localToken = local.linkFor("sam@example.com");
  const drogon::HttpResponsePtr insecure = call(
      local, &AuthApi::verify, request(drogon::Post, "/v1/auth/verify", kVerified + localToken + "\"}"));
  REQUIRE(hasCookie(insecure, "wm_session"));
  CHECK(!insecure->getCookie("wm_session").getValue().empty());
  checkSessionCookie(insecure->getCookie("wm_session"), false, "", 7776000);
}

TEST(auth_signing_out_expires_the_cookie_with_the_same_flags_it_was_set_with) {
  Harness h;
  h.signIn("s-live");

  const drogon::HttpResponsePtr response =
      call(h, &AuthApi::logout, request(drogon::Post, "/v1/auth/logout", "", "s-live"));
  CHECK_EQ(response->getStatusCode(), drogon::k204NoContent);
  REQUIRE(hasCookie(response, "wm_session"));
  CHECK_EQ(response->getCookie("wm_session").getValue(), std::string(""));
  checkSessionCookie(response->getCookie("wm_session"), true, kDomain, 0);

  CHECK(h.authRepo.sessions.empty());
  CHECK_EQ(call(h, &AuthApi::me, request(drogon::Get, "/v1/me", "", "s-live"))->getStatusCode(),
           drogon::k401Unauthorized);

  const drogon::HttpResponsePtr anonymous =
      call(h, &AuthApi::logout, request(drogon::Post, "/v1/auth/logout"));
  CHECK_EQ(anonymous->getStatusCode(), drogon::k204NoContent);
  REQUIRE(hasCookie(anonymous, "wm_session"));
  CHECK_EQ(anonymous->getCookie("wm_session").getValue(), std::string(""));
  checkSessionCookie(anonymous->getCookie("wm_session"), true, kDomain, 0);
}

TEST(auth_closing_an_account_clears_this_device_s_cookie_and_names_the_day_it_ends) {
  Harness h;
  h.signIn("s-live");

  const drogon::HttpResponsePtr response =
      call(h, &AuthApi::deleteMe, request(drogon::Delete, "/v1/me", "", "s-live"));
  CHECK_EQ(response->getStatusCode(), drogon::k200OK);
  REQUIRE(hasCookie(response, "wm_session"));
  CHECK_EQ(response->getCookie("wm_session").getValue(), std::string(""));
  checkSessionCookie(response->getCookie("wm_session"), true, kDomain, 0);

  const Json::Value body = *response->getJsonObject();
  const UnixMs closesMs = static_cast<UnixMs>(body["closesMs"].asInt64());
  CHECK_EQ(closesMs, h.clock->now + 30ull * 24 * 60 * 60 * 1000);   // the 30-day grace
  REQUIRE_EQ(body["closingOn"].asString().size(), std::size_t{20});   // ISO 8601 UTC, to the second
  CHECK_EQ(body["closingOn"].asString().back(), 'Z');
  CHECK(h.authRepo.sessions.empty());
}

TEST(auth_only_revoking_your_own_session_clears_your_own_cookie) {
  Harness h;
  const UserId mine = h.signIn("s-mine", "sam@example.com");
  h.authRepo.insertSession(h.tokens.digestOf("s-phone"), mine, h.clock->now + 1'000'000, "iPhone",
                           "", h.clock->now);
  const std::string phoneId = h.authRepo.sessions[h.tokens.digestOf("s-phone")].id;
  const std::string ownId = h.authRepo.sessions[h.tokens.digestOf("s-mine")].id;

  const drogon::HttpResponsePtr other = revoke(h, "s-mine", phoneId);
  CHECK_EQ(other->getStatusCode(), drogon::k204NoContent);
  CHECK_FALSE(hasCookie(other, "wm_session"));
  CHECK_EQ(h.authRepo.sessions.count(h.tokens.digestOf("s-phone")), std::size_t{0});
  CHECK_EQ(h.authRepo.sessions.count(h.tokens.digestOf("s-mine")), std::size_t{1});

  const drogon::HttpResponsePtr own = revoke(h, "s-mine", ownId);
  CHECK_EQ(own->getStatusCode(), drogon::k204NoContent);
  REQUIRE(hasCookie(own, "wm_session"));
  CHECK_EQ(own->getCookie("wm_session").getValue(), std::string(""));
  checkSessionCookie(own->getCookie("wm_session"), true, kDomain, 0);
  CHECK(h.authRepo.sessions.empty());
}

TEST(auth_signing_out_everywhere_leaves_this_device_s_cookie_standing) {
  Harness h;
  const UserId mine = h.signIn("s-mine", "sam@example.com");
  h.authRepo.insertSession(h.tokens.digestOf("s-phone"), mine, h.clock->now + 1'000'000, "iPhone",
                           "", h.clock->now);

  const drogon::HttpResponsePtr response = call(
      h, &AuthApi::signOutEverywhere, request(drogon::Delete, "/v1/sessions", "", "s-mine"));
  CHECK_EQ(response->getStatusCode(), drogon::k204NoContent);
  CHECK_FALSE(hasCookie(response, "wm_session"));
  CHECK_EQ(h.authRepo.sessions.count(h.tokens.digestOf("s-mine")), std::size_t{1});
  CHECK_EQ(h.authRepo.sessions.count(h.tokens.digestOf("s-phone")), std::size_t{0});
}

TEST(auth_the_device_list_is_the_caller_s_own_with_this_device_flagged) {
  Harness h;
  const UserId mine = h.signIn("s-mine", "sam@example.com");
  h.signIn("s-theirs", "ada@example.com");
  h.authRepo.insertSession(h.tokens.digestOf("s-phone"), mine, h.clock->now + 1'000'000, "iPhone",
                           "10.0.0.9", h.clock->now);

  const Json::Value body =
      *call(h, &AuthApi::listSessions, request(drogon::Get, "/v1/sessions", "", "s-mine"))
           ->getJsonObject();
  REQUIRE(body["sessions"].size() == 2u);

  int current = 0;
  for (const Json::Value& row : body["sessions"]) {
    if (row["current"].asBool()) ++current;
    CHECK_EQ(row["createdMs"].asInt64(), static_cast<Json::Int64>(h.clock->now));
    CHECK_EQ(row["lastSeenMs"].asInt64(), static_cast<Json::Int64>(h.clock->now));
    CHECK(!row["id"].asString().empty());
  }
  CHECK_EQ(current, 1);
}

TEST(auth_a_bearer_token_opens_the_same_door_the_cookie_does) {
  Harness h;
  h.signIn("s-live");

  auto bearer = drogon::HttpRequest::newHttpRequest();
  bearer->setMethod(drogon::Get);
  bearer->setPath("/v1/me");
  bearer->addHeader("authorization", "Bearer s-live");
  CHECK_EQ(call(h, &AuthApi::me, bearer)->getStatusCode(), drogon::k200OK);

  auto raw = drogon::HttpRequest::newHttpRequest();
  raw->setMethod(drogon::Get);
  raw->setPath("/v1/me");
  raw->addHeader("authorization", "s-live");
  CHECK_EQ(call(h, &AuthApi::me, raw)->getStatusCode(), drogon::k401Unauthorized);

  h.signIn("s-other", "ada@example.com");
  auto both = request(drogon::Get, "/v1/me", "", "s-live");
  both->addHeader("authorization", "Bearer s-other");
  CHECK_EQ((*call(h, &AuthApi::me, both)->getJsonObject())["user"]["email"].asString(),
           std::string("sam@example.com"));
}

TEST(auth_a_blank_or_oversized_name_is_refused_and_a_good_one_comes_back_applied) {
  Harness h;
  h.signIn("s-live");

  const drogon::HttpResponsePtr renamed = call(
      h, &AuthApi::patchMe, request(drogon::Patch, "/v1/me", R"({"name":"Ada Lovelace"})", "s-live"));
  CHECK_EQ(renamed->getStatusCode(), drogon::k200OK);
  CHECK_EQ((*renamed->getJsonObject())["user"]["name"].asString(), std::string("Ada Lovelace"));

  for (const std::string& body : {std::string(R"({"name":""})"), std::string(R"({"name":"   "})"),
                                  std::string("{}"),
                                  R"({"name":")" + std::string(81, 'a') + R"("})"}) {
    const drogon::HttpResponsePtr refused =
        call(h, &AuthApi::patchMe, request(drogon::Patch, "/v1/me", body, "s-live"));
    CHECK_EQ(refused->getStatusCode(), drogon::k400BadRequest);
    CHECK_EQ((*refused->getJsonObject())["error"].asString(),
             std::string("That name's blank, or too long — 80 characters at most."));
  }
  CHECK_EQ((*call(h, &AuthApi::me, request(drogon::Get, "/v1/me", "", "s-live"))
                 ->getJsonObject())["user"]["name"]
               .asString(),
           std::string("Ada Lovelace"));
}

TEST(auth_a_request_with_no_address_never_reaches_the_sender) {
  Harness h;

  for (const std::string& body : {std::string("{}"), std::string(R"({"email":""})"),
                                  std::string("not json")}) {
    const drogon::HttpResponsePtr refused =
        call(h, &AuthApi::requestLink, request(drogon::Post, "/v1/auth/magic-link", body));
    CHECK_EQ(refused->getStatusCode(), drogon::k400BadRequest);
    const Json::Value out = *refused->getJsonObject();
    CHECK_EQ(out["error"].asString(),
             std::string("That address looks unfinished — check the ending."));
    CHECK_EQ(out["code"].asString(), std::string("invalid_email"));
  }
  CHECK(h.email.sent.empty());
  CHECK(h.authRepo.links.empty());

  CHECK_EQ(call(h, &AuthApi::requestLink,
                request(drogon::Post, "/v1/auth/magic-link", R"({"email":"sam@"})"))
               ->getStatusCode(),
           drogon::k400BadRequest);
  CHECK(h.email.sent.empty());

  const drogon::HttpResponsePtr sent = call(
      h, &AuthApi::requestLink,
      request(drogon::Post, "/v1/auth/magic-link", R"({"email":"sam@example.com"})"));
  CHECK_EQ(sent->getStatusCode(), drogon::k200OK);
  CHECK_EQ((*sent->getJsonObject())["status"].asString(), std::string("sent"));
  CHECK_EQ(h.email.sent.size(), std::size_t{1});
  CHECK_EQ(h.authRepo.links.size(), std::size_t{1});
}

TEST(auth_a_send_that_could_not_reach_the_provider_is_reported_and_loses_no_link) {
  Harness h;
  h.email.failNext = true;

  const drogon::HttpResponsePtr response = call(
      h, &AuthApi::requestLink,
      request(drogon::Post, "/v1/auth/magic-link", R"({"email":"sam@example.com"})"));

  CHECK_EQ(response->getStatusCode(), drogon::k502BadGateway);
  const Json::Value body = *response->getJsonObject();
  CHECK_EQ(body["code"].asString(), std::string("unreachable"));
  CHECK_EQ(body["detail"].asString(), std::string("Nothing you've written is lost."));
  CHECK_EQ(h.authRepo.links.size(), std::size_t{1});
}

TEST(auth_a_fork_link_plants_through_the_port_and_a_deployment_without_one_signs_in_plainly) {
  Harness h;
  h.fork->description = ForkDescription{"Open a bakery", "12 steps"};
  h.fork->planted = "t_planted";

  const std::string token = h.linkFor("sam@example.com", "t_source");
  const drogon::HttpResponsePtr response =
      call(h, &AuthApi::verify, request(drogon::Post, "/v1/auth/verify", kVerified + token + "\"}"));

  CHECK_EQ(response->getStatusCode(), drogon::k200OK);
  CHECK_EQ((*response->getJsonObject())["forkedTree"].asString(), std::string("t_planted"));
  CHECK_EQ(h.fork->plantedFor, (std::vector<std::string>{"t_source"}));
  CHECK_EQ(h.email.sent.back().templateId, std::string("magic-link-fork"));
  CHECK_EQ(h.email.sent.back().sourceTitle, std::string("Open a bakery"));

  h.fork->planted = std::nullopt;
  const std::string second = h.linkFor("ada@example.com", "t_gone");
  const drogon::HttpResponsePtr plain = call(
      h, &AuthApi::verify, request(drogon::Post, "/v1/auth/verify", kVerified + second + "\"}"));
  CHECK_EQ(plain->getStatusCode(), drogon::k200OK);
  CHECK_FALSE((*plain->getJsonObject()).isMember("forkedTree"));
  REQUIRE(hasCookie(plain, "wm_session"));

  Harness bare;
  bare.api = std::make_shared<AuthApi>(bare.auth, nullptr, true, kDomain);
  const std::string third = bare.linkFor("sam@example.com", "t_source");
  const drogon::HttpResponsePtr noProduct = call(
      bare, &AuthApi::verify, request(drogon::Post, "/v1/auth/verify", kVerified + third + "\"}"));
  CHECK_EQ(noProduct->getStatusCode(), drogon::k200OK);
  CHECK_FALSE((*noProduct->getJsonObject()).isMember("forkedTree"));
}

TEST(auth_verify_code_signs_in_with_the_same_cookie_the_link_door_mints) {
  Harness h;
  const std::string code = h.codeFor("sam@example.com");
  CHECK_EQ(h.email.sent.back().templateId, std::string("magic-code"));

  const drogon::HttpResponsePtr response =
      call(h, &AuthApi::verifyCode,
           request(drogon::Post, "/v1/auth/verify-code",
                   R"({"email":"sam@example.com","code":")" + code + "\"}"));
  CHECK_EQ(response->getStatusCode(), drogon::k200OK);
  const Json::Value body = *response->getJsonObject();
  CHECK_EQ(body["user"]["email"].asString(), std::string("sam@example.com"));
  CHECK_FALSE(body.isMember("session"));

  REQUIRE(hasCookie(response, "wm_session"));
  const drogon::Cookie& cookie = response->getCookie("wm_session");
  CHECK(!cookie.getValue().empty());
  checkSessionCookie(cookie, true, kDomain, 7776000);  // 90 days

  const drogon::HttpResponsePtr me =
      call(h, &AuthApi::me, request(drogon::Get, "/v1/me", "", cookie.getValue()));
  CHECK_EQ(me->getStatusCode(), drogon::k200OK);
  CHECK_EQ((*me->getJsonObject())["user"]["email"].asString(), std::string("sam@example.com"));
}

TEST(auth_every_code_refusal_is_the_same_410_and_mints_nothing) {
  Harness h;
  const std::string code = h.codeFor("sam@example.com");

  const drogon::HttpResponsePtr wrong =
      call(h, &AuthApi::verifyCode,
           request(drogon::Post, "/v1/auth/verify-code",
                   R"({"email":"sam@example.com","code":"999999"})"));
  CHECK_EQ(wrong->getStatusCode(), drogon::k410Gone);
  const Json::Value gone = *wrong->getJsonObject();
  CHECK_EQ(gone["error"].asString(), std::string("That code has expired"));
  CHECK_EQ(gone["detail"].asString(), std::string("Codes work once and last 15 minutes."));
  CHECK_EQ(gone["code"].asString(), std::string("expired"));
  CHECK_FALSE(hasCookie(wrong, "wm_session"));

  const drogon::HttpResponsePtr unknown =
      call(h, &AuthApi::verifyCode,
           request(drogon::Post, "/v1/auth/verify-code",
                   R"({"email":"nobody@example.com","code":"999999"})"));
  CHECK_EQ(unknown->getStatusCode(), drogon::k410Gone);
  CHECK_EQ(std::string(unknown->getBody()), std::string(wrong->getBody()));

  CHECK_EQ(call(h, &AuthApi::verifyCode,
                request(drogon::Post, "/v1/auth/verify-code",
                        R"({"email":"sam@example.com","code":")" + code + "\"}"))
               ->getStatusCode(),
           drogon::k200OK);
  const drogon::HttpResponsePtr replay =
      call(h, &AuthApi::verifyCode,
           request(drogon::Post, "/v1/auth/verify-code",
                   R"({"email":"sam@example.com","code":")" + code + "\"}"));
  CHECK_EQ(replay->getStatusCode(), drogon::k410Gone);
  CHECK_EQ(std::string(replay->getBody()), std::string(wrong->getBody()));

  const std::string second = h.codeFor("ada@example.com");
  for (int guess = 0; guess < 5; ++guess)
    call(h, &AuthApi::verifyCode,
         request(drogon::Post, "/v1/auth/verify-code",
                 R"({"email":"ada@example.com","code":"999999"})"));
  const drogon::HttpResponsePtr exhausted =
      call(h, &AuthApi::verifyCode,
           request(drogon::Post, "/v1/auth/verify-code",
                   R"({"email":"ada@example.com","code":")" + second + "\"}"));
  CHECK_EQ(exhausted->getStatusCode(), drogon::k410Gone);
  CHECK_EQ(std::string(exhausted->getBody()), std::string(wrong->getBody()));
}

TEST(auth_a_code_request_missing_its_email_or_code_is_a_400) {
  Harness h;
  for (const std::string& body :
       {std::string("{}"), std::string(R"({"email":"sam@example.com"})"),
        std::string(R"({"code":"123456"})"), std::string(R"({"email":"","code":""})"),
        std::string("not json")}) {
    const drogon::HttpResponsePtr refused =
        call(h, &AuthApi::verifyCode, request(drogon::Post, "/v1/auth/verify-code", body));
    CHECK_EQ(refused->getStatusCode(), drogon::k400BadRequest);
    const Json::Value out = *refused->getJsonObject();
    CHECK_EQ(out["error"].asString(), std::string("Missing code"));
    CHECK_EQ(out["code"].asString(), std::string("bad_request"));
  }
  CHECK(h.authRepo.sessions.empty());
}

TEST(auth_the_mint_door_picks_the_code_mail_and_absence_keeps_the_link) {
  Harness h;
  const drogon::HttpResponsePtr coded = call(
      h, &AuthApi::requestLink,
      request(drogon::Post, "/v1/auth/magic-link", R"({"email":"sam@example.com","door":"app"})"));
  CHECK_EQ(coded->getStatusCode(), drogon::k200OK);
  CHECK_EQ((*coded->getJsonObject())["status"].asString(), std::string("sent"));
  CHECK_EQ(h.email.sent.back().templateId, std::string("magic-code"));
  CHECK_EQ(h.email.sent.back().code.size(), std::size_t{6});

  const drogon::HttpResponsePtr linked = call(
      h, &AuthApi::requestLink,
      request(drogon::Post, "/v1/auth/magic-link", R"({"email":"sam@example.com"})"));
  CHECK_EQ(linked->getStatusCode(), drogon::k200OK);
  CHECK_EQ(h.email.sent.back().templateId, std::string("magic-link"));
}

TEST(auth_the_apple_door_stays_shut_until_it_is_configured) {
  Harness h;

  const drogon::HttpResponsePtr unconfigured = call(
      h, &AuthApi::apple, request(drogon::Post, "/v1/auth/apple", R"({"authorizationCode":"c"})"));
  CHECK_EQ(unconfigured->getStatusCode(), drogon::k404NotFound);
  CHECK_EQ((*unconfigured->getJsonObject())["error"].asString(),
           std::string("apple sign-in is not configured"));
  CHECK(h.authRepo.identities.empty());
}

TEST(auth_the_google_door_bounces_into_the_app_until_it_is_configured) {
  Harness h;

  const drogon::HttpResponsePtr start =
      call(h, &AuthApi::googleStart, request(drogon::Get, "/v1/auth/google/start"));
  CHECK_EQ(start->getStatusCode(), drogon::k302Found);
  CHECK_EQ(start->getHeader("location"), kApp + "/#/");
  CHECK_FALSE(hasCookie(start, "wm_oauth_state"));
  CHECK_FALSE(hasCookie(start, "wm_session"));

  const drogon::HttpResponsePtr callback =
      call(h, &AuthApi::googleCallback, request(drogon::Get, "/v1/auth/google/callback"));
  CHECK_EQ(callback->getStatusCode(), drogon::k302Found);
  CHECK_EQ(callback->getHeader("location"), kApp + "/#/");
  CHECK_FALSE(hasCookie(callback, "wm_session"));
}

TEST(auth_the_google_start_mints_a_state_the_callback_will_insist_on) {
  Harness h(true, kDomain,
            std::make_shared<GoogleOAuthClient>("cli", "secret", kApp + "/v1/auth/google/callback"));

  const drogon::HttpResponsePtr start =
      call(h, &AuthApi::googleStart, request(drogon::Get, "/v1/auth/google/start"));
  CHECK_EQ(start->getStatusCode(), drogon::k302Found);
  REQUIRE(hasCookie(start, "wm_oauth_state"));

  const drogon::Cookie& state = start->getCookie("wm_oauth_state");
  CHECK_EQ(state.getValue().size(), std::size_t{32});  // 16 random bytes, hex
  CHECK(state.isHttpOnly());
  CHECK(state.isSecure());
  CHECK_EQ(state.getPath(), std::string("/"));
  CHECK(state.getSameSite() == drogon::Cookie::SameSite::kLax);
  CHECK_EQ(state.getDomain(), kDomain);
  CHECK_EQ(state.getMaxAge(), std::optional<int>(600));  // ten minutes
  CHECK(start->getHeader("location").find("state=" + state.getValue()) != std::string::npos);
  CHECK_FALSE(hasCookie(start, "wm_session"));

  const drogon::HttpResponsePtr again =
      call(h, &AuthApi::googleStart, request(drogon::Get, "/v1/auth/google/start"));
  CHECK(again->getCookie("wm_oauth_state").getValue() != state.getValue());
}

TEST(auth_a_failed_google_callback_expires_only_the_state_and_never_the_session) {
  Harness h(true, kDomain,
            std::make_shared<GoogleOAuthClient>("cli", "secret", kApp + "/v1/auth/google/callback"));
  h.signIn("s-live");

  auto callbackWith = [&](const std::string& code, const std::string& state,
                          const std::string& cookieState) {
    auto req = request(drogon::Get, "/v1/auth/google/callback", "", "s-live");
    if (!code.empty()) req->setParameter("code", code);
    if (!state.empty()) req->setParameter("state", state);
    if (!cookieState.empty()) req->addCookie("wm_oauth_state", cookieState);
    return call(h, &AuthApi::googleCallback, req);
  };

  for (const drogon::HttpResponsePtr& bounced :
       {callbackWith("the-code", "aaaa", "bbbb"),    // a forged state
        callbackWith("the-code", "aaaa", ""),        // no cookie at all
        callbackWith("the-code", "", "aaaa"),        // no state on the query
        callbackWith("", "aaaa", "aaaa")}) {         // no code
    CHECK_EQ(bounced->getStatusCode(), drogon::k302Found);
    CHECK_EQ(bounced->getHeader("location"), kApp + "/#/?signin=google_failed");
    REQUIRE(hasCookie(bounced, "wm_oauth_state"));
    CHECK_EQ(bounced->getCookie("wm_oauth_state").getMaxAge(), std::optional<int>(0));
    CHECK_FALSE(hasCookie(bounced, "wm_session"));
  }
  CHECK_EQ(h.authRepo.sessions.count(h.tokens.digestOf("s-live")), std::size_t{1});
}
