#include "products/journal/adapters/http/JournalApi.h"

#include "platform/adapters/json/JsonText.h"
#include "products/journal/adapters/json/PageJson.h"
#include "test/platform/Fakes.h"
#include "test/products/journal/Fakes.h"
#include "test/testing.h"

#include <algorithm>
#include <cstdint>
#include <map>
#include <optional>
#include <string>
#include <utility>
#include <vector>

using namespace wm;
using namespace wm::fake;

namespace {

struct Harness {
  FakeAuthRepository authRepo;
  FakeEmail email;
  FakeTokens tokens;
  FakeClock clock;
  FakeOAuthRepository oauthRepo;
  OAuthService oauth{oauthRepo, tokens, clock};
  FakeAccountFootprint footprint;
  FakeSessionRevocations revocations;
  std::shared_ptr<AuthService> auth =
      std::make_shared<AuthService>(authRepo, email, tokens, clock, oauth, footprint, revocations, "https://windmill.works");
  std::shared_ptr<FakeJournalRepository> repo = std::make_shared<FakeJournalRepository>();
  JournalApi api{repo, auth};

  UserId signIn(const std::string& sessionSecret) {
    User user = authRepo.createUser(Email{"sam@example.com"}, "sam");
    authRepo.insertSession(tokens.digestOf(sessionSecret), user.id, clock.now + 1'000'000, "", "", clock.now);
    return user.id;
  }
};

drogon::HttpRequestPtr getRequest(const std::string& path, const std::string& session = "") {
  auto request = drogon::HttpRequest::newHttpRequest();
  request->setMethod(drogon::Get);
  request->setPath(path);
  if (!session.empty()) request->addCookie("wm_session", session);
  return request;
}

drogon::HttpResponsePtr sendGet(JournalApi& api, const drogon::HttpRequestPtr& request,
                                const std::string& date) {
  drogon::HttpResponsePtr captured;
  api.getPage(request, [&](const drogon::HttpResponsePtr& response) { captured = response; }, date);
  return captured;
}

Json::Value bodyOf(const drogon::HttpResponsePtr& response) { return *response->getJsonObject(); }

}

// ---- PageJson: the wire boundary ---------------------------------------------------------

TEST(page_to_json_spells_every_field) {
  Page page{uid("u1"), ld("2026-07-27")};
  page.body = "wrote by hand";
  page.mood = Score{4};
  page.energy = Score{2};
  page.source = Source::spoken;
  page.stamp = hlc(1'700'000'000'000, 3, "dev-a");
  page.updatedAtMs = 1'700'000'001'234;

  CHECK_EQ(dump(toJson(page)),
           std::string(R"({"body":"wrote by hand","day":"2026-07-27","energy":2,"mood":4,)"
                       R"("source":"spoken","stamp":"1700000000000:3:dev-a","updatedAt":1700000001234})"));
}

TEST(pages_to_json_is_an_array_in_the_given_order) {
  Page first{uid("u1"), ld("2026-07-26")};
  first.body = "yesterday";
  first.mood = Score{0};
  first.stamp = hlc(1, 0, "dev-a");
  Page second{uid("u1"), ld("2026-07-27")};
  second.body = "today";
  second.stamp = hlc(2, 0, "dev-a");

  Json::Value array = toJson(std::vector<Page>{first, second});

  CHECK(array.isArray());
  CHECK_EQ(dump(array), "[" + dump(toJson(first)) + "," + dump(toJson(second)) + "]");
}

// ---- JournalApi: the owner gate and the round trip ---------------------------------------

TEST(journal_get_without_a_session_is_401) {
  Harness h;

  drogon::HttpResponsePtr response = sendGet(h.api, getRequest("/v1/journal/page/2026-07-27"), "2026-07-27");

  CHECK_EQ(response->getStatusCode(), drogon::k401Unauthorized);
  CHECK_EQ(dump(bodyOf(response)), std::string(R"({"error":"sign in to open your journal"})"));
  CHECK(h.repo->byKey.empty());
}

TEST(journal_get_of_a_malformed_date_is_400) {
  Harness h;
  h.signIn("s-live");

  drogon::HttpResponsePtr response =
      sendGet(h.api, getRequest("/v1/journal/page/27-07-2026", "s-live"), "27-07-2026");

  CHECK_EQ(response->getStatusCode(), drogon::k400BadRequest);
  CHECK_EQ(dump(bodyOf(response)), std::string(R"({"error":"bad date"})"));
}

TEST(journal_get_of_an_unwritten_day_is_404) {
  Harness h;
  h.signIn("s-live");

  drogon::HttpResponsePtr response =
      sendGet(h.api, getRequest("/v1/journal/page/2026-07-27", "s-live"), "2026-07-27");

  CHECK_EQ(response->getStatusCode(), drogon::k404NotFound);
  CHECK_EQ(dump(bodyOf(response)), std::string(R"({"error":"nothing written"})"));
}

TEST(journal_get_answers_the_stored_page_in_its_wire_shape) {
  Harness h;
  UserId me = h.signIn("s-live");
  Page page{me, ld("2026-07-27")};
  page.body = "wrote by hand";
  page.mood = Score{4};
  page.energy = Score{2};
  page.source = Source::spoken;
  page.stamp = hlc(1'700'000'000'000, 3, "dev-a");
  page.updatedAtMs = 1'700'000'001'234;
  h.repo->byKey.emplace(FakeJournalRepository::key(me, page.day), page);

  drogon::HttpResponsePtr read =
      sendGet(h.api, getRequest("/v1/journal/page/2026-07-27", "s-live"), "2026-07-27");

  CHECK_EQ(read->getStatusCode(), drogon::k200OK);
  CHECK_EQ(dump(bodyOf(read)),
           std::string(R"({"body":"wrote by hand","day":"2026-07-27","energy":2,"mood":4,)"
                       R"("source":"spoken","stamp":"1700000000000:3:dev-a","updatedAt":1700000001234})"));
}

TEST(journal_routes_refuse_a_date_the_calendar_does_not_have) {
  Harness h;
  h.signIn("s-live");

  CHECK_EQ(sendGet(h.api, getRequest("/v1/journal/page/2026-02-31", "s-live"), "2026-02-31")
               ->getStatusCode(),
           drogon::k400BadRequest);
  CHECK_EQ(sendGet(h.api, getRequest("/v1/journal/page/0000-01-01", "s-live"), "0000-01-01")
               ->getStatusCode(),
           drogon::k400BadRequest);
  CHECK(h.repo->byKey.empty());
}

TEST(journal_list_refuses_an_impossible_window) {
  Harness h;
  h.signIn("s-live");
  drogon::HttpRequestPtr request = getRequest("/v1/journal/pages", "s-live");
  request->setParameter("from", "2026-02-31");
  request->setParameter("to", "2026-03-01");

  drogon::HttpResponsePtr captured;
  h.api.listPages(request, [&](const drogon::HttpResponsePtr& response) { captured = response; });

  CHECK_EQ(captured->getStatusCode(), drogon::k400BadRequest);
  CHECK_EQ(dump(bodyOf(captured)), std::string(R"({"error":"bad date"})"));
}
