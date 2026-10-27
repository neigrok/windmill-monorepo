#include "products/gym/coach/TurnApi.h"

#include "platform/application/OAuthService.h"
#include "test/DrogonLoopback.h"
#include "test/products/gym/coach/TurnFixture.h"

#include <chrono>
#include <future>
#include <memory>
#include <string>
#include <thread>
#include <utility>
#include <vector>

using namespace wm;
using namespace wm::gym;
using namespace wm::gym::coach;
using namespace wm::gym::coachtest;

// The four turn routes over the real service and the scripted model, each request parsed by
// Drogon off the wire: who may open which seat, what a refusal looks like before the stream, and
// the SSE body a closing connection reads whole.

namespace {

struct ApiHarness {
  Harness h;
  fake::FakeAuthRepository accounts;
  fake::FakeEmail email;
  fake::FakeTokens authTokens;
  fake::FakeOAuthRepository oauthRepo;
  OAuthService oauth{oauthRepo, authTokens, h.clock};
  fake::FakeAccountFootprint footprint;
  fake::FakeSessionRevocations revocations;
  std::shared_ptr<AuthService> auth = std::make_shared<AuthService>(accounts, email, authTokens, h.clock, oauth, footprint,
                                                                   revocations, "https://windmill.works");
  std::shared_ptr<Entitlements> entitlements = std::make_shared<Entitlements>(h.subscriptions, h.usage);
  std::shared_ptr<AiInstallationApi> installations = std::make_shared<AiInstallationApi>(
      h.installations, auth, entitlements, h.failures, AiInstallationProxy::Direct);
  TurnApi api{h.service, installations, h.failures};
  std::string credential;
  const UserId account{"44444444-4444-4444-4444-444444444444"};

  ApiHarness() {
    const User user{account, Email{"lifter@example.test"}, "Lifter", {}};
    accounts.usersById[account.str()] = user;
    accounts.insertSession(authTokens.digestOf("s-live"), account, h.clock.now + 1'000'000, "", "", h.clock.now);
    credential = h.installations->issue("127.0.0.1").credential;
  }

  ~ApiHarness() {
    h.service->stop();
    api.shutdown();
  }

  TurnPrincipal anonymous() {
    TurnPrincipal principal;
    principal.seat = Seat::anon;
    principal.installation = h.installations->authenticate(credential);
    principal.address = "127.0.0.1";
    return principal;
  }

  // A request as Drogon parses it off the wire, so its header lines and peer are real.
  static drogon::HttpRequestPtr request(const std::string& method, const std::string& path, const Json::Value& body,
                                        const std::vector<std::string>& headers) {
    const std::string raw = body.isNull() ? std::string() : dump(body);
    std::string text = method + " " + path + " HTTP/1.1\r\nHost: localhost\r\n";
    for (const std::string& header : headers) text += header + "\r\n";
    if (!raw.empty()) text += "Content-Type: application/json\r\nContent-Length: " + std::to_string(raw.size()) + "\r\n";
    text += "\r\n" + raw;
    test::DrogonLoopback::Connection wire;
    const auto parsed = wire.exchange(text).request;
    if (!parsed) throw std::runtime_error("the test request was not parsed");
    return parsed;
  }

  template <typename Call>
  drogon::HttpResponsePtr settle(Call call) {
    auto settled = std::make_shared<std::promise<drogon::HttpResponsePtr>>();
    std::future<drogon::HttpResponsePtr> reply = settled->get_future();
    call([settled](const drogon::HttpResponsePtr& response) { settled->set_value(response); });
    if (reply.wait_for(std::chrono::seconds(5)) != std::future_status::ready) throw std::runtime_error("the route never answered");
    return reply.get();
  }

