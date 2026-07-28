#include "products/journal/adapters/http/EchoApi.h"

#include "platform/application/Entitlements.h"
#include "platform/adapters/json/JsonText.h"
#include "test/application/AuthFakes.h"
#include "test/products/journal/Fakes.h"
#include "test/testing.h"

#include <cstdint>
#include <memory>
#include <string>
#include <utility>

using namespace wm;
using namespace wm::fake;

namespace {

// The same harness NudgeApiTest runs on, plus the echo half: the fake repository, a REAL EchoSweep
// over the fakes, and the api under test. The first user the auth fake mints is "u1".
struct Harness {
  FakeAuthRepository authRepo;
  FakeEmail email;
  std::shared_ptr<FakeTokens> tokens = std::make_shared<FakeTokens>();
  std::shared_ptr<FakeClock> clock = std::make_shared<FakeClock>();
  FakeOAuthRepository oauthRepo;
  OAuthService oauth{oauthRepo, *tokens, *clock};
  std::shared_ptr<AuthService> auth =
      std::make_shared<AuthService>(authRepo, email, *tokens, *clock, oauth, "https://windmill.works");
  std::shared_ptr<FakeEchoRepository> echoes = std::make_shared<FakeEchoRepository>();
  FakeEmbedder embedder;
  FakeSubscriptionRepository subscriptions;
  Entitlements entitlements{subscriptions};
  std::shared_ptr<EchoSweep> sweep;
  std::shared_ptr<EchoApi> api;

  explicit Harness(std::string adminToken = "")
      : sweep(std::make_shared<EchoSweep>(*echoes, embedder, entitlements, *clock, EchoRules{})),
        api(std::make_shared<EchoApi>(echoes, sweep, auth, std::move(adminToken))) {}

