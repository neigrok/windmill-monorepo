#include "platform/adapters/http/SyncApi.h"

#include "platform/adapters/http/CredentialTap.h"
#include "platform/application/OAuthService.h"
#include "platform/domain/sync/Jcs.h"
#include "test/platform/Fakes.h"
#include "test/platform/application/sync/SyncWorld.h"
#include "test/testing.h"

#include <future>
#include <memory>
#include <optional>
#include <string>
#include <string_view>

// SyncApi's gates, driven in-process over the fakes: the 503 it answers on the IO thread when the pool is
// full, §9.1's envelope in its order (the version, the credentials, the body's size, then its shape), the version
// as the one value its carrier presents, credentials sent that do not resolve answered 401 whatever their shape, a
// request no tap read answered 401, and a signed-in round trip whose body is JCS and says whom it was served as.

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
  FakeSessionRevocations revocations;
  std::shared_ptr<AuthService> auth = std::make_shared<AuthService>(authRepo, email, tokens, *clock, oauth, footprint, revocations, "https://windmill.works");
  sync::test::FakeWorld world;
  sync::Admission admission{world.catalog(), world.store(), world.feed, world.clock(), world.failures};
  std::shared_ptr<sync::SyncService> service = std::make_shared<sync::SyncService>(world.catalog(), world.store(), admission, *clock);

  sync::SyncApi api(std::size_t queueCeiling) {
    return sync::SyncApi(sync::SyncDeps{.service = service,
                                        .auth = auth,
                                        .workers = std::make_shared<WorkerPool>("sync-test", 1, queueCeiling),
                                        .clock = clock,
                                        .minSchema = 2,
                                        .epoch = "ep-1"});
  }

  // A session secret of a new account, whose id the fakes number u1, u2, …
  std::string signIn(const std::string& name) {
    const User user = authRepo.createUser(Email{name + "@example.com"}, name);
    authRepo.insertSession(tokens.digestOf("s-" + name), user.id, clock->now + 1'000'000, "", "", clock->now);
    return "s-" + name;
  }
};

// A request as a tapped connection hands it to a handler: `fields` read by the CredentialTap, every occurrence kept.
drogon::HttpRequestPtr request(drogon::HttpMethod method, const std::string& path, const std::string& body, const std::string& schema,
                               const sync::HeaderFields& fields = {}) {
  auto req = drogon::HttpRequest::newHttpRequest();
  req->setMethod(method);
  req->setPath(path);
  req->setBody(body);
  if (!schema.empty()) req->addHeader("sync-schema", schema);
  req->addHeader(kSentCredentialsField, sentCredentialsFieldOf(sync::sentCredentialsOf(fields)));
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
  const auto [status, body] = answer(&sync::SyncApi::hello, api, request(drogon::Get, "/v1/sync/hello", "", "2"));
  CHECK_EQ(status, 503);
  CHECK_EQ(body, std::string(R"({"epoch":"ep-1","error":"unavailable","retryAfterMs":1000,"serverTime":1700000000000})"));
}

