#include "platform/adapters/llm/AiCallBudget.h"
#include "platform/adapters/llm/AnthropicClient.h"
#include "platform/application/WriteObservation.h"
#include "test/platform/Fakes.h"
#include "test/platform/FakeAiBudgetRepository.h"
#include "test/testing.h"

#include <map>
#include <stdexcept>

using namespace wm;
using namespace wm::fake;

namespace {
struct Failures : FailureReporter {
  std::vector<std::string> reports;
  void report(const std::string& kind, const std::string& where, const std::string& detail) override {
    reports.push_back(kind + ":" + where + ":" + detail);
  }
};
}

TEST(ai_call_budget_prices_a_context_bound_and_refuses_unpriced_options) {
  Json::Value request;
  request["model"] = "claude-opus-5";
  request["max_tokens"] = 16'000;
  CHECK_EQ(anthropicReservationNanos(request), std::optional<long long>{6'650'000'000});
  request["model"] = "claude-sonnet-5";
  CHECK_EQ(anthropicReservationNanos(request), std::optional<long long>{2'660'000'000});
  request["system"][0]["cache_control"]["type"] = "ephemeral";
  request["system"][0]["cache_control"]["ttl"] = "1h";
  CHECK_FALSE(anthropicReservationNanos(request));
  request.removeMember("system");
  request["speed"] = "fast";
  CHECK_FALSE(anthropicReservationNanos(request));
  request.removeMember("speed");
  request["tools"][0]["type"] = "web_search_20250305";
  CHECK_FALSE(anthropicReservationNanos(request));
  request.removeMember("tools");
  request["model"] = "future-model";
  CHECK_FALSE(anthropicReservationNanos(request));
}

TEST(ai_call_budget_resolves_account_tier_and_never_dispatches_anonymous_or_exhausted_work) {
  FakeAiBudgetRepository repository;
  AiBudgetLimits limits;
  auto service = std::make_shared<AiBudgetService>(repository, [&] { return limits; }, [] { return 1'792'000'000'000LL; });
  FakeAuthRepository accounts;
  const auto user = accounts.createUser(Email{"owner@example.com"}, "Owner");
  FakeSubscriptionRepository subscriptions;
  FakeAiUsageRepository usage;
  Entitlements entitlements{subscriptions, usage, "owner@example.com", {}, service};
  Failures failures;
  auto budget = std::make_shared<AiCallBudget>(service, entitlements, accounts, failures);
  AiSpend spend;
  spend.model = "claude-sonnet-5";
  spend.product = "gym";
  spend.operation = "ask";
  Json::Value request;
  request["model"] = spend.model;
  request["max_tokens"] = 16'000;
  CHECK_EQ(budget->begin(spend, request).refusal, std::string{"device_verification_required"});
  CHECK(repository.reservations.empty());
  spend.user = user.id;
  const auto admission = budget->begin(spend, request);
  REQUIRE(admission.reservation);
  const auto& row = repository.reservations.at(admission.reservation->id);
  CHECK(row.tier == AiBudgetTier::WindmillOne);
  CHECK(row.subject == (AiBudgetSubject{AiBudgetSubjectKind::Account, user.id.str()}));
  CHECK(row.state == AiBudgetState::Dispatched);
  int sends = 0;
  repository.totals.concurrentCalls = limits.paidConcurrency;
  std::string refusal;
  auto call = metered([&](const Json::Value&) -> std::optional<Json::Value> { ++sends; return Json::Value(); },
      spend, {}, {}, {}, {}, budget, [&](const std::string& code) { refusal = code; });
  CHECK_FALSE(call(request));
  CHECK_EQ(sends, 0);
  CHECK_EQ(refusal, std::string(aiBudgetCodeName(AiBudgetCode::ConcurrencyExhausted)));
  CHECK_EQ(repository.reservations.size(), 1u);
}

TEST(ai_call_budget_settles_complete_usage_and_keeps_missing_or_partial_usage_reserved) {
  FakeAiBudgetRepository repository;
  AiBudgetLimits limits;
  auto service = std::make_shared<AiBudgetService>(repository, [&] { return limits; }, [] { return 1'792'000'000'000LL; });
  FakeAuthRepository accounts;
  const auto user = accounts.createUser(Email{"sam@example.com"}, "Sam");
  FakeSubscriptionRepository subscriptions;
  FakeAiUsageRepository ledger;
  Entitlements entitlements{subscriptions, ledger, "sam@example.com"};
  Failures failures;
  auto budget = std::make_shared<AiCallBudget>(service, entitlements, accounts, failures);
  AiSpend spend;
  spend.user = user.id;
  spend.model = "claude-sonnet-5";
  Json::Value request;
  request["model"] = spend.model;
  request["max_tokens"] = 16'000;
  Json::Value usage;
  usage["input_tokens"] = 100;
  usage["output_tokens"] = 200;
  usage["cache_read_input_tokens"] = 300;
  usage["cache_creation_input_tokens"] = 400;
  const auto complete = budget->begin(spend, request);
  REQUIRE(complete.reservation);
  budget->finish(*complete.reservation, spend.model, usage, true);
  CHECK(repository.reservations.at(complete.reservation->id).state == AiBudgetState::Settled);
  CHECK_EQ(repository.reservations.at(complete.reservation->id).actualNanos, std::optional<long long>{3'260'000});
  for (const bool missing : {false, true}) {
    const auto incomplete = budget->begin(spend, request);
    REQUIRE(incomplete.reservation);
    budget->finish(*incomplete.reservation, spend.model, missing ? Json::Value() : usage, false);
    CHECK(repository.reservations.at(incomplete.reservation->id).state == AiBudgetState::Uncertain);
    CHECK_FALSE(repository.reservations.at(incomplete.reservation->id).actualNanos);
  }
  usage.removeMember("output_tokens");
  CHECK_FALSE(anthropicActualNanos(spend.model, usage));
  struct ReporterScope {
    std::shared_ptr<Failures> reporter = std::make_shared<Failures>();
    ReporterScope() { installWriteReporter(reporter); }
    ~ReporterScope() { installWriteReporter(nullptr); }
  } scope;
  repository.failReserve = true;
  int sends = 0;
  auto call = metered([&](const Json::Value&) -> std::optional<Json::Value> { ++sends; return {}; }, spend,
      {}, {}, {}, {}, budget);
  CHECK_FALSE(call(request));
  CHECK_EQ(sends, 0);
  CHECK_EQ(scope.reporter->reports.size(), 1u);
  for (const auto& report : scope.reporter->reports) CHECK_EQ(report.find("private"), std::string::npos);
}

TEST(ai_call_budget_only_terminal_provider_replies_have_complete_usage) {
  for (const std::string stop : {"end_turn", "max_tokens", "refusal", "tool_use", "unknown", ""}) {
    Json::Value body;
    body["stop_reason"] = stop;
    body["usage"]["input_tokens"] = 10;
    body["usage"]["output_tokens"] = 20;
    body["usage"]["cache_read_input_tokens"] = 0;
    body["usage"]["cache_creation_input_tokens"] = 0;
    body["content"][0]["type"] = "text";
    body["content"][0]["text"] = "{}";
    Json::StreamWriterBuilder writer;
    const auto reply = readMessagesReply(200, Json::writeString(writer, body));
    CHECK_EQ(reply.usageComplete, stop != "unknown" && !stop.empty());
    CHECK_EQ(reply.tokens.output, 20);
  }
}

TEST(ai_call_budget_keeps_unfunded_paid_and_small_free_allowances_closed_without_hiding_remaining_usd) {
  FakeAiBudgetRepository repository;
  auto service = std::make_shared<AiBudgetService>(repository, [] { return AiBudgetLimits{}; },
                                                   [] { return 1'792'000'000'000LL; });
  FakeAuthRepository accounts;
  const auto account = accounts.createUser(Email{"free@example.com"}, "Free");
  FakeSubscriptionRepository subscriptions;
  FakeAiUsageRepository usage;
  Entitlements entitlements{subscriptions, usage, {}, {}, service};
  Failures failures;
  AiCallBudget budget{service, entitlements, accounts, failures};
  AiSpend spend;
  spend.user = account.id;
  spend.model = "claude-sonnet-5";
  spend.operation = "echo.segment";
  Json::Value request;
  request["model"] = spend.model;
  request["max_tokens"] = 16'000;
  CHECK_EQ(budget.begin(spend, request).refusal, std::string{"subject_exhausted"});
  CHECK_EQ(entitlements.aiAllowanceView(account.id, account.email.value).remainingNanos, 250'000'000);
  CHECK(repository.reservations.empty());
  subscriptions.subscribe(account.id);
  CHECK_EQ(budget.begin(spend, request).refusal, std::string{"funding_required"});
  CHECK(repository.reservations.empty());
  CHECK(failures.reports.empty());
}
