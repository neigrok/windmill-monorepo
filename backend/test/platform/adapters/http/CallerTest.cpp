#include "platform/adapters/http/Caller.h"

#include "platform/adapters/http/AuthApi.h"
#include "platform/adapters/http/EventsApi.h"
#include "platform/adapters/http/FeedbackApi.h"
#include "platform/adapters/http/McpKeyApi.h"
#include "platform/adapters/http/OAuthApi.h"
#include "platform/adapters/http/SyncApi.h"
#include "platform/adapters/json/JsonText.h"
#include "platform/application/McpKeyService.h"
#include "platform/application/WorkerPool.h"
#include "platform/domain/sync/Jcs.h"
#include "products/gym/adapters/http/PreferencesApi.h"
#include "products/journal/adapters/http/JournalApi.h"
#include "products/roadmap/adapters/http/TreeApi.h"
#include "products/roadmap/application/ForkService.h"
#include "products/roadmap/domain/LooseGraph.h"
#include "test/DrogonLoopback.h"
#include "test/platform/Fakes.h"
#include "test/platform/application/sync/SyncWorld.h"
#include "test/products/gym/Fakes.h"
#include "test/products/journal/Fakes.h"
#include "test/products/roadmap/Fakes.h"
#include "test/testing.h"

#include <chrono>
#include <functional>
#include <future>
#include <iostream>
#include <map>
#include <memory>
#include <stdexcept>
#include <string>
#include <vector>

// The one credential rule at every door that reads a session (Caller.h): the same header lines, sent to each door, read
// as Ann, as anonymous, as credentials the rule refuses, or as one lapsed credential, and each door answers a reading one
// way. A door that serves an account alone answers 401 to all but Ann; a door that serves anonymous callers too refuses
// only the refused, and serves a lapsed credential as anonymous; the sync doors refuse a lapsed one too. Logout and the
// session doors end the session the request is served through, the cookie's when it sends one, and a refusal ends none.

using namespace wm;
using namespace wm::fake;
using namespace std::chrono_literals;

namespace {

enum class Reading { ann, anonymous, refused, lapsed };

// Ann holds a browser's session (s-ann) and a phone's (s-ann-phone), Bob one (s-bob), and no session holds s-gone.
struct Accounts {
  std::shared_ptr<FakeAuthRepository> repo = std::make_shared<FakeAuthRepository>();
  FakeEmail email;
  FakeTokens tokens;
  std::shared_ptr<FakeClock> clock = std::make_shared<FakeClock>();
  FakeOAuthRepository oauthRepo;
  std::shared_ptr<OAuthService> oauth = std::make_shared<OAuthService>(oauthRepo, tokens, *clock);
  FakeAccountFootprint footprint;
  FakeSessionRevocations revocations;
  std::shared_ptr<AuthService> auth =
      std::make_shared<AuthService>(*repo, email, tokens, *clock, *oauth, footprint, revocations, "https://windmill.works");
  UserId ann = seat("ann", {"s-ann", "s-ann-phone"});
  UserId bob = seat("bob", {"s-bob"});

  UserId seat(const std::string& name, const std::vector<std::string>& secrets) {
    const User user = repo->createUser(Email{name + "@example.com"}, name);
    for (const std::string& secret : secrets)
      repo->insertSession(tokens.digestOf(secret), user.id, clock->now + 1'000'000, "", "", clock->now);
    return user.id;
  }

  // The token of the live session whose id is `id`.
  std::string tokenOf(const std::string& id) const {
    for (const auto& [digest, record] : repo->sessions)
      if (record.id == id) return "s" + digest.substr(1);
    return "none";
  }