TEST(sync_api_answers_the_envelope_in_section_9_1_s_order) {
  Harness harness;
  sync::SyncApi api = harness.api(8);
  const sync::HeaderFields ann{{"Cookie", "wm_session=" + harness.signIn("ann")}};
  const sync::HeaderFields nope{{"Cookie", "wm_session=nope"}};
  const std::string oversized(2'097'153, ' ');
  const std::pair<int, std::string> malformed{400, R"({"epoch":"ep-1","error":"malformed","serverTime":1700000000000})"};
  const std::pair<int, std::string> upgrade{426, R"({"epoch":"ep-1","error":"upgrade-required","serverTime":1700000000000})"};
  const std::pair<int, std::string> unauthenticated{401, R"({"as":null,"epoch":"ep-1","error":"unauthenticated","serverTime":1700000000000})"};
  CHECK_EQ(answer(&sync::SyncApi::hello, api, request(drogon::Get, "/v1/sync/hello", "", "")), malformed);
  CHECK_EQ(answer(&sync::SyncApi::hello, api, request(drogon::Get, "/v1/sync/hello", "", "1", nope)), upgrade);
  CHECK_EQ(answer(&sync::SyncApi::push, api, request(drogon::Post, "/v1/sync/push", oversized, "1")), upgrade);
  CHECK_EQ(answer(&sync::SyncApi::push, api, request(drogon::Post, "/v1/sync/push", oversized, "2")), unauthenticated);
  CHECK_EQ(answer(&sync::SyncApi::push, api, request(drogon::Post, "/v1/sync/push", oversized, "2", ann)),
           (std::pair<int, std::string>{413, R"({"as":"u1","epoch":"ep-1","error":"request-too-large","serverTime":1700000000000})"}));
  CHECK_EQ(answer(&sync::SyncApi::push, api, request(drogon::Post, "/v1/sync/push", "{\"replica\":", "2", ann)),
           (std::pair<int, std::string>{400, R"({"as":"u1","epoch":"ep-1","error":"malformed","serverTime":1700000000000})"}));
  CHECK_EQ(answer(&sync::SyncApi::pull, api, request(drogon::Post, "/v1/sync/pull", std::string(65'537, ' '), "1")), upgrade);
  CHECK_EQ(answer(&sync::SyncApi::pull, api, request(drogon::Post, "/v1/sync/pull", std::string(65'537, ' '), "2", nope)),
           unauthenticated);
  CHECK_EQ(answer(&sync::SyncApi::pull, api, request(drogon::Post, "/v1/sync/pull", std::string(65'537, ' '), "2")),
           (std::pair<int, std::string>{413, R"({"as":null,"epoch":"ep-1","error":"request-too-large","serverTime":1700000000000})"}));
  CHECK_EQ(answer(&sync::SyncApi::pull, api, request(drogon::Post, "/v1/sync/pull", std::string(65'536, ' '), "2")),
           (std::pair<int, std::string>{400, R"({"as":null,"epoch":"ep-1","error":"malformed","serverTime":1700000000000})"}));
  CHECK_EQ(answer(&sync::SyncApi::pull, api, request(drogon::Post, "/v1/sync/pull", "{\"scopes\":", "2", ann)),
           (std::pair<int, std::string>{400, R"({"as":"u1","epoch":"ep-1","error":"malformed","serverTime":1700000000000})"}));
}

TEST(sync_schema_refusal_serves_a_decimal_integer_at_or_above_min_schema_past_int64_included) {
  auto refusalOf = [](std::string_view version) {
    const std::optional<sync::SyncReply> refused = sync::schemaRefusal(version, 2, 1000, "ep-1");
    return refused ? std::to_string(refused->status) + " " + sync::jcs(refused->body) : std::string("served");
  };
  CHECK_EQ(refusalOf("2"), std::string("served"));
  CHECK_EQ(refusalOf("3"), std::string("served"));
  CHECK_EQ(refusalOf("99999999999999999999"), std::string("served"));
  CHECK_EQ(refusalOf("1"), std::string(R"(426 {"epoch":"ep-1","error":"upgrade-required","serverTime":1000})"));
  CHECK_EQ(refusalOf("-99999999999999999999"), std::string(R"(426 {"epoch":"ep-1","error":"upgrade-required","serverTime":1000})"));
  for (const std::string_view malformed : {"", "2.5", "two", " 2", "+2", "2,2"}) {
    CHECK_EQ(refusalOf(malformed), std::string(R"(400 {"epoch":"ep-1","error":"malformed","serverTime":1000})"));
  }
}

TEST(sync_api_answers_401_to_credentials_sent_that_do_not_resolve_whatever_their_shape_and_serves_none_sent_as_anonymous) {
  Harness harness;
  sync::SyncApi api = harness.api(8);
  const std::string ann = harness.signIn("ann");
  const std::string bob = harness.signIn("bob");
  const std::string revoked = harness.signIn("cat");
  harness.auth->signOut(revoked);
  auto hello = [&api](const sync::HeaderFields& fields) {
    return answer(&sync::SyncApi::hello, api, request(drogon::Get, "/v1/sync/hello", "", "2", fields));
  };
  auto pull = [&api](const sync::HeaderFields& fields) {
    return answer(&sync::SyncApi::pull, api, request(drogon::Post, "/v1/sync/pull", R"({"scopes":[{"scope":"self/probe","cursor":null}]})", "2", fields));
  };
  auto push = [&api](const sync::HeaderFields& fields) {
    return answer(&sync::SyncApi::push, api,
                  request(drogon::Post, "/v1/sync/push", R"({"replica":"rp_0000000000000000000000000000000a","account":"u1","ackThrough":0,"intents":[]})",
                          "2", fields));
  };
  const std::pair<int, std::string> unauthenticated{401, R"({"as":null,"epoch":"ep-1","error":"unauthenticated","serverTime":1700000000000})"};
  const std::vector<sync::HeaderFields> unresolved{
      {{"Cookie", "wm_session=" + revoked}},
      {{"Cookie", "wm_session=nope"}},
      {{"Cookie", "wm_session="}},
      {{"Cookie", "theme=dark; wm_session"}},
      {{"Cookie", "wm_session=\"" + ann + "\""}},
      {{"Cookie", "wm_session=" + ann + "; wm_session=" + ann}},
      {{"Cookie", "wm_session=" + ann}, {"Cookie", "wm_session=" + bob}},
      {{"Authorization", "Bearer " + revoked}},
      {{"Authorization", "Bearer "}},
      {{"Authorization", "Basic " + ann}},
      {{"Authorization", ann}},
      {{"Authorization", ""}},
      {{"Authorization", "Bearer " + ann}, {"Authorization", "Bearer " + ann}},
      {{"Cookie", "wm_session=" + ann}, {"Authorization", "Bearer " + bob}},
      {{"Cookie", "wm_session=" + ann}, {"Authorization", "Basic " + ann}},
      {{"Cookie", "wm_session=" + revoked}, {"Authorization", "Bearer " + ann}},
      {{"Cookie", "wm_session"}, {"Authorization", "Bearer " + ann}},
  };
  for (const sync::HeaderFields& fields : unresolved) {
    CHECK_EQ(hello(fields), unauthenticated);
    CHECK_EQ(pull(fields), unauthenticated);
    CHECK_EQ(push(fields), unauthenticated);
  }

  CHECK_EQ(hello({}), (std::pair<int, std::string>{200, R"({"as":null,"epoch":"ep-1","minSchema":2,"schema":2,"serverTime":1700000000000})"}));
  CHECK_EQ(pull({}), (std::pair<int, std::string>{200, R"({"as":null,"epoch":"ep-1","pages":[{"kind":"not-found","scope":"self/probe"}],"serverTime":1700000000000})"}));
  CHECK_EQ(push({}), unauthenticated);
  CHECK_EQ(hello({{"Cookie", "theme=dark"}}), hello({}));
  const std::pair<int, std::string> annHello{
      200, R"({"as":"u1","epoch":"ep-1","holdsRecords":{"probe":false},"minSchema":2,"schema":2,"serverTime":1700000000000})"};
  CHECK_EQ(hello({{"Cookie", "wm_session=" + ann}}), annHello);
  CHECK_EQ(hello({{"Authorization", "Bearer " + ann}}), annHello);
  CHECK_EQ(hello({{"authorization", "bEaReR " + ann}}), annHello);
  CHECK_EQ(hello({{"Cookie", "wm_session=" + ann}, {"Authorization", "Bearer " + ann}}), annHello);
}

TEST(sync_api_answers_401_to_a_request_no_credential_tap_read) {
  Harness harness;
  sync::SyncApi api = harness.api(8);
  const std::string ann = harness.signIn("ann");
  auto untapped = [&ann](drogon::HttpMethod method, const std::string& path, const std::string& body) {
    auto req = drogon::HttpRequest::newHttpRequest();
    req->setMethod(method);
    req->setPath(path);
    req->setBody(body);
    req->addHeader("sync-schema", "2");
    req->addCookie("wm_session", ann);
    return req;
  };
  const std::pair<int, std::string> unauthenticated{401, R"({"as":null,"epoch":"ep-1","error":"unauthenticated","serverTime":1700000000000})"};
  CHECK_EQ(answer(&sync::SyncApi::hello, api, untapped(drogon::Get, "/v1/sync/hello", "")), unauthenticated);
  CHECK_EQ(answer(&sync::SyncApi::pull, api, untapped(drogon::Post, "/v1/sync/pull", R"({"scopes":[]})")), unauthenticated);
  CHECK_EQ(answer(&sync::SyncApi::push, api, untapped(drogon::Post, "/v1/sync/push", "{}")), unauthenticated);
}

TEST(sync_api_admits_a_push_naming_the_account_it_is_served_as_and_answers_it_as_jcs) {
  Harness harness;
  sync::SyncApi api = harness.api(8);
  const sync::HeaderFields ann{{"Cookie", "wm_session=" + harness.signIn("ann")}};
  const sync::HeaderFields bob{{"Authorization", "Bearer " + harness.signIn("bob")}};
  const std::string push = R"({"replica":"rp_0000000000000000000000000000000a","account":"u1","ackThrough":0,"intents":[
    {"n":1,"scope":"self/probe","d":[{"t":"card","id":"card0001","born":"1000:0:r_a","life":["alive","1000:0:r_a"],"f":{"title":["One","1000:0:r_a"]}}]}]})";
  CHECK_EQ(answer(&sync::SyncApi::push, api, request(drogon::Post, "/v1/sync/push", push, "2", bob)),
           (std::pair<int, std::string>{409, R"({"as":"u2","epoch":"ep-1","error":"account-mismatch","serverTime":1700000000000})"}));
  CHECK_EQ(answer(&sync::SyncApi::push, api, request(drogon::Post, "/v1/sync/push", push, "2", ann)),
           (std::pair<int, std::string>{200, R"({"as":"u1","epoch":"ep-1","lastN":1,"results":[{"n":1,"s":"ok","seq":1}],"serverTime":1700000000000})"}));
  CHECK_EQ(answer(&sync::SyncApi::push, api, request(drogon::Post, "/v1/sync/push", push, "2")),
           (std::pair<int, std::string>{401, R"({"as":null,"epoch":"ep-1","error":"unauthenticated","serverTime":1700000000000})"}));
}
