#include "platform/adapters/http/EventsApi.h"

#include "products/roadmap/adapters/json/TreeJson.h"
#include "test/application/AuthFakes.h"
#include "test/testing.h"

#include <optional>
#include <string>
#include <vector>

using namespace wm;
using namespace wm::fake;

namespace {

struct FakeEventRepository : EventRepository {
  struct Batch {
    std::string sessionKey;
    std::optional<UserId> user;
    std::vector<FunnelEvent> events;
  };
  std::vector<Batch> appended;

  void append(const std::string& sessionKey, const std::optional<UserId>& user,
              const std::vector<FunnelEvent>& events) override {
    appended.push_back(Batch{sessionKey, user, events});
  }
};

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
  std::shared_ptr<FakeEventRepository> repo = std::make_shared<FakeEventRepository>();
  EventsApi api{repo, auth};

  UserId signIn(const std::string& sessionSecret) {
    User user = authRepo.createUser(Email{"sam@example.com"}, "sam");
    authRepo.insertSession(tokens.digestOf(sessionSecret), user.id, clock.now + 1'000'000, "", "", clock.now);
    return user.id;
  }
};

drogon::HttpRequestPtr post(const Json::Value& body) {
  auto request = drogon::HttpRequest::newHttpRequest();
  request->setMethod(drogon::Post);
  request->setPath("/v1/events");
  request->setContentTypeCode(drogon::CT_APPLICATION_JSON);
  request->setBody(dump(body));
  return request;
}

drogon::HttpResponsePtr send(EventsApi& api, const drogon::HttpRequestPtr& request) {
  drogon::HttpResponsePtr captured;
  api.ingest(request, [&](const drogon::HttpResponsePtr& response) { captured = response; });
  return captured;
}

Json::Value entry(const std::string& name, long long clientMs) {
  Json::Value event(Json::objectValue);
  event["name"] = name;
  event["clientMs"] = static_cast<Json::Int64>(clientMs);
  return event;
}

Json::Value batch(const std::string& sessionKey, const Json::Value& events) {
  Json::Value body(Json::objectValue);
  body["sessionKey"] = sessionKey;
  body["events"] = events;
  return body;
}

Json::Value bodyOf(const drogon::HttpResponsePtr& response) { return *response->getJsonObject(); }

}

TEST(events_batch_caps_at_fifty_and_the_fifty_first_is_dropped) {
  Harness h;
  Json::Value events(Json::arrayValue);
  for (int i = 0; i < 51; ++i) events.append(entry("step_" + std::to_string(i), 1000 + i));

  drogon::HttpResponsePtr response = send(h.api, post(batch("browser-abc", events)));

  CHECK_EQ(response->getStatusCode(), drogon::k202Accepted);
  CHECK_EQ(bodyOf(response)["accepted"].asInt(), 50);
  CHECK_EQ(h.repo->appended.size(), 1u);
  if (h.repo->appended.empty()) return;  // the CHECK already failed; don't segfault the suite
  const FakeEventRepository::Batch& stored = h.repo->appended[0];
  CHECK_EQ(stored.sessionKey, std::string("browser-abc"));
  CHECK(stored.user == std::nullopt);
  CHECK_EQ(stored.events.size(), 50u);
  for (int i = 0; i < 50; ++i) {
    CHECK_EQ(stored.events[i].name, "step_" + std::to_string(i));
    CHECK_EQ(stored.events[i].clientMs, 1000 + i);
    CHECK_EQ(stored.events[i].props, std::string("{}"));
  }
}

TEST(events_malformed_entries_drop_alone_while_valid_siblings_persist) {
  Harness h;
  Json::Value okWithProps = entry("tree_opened", 1000);
  Json::Value props(Json::objectValue);
  props["source"] = "landing";
  okWithProps["props"] = props;

  Json::Value camelName = entry("TreeOpened", 1001);
  Json::Value longName = entry(std::string(65, 'a'), 1002);
  Json::Value noClock(Json::objectValue);
  noClock["name"] = "no_clock";
  Json::Value stringClock = entry("string_clock", 0);
  stringClock["clientMs"] = "1003";
  Json::Value fatProps = entry("fat_props", 1004);
  Json::Value fat(Json::objectValue);
  fat["pad"] = std::string(1100, 'x');
  fatProps["props"] = fat;
  Json::Value nestedProps = entry("nested_props", 1005);
  Json::Value nested(Json::objectValue);
  nested["inner"] = Json::Value(Json::objectValue);
  nestedProps["props"] = nested;
  Json::Value arrayProps = entry("array_props", 1006);
  arrayProps["props"] = Json::Value(Json::arrayValue);
  Json::Value nulProps = entry("nul_props", 1007);  // jsonb can't store \0 — must drop alone,
  Json::Value nul(Json::objectValue);               // never poison the single-txn batch into a 500
  nul["value"] = std::string("ab\0cd", 5);
  nulProps["props"] = nul;
  Json::Value hugeClock = entry("huge_clock", 0);   // past the 4e12 cap — garbage timestamps stay
  hugeClock["clientMs"] = 9e12;                     // out (inf can't round-trip valid JSON at all)
  Json::Value okPlain = entry("node_planted", 2000);

  Json::Value events(Json::arrayValue);
  events.append(okWithProps);
  events.append(camelName);
  events.append(longName);
  events.append(noClock);
  events.append(stringClock);
  events.append(fatProps);
  events.append(nestedProps);
  events.append(arrayProps);
  events.append(nulProps);
  events.append(hugeClock);
  events.append("not_an_object");
  events.append(okPlain);

  drogon::HttpResponsePtr response = send(h.api, post(batch("browser-abc", events)));

  CHECK_EQ(response->getStatusCode(), drogon::k202Accepted);
  CHECK_EQ(bodyOf(response)["accepted"].asInt(), 2);
  CHECK_EQ(h.repo->appended.size(), 1u);
  if (h.repo->appended.empty()) return;  // the CHECK already failed; don't segfault the suite
  const FakeEventRepository::Batch& stored = h.repo->appended[0];
  CHECK_EQ(stored.events.size(), 2u);
  CHECK_EQ(stored.events[0].name, std::string("tree_opened"));
  CHECK_EQ(stored.events[0].clientMs, 1000);
  CHECK_EQ(stored.events[0].props, std::string(R"({"source":"landing"})"));
  CHECK_EQ(stored.events[1].name, std::string("node_planted"));
  CHECK_EQ(stored.events[1].clientMs, 2000);
  CHECK_EQ(stored.events[1].props, std::string("{}"));
}