  // The sessions still alive, by token, and whether Ann's account is closed.
  std::string standing() const {
    std::string out = "sessions";
    for (const auto& [digest, record] : repo->sessions) out += " s" + digest.substr(1);
    if (repo->usersById.at(ann.str()).deletedAt) out += ", Ann's closed";
    return out;
  }
};

// The request Drogon parses from `method path`, `lines` as its field lines, and `body` as JSON.
drogon::HttpRequestPtr received(std::string_view method, const std::string& path, const sync::HeaderOccurrences& lines,
                                const std::string& body = "") {
  std::vector<std::string> fields{"Host: caller-test", "Sync-Schema: 2"};
  for (const auto& [name, value] : lines) fields.push_back(name + ": " + value);
  if (!body.empty()) fields.push_back("Content-Type: application/json");
  return wm::test::DrogonLoopback::received(method, path, fields, body);
}

// What a door answers, on whichever thread it answers; a door that has not answered within 10 s fails the case.
drogon::HttpResponsePtr answerOf(const std::function<void(HttpCallback&&)>& door) {
  auto replied = std::make_shared<std::promise<drogon::HttpResponsePtr>>();
  std::future<drogon::HttpResponsePtr> answer = replied->get_future();
  door([replied](const drogon::HttpResponsePtr& response) { replied->set_value(response); });
  if (answer.wait_for(10s) != std::future_status::ready) throw std::runtime_error("the door did not answer within 10 s");
  return answer.get();
}

std::string statusOf(const drogon::HttpResponsePtr& response) {
  return std::to_string(static_cast<int>(response->statusCode()));
}

struct FeedbackRows : FeedbackRepository {
  std::vector<std::optional<UserId>> authors;
  void insert(const std::string&, const std::optional<UserId>& user, const std::string&, const std::string&,
              const std::string&) override {
    authors.push_back(user);
  }
};

struct EventBatches : EventRepository {
  std::vector<std::optional<UserId>> authors;
  void append(const std::string&, const std::optional<UserId>& user, const std::vector<FunnelEvent>&) override {
    authors.push_back(user);
  }
  int countInLastDay(const std::string&) override { return 0; }
};

std::string authorOf(const std::vector<std::optional<UserId>>& authors) {
  if (authors.empty()) return "";
  return authors.front() ? " from " + authors.front()->str() : " from anonymous";
}

using Answer = std::function<std::string(const sync::HeaderOccurrences&)>;

struct Door {
  std::string name;
  Answer answer;
  std::map<Reading, std::string> answers;
};

// A door that serves an account alone: Ann's answer, and `others` to every other reading.
std::map<Reading, std::string> accountDoor(const std::string& ann, const std::string& others = "401") {
  return {{Reading::ann, ann}, {Reading::anonymous, others}, {Reading::refused, others}, {Reading::lapsed, others}};
}

// A door that serves anonymous callers too: Ann's answer, the anonymous one to a lapsed credential as to none, and
// `refused` to the credentials the rule refuses.
std::map<Reading, std::string> openDoor(const std::string& ann, const std::string& anonymous, const std::string& refused = "401") {
  return {{Reading::ann, ann}, {Reading::anonymous, anonymous}, {Reading::refused, refused}, {Reading::lapsed, anonymous}};
}

// One of AuthApi's doors over fresh accounts: its status, and with `standing` what it left of the accounts.
Answer authDoor(const std::string& method, const std::string& path, const std::string& body,
                void (AuthApi::*door)(const drogon::HttpRequestPtr&, HttpCallback&&), bool standing = false) {
  return [method, path, body, door, standing](const sync::HeaderOccurrences& lines) {
    Accounts accounts;
    AuthApi api{accounts.auth, nullptr, false, SessionCookieScopes{"", ""}};
    const drogon::HttpRequestPtr req = received(method, path, lines, body);
    const std::string status = statusOf(answerOf([&](HttpCallback&& reply) { (api.*door)(req, std::move(reply)); }));
    return standing ? status + " " + accounts.standing() : status;
  };
}

// Ann's private roadmap t_mine and an unlisted one to fork, t_src, behind the roadmap's REST reads over its rooms.
struct Roadmaps {
  Accounts accounts;
  std::shared_ptr<FakeProgressRepository> progress = std::make_shared<FakeProgressRepository>();
  std::shared_ptr<FakeTreeRepository> trees = std::make_shared<FakeTreeRepository>(*progress);
  std::shared_ptr<FakeOpLog> ops = std::make_shared<FakeOpLog>();
  FakeBus bus;
  FakeTokens tokens;
  HeldRetries retries;
  std::shared_ptr<RoomRegistry> rooms = std::make_shared<RoomRegistry>(*trees, *ops, bus, retries.timer());
  std::shared_ptr<ForkService> fork = std::make_shared<ForkService>(*rooms, *trees, tokens, *accounts.clock);
  std::shared_ptr<OwnerProgress> ownerProgress = std::make_shared<OwnerProgress>(*progress, *trees, *accounts.clock);
  TreeApi api{rooms, trees, ownerProgress, ops, accounts.auth, fork, nullptr, nullptr};