  drogon::HttpResponsePtr open(const drogon::HttpRequestPtr& request) {
    return settle([&](HttpCallback&& cb) { api.open(request, std::move(cb)); });
  }
  drogon::HttpResponsePtr results(const drogon::HttpRequestPtr& request, const std::string& turnId) {
    return settle([&](HttpCallback&& cb) { api.results(request, std::move(cb), turnId); });
  }
  drogon::HttpResponsePtr stop(const drogon::HttpRequestPtr& request, const std::string& turnId) {
    return settle([&](HttpCallback&& cb) { api.stop(request, std::move(cb), turnId); });
  }
  drogon::HttpResponsePtr resume(const drogon::HttpRequestPtr& request, const std::string& turnId) {
    return settle([&](HttpCallback&& cb) { api.resume(request, std::move(cb), turnId); });
  }
};

Json::Value openBody(const char* turnId) {
  Json::Value body = parse(R"({"catalog":"catalog/1","turnId":"","question":"How is my squat?","history":[],"context":[],"pictures":[]})");
  body["turnId"] = turnId;
  return body;
}

std::string refusalOf(const drogon::HttpResponsePtr& response) {
  const Json::Value body = parse(std::string(response->getBody()));
  return std::to_string(static_cast<int>(response->getStatusCode())) + " " + body["code"].asString() + " | " + body["error"].asString();
}

// The frames of an SSE body, each `done` without its environment-dependent allowance.
Json::Value framesOf(const std::string& body) {
  Json::Value frames(Json::arrayValue);
  std::size_t at = 0;
  while (at < body.size()) {
    const std::size_t end = body.find("\n\n", at);
    if (end == std::string::npos) throw std::runtime_error("an unterminated SSE frame");
    const std::string block = body.substr(at, end - at);
    at = end + 2;
    const std::size_t data = block.find("\ndata: ");
    if (block.rfind("event: ", 0) != 0 || data == std::string::npos) throw std::runtime_error("a frame out of shape: " + block);
    Json::Value frame(Json::objectValue);
    frame["event"] = block.substr(7, data - 7);
    frame["data"] = parse(block.substr(data + 7));
    frames.append(withoutAllowance(frame));
  }
  return frames;
}

}  // namespace

TEST(gym_turn_routes_refuse_before_the_stream_with_a_status_and_a_code) {
  ApiHarness a;
  const std::string sentence = " | Coach could not take this message.";
  CHECK_EQ(refusalOf(a.open(ApiHarness::request("POST", "/v1/gym/coach/turns", openBody("tn_api_0000001"), {}))),
           "401 unauthenticated" + sentence);
  CHECK_EQ(refusalOf(a.open(ApiHarness::request("POST", "/v1/gym/coach/turns", openBody("tn_api_0000001"), {"Cookie: wm_session=s-nobody"}))),
           "401 unauthenticated" + sentence);
  CHECK_EQ(refusalOf(a.open(ApiHarness::request("POST", "/v1/gym/coach/turns", openBody("tn_api_0000001"), {"X-Windmill-Installation: not-a-credential"}))),
           "401 invalid_installation" + sentence);
  Json::Value retired = openBody("tn_api_0000001");
  retired["catalog"] = "catalog/0";
  CHECK_EQ(refusalOf(a.open(ApiHarness::request("POST", "/v1/gym/coach/turns", retired, {"X-Windmill-Installation: " + a.credential}))),
           "426 coach-update-required" + sentence);
  Json::Value malformed = openBody("tn_api_0000001");
  malformed["question"] = 7;
  CHECK_EQ(refusalOf(a.open(ApiHarness::request("POST", "/v1/gym/coach/turns", malformed, {"Cookie: wm_session=s-live"}))),
           "400 coach-bad-request" + sentence);
  CHECK_EQ(refusalOf(a.results(ApiHarness::request("POST", "/v1/gym/coach/turns/tn_api_0000009/results", parse(R"({"batch":1,"results":[]})"),
                                                   {"Cookie: wm_session=s-live"}), "tn_api_0000009")),
           "404 coach-turn-unknown" + sentence);
  CHECK_EQ(refusalOf(a.stop(ApiHarness::request("POST", "/v1/gym/coach/turns/tn_api_0000009/stop", parse("{}"), {"Cookie: wm_session=s-live"}), "tn_api_0000009")),
           "404 coach-turn-unknown" + sentence);
  CHECK_EQ(refusalOf(a.resume(ApiHarness::request("GET", "/v1/gym/coach/turns/tn_api_0000009", Json::Value(), {"X-Windmill-Installation: " + a.credential}), "tn_api_0000009")),
           "404 coach-turn-unknown" + sentence);
}

TEST(gym_turn_route_binds_a_session_and_a_bound_installation_must_sign_in) {
  ApiHarness a;
  a.h.model->replies = parse(R"([{"stop_reason":"end_turn","content":[{"type":"text","text":"Moving well."}]}])");
  a.h.model->start();
  const drogon::HttpResponsePtr response = a.open(ApiHarness::request("POST", "/v1/gym/coach/turns", openBody("tn_api_0000002"),
                                                                      {"Cookie: wm_session=s-live", "Connection: close"}));
  CHECK_EQ(response->getStatusCode(), drogon::k200OK);
  CHECK_EQ(response->contentTypeString(), std::string("text/event-stream"));
  CHECK_EQ(framesOf(std::string(response->getBody())),
           parse(R"([{"event":"text","data":{"delta":"Moving well."}},{"event":"done","data":{"state":"completed"}}])"));
  const std::shared_ptr<Turn> turn = a.h.service->find(a.h.bound(), "tn_api_0000002");
  REQUIRE(turn);
  CHECK(turn->principal().seat == Seat::bound);

  CHECK(a.h.installations->bind(*a.h.installations->authenticate(a.credential), a.account) == AiBudgetCode::Ok);
  CHECK_EQ(refusalOf(a.open(ApiHarness::request("POST", "/v1/gym/coach/turns", openBody("tn_api_0000003"), {"X-Windmill-Installation: " + a.credential}))),
           std::string("409 device_bound | Coach could not take this message."));
}

