#include "platform/adapters/http/SyncApi.h"

#include "platform/application/OAuthService.h"
#include "platform/domain/sync/Jcs.h"
#include "test/platform/Fakes.h"
#include "test/platform/application/sync/SyncWorld.h"
#include "test/testing.h"

#include <future>
#include <optional>
#include <vector>
#include <memory>
#include <string>

// SyncApi's gates, driven in-process over the fakes: the 503 it answers on the IO thread when the pool is
// full, §9.1's envelope in its order (the version, the principal, the body's size, then its shape), the live
// upgrade's version carrier, and a signed-in round trip whose body is JCS.

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

TEST(sync_api_answers_the_envelope_in_section_9_1_s_order) {
  Harness harness;
  sync::SyncApi api = harness.api(8);
  const std::string session = harness.signIn();
  const std::string oversized(2'097'153, ' ');
  const std::pair<int, std::string> malformed{400, R"({"epoch":"ep-1","error":"malformed","serverTime":1700000000000})"};
  const std::pair<int, std::string> tooLarge{413, R"({"epoch":"ep-1","error":"request-too-large","serverTime":1700000000000})"};
  CHECK_EQ(answer(&sync::SyncApi::hello, api, request(drogon::Get, "/v1/sync/hello", "", "")), malformed);
  CHECK_EQ(answer(&sync::SyncApi::hello, api, request(drogon::Get, "/v1/sync/hello", "", "0")),
           (std::pair<int, std::string>{426, R"({"epoch":"ep-1","error":"upgrade-required","serverTime":1700000000000})"}));
  CHECK_EQ(answer(&sync::SyncApi::push, api, request(drogon::Post, "/v1/sync/push", oversized, "0")),
           (std::pair<int, std::string>{426, R"({"epoch":"ep-1","error":"upgrade-required","serverTime":1700000000000})"}));
  CHECK_EQ(answer(&sync::SyncApi::push, api, request(drogon::Post, "/v1/sync/push", oversized, "1")),
           (std::pair<int, std::string>{401, R"({"epoch":"ep-1","error":"unauthenticated","serverTime":1700000000000})"}));
  CHECK_EQ(answer(&sync::SyncApi::push, api, request(drogon::Post, "/v1/sync/push", oversized, "1", session)), tooLarge);
  CHECK_EQ(answer(&sync::SyncApi::push, api, request(drogon::Post, "/v1/sync/push", "{\"replica\":", "1", session)), malformed);
  CHECK_EQ(answer(&sync::SyncApi::pull, api, request(drogon::Post, "/v1/sync/pull", "{\"scopes\":", "1", session)), malformed);
}

TEST(sync_schema_refusal_serves_one_decimal_integer_at_or_above_min_schema_past_int64_included) {
  auto refusalOf = [](const std::vector<std::string>& versions) {
    const std::optional<sync::SyncReply> refused = sync::schemaRefusal(versions, 2, 1000, "ep-1");
    return refused ? refused->body["error"].asString() : std::string("served");
  };
  CHECK_EQ(refusalOf({"2"}), std::string("served"));
  CHECK_EQ(refusalOf({"3"}), std::string("served"));
  CHECK_EQ(refusalOf({"99999999999999999999"}), std::string("served"));
  CHECK_EQ(refusalOf({"1"}), std::string("upgrade-required"));
  CHECK_EQ(refusalOf({"-99999999999999999999"}), std::string("upgrade-required"));
  CHECK_EQ(refusalOf({}), std::string("malformed"));
  CHECK_EQ(refusalOf({"2", "2"}), std::string("malformed"));
  CHECK_EQ(refusalOf({""}), std::string("malformed"));
  CHECK_EQ(refusalOf({"2.5"}), std::string("malformed"));
  CHECK_EQ(refusalOf({"two"}), std::string("malformed"));
  CHECK_EQ(refusalOf({" 2"}), std::string("malformed"));
  CHECK_EQ(refusalOf({"+2"}), std::string("malformed"));
}

TEST(the_live_upgrade_carries_its_version_as_every_schema_query_parameter_percent_decoded) {
  using Versions = std::vector<std::string>;
  CHECK_EQ(sync::schemaParameters("schema=2"), (Versions{"2"}));
  CHECK_EQ(sync::schemaParameters("token=x&schema=2&schema=3"), (Versions{"2", "3"}));
  CHECK_EQ(sync::schemaParameters("sch%65ma=%32"), (Versions{"2"}));
  CHECK_EQ(sync::schemaParameters("schema&schemas=2&xschema=2"), (Versions{""}));
  CHECK_EQ(sync::schemaParameters(""), (Versions{}));
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