  UserId signIn(const std::string& sessionSecret) {
    User user = authRepo.createUser(Email{"sam@example.com"}, "sam");
    authRepo.insertSession(tokens->digestOf(sessionSecret), user.id, clock->now + 1'000'000, "", "",
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

drogon::HttpResponsePtr listEchoes(Harness& h, const drogon::HttpRequestPtr& req) {
  drogon::HttpResponsePtr captured;
  h.api->listEchoes(req, [&](const drogon::HttpResponsePtr& response) { captured = response; });
  return captured;
}

drogon::HttpResponsePtr dismiss(Harness& h, const drogon::HttpRequestPtr& req,
                                const std::string& date) {
  drogon::HttpResponsePtr captured;
  h.api->dismiss(req, [&](const drogon::HttpResponsePtr& response) { captured = response; }, date);
  return captured;
}

drogon::HttpResponsePtr adminSweep(Harness& h, const drogon::HttpRequestPtr& req) {
  drogon::HttpResponsePtr captured;
  h.api->adminSweep(req, [&](const drogon::HttpResponsePtr& response) { captured = response; });
  return captured;
}

}

TEST(echoes_list_without_a_session_is_401) {
  Harness h;

  drogon::HttpResponsePtr response = listEchoes(h, request(drogon::Get, "/v1/journal/echoes"));

  CHECK_EQ(response->getStatusCode(), drogon::k401Unauthorized);
  CHECK_EQ(dump(*response->getJsonObject()),
           std::string(R"({"error":"sign in to read your echoes"})"));
}

TEST(echoes_list_returns_only_the_owners_echoes_and_never_the_score) {
  Harness h;
  UserId me = h.signIn("s-live");
  h.echoes->saveEcho(me, ld("2026-07-20"), EchoMatch{ld("2026-03-01"), {0, 40}, {12, 60}, 0.81f});
  h.echoes->saveEcho(uid("u2"), ld("2026-07-21"), EchoMatch{ld("2026-02-02"), {1, 5}, {2, 9}, 0.9f});

  drogon::HttpResponsePtr response =
      listEchoes(h, request(drogon::Get, "/v1/journal/echoes", "", "s-live"));

  // The stranger's echo stays theirs, and the score is stored but never shipped — an echo is a
  // presence, not a number. The full-body compare is what proves no "score" key rode along.
  CHECK_EQ(response->getStatusCode(), drogon::k200OK);
  CHECK_EQ(dump(*response->getJsonObject()),
           std::string(R"({"echoes":[{"matchDay":"2026-03-01","matchSpan":[12,60],)"
                       R"("triggerDay":"2026-07-20","triggerSpan":[0,40]}]})"));
  CHECK_FALSE((*response->getJsonObject())["echoes"][0].isMember("score"));
}

TEST(echoes_list_honours_the_asked_window) {
  Harness h;
  UserId me = h.signIn("s-live");
  h.echoes->saveEcho(me, ld("2026-07-20"), EchoMatch{ld("2026-03-01"), {0, 40}, {12, 60}, 0.81f});
  drogon::HttpRequestPtr inside = request(drogon::Get, "/v1/journal/echoes", "", "s-live");
  inside->setParameter("from", "2026-07-01");
  inside->setParameter("to", "2026-07-31");
  drogon::HttpRequestPtr outside = request(drogon::Get, "/v1/journal/echoes", "", "s-live");
  outside->setParameter("from", "2026-01-01");
  outside->setParameter("to", "2026-01-31");

  drogon::HttpResponsePtr found = listEchoes(h, inside);
  drogon::HttpResponsePtr empty = listEchoes(h, outside);

  CHECK_EQ(found->getStatusCode(), drogon::k200OK);
  CHECK_EQ((*found->getJsonObject())["echoes"].size(), 1u);
  CHECK_EQ(empty->getStatusCode(), drogon::k200OK);
  CHECK_EQ(dump(*empty->getJsonObject()), std::string(R"({"echoes":[]})"));
}

TEST(echoes_dismiss_is_204_and_removes_it_from_the_list) {
  Harness h;
  UserId me = h.signIn("s-live");
  h.echoes->saveEcho(me, ld("2026-07-20"), EchoMatch{ld("2026-03-01"), {0, 40}, {12, 60}, 0.81f});

  drogon::HttpResponsePtr response = dismiss(
      h, request(drogon::Post, "/v1/journal/echoes/2026-07-20/dismiss", "", "s-live"), "2026-07-20");

  CHECK_EQ(response->getStatusCode(), drogon::k204NoContent);
  drogon::HttpResponsePtr after =
      listEchoes(h, request(drogon::Get, "/v1/journal/echoes", "", "s-live"));
  CHECK_EQ(dump(*after->getJsonObject()), std::string(R"({"echoes":[]})"));
}

TEST(echoes_dismiss_with_a_malformed_date_is_400) {
  Harness h;
  h.signIn("s-live");

  drogon::HttpResponsePtr response = dismiss(
      h, request(drogon::Post, "/v1/journal/echoes/20-07-2026/dismiss", "", "s-live"), "20-07-2026");

  CHECK_EQ(response->getStatusCode(), drogon::k400BadRequest);
  CHECK_EQ(dump(*response->getJsonObject()), std::string(R"({"error":"bad date"})"));
}

TEST(echo_admin_sweep_with_no_token_configured_is_403) {
  Harness h;

  drogon::HttpResponsePtr response =
      adminSweep(h, request(drogon::Post, "/v1/admin/journal/echo/sweep"));

  CHECK_EQ(response->getStatusCode(), drogon::k403Forbidden);
  CHECK_EQ(dump(*response->getJsonObject()), std::string(R"({"error":"admin token required"})"));
}

TEST(echo_admin_sweep_with_the_wrong_token_is_403) {
  Harness h("the-secret");
  drogon::HttpRequestPtr req = request(drogon::Post, "/v1/admin/journal/echo/sweep");
  req->addHeader("x-admin-token", "the-secre");

  drogon::HttpResponsePtr response = adminSweep(h, req);

  CHECK_EQ(response->getStatusCode(), drogon::k403Forbidden);
  CHECK_EQ(dump(*response->getJsonObject()), std::string(R"({"error":"admin token required"})"));
}

TEST(echo_admin_sweep_with_the_right_token_reports) {
  Harness h("the-secret");
  Json::Value body(Json::objectValue);
  body["asOfMs"] = Json::Value::UInt64(1'700'000'000'000ULL);
  drogon::HttpRequestPtr req =
      request(drogon::Post, "/v1/admin/journal/echo/sweep", dump(body));
  req->addHeader("x-admin-token", "the-secret");

  drogon::HttpResponsePtr response = adminSweep(h, req);

  // Nobody wrote anything, so one pass over an empty repository is all zeros — the door and the
  // report shape are what this case pins down.
  CHECK_EQ(response->getStatusCode(), drogon::k200OK);
  CHECK_EQ(dump(*response->getJsonObject()),
           std::string(R"({"echoesFound":0,"skippedNotSubscribed":0,)"
                       R"("usersScanned":0,"vectorsComputed":0})"));
}
