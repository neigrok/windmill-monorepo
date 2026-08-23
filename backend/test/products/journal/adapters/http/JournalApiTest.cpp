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

Json::Value pageWrite(const std::string& text) {
  Json::Value body(Json::objectValue);
  body["body"] = text;
  body["mood"] = 4;
  body["energy"] = 2;
  body["source"] = "spoken";
  body["stamp"] = "1700000000000:3:dev-a";
  return body;
}

struct Harness {
  FakeAuthRepository authRepo;
  FakeEmail email;
  FakeTokens tokens;
  FakeClock clock;
  FakeOAuthRepository oauthRepo;
  OAuthService oauth{oauthRepo, tokens, clock};
  FakeAccountFootprint footprint;
  std::shared_ptr<AuthService> auth =
      std::make_shared<AuthService>(authRepo, email, tokens, clock, oauth, footprint, "https://windmill.works");
  FakeJournalRepository repo;
  std::shared_ptr<PageService> pages = std::make_shared<PageService>(repo);
  JournalApi api{pages, auth};

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

drogon::HttpRequestPtr putRequest(const Json::Value& body, const std::string& session = "") {
  auto request = drogon::HttpRequest::newHttpRequest();
  request->setMethod(drogon::Put);
  request->setPath("/v1/journal/page/2026-07-27");
  request->setContentTypeCode(drogon::CT_APPLICATION_JSON);
  request->setBody(dump(body));
  if (!session.empty()) request->addCookie("wm_session", session);
  return request;
}

drogon::HttpResponsePtr sendGet(JournalApi& api, const drogon::HttpRequestPtr& request,
                                const std::string& date) {
  drogon::HttpResponsePtr captured;
  api.getPage(request, [&](const drogon::HttpResponsePtr& response) { captured = response; }, date);
  return captured;
}

drogon::HttpResponsePtr sendPut(JournalApi& api, const drogon::HttpRequestPtr& request,
                                const std::string& date) {
  drogon::HttpResponsePtr captured;
  api.putPage(request, [&](const drogon::HttpResponsePtr& response) { captured = response; }, date);
  return captured;
}

Json::Value bodyOf(const drogon::HttpResponsePtr& response) { return *response->getJsonObject(); }

}

// ---- PageJson: the wire boundary ---------------------------------------------------------

TEST(page_write_parses_every_field) {
  Page page = parsePageWrite(pageWrite("wrote by hand"), uid("u1"), ld("2026-07-27"));

  CHECK(page.user == uid("u1"));
  CHECK(page.day == ld("2026-07-27"));
  CHECK_EQ(page.body, std::string("wrote by hand"));
  CHECK(page.mood == Mood::m4);
  CHECK(page.energy == Energy::e2);
  CHECK(page.source == Source::spoken);
  CHECK(page.stamp == hlc(1'700'000'000'000, 3, "dev-a"));
  CHECK_EQ(page.updatedAtMs, 0u);  // server time, stamped on store — never taken from the client
}

TEST(page_write_without_a_stamp_parses_to_the_unset_hlc) {
  Json::Value body(Json::objectValue);
  body["body"] = "quiet day";

  Page page = parsePageWrite(body, uid(), ld("2026-01-02"));

  CHECK(page.stamp == Hlc{});
  CHECK_FALSE(page.stamp.isSet());
  CHECK_EQ(page.body, std::string("quiet day"));
  CHECK(page.mood == Mood::none);
  CHECK(page.energy == Energy::none);
  CHECK(page.source == Source::typed);
  CHECK_EQ(page.updatedAtMs, 0u);
}

TEST(page_write_clamps_out_of_range_scales_and_reads_an_odd_source_as_typed) {
  Json::Value body(Json::objectValue);
  body["body"] = "loud day";
  body["mood"] = 9;
  body["energy"] = 7;
  body["source"] = "sung";

  Page page = parsePageWrite(body, uid(), ld("2026-01-02"));

  CHECK(page.mood == Mood::none);
  CHECK(page.energy == Energy::none);
  CHECK(page.source == Source::typed);
}

