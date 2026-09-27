#include "platform/adapters/http/SyncApi.h"

#include "platform/application/OAuthService.h"
#include "platform/domain/sync/Jcs.h"
#include "test/platform/Fakes.h"
#include "test/platform/application/sync/SyncWorld.h"
#include "test/testing.h"

#include <future>
#include <memory>
#include <string>

// SyncApi's gates, driven in-process over the fakes: the 503 it answers on the IO thread when the pool is
// full, the Sync-Schema check, the body size and shape, and a signed-in round trip whose body is JCS.

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
  std::shared_ptr<AuthService> auth = std::make_shared<AuthService>(authRepo, email, tokens, *clock, oauth, footprint, "https://windmill.works");
  sync::test::FakeWorld world;
  sync::Admission admission{world.catalog(), world.store(), world.feed, world.clock(), world.failures};
  std::shared_ptr<sync::SyncService> service = std::make_shared<sync::SyncService>(world.catalog(), world.store(), admission, *clock);

  sync::SyncApi api(std::size_t queueCeiling) {
    return sync::SyncApi(sync::SyncDeps{.service = service,
                                        .auth = auth,
                                        .workers = std::make_shared<WorkerPool>("sync-test", 1, queueCeiling),
                                        .clock = clock,
                                        .minSchema = 1,
                                        .epoch = "ep-1"});
  }

  std::string signIn() {
    const User user = authRepo.createUser(Email{"probe@example.com"}, "probe");
    authRepo.insertSession(tokens.digestOf("s-probe"), user.id, clock->now + 1'000'000, "", "", clock->now);
    return "s-probe";
  }
};

drogon::HttpRequestPtr request(drogon::HttpMethod method, const std::string& path, const std::string& body, const std::string& schema,
                               const std::string& session = "") {
  auto req = drogon::HttpRequest::newHttpRequest();
  req->setMethod(method);
  req->setPath(path);
  req->setBody(body);
  if (!schema.empty()) req->addHeader("sync-schema", schema);
  if (!session.empty()) req->addCookie("wm_session", session);
  return req;
}

// The status and the exact body text a handler answers, wherever the pool runs it.
std::pair<int, std::string> answer(void (sync::SyncApi::*handler)(const drogon::HttpRequestPtr&, sync::SyncApi::Reply&&), sync::SyncApi& api,
                                   const drogon::HttpRequestPtr& req) {
  std::promise<std::pair<int, std::string>> replied;
  (api.*handler)(req, [&replied](const drogon::HttpResponsePtr& response) {
    replied.set_value({static_cast<int>(response->statusCode()), std::string(response->body())});
  });
  return replied.get_future().get();
}

}

TEST(sync_api_answers_503_with_a_wait_when_the_pool_takes_no_more_work) {
  Harness harness;
  sync::SyncApi api = harness.api(0);
  const auto [status, body] = answer(&sync::SyncApi::hello, api, request(drogon::Get, "/v1/sync/hello", "", "1"));
  CHECK_EQ(status, 503);
  CHECK_EQ(body, std::string(R"({"epoch":"ep-1","error":"unavailable","retryAfterMs":1000,"serverTime":1700000000000})"));
}

TEST(sync_api_refuses_a_missing_or_old_sync_schema_and_a_body_it_cannot_take) {
  Harness harness;
  sync::SyncApi api = harness.api(8);
  const std::string session = harness.signIn();
  CHECK_EQ(answer(&sync::SyncApi::hello, api, request(drogon::Get, "/v1/sync/hello", "", "")),
           (std::pair<int, std::string>{400, R"({"epoch":"ep-1","error":"malformed","serverTime":1700000000000})"}));
  CHECK_EQ(answer(&sync::SyncApi::hello, api, request(drogon::Get, "/v1/sync/hello", "", "0")),
           (std::pair<int, std::string>{426, R"({"epoch":"ep-1","error":"upgrade-required","serverTime":1700000000000})"}));
  CHECK_EQ(answer(&sync::SyncApi::push, api, request(drogon::Post, "/v1/sync/push", "{\"replica\":", "1", session)),
           (std::pair<int, std::string>{400, R"({"epoch":"ep-1","error":"malformed","serverTime":1700000000000})"}));
  CHECK_EQ(answer(&sync::SyncApi::push, api, request(drogon::Post, "/v1/sync/push", std::string(2'097'153, ' '), "1", session)),
           (std::pair<int, std::string>{413, R"({"epoch":"ep-1","error":"request-too-large","serverTime":1700000000000})"}));
}

TEST(sync_api_admits_a_signed_in_push_and_answers_it_as_jcs) {
  Harness harness;
  sync::SyncApi api = harness.api(8);
  const std::string session = harness.signIn();
  const std::string push = R"({"replica":"rp_0000000000000000000000000000000a","ackThrough":0,"intents":[
    {"n":1,"scope":"self/probe","d":[{"t":"card","id":"card0001","born":"1000:0:r_a","life":["alive","1000:0:r_a"],"f":{"title":["One","1000:0:r_a"]}}]}]})";
  CHECK_EQ(answer(&sync::SyncApi::push, api, request(drogon::Post, "/v1/sync/push", push, "1", session)),
           (std::pair<int, std::string>{200, R"({"epoch":"ep-1","lastN":1,"results":[{"n":1,"s":"ok","seq":1}],"serverTime":1700000000000})"}));
  CHECK_EQ(answer(&sync::SyncApi::push, api, request(drogon::Post, "/v1/sync/push", push, "1")),
           (std::pair<int, std::string>{401, R"({"epoch":"ep-1","error":"unauthenticated","serverTime":1700000000000})"}));
}
