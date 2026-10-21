#include "platform/adapters/http/AiAllowanceApi.h"
#include "test/DrogonLoopback.h"
#include "test/platform/Fakes.h"
#include "test/platform/FakeAiBudgetRepository.h"
#include "test/testing.h"
#include "platform/application/WriteObservation.h"

#include <stdexcept>

using namespace wm;
using namespace wm::fake;

namespace {
struct ReadFailures : FailureReporter {
  std::vector<std::string> reports;
  void report(const std::string& kind, const std::string& operation, const std::string& detail) override {
    reports.push_back(kind + "|" + operation + "|" + detail);
  }
  void reportWrite(const std::string& operation, const std::string& product, const std::string& door,
                   const std::string& outcome, const std::string&, const std::string&) override {
    reports.push_back(product + "|" + operation + "|" + door + "|" + outcome);
  }
};
}

TEST(ai_allowance_reads_fixed_point_account_month_and_refuses_ambiguous_credentials) {
  FakeAuthRepository accounts;
  FakeEmail email;
  FakeTokens tokens;
  FakeClock clock;
  clock.now = 1'792'281'600'000;
  FakeOAuthRepository oauthRepo;
  OAuthService oauth{oauthRepo, tokens, clock};
  FakeAccountFootprint footprint;
  FakeSessionRevocations revocations;
  auto auth = std::make_shared<AuthService>(accounts, email, tokens, clock, oauth, footprint,
                                           revocations, "https://windmill.works");
  const User user{UserId{"44444444-4444-4444-4444-444444444444"}, Email{"sam@example.com"}, "Sam", {}};
  accounts.usersById[user.id.str()] = user;
  accounts.usersByEmail[user.email.value] = user;
  accounts.insertSession(tokens.digestOf("s-good"), user.id, clock.now + 1'000'000, "", "", clock.now);
  FakeSubscriptionRepository subscriptions;
  FakeAiUsageRepository usage;
  FakeAiBudgetRepository repository;
  repository.totals.subject = {25'000'000, 50'000'000, 0};
  AiBudgetLimits limits;
  auto service = std::make_shared<AiBudgetService>(repository, [&] { return limits; }, [&] { return clock.now; });
  auto entitlements = std::make_shared<Entitlements>(subscriptions, usage, "", std::vector<std::string>{}, service);
  auto failures = std::make_shared<ReadFailures>();
  struct ReportScope {
    explicit ReportScope(const std::shared_ptr<ReadFailures>& reports) { installWriteReporter(reports); }
    ~ReportScope() { installWriteReporter(nullptr); }
  } scope{failures};
  AiAllowanceApi api{auth, entitlements, failures};
  wm::test::DrogonLoopback::Connection wire;
  for (const std::string header : {"", "Authorization: Bearer invalid\r\n",
      "Cookie: wm_session=s-good\r\nAuthorization: Bearer invalid\r\n",
      "Authorization: Bearer s-good\r\nAuthorization: Bearer s-good\r\n"}) {
    const auto exchange = wire.exchange("GET /v1/ai/allowance HTTP/1.1\r\nHost: localhost\r\n" + header + "\r\n");
    REQUIRE(exchange.request);
    drogon::HttpResponsePtr response;
    api.get(exchange.request, [&](const auto& result) { response = result; });
    REQUIRE(response);
    CHECK_EQ(response->getStatusCode(), drogon::k401Unauthorized);
    CHECK_EQ(response->getHeader("cache-control"), std::string{"no-store"});
  }
  CHECK_EQ(repository.reads, 0);
  const auto exchange = wire.exchange("GET /v1/ai/allowance HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer s-good\r\n\r\n");
  REQUIRE(exchange.request);
  drogon::HttpResponsePtr response;
  api.get(exchange.request, [&](const auto& result) { response = result; });
  REQUIRE(response);
  CHECK_EQ(response->getStatusCode(), drogon::k200OK);
  Json::Value expected;
  Json::Reader parser;
  REQUIRE(parser.parse(R"({"currency":"USD","period":"calendar_month_utc","tier":"logged_in","configured":true,"code":"ok","limit":"0.250000000","used":"0.025000000","reserved":"0.050000000","remaining":"0.175000000","resetsAtMs":1793491200000,"budgetResetsAtMs":null,"status":"available"})", expected));
  expected["resetsAtMs"] = Json::Int64{1'793'491'200'000};
  REQUIRE(response->getJsonObject());
  CHECK(*response->getJsonObject() == expected);
  CHECK_EQ(response->getHeader("cache-control"), std::string{"no-store"});
  subscriptions.subscribe(user.id);
  api.get(exchange.request, [&](const auto& result) { response = result; });
  auto unfunded = expected;
  unfunded["tier"] = "windmill_one";
  unfunded["period"] = "billing_period";
  unfunded["configured"] = false;
  unfunded["code"] = "funding_required";
  unfunded["limit"] = Json::Value();
  unfunded["used"] = "0.000000000";
  unfunded["reserved"] = "0.000000000";
  unfunded["remaining"] = "0.000000000";
  unfunded["resetsAtMs"] = Json::Value();
  unfunded["status"] = "unavailable";
  CHECK(*response->getJsonObject() == unfunded);
  repository.grants.emplace("paid-period", AiBudgetGrant{"paid-period", user.id.str(),
      AiBudgetFundingSource::Subscription, {static_cast<long long>(clock.now) - 1'000, static_cast<long long>(clock.now) + 2'000}, 7'000'000'000, "txn-paid"});
  api.get(exchange.request, [&](const auto& result) { response = result; });
  auto paid = expected;
  paid["tier"] = "windmill_one";
  paid["period"] = "billing_period";
  paid["limit"] = "7.000000000";
  paid["remaining"] = "6.925000000";
  paid["resetsAtMs"] = Json::Int64(clock.now + 2'000);
  CHECK(*response->getJsonObject() == paid);
  repository.failRead = true;
  api.get(exchange.request, [&](const auto& result) { response = result; });
  CHECK_EQ(response->getStatusCode(), drogon::k503ServiceUnavailable);
  CHECK(failures->reports == std::vector<std::string>{"platform|ai.budget.view|ai|failed"});
}