TEST(page_write_that_is_not_an_object_is_invalid) {
  bool threw = false;
  try {
    parsePageWrite(Json::Value("just text"), uid(), ld("2026-01-02"));
  } catch (const InvalidPage&) {
    threw = true;
  }
  CHECK(threw);
}

TEST(page_to_json_spells_every_field) {
  Page page{uid("u1"), ld("2026-07-27")};
  page.body = "wrote by hand";
  page.mood = Mood::m4;
  page.energy = Energy::e2;
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
  CHECK(h.repo.byKey.empty());
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

TEST(journal_put_then_get_round_trips_the_stored_page) {
  Harness h;
  UserId me = h.signIn("s-live");
  const std::string wire =
      R"({"body":"wrote by hand","day":"2026-07-27","energy":2,"mood":4,)"
      R"("source":"spoken","stamp":"1700000000000:3:dev-a","updatedAt":0})";

  drogon::HttpResponsePtr stored =
      sendPut(h.api, putRequest(pageWrite("wrote by hand"), "s-live"), "2026-07-27");

  CHECK_EQ(stored->getStatusCode(), drogon::k200OK);
  CHECK_EQ(dump(bodyOf(stored)), wire);
  REQUIRE_EQ(h.repo.byKey.size(), 1u);
  const FakeJournalRepository::Key key{me.str(), "2026-07-27"};
  CHECK(h.repo.byKey.at(key).user == me);

  drogon::HttpResponsePtr read =
      sendGet(h.api, getRequest("/v1/journal/page/2026-07-27", "s-live"), "2026-07-27");

  CHECK_EQ(read->getStatusCode(), drogon::k200OK);
  CHECK_EQ(dump(bodyOf(read)), wire);
}

TEST(journal_put_of_a_page_past_the_cap_is_413_and_stores_nothing) {
  Harness h;
  h.signIn("s-live");

  drogon::HttpResponsePtr response =
      sendPut(h.api, putRequest(pageWrite(std::string(kMaxPageBytes + 1, 'x')), "s-live"),
              "2026-07-27");

  CHECK_EQ(response->getStatusCode(), drogon::k413RequestEntityTooLarge);
  CHECK_EQ(dump(bodyOf(response)), std::string(R"({"error":"that page is too long to store"})"));
  CHECK(h.repo.byKey.empty());   // nothing stored, so nothing to trail into the revision table
}

TEST(journal_put_of_a_page_at_the_cap_is_stored) {
  Harness h;
  h.signIn("s-live");

  CHECK_EQ(sendPut(h.api, putRequest(pageWrite(std::string(kMaxPageBytes, 'x')), "s-live"),
                   "2026-07-27")
               ->getStatusCode(),
           drogon::k200OK);
  CHECK_EQ(h.repo.byKey.size(), 1u);
}

TEST(journal_routes_refuse_a_date_the_calendar_does_not_have) {
  Harness h;
  h.signIn("s-live");

  CHECK_EQ(sendGet(h.api, getRequest("/v1/journal/page/2026-02-31", "s-live"), "2026-02-31")
               ->getStatusCode(),
           drogon::k400BadRequest);
  CHECK_EQ(sendPut(h.api, putRequest(pageWrite("hi"), "s-live"), "2026-02-31")->getStatusCode(),
           drogon::k400BadRequest);
  CHECK_EQ(sendGet(h.api, getRequest("/v1/journal/page/0000-01-01", "s-live"), "0000-01-01")
               ->getStatusCode(),
           drogon::k400BadRequest);
  CHECK(h.repo.byKey.empty());
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

TEST(journal_put_with_a_malformed_stamp_is_400_not_500) {
  Harness h;
  h.signIn("s-live");
  Json::Value body(Json::objectValue);
  body["body"] = "hi";
  body["stamp"] = "x:0:dev";   // parseHlc throws on the non-numeric ms — a client 400, never a 500

  drogon::HttpResponsePtr response = sendPut(h.api, putRequest(body, "s-live"), "2026-07-27");

  CHECK_EQ(response->getStatusCode(), drogon::k400BadRequest);
  CHECK_EQ(dump(bodyOf(response)), std::string(R"({"error":"could not read that page"})"));
  CHECK(h.repo.byKey.empty());
}
