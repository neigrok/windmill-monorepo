#include "products/gym/coach/TurnApi.h"

#include "platform/adapters/http/WriteRoutes.h"
#include "platform/application/OAuthService.h"
#include "test/DrogonLoopback.h"
#include "test/products/gym/coach/TurnFixture.h"

#include <chrono>
#include <functional>
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
  wm::fake::FakeAuthRepository accounts;
  wm::fake::FakeEmail email;
  wm::fake::FakeTokens authTokens;
  wm::fake::FakeOAuthRepository oauthRepo;
  OAuthService oauth{oauthRepo, authTokens, h.clock};
  wm::fake::FakeAccountFootprint footprint;
  wm::fake::FakeSessionRevocations revocations;
  std::shared_ptr<AuthService> auth = std::make_shared<AuthService>(accounts, email, authTokens, h.clock, oauth, footprint,
                                                                   revocations, "https://windmill.works");
  std::shared_ptr<Entitlements> entitlements = std::make_shared<Entitlements>(h.subscriptions, h.usage);
  std::shared_ptr<AiInstallationApi> installations = std::make_shared<AiInstallationApi>(
      h.installations, auth, entitlements, h.failures, AiInstallationProxy::Direct);
  TurnApi api{h.service, installations, h.failures};
  std::string credential;
  const UserId account{"44444444-4444-4444-4444-444444444444"};

  explicit ApiHarness(bool durableAllowances = false) : h(durableAllowances) {
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
  // The open as its write route runs it: the completion is taken on the worker, before the reply lands.
  drogon::HttpResponsePtr openObserved(const drogon::HttpRequestPtr& request) {
    beginWriteRequest(request, {"/v1/gym/coach/turns", "gym.coach.turn.open", "gym", "rest", {drogon::Post}});
    return settle([&](HttpCallback&& cb) {
      api.open(request, [request, cb = std::move(cb)](const drogon::HttpResponsePtr& response) {
        finishWriteRequest(request, response);
        cb(response);
      });
    });
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

// What the write observation says of a request: its completion lines and the Issues it files.
struct WriteWatch : FailureReporter {
  std::vector<std::string> outcomes;
  std::vector<std::string> issues;

  WriteWatch() {
    installWriteSink([this](const WriteCompletion& completion) {
      if (completion.operation == "gym.coach.turn.open") outcomes.push_back(completion.outcome);
    });
    installWriteReporter(std::shared_ptr<FailureReporter>(this, [](FailureReporter*) {}));
  }
  ~WriteWatch() {
    installWriteSink({});
    installWriteReporter({});
  }
  void report(const std::string& kind, const std::string& operation, const std::string&) override {
    issues.push_back(kind + " " + operation);
  }
};

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

// §6.3, §6.5: an allowance refusal before the stream answers 429 with the allowance that refused it,
// `budgetResetsAtMs` naming when that budget returns; its write line carries the code and it files no Issue.
TEST(gym_turn_route_answers_an_allowance_refusal_429_with_the_allowance_and_files_no_issue) {
  struct Case {
    std::string code;
    std::function<void(ApiHarness&)> arrange;
    Json::Value allowance;
  };
  const Json::Value monthEnd = Json::Int64(1'701'388'800'000);
  const Json::Value dayEnd = Json::Int64(1'700'006'400'000);
  Json::Value account = parse(R"({"configured":true,"currency":"USD","limit":"0.250000000","period":"calendar_month_utc",
      "remaining":"0.250000000","reserved":"0.000000000","tier":"logged_in","used":"0.000000000"})");
  account["resetsAtMs"] = monthEnd;
  const auto allowanceOf = [&](const char* code, const Json::Value& reset, const Json::Value& changes) {
    Json::Value allowance = account;
    allowance["code"] = code;
    allowance["budgetResetsAtMs"] = reset;
    for (const std::string& key : changes.getMemberNames()) allowance[key] = changes[key];
    return allowance;
  };
  const std::vector<Case> cases{
      {"subject_exhausted", [](ApiHarness& a) { a.h.budgetRepository.totals.subject.spentNanos = 250'000'000; },
       allowanceOf("subject_exhausted", monthEnd, parse(R"({"used":"0.250000000","remaining":"0.000000000"})"))},
      {"free_month_exhausted", [](ApiHarness& a) { a.h.budgetRepository.totals.freeMonth.spentNanos = a.h.limits.freeMonthlyNanos; },
       allowanceOf("free_month_exhausted", monthEnd, Json::Value(Json::objectValue))},
      {"free_day_exhausted", [](ApiHarness& a) { a.h.budgetRepository.totals.freeDay.spentNanos = a.h.limits.freeDailyNanos; },
       allowanceOf("free_day_exhausted", dayEnd, Json::Value(Json::objectValue))},
      {"concurrency_exhausted", [](ApiHarness& a) { a.h.budgetRepository.totals.concurrentCalls = 1; },
       allowanceOf("concurrency_exhausted", Json::Value(), Json::Value(Json::objectValue))},
      {"debt_outstanding", [](ApiHarness& a) { a.h.budgetRepository.totals.subject.debtNanos = 1; },
       allowanceOf("debt_outstanding", Json::Value(), Json::Value(Json::objectValue))},
      {"funding_required", [](ApiHarness& a) { a.h.subscriptions.subscribe(a.account); },
       allowanceOf("funding_required", Json::Value(), parse(R"({"configured":false,"limit":null,"period":"billing_period",
           "remaining":"0.000000000","resetsAtMs":null,"tier":"windmill_one"})"))}};
  for (const Case& refusal : cases) {
    WriteWatch watch;
    ApiHarness a(true);
    refusal.arrange(a);
    const drogon::HttpResponsePtr response = a.openObserved(ApiHarness::request("POST", "/v1/gym/coach/turns", openBody("tn_api_0000005"), {"Cookie: wm_session=s-live"}));
    CHECK_EQ(response->getStatusCode(), drogon::k429TooManyRequests);
    CHECK_EQ(response->getHeader("cache-control"), std::string("private, no-store"));
    Json::Value expected(Json::objectValue);
    expected["error"] = "Coach could not take this message.";
    expected["code"] = refusal.code;
    expected["allowance"] = refusal.allowance;
    CHECK_EQ(parse(std::string(response->getBody())), expected);
    CHECK(watch.outcomes == std::vector<std::string>{refusal.code});
    CHECK(watch.issues.empty());
    CHECK(a.h.failures->reports.empty());
  }
}

// A lifetime allowance has no reset: the seat's allowance says so with nulls, and the refusal invents none.
TEST(gym_turn_route_refuses_a_spent_lifetime_allowance_with_no_reset_moment) {
  WriteWatch watch;
  ApiHarness a;
  a.h.budgetRepository.totals.subject.spentNanos = a.h.limits.anonymousLifetimeNanos;
  const drogon::HttpResponsePtr response = a.openObserved(ApiHarness::request("POST", "/v1/gym/coach/turns", openBody("tn_api_0000006"), {"X-Windmill-Installation: " + a.credential}));
  CHECK_EQ(response->getStatusCode(), drogon::k429TooManyRequests);
  CHECK_EQ(parse(std::string(response->getBody())), parse(R"({"error":"Coach could not take this message.","code":"subject_exhausted","allowance":{
      "budgetResetsAtMs":null,"code":"subject_exhausted","configured":true,"currency":"USD","limit":"0.250000000","period":"lifetime",
      "remaining":"0.000000000","reserved":"0.000000000","resetsAtMs":null,"tier":"anonymous","used":"0.250000000"}})"));
  CHECK(watch.outcomes == std::vector<std::string>{"subject_exhausted"});
  CHECK(watch.issues.empty());
}

// A refusal no allowance was read for carries none: the legacy window has no USD contract to name,
// and `coach-busy` stays an expected 503. The accounting read failing is the one failure among them.
TEST(gym_turn_route_omits_the_allowance_where_none_was_read_and_only_accounting_failure_is_an_issue) {
  const std::string sentence = R"("error":"Coach could not take this message.")";
  {
    WriteWatch watch;
    ApiHarness a;
    a.h.usage.spentByProduct[""] = kFreeMonthlyAiNanos;
    const drogon::HttpResponsePtr response = a.openObserved(ApiHarness::request("POST", "/v1/gym/coach/turns", openBody("tn_api_0000007"), {"Cookie: wm_session=s-live"}));
    CHECK_EQ(response->getStatusCode(), drogon::k429TooManyRequests);
    CHECK_EQ(parse(std::string(response->getBody())), parse("{" + sentence + R"(,"code":"subject_exhausted"})"));
    CHECK(watch.outcomes == std::vector<std::string>{"subject_exhausted"});
    CHECK(watch.issues.empty());
  }
  {
    WriteWatch watch;
    ApiHarness a;
    a.h.model->wired = false;
    const drogon::HttpResponsePtr response = a.openObserved(ApiHarness::request("POST", "/v1/gym/coach/turns", openBody("tn_api_0000008"), {"Cookie: wm_session=s-live"}));
    CHECK_EQ(response->getStatusCode(), drogon::k503ServiceUnavailable);
    CHECK_EQ(parse(std::string(response->getBody())), parse("{" + sentence + R"(,"code":"coach-busy"})"));
    CHECK(watch.outcomes == std::vector<std::string>{"coach-busy"});
    CHECK(watch.issues.empty());
  }
  {
    WriteWatch watch;
    ApiHarness a(true);
    a.h.budgetRepository.failRead = true;
    const drogon::HttpResponsePtr response = a.openObserved(ApiHarness::request("POST", "/v1/gym/coach/turns", openBody("tn_api_0000009"), {"Cookie: wm_session=s-live"}));
    CHECK_EQ(response->getStatusCode(), drogon::k503ServiceUnavailable);
    CHECK_EQ(parse(std::string(response->getBody())), parse("{" + sentence + R"(,"code":"ai_accounting_unavailable"})"));
    CHECK(watch.outcomes == std::vector<std::string>{"failed"});
    CHECK(a.h.failures->reports == std::vector<std::string>{"gym:coach_turn.open:allowance unavailable"});
  }
}