  Roadmaps() {
    LooseGraph mine;
    mine.createNode(NodeId{"sail"}, "Learn to sail", "", NodeColor::sky, Hlc{1, 0, "seed"});
    trees->byId["t_mine"] = StoredTree{mine.exportState(), LegendState{}, {"Mine", {}}, 0, accounts.ann, Visibility::private_};
    LooseGraph source;
    source.createNode(NodeId{"root"}, "Root", "", NodeColor::sky, Hlc{1, 0, "seed"});
    trees->byId["t_src"] = StoredTree{source.exportState(), LegendState{}, {"Source", {}}, 0, UserId{"owner"}, Visibility::unlisted};
  }
};

std::vector<Door> doors() {
  const std::string everyone = "sessions s-ann s-ann-phone s-bob";
  return {
      {"GET /v1/me", authDoor("GET", "/v1/me", "", &AuthApi::me), accountDoor("200")},
      {"PATCH /v1/me", authDoor("PATCH", "/v1/me", R"({"name":"Ann"})", &AuthApi::patchMe), accountDoor("200")},
      {"DELETE /v1/me", authDoor("DELETE", "/v1/me", R"({"account":"u1"})", &AuthApi::deleteMe, true),
       accountDoor("200 sessions s-bob, Ann's closed", "401 " + everyone)},
      {"GET /v1/sessions",
       [](const sync::HeaderOccurrences& lines) {
         Accounts accounts;
         AuthApi api{accounts.auth, nullptr, false, SessionCookieScopes{"", ""}};
         const drogon::HttpRequestPtr req = received("GET", "/v1/sessions", lines);
         const drogon::HttpResponsePtr response = answerOf([&](HttpCallback&& reply) { api.listSessions(req, std::move(reply)); });
         if (response->statusCode() != drogon::k200OK) return statusOf(response);
         for (const Json::Value& session : (*response->getJsonObject())["sessions"])
           if (session["current"].asBool()) return "200 current " + accounts.tokenOf(session["id"].asString());
         return std::string("200 current none");
       },
       accountDoor("200 current s-ann")},
      {"DELETE /v1/sessions", authDoor("DELETE", "/v1/sessions", "", &AuthApi::signOutEverywhere, true),
       accountDoor("204 sessions s-ann s-bob", "401 " + everyone)},
      {"DELETE /v1/sessions/{Ann's phone}",
       [](const sync::HeaderOccurrences& lines) {
         Accounts accounts;
         AuthApi api{accounts.auth, nullptr, false, SessionCookieScopes{"", ""}};
         const std::string phone = accounts.repo->sessions.at("d-ann-phone").id;
         const drogon::HttpRequestPtr req = received("DELETE", "/v1/sessions/" + phone, lines);
         const drogon::HttpResponsePtr response =
             answerOf([&](HttpCallback&& reply) { api.revokeSession(req, std::move(reply), phone); });
         return statusOf(response) + " " + accounts.standing();
       },
       accountDoor("204 sessions s-ann s-bob", "401 " + everyone)},
      {"POST /v1/auth/logout", authDoor("POST", "/v1/auth/logout", "", &AuthApi::logout, true),
       openDoor("204 sessions s-ann-phone s-bob", "204 " + everyone, "401 " + everyone)},
      {"POST /v1/auth/link", authDoor("POST", "/v1/auth/link", "{}", &AuthApi::link), accountDoor("400")},
      {"GET /v1/oauth/grants",
       [](const sync::HeaderOccurrences& lines) {
         Accounts accounts;
         OAuthApi api{accounts.oauth, accounts.auth, "https://api.windmill.works", "https://windmill.works", "/connect", {}};
         const drogon::HttpRequestPtr req = received("GET", "/v1/oauth/grants", lines);
         return statusOf(answerOf([&](HttpCallback&& reply) { api.listGrants(req, std::move(reply)); }));
       },
       accountDoor("200")},
      {"POST /v1/oauth/decision",
       [](const sync::HeaderOccurrences& lines) {
         Accounts accounts;
         OAuthApi api{accounts.oauth, accounts.auth, "https://api.windmill.works", "https://windmill.works", "/connect", {}};
         const drogon::HttpRequestPtr req = received("POST", "/v1/oauth/decision", lines, "{}");
         return statusOf(answerOf([&](HttpCallback&& reply) { api.decision(req, std::move(reply)); }));
       },
       accountDoor("400")},
      {"GET /v1/mcp-keys",
       [](const sync::HeaderOccurrences& lines) {
         Accounts accounts;
         FakeMcpKeyRepository keyRepo;
         McpKeyApi api{accounts.auth, std::make_shared<McpKeyService>(keyRepo, accounts.tokens, *accounts.clock)};
         const drogon::HttpRequestPtr req = received("GET", "/v1/mcp-keys", lines);
         return statusOf(answerOf([&](HttpCallback&& reply) { api.listKeys(req, std::move(reply)); }));
       },
       accountDoor("200")},
      {"POST /v1/feedback",
       [](const sync::HeaderOccurrences& lines) {
         Accounts accounts;
         auto rows = std::make_shared<FeedbackRows>();
         FeedbackApi api{rows, accounts.auth};
         const drogon::HttpRequestPtr req = received("POST", "/v1/feedback", lines, R"({"message":"The rule holds."})");
         return statusOf(answerOf([&](HttpCallback&& reply) { api.submit(req, std::move(reply)); })) + authorOf(rows->authors);
       },
       openDoor("202 from u1", "202 from anonymous")},
      {"POST /v1/events",
       [](const sync::HeaderOccurrences& lines) {
         Accounts accounts;
         auto batches = std::make_shared<EventBatches>();
         EventsApi api{batches, accounts.auth};
         const drogon::HttpRequestPtr req = received(
             "POST", "/v1/events", lines, R"({"sessionKey":"browser-abc","events":[{"name":"tree_opened","clientMs":1000}]})");
         return statusOf(answerOf([&](HttpCallback&& reply) { api.ingest(req, std::move(reply)); })) + authorOf(batches->authors);
       },
       openDoor("202 from u1", "202 from anonymous")},
      {"GET /v1/journal/pages",
       [](const sync::HeaderOccurrences& lines) {
         Accounts accounts;
         JournalApi api{std::make_shared<FakeJournalRepository>(), accounts.auth};
         const drogon::HttpRequestPtr req = received("GET", "/v1/journal/pages", lines);
         return statusOf(answerOf([&](HttpCallback&& reply) { api.listPages(req, std::move(reply)); }));
       },
       accountDoor("200")},
      {"GET /v1/gym/preferences",
       [](const sync::HeaderOccurrences& lines) {
         Accounts accounts;
         gym::fake::FakeGym gym;
         gym::PreferencesApi api{std::shared_ptr<gym::PreferencesRepository>(std::shared_ptr<void>{}, &gym.preferences), accounts.auth};
         const drogon::HttpRequestPtr req = received("GET", "/v1/gym/preferences", lines);
         return statusOf(answerOf([&](HttpCallback&& reply) { api.preferences(req, std::move(reply)); }));
       },
       accountDoor("200")},
      {"GET /v1/trees/{Ann's private roadmap}",
       [](const sync::HeaderOccurrences& lines) {
         Roadmaps roadmaps;
         const drogon::HttpRequestPtr req = received("GET", "/v1/trees/t_mine", lines);
         return statusOf(answerOf([&](HttpCallback&& reply) { roadmaps.api.getTree(req, std::move(reply), "t_mine"); }));
       },
       openDoor("200", "404")},
      {"POST /v1/trees/{id}/fork",
       [](const sync::HeaderOccurrences& lines) {
         Roadmaps roadmaps;
         const drogon::HttpRequestPtr req = received("POST", "/v1/trees/t_src/fork", lines, "{}");
         return statusOf(answerOf([&](HttpCallback&& reply) { roadmaps.api.forkTree(req, std::move(reply), "t_src"); }));
       },
       accountDoor("201")},
      {"GET /v1/sync/hello",
       [](const sync::HeaderOccurrences& lines) {
         Accounts accounts;
         sync::test::FakeWorld world;
         sync::Admission admission{world.catalog(), world.store(), world.feed, world.clock(), world.failures};
         sync::SyncApi api{sync::SyncDeps{
             .service = std::make_shared<sync::SyncService>(world.catalog(), world.store(), admission, *accounts.clock, nullptr, accounts.repo),
             .auth = accounts.auth,
             .workers = std::make_shared<WorkerPool>("caller-test", 1, 8),
             .clock = accounts.clock,
             .minSchema = 2,
             .epoch = "ep-1"}};
         const drogon::HttpRequestPtr req = received("GET", "/v1/sync/hello", lines);
         const drogon::HttpResponsePtr response = answerOf([&](HttpCallback&& reply) { api.hello(req, std::move(reply)); });
         return statusOf(response) + " as " + sync::jcs((*response->getJsonObject())["as"]);
       },
       {{Reading::ann, "200 as \"u1\""}, {Reading::anonymous, "200 as null"}, {Reading::refused, "401 as null"},
        {Reading::lapsed, "401 as null"}}},
  };
}

}