TEST(events_anonymous_caller_is_stored_without_a_user) {
  Harness h;
  Json::Value events(Json::arrayValue);
  events.append(entry("landing_viewed", 500));

  drogon::HttpResponsePtr response = send(h.api, post(batch("ghost-1", events)));

  CHECK_EQ(response->getStatusCode(), drogon::k202Accepted);
  CHECK_EQ(bodyOf(response)["accepted"].asInt(), 1);
  CHECK_EQ(h.repo->appended.size(), 1u);
  CHECK_EQ(h.repo->appended[0].sessionKey, std::string("ghost-1"));
  CHECK(h.repo->appended[0].user == std::nullopt);
}

TEST(events_authenticated_caller_is_attributed_from_the_session_not_the_body) {
  Harness h;
  UserId user = h.signIn("s-live");

  Json::Value events(Json::arrayValue);
  events.append(entry("tree_opened", 1000));
  Json::Value body = batch("browser-abc", events);
  body["userId"] = "forged-identity";  // never read: attribution comes from the session

  drogon::HttpRequestPtr request = post(body);
  request->addHeader("authorization", "Bearer s-live");
  drogon::HttpResponsePtr response = send(h.api, request);

  CHECK_EQ(response->getStatusCode(), drogon::k202Accepted);
  CHECK_EQ(bodyOf(response)["accepted"].asInt(), 1);
  CHECK_EQ(h.repo->appended.size(), 1u);
  CHECK(h.repo->appended[0].user == std::optional<UserId>(user));
}

TEST(events_session_cookie_attributes_like_bearer) {
  Harness h;
  UserId user = h.signIn("s-cookie");

  Json::Value events(Json::arrayValue);
  events.append(entry("node_planted", 1500));
  drogon::HttpRequestPtr request = post(batch("browser-abc", events));
  request->addCookie("wm_session", "s-cookie");
  drogon::HttpResponsePtr response = send(h.api, request);

  CHECK_EQ(response->getStatusCode(), drogon::k202Accepted);
  CHECK_EQ(h.repo->appended.size(), 1u);
  CHECK(h.repo->appended[0].user == std::optional<UserId>(user));
}

TEST(events_malformed_body_is_rejected_whole_with_400) {
  Harness h;

  auto rawText = drogon::HttpRequest::newHttpRequest();
  rawText->setMethod(drogon::Post);
  rawText->setPath("/v1/events");
  rawText->setContentTypeCode(drogon::CT_APPLICATION_JSON);
  rawText->setBody("not json at all");
  CHECK_EQ(send(h.api, rawText)->getStatusCode(), drogon::k400BadRequest);

  Json::Value noKey(Json::objectValue);
  noKey["events"] = Json::Value(Json::arrayValue);
  CHECK_EQ(send(h.api, post(noKey))->getStatusCode(), drogon::k400BadRequest);

  Json::Value longKey = batch(std::string(65, 'k'), Json::Value(Json::arrayValue));
  CHECK_EQ(send(h.api, post(longKey))->getStatusCode(), drogon::k400BadRequest);

  Json::Value noArray(Json::objectValue);
  noArray["sessionKey"] = "browser-abc";
  noArray["events"] = "not-an-array";
  CHECK_EQ(send(h.api, post(noArray))->getStatusCode(), drogon::k400BadRequest);

  CHECK_EQ(h.repo->appended.size(), 0u);
}

TEST(events_empty_batch_is_accepted_with_zero_and_never_touches_the_repo) {
  Harness h;
  drogon::HttpResponsePtr response = send(h.api, post(batch("browser-abc", Json::Value(Json::arrayValue))));

  CHECK_EQ(response->getStatusCode(), drogon::k202Accepted);
  CHECK_EQ(dump(bodyOf(response)), std::string(R"({"accepted":0})"));
  CHECK_EQ(h.repo->appended.size(), 0u);
}
