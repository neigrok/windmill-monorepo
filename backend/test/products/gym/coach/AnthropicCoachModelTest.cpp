#include "products/gym/coach/AnthropicCoachModel.h"

#include "platform/adapters/json/JsonText.h"
#include "platform/application/Entitlements.h"
#include "platform/domain/AiUsage.h"
#include "test/platform/FakeAiBudgetRepository.h"
#include "test/platform/Fakes.h"
#include "test/platform/adapters/llm/LoopbackStream.h"
#include "test/testing.h"

#include <chrono>
#include <memory>
#include <string>

using namespace wm;
using namespace wm::gym::coach;

// A phone turn's stop ends the round the server is streaming: it settles at once at the input the vendor reported and
// the output that streamed, and never stays held as an ambiguous send.
TEST(a_stopped_phone_turn_settles_its_round_at_once_at_the_input_and_the_output_that_streamed) {
  test::LoopbackStream vendor{2'400, std::string(60, 'w'), 400, std::chrono::milliseconds(10)};
  fake::FakeAiBudgetRepository repository;
  auto budgets = std::make_shared<AiBudgetService>(repository, [] { return AiBudgetLimits{}; },
                                                  [] { return 1'792'000'000'000LL; });
  fake::FakeAuthRepository accounts;
  const auto lifter = accounts.createUser(Email{"phone@example.com"}, "Phone");
  fake::FakeSubscriptionRepository subscriptions;
  fake::FakeAiUsageRepository ledger;
  Entitlements entitlements{subscriptions, ledger, {}, {}, budgets};
  struct Failures : FailureReporter {
    int reports = 0;
    void report(const std::string&, const std::string&, const std::string&) override { ++reports; }
  };
  const auto failures = std::make_shared<Failures>();
  AnthropicCoachModel model{"PRIVATE_API_KEY", vendor.baseUrl(), failures, nullptr, nullptr,
                            std::make_shared<AiCallBudget>(budgets, entitlements, accounts, *failures)};
  TurnPrincipal principal;
  principal.seat = Seat::bound;
  principal.account = lifter;
  std::string streamed;
  std::string refusal;
  const auto round = model.open(principal, "turn-stopped", [&](const std::string& text) { streamed = text; },
                                [&] { return streamed.size() < 360; }, [&](const std::string& code) { refusal = code; });
  const auto reply = round(parse(R"({"model":"claude-opus-5","max_tokens":2000,
      "messages":[{"role":"user","content":"Plan my week."}]})"));
  REQUIRE(reply);
  CHECK_EQ((*reply)["stop_reason"].asString(), std::string("cancelled"));
  CHECK(refusal.empty());
  REQUIRE(streamed.size() >= 360);
  REQUIRE_EQ(repository.reservations.size(), 1u);
  const auto& held = repository.reservations.begin()->second;
  CHECK_EQ(held.state, AiBudgetState::Settled);
  const long long output = static_cast<long long>((streamed.size() + 2) / 3 + 3);
  CHECK_EQ((*reply)["usage"]["output_tokens"].asInt64(), output);
  const auto used = costNanos("claude-opus-5", TokenUse{2'400, output, 0, 0});
  REQUIRE(used);
  CHECK(*used < held.amountNanos);
  CHECK_EQ(held.actualNanos, used);
  CHECK_EQ(failures->reports, 0);
}