TEST(every_door_that_reads_a_session_reads_each_shape_of_credentials_as_the_sync_doors_do) {
  struct Shape {
    std::string name;
    sync::HeaderOccurrences lines;
    Reading reading;
  };
  const std::vector<Shape> shapes{
      {"no credential", {}, Reading::anonymous},
      {"Ann's cookie", {{"Cookie", "wm_session=s-ann"}}, Reading::ann},
      {"Ann's bearer", {{"Authorization", "Bearer s-ann"}}, Reading::ann},
      {"a lowercase bearer", {{"authorization", "bearer s-ann"}}, Reading::ann},
      {"an uppercase BEARER", {{"Authorization", "BEARER s-ann"}}, Reading::ann},
      {"Ann's cookie and bearer", {{"Cookie", "wm_session=s-ann"}, {"Authorization", "Bearer s-ann"}}, Reading::ann},
      {"Ann's cookie and her phone's bearer", {{"Authorization", "Bearer s-ann-phone"}, {"Cookie", "wm_session=s-ann"}}, Reading::ann},
      {"a bare wm_session", {{"Cookie", "theme=dark; wm_session"}}, Reading::refused},
      {"an empty bearer", {{"Authorization", "Bearer "}}, Reading::refused},
      {"Ann's cookie and Bob's bearer", {{"Cookie", "wm_session=s-ann"}, {"Authorization", "Bearer s-bob"}}, Reading::refused},
      {"cookies of Ann and Bob", {{"Cookie", "wm_session=s-ann; wm_session=s-bob"}}, Reading::refused},
      {"another scheme", {{"Authorization", "Basic s-ann"}}, Reading::refused},
      {"a lapsed cookie", {{"Cookie", "wm_session=s-gone"}}, Reading::lapsed},
      {"a lapsed bearer", {{"Authorization", "Bearer s-gone"}}, Reading::lapsed},
  };
  for (const Door& door : doors()) {
    std::string answered;
    std::string expected;
    for (const Shape& shape : shapes) {
      answered += shape.name + ": " + door.answer(shape.lines) + "\n";
      expected += shape.name + ": " + door.answers.at(shape.reading) + "\n";
    }
    if (answered != expected) std::cerr << door.name << " answered\n" << answered << "where the rule answers\n" << expected;
    CHECK_EQ(answered, expected);
  }
}