TEST(gym_turn_route_opens_an_anonymous_seat_and_answers_results_and_stop_in_order) {
  ApiHarness a;
  a.h.model->replies = parse(R"([{"stop_reason":"tool_use","content":[{"type":"tool_use","id":"toolu_1","name":"list_routines","input":{}}]},
                                 {"stop_reason":"end_turn","content":[{"type":"text","text":"None yet."}]}])");
  a.h.model->start();
  const std::string installation = "X-Windmill-Installation: " + a.credential;
  auto settled = std::make_shared<std::promise<drogon::HttpResponsePtr>>();
  std::future<drogon::HttpResponsePtr> streamed = settled->get_future();
  a.api.open(ApiHarness::request("POST", "/v1/gym/coach/turns", openBody("tn_api_0000004"), {installation, "Connection: close"}),
             [settled](const drogon::HttpResponsePtr& response) { settled->set_value(response); });

  std::shared_ptr<Turn> turn;
  for (int attempt = 0; !turn && attempt < 300; ++attempt) {
    turn = a.h.service->find(a.anonymous(), "tn_api_0000004");
    if (!turn) std::this_thread::sleep_for(std::chrono::milliseconds(10));
  }
  REQUIRE(turn);
  CHECK(turn->principal().seat == Seat::anon);

  const std::string sentence = " | Coach could not take this message.";
  const auto post = [&](const char* body) {
    return ApiHarness::request("POST", "/v1/gym/coach/turns/tn_api_0000004/results", parse(body), {installation});
  };
  CHECK_EQ(refusalOf(a.results(post(R"({"batch":2,"results":[{"callId":"toolu_1","ok":true,"result":{}}]})"), "tn_api_0000004")),
           "409 coach-turn-order" + sentence);
  CHECK_EQ(refusalOf(a.results(post(R"({"batch":1,"results":[{"callId":"toolu_1","ok":true}]})"), "tn_api_0000004")),
           "400 coach-bad-request" + sentence);
  const drogon::HttpResponsePtr accepted = a.results(post(R"({"batch":1,"results":[{"callId":"toolu_1","ok":true,"result":{"routines":[]}}]})"), "tn_api_0000004");
  CHECK_EQ(accepted->getStatusCode(), drogon::k200OK);
  CHECK_EQ(std::string(accepted->getBody()), std::string("{\"batch\":1}"));
  const drogon::HttpResponsePtr replay = a.results(post(R"({"batch":1,"results":[{"callId":"toolu_1","ok":true,"result":{"routines":[]}}]})"), "tn_api_0000004");
  CHECK_EQ(replay->getStatusCode(), drogon::k204NoContent);

  REQUIRE(streamed.wait_for(std::chrono::seconds(5)) == std::future_status::ready);
  CHECK_EQ(framesOf(std::string(streamed.get()->getBody())),
           parse(R"([{"event":"calls","data":{"batch":1,"calls":[{"callId":"toolu_1","input":{},"name":"list_routines"}]}},
                     {"event":"text","data":{"delta":"None yet."}},
                     {"event":"done","data":{"state":"completed"}}])"));

  const drogon::HttpResponsePtr stopped = a.stop(ApiHarness::request("POST", "/v1/gym/coach/turns/tn_api_0000004/stop", parse("{}"), {installation}), "tn_api_0000004");
  CHECK_EQ(stopped->getStatusCode(), drogon::k202Accepted);
  CHECK_EQ(std::string(stopped->getBody()), std::string("{\"state\":\"completed\"}"));
  CHECK_EQ(refusalOf(a.stop(ApiHarness::request("POST", "/v1/gym/coach/turns/tn_api_0000004/stop", parse("{}"), {"Cookie: wm_session=s-live"}), "tn_api_0000004")),
           "404 coach-turn-unknown" + sentence);

  const drogon::HttpResponsePtr resumed = a.resume(ApiHarness::request("GET", "/v1/gym/coach/turns/tn_api_0000004", Json::Value(), {installation, "Connection: close"}), "tn_api_0000004");
  CHECK_EQ(framesOf(std::string(resumed->getBody())),
           parse(R"([{"event":"snapshot","data":{"text":"None yet.","state":"completed"}},{"event":"done","data":{"state":"completed"}}])"));
}
