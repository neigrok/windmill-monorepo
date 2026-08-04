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
  FakeAccountFootprint footprint;
  std::shared_ptr<AuthService> auth =
      std::make_shared<AuthService>(authRepo, email, *tokens, *clock, oauth, footprint, "https://windmill.works");
  std::shared_ptr<FakeEchoRepository> echoes = std::make_shared<FakeEchoRepository>();
  FakeEmbedder embedder;
  FakeCurator curator;
  FakeSubscriptionRepository subscriptions;
  Entitlements entitlements{subscriptions};
  std::shared_ptr<EchoSweep> sweep;
  std::shared_ptr<EchoApi> api;

  explicit Harness(std::string adminToken = "")
      : sweep(std::make_shared<EchoSweep>(*echoes, embedder, curator, *clock, SelectionRules{},
                                          SweepBudget{})),
        api(std::make_shared<EchoApi>(echoes, sweep, auth,
                                      std::shared_ptr<Entitlements>(&entitlements, [](Entitlements*) {}),
                                      std::move(adminToken))) {}

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
                                const std::string& triggerDay, const std::string& matchDay) {
  drogon::HttpResponsePtr captured;
  h.api->dismiss(req, [&](const drogon::HttpResponsePtr& response) { captured = response; },
                 triggerDay, matchDay);
  return captured;
}

drogon::HttpResponsePtr adminSweep(Harness& h, const drogon::HttpRequestPtr& req) {
  drogon::HttpResponsePtr captured;
  h.api->adminSweep(req, [&](const drogon::HttpResponsePtr& response) { captured = response; });
  return captured;
}

}

namespace {

// One echo already on a page, planted the way a finished pass would have left it.
void plantEcho(Harness& h, const UserId& user) {
  CuratedEchoes curated;
  curated.curatorVersion = "fake-curator-v1";
  curated.rows.push_back(EchoRow{21, ld("2024-01-01"), 11, 0.8f, 0.9f, true});
  h.echoes->replaceEchoes(user, ld("2026-05-01"), curated);
}

drogon::HttpResponsePtr listOf(Harness& h, const drogon::HttpRequestPtr& req) {
  drogon::HttpResponsePtr captured;
  h.api->listEchoes(req, [&](const drogon::HttpResponsePtr& r) { captured = r; });
  return captured;
}

}

TEST(echoes_needs_a_signed_in_reader) {
  Harness h;
  const drogon::HttpResponsePtr response = listOf(h, request(drogon::Get, "/v1/journal/echoes"));
  CHECK_EQ(static_cast<int>(response->statusCode()), 401);
}

TEST(echoes_are_grouped_by_the_page_that_carries_them) {
  Harness h;
  const UserId user = h.signIn("s-live");
  plantEcho(h, user);

  const drogon::HttpResponsePtr response =
      listOf(h, request(drogon::Get, "/v1/journal/echoes", "", "s-live"));
  CHECK_EQ(static_cast<int>(response->statusCode()), 200);

  const Json::Value body = parse(std::string(response->getBody()));
  CHECK_EQ(body["pages"].size(), 1u);
  CHECK_EQ(body["pages"][0]["day"].asString(), std::string("2026-05-01"));
  CHECK_EQ(body["pages"][0]["matches"].size(), 1u);
  CHECK_EQ(body["pages"][0]["matches"][0]["day"].asString(), std::string("2024-01-01"));
}

// The honest cut. A subscriber is handed the passage; everyone else is handed its real opening
// words and the number withheld — which tells the truth about what exists, rather than the older
// behaviour of hiding that anything was found at all.
TEST(an_unentitled_reader_is_told_what_exists_and_shown_only_its_opening_words) {
  Harness h;
  const UserId user = h.signIn("s-live");
  plantEcho(h, user);

  const drogon::HttpResponsePtr response =
      listOf(h, request(drogon::Get, "/v1/journal/echoes", "", "s-live"));
  const Json::Value page = parse(std::string(response->getBody()))["pages"][0];

  CHECK(!page["entitled"].asBool());
  CHECK_EQ(page["matches"].size(), 1u);   // the echo is NOT hidden
}

TEST(a_subscriber_is_handed_the_whole_passage) {
  Harness h;
  const UserId user = h.signIn("s-live");
  h.subscriptions.subscribe(user);
  plantEcho(h, user);

  const drogon::HttpResponsePtr response =
      listOf(h, request(drogon::Get, "/v1/journal/echoes", "", "s-live"));
  const Json::Value page = parse(std::string(response->getBody()))["pages"][0];

  CHECK(page["entitled"].asBool());
  CHECK_EQ(page["matches"][0]["withheldWords"].asInt(), 0);
}

TEST(an_admin_sweep_without_a_token_is_refused) {
  Harness h;
  drogon::HttpResponsePtr captured;
  h.api->adminSweep(request(drogon::Post, "/v1/admin/journal/echo/sweep"),
                    [&](const drogon::HttpResponsePtr& r) { captured = r; });
  CHECK_EQ(static_cast<int>(captured->statusCode()), 403);
}
