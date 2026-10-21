#include "platform/domain/AiBudget.h"

#include "test/testing.h"

#include <chrono>
#include <limits>
#include <string>

using namespace wm;

TEST(ai_output_budget_validates_exact_integer_costs_and_overflow) {
  const AiOutputBudget offer{60'000'000, 25'000, 1'024, 2'000};
  CHECK(offer.valid());
  CHECK_EQ(offer.costNanos(1'024), 85'600'000);
  CHECK_EQ(offer.costNanos(2'000), 110'000'000);
  CHECK_EQ(offer.tokensFor(90'000'000), std::optional<int>{1'200});
  for (const auto amount : {85'599'999LL, 90'000'001LL, 110'000'001LL, -1LL}) CHECK_FALSE(offer.tokensFor(amount));
  for (const auto invalid : {AiOutputBudget{-1, 1, 1, 2}, AiOutputBudget{0, 0, 1, 2},
      AiOutputBudget{0, -1, 1, 2}, AiOutputBudget{0, 1, 0, 2}, AiOutputBudget{0, 1, 2, 1},
      AiOutputBudget{1, std::numeric_limits<long long>::max(), 1, 1},
      AiOutputBudget{0, std::numeric_limits<long long>::max() / 2 + 1, 1, 2}}) {
    CHECK_FALSE(invalid.valid());
    CHECK_EQ(invalid.costNanos(invalid.maxTokens), 0);
    CHECK_FALSE(invalid.tokensFor(0));
  }
  CHECK((AiOutputBudget{0, std::numeric_limits<long long>::max(), 1, 1}.valid()));
}

TEST(ai_output_budget_selects_largest_cap_from_each_limiting_free_balance) {
  const AiBudgetPrincipal principal{{AiBudgetSubjectKind::Account, "account"}, AiBudgetTier::LoggedIn};
  const AiOutputBudget offer{60'000'000, 25'000, 1'024, 2'000};
  const AiBudgetRequest request{"adaptive", principal, offer.costNanos(offer.maxTokens), 0, offer};
  const AiBudgetLimits limits;
  for (const int pool : {0, 1, 2}) {
    for (const long long available : {110'000'000LL, 100'024'999LL, 85'600'000LL, 85'599'999LL, 0LL}) {
      AiBudgetSnapshot snapshot;
      snapshot.period = *AiBudgetPeriod::at(0);
      if (pool == 0) snapshot.subject = {limits.loggedInMonthlyNanos - available - 1'000, 1'000};
      if (pool == 1) snapshot.freeMonth = {limits.freeMonthlyNanos - available - 1'000, 1'000};
      if (pool == 2) snapshot.freeDay = {limits.freeDailyNanos - available - 1'000, 1'000};
      const auto plan = planAiBudget(request, limits, snapshot);
      if (available < offer.costNanos(offer.minTokens)) {
        CHECK_EQ(plan.code, pool == 0 ? AiBudgetCode::SubjectExhausted :
            pool == 1 ? AiBudgetCode::FreeMonthExhausted : AiBudgetCode::FreeDayExhausted);
        CHECK_FALSE(plan.reservation);
        continue;
      }
      REQUIRE(plan.reservation);
      CHECK(plan.reservation->valid());
      CHECK_EQ(plan.code, AiBudgetCode::Ok);
      const int expected = static_cast<int>(std::min(2'000LL, (available - offer.inputNanos) / offer.outputTokenNanos));
      CHECK_EQ(plan.reservation->amountNanos, offer.costNanos(expected));
      CHECK_EQ(plan.reservation->outputBudget->tokensFor(plan.reservation->amountNanos), std::optional<int>{expected});
      CHECK_EQ(plan.reservation->outputBudget, std::optional<AiOutputBudget>{offer});
      CHECK(plan.reservation->sameRequest(request));
      auto changed = request;
      ++changed.outputBudget->minTokens;
      CHECK_FALSE(plan.reservation->sameRequest(changed));
      changed = request;
      changed.outputBudget.reset();
      changed.amountNanos = plan.reservation->amountNanos;
      CHECK_FALSE(plan.reservation->sameRequest(changed));
    }
  }
}

TEST(ai_output_budget_keeps_admission_guards_and_paid_funding_separate) {
  const AiBudgetLimits limits;
  const AiOutputBudget offer{60'000'000, 25'000, 1'024, 2'000};
  AiBudgetRequest request{"adaptive", {{AiBudgetSubjectKind::Account, "account"}, AiBudgetTier::LoggedIn},
      offer.costNanos(offer.maxTokens), 0, offer};
  AiBudgetSnapshot snapshot;
  snapshot.period = *AiBudgetPeriod::at(0);
  snapshot.subject.debtNanos = 1;
  CHECK_EQ(planAiBudget(request, limits, snapshot).code, AiBudgetCode::DebtOutstanding);
  snapshot.subject.debtNanos = 0;
  snapshot.freeDay.debtNanos = 1;
  CHECK_EQ(planAiBudget(request, limits, snapshot).code, AiBudgetCode::DebtOutstanding);
  snapshot.freeDay.debtNanos = 0;
  snapshot.concurrentCalls = limits.freeConcurrency;
  CHECK_EQ(planAiBudget(request, limits, snapshot).code, AiBudgetCode::ConcurrencyExhausted);
  request.principal.tier = AiBudgetTier::WindmillOne;
  CHECK_EQ(planAiBudget(request, limits, snapshot).code, AiBudgetCode::FundingRequired);
  snapshot.grant = AiBudgetGrant{"grant", "account", AiBudgetFundingSource::Owner, snapshot.period,
      90'000'000, "owner-period"};
  snapshot.freeDay = {limits.freeDailyNanos, 1, 1};
  snapshot.freeMonth = {limits.freeMonthlyNanos, 1, 1};
  const auto paid = planAiBudget(request, limits, snapshot);
  REQUIRE(paid.reservation);
  CHECK_EQ(paid.reservation->amountNanos, 90'000'000);
  CHECK_EQ(paid.reservation->outputBudget->tokensFor(paid.reservation->amountNanos), std::optional<int>{1'200});
  snapshot.concurrentCalls = limits.paidConcurrency;
  CHECK_EQ(planAiBudget(request, limits, snapshot).code, AiBudgetCode::ConcurrencyExhausted);
  request.principal = {{AiBudgetSubjectKind::Device, "device"}, AiBudgetTier::Anonymous};
  snapshot = {};
  snapshot.window = AiBudgetWindow::Lifetime;
  snapshot.deviceBound = true;
  CHECK_EQ(planAiBudget(request, limits, snapshot).code, AiBudgetCode::DeviceBound);
  request.outputBudget->inputNanos = std::numeric_limits<long long>::max();
  CHECK_EQ(planAiBudget(request, limits, snapshot).code, AiBudgetCode::Invalid);
}

TEST(ai_budget_usd_round_trips_without_losing_subcent_costs) {
  CHECK_EQ(parseAiUsd("10"), std::optional<long long>{10'000'000'000});
  CHECK_EQ(parseAiUsd("0.000000001"), std::optional<long long>{1});
  CHECK_EQ(parseAiUsd("123.123456789"), std::optional<long long>{123'123'456'789});
  CHECK_EQ(parseAiUsd("9223372036.854775807"), std::optional<long long>{std::numeric_limits<long long>::max()});
  CHECK_EQ(formatAiUsd(0), "0.000000000");
  CHECK_EQ(formatAiUsd(10'000'000'000), "10.000000000");
  CHECK_EQ(formatAiUsd(123'123'456'789), "123.123456789");
  CHECK_EQ(parseAiUsd(formatAiUsd(std::numeric_limits<long long>::max())),
           std::optional<long long>{std::numeric_limits<long long>::max()});
  for (const std::string text : {"", " 10", "10 ", "+1", "-1", "1e2", "NaN", "1.", ".1", "01", "1..2",
                                "0.0000000001", "9223372036.854775808", "9223372037", "999999999999999999999"}) {
    CHECK_FALSE(parseAiUsd(text));
  }
}

TEST(ai_budget_months_follow_utc_calendar_and_leap_years) {
  using namespace std::chrono;
  const long long february = duration_cast<milliseconds>(sys_days{2024y / February / 1}.time_since_epoch()).count();
  const long long march = duration_cast<milliseconds>(sys_days{2024y / March / 1}.time_since_epoch()).count();
  const long long april = duration_cast<milliseconds>(sys_days{2024y / April / 1}.time_since_epoch()).count();
  CHECK((AiBudgetPeriod::at(february) == AiBudgetPeriod{february, march}));
  CHECK((AiBudgetPeriod::at(march - 1) == AiBudgetPeriod{february, march}));
  CHECK((AiBudgetPeriod::at(march) == AiBudgetPeriod{march, april}));
  CHECK((AiBudgetPeriod::at(0) == AiBudgetPeriod{0, 2'678'400'000}));
  CHECK_FALSE(AiBudgetPeriod::at(-1));
  CHECK_FALSE(AiBudgetPeriod::at(std::numeric_limits<long long>::max()));
}

TEST(ai_budget_policy_has_exact_lifetime_free_and_funded_amounts) {
  const AiBudgetLimits limits;
  CHECK_EQ(limits.anonymousLifetimeNanos, 50'000'000);
  CHECK_EQ(limits.loggedInMonthlyNanos, 250'000'000);
  CHECK_EQ(limits.paidPeriodNanos, 7'000'000'000);
  CHECK_EQ(limits.freeMonthlyNanos, 100'000'000'000);
  CHECK_EQ(limits.freeDailyNanos, 5'000'000'000);
  CHECK_EQ(limits.freeConcurrency, 1);
  CHECK_EQ(limits.paidConcurrency, 2);
  CHECK(limits.valid());
  CHECK_EQ(AiBudgetPeriod::dayAt(86'400'001), (AiBudgetPeriod{86'400'000, 172'800'000}));
  CHECK(AiBudgetPeriod::lifetime().contains(0));
  CHECK(AiBudgetPeriod::lifetime().contains(2'678'400'000));
  CHECK_FALSE(AiBudgetPeriod::lifetime().contains(-1));
}

TEST(ai_budget_anonymous_allowance_is_lifetime_and_bound_devices_cannot_spend_again) {
  const AiBudgetPrincipal principal{{AiBudgetSubjectKind::Device, "device"}, AiBudgetTier::Anonymous};
  AiBudgetSnapshot snapshot;
  snapshot.window = AiBudgetWindow::Lifetime;
  snapshot.period = AiBudgetPeriod::lifetime();
  snapshot.subject = {40'000'000, 5'000'000, 0};
  const AiBudgetLimits limits;
  CHECK_EQ(admitAiBudget({"call", principal, 5'000'000, 0}, limits, snapshot), AiBudgetCode::Ok);
  CHECK_EQ(admitAiBudget({"call", principal, 5'000'001, 0}, limits, snapshot), AiBudgetCode::SubjectExhausted);
  const auto january = aiBudgetView(principal, 0, limits, snapshot);
  const auto february = aiBudgetView(principal, 2'678'400'000, limits, snapshot);
  CHECK_EQ(january, february);
  CHECK_EQ(january.window, AiBudgetWindow::Lifetime);
  CHECK_FALSE(january.resetsAtMs);
  CHECK_EQ(january.remainingNanos, 5'000'000);
  snapshot.deviceBound = true;
  CHECK_EQ(admitAiBudget({"call", principal, 1, 0}, limits, snapshot), AiBudgetCode::DeviceBound);
}

TEST(ai_budget_free_account_spend_and_holds_are_checked_with_both_shared_pools) {
  const AiBudgetPrincipal principal{{AiBudgetSubjectKind::Account, "account"}, AiBudgetTier::LoggedIn};
  AiBudgetSnapshot snapshot;
  snapshot.period = *AiBudgetPeriod::at(0);
  snapshot.subject = {200'000'000, 20'000'000};
  const AiBudgetLimits limits;
  CHECK_EQ(admitAiBudget({"call", principal, 30'000'000, 0}, limits, snapshot), AiBudgetCode::Ok);
  CHECK_EQ(admitAiBudget({"call", principal, 30'000'001, 0}, limits, snapshot), AiBudgetCode::SubjectExhausted);
  snapshot.freeDay = {4'990'000'000, 0};
  CHECK_EQ(admitAiBudget({"call", principal, 10'000'001, 0}, limits, snapshot), AiBudgetCode::FreeDayExhausted);
  snapshot.freeMonth = {99'995'000'000, 0};
  CHECK_EQ(admitAiBudget({"call", principal, 5'000'001, 0}, limits, snapshot), AiBudgetCode::FreeMonthExhausted);
  snapshot.freeDay = {5'000'000'000, 0};
  const auto day = aiBudgetView(principal, 0, limits, snapshot);
  CHECK_EQ(day.code, AiBudgetCode::FreeDayExhausted);
  CHECK_EQ(day.resetsAtMs, std::optional<long long>{2'678'400'000});
  CHECK_EQ(day.budgetResetsAtMs, std::optional<long long>{86'400'000});
  CHECK_EQ(day.remainingNanos, 30'000'000);
  snapshot.freeMonth.spentNanos = limits.freeMonthlyNanos;
  const auto month = aiBudgetView(principal, 0, limits, snapshot);
  CHECK_EQ(month.code, AiBudgetCode::FreeMonthExhausted);
  CHECK_EQ(month.budgetResetsAtMs, month.resetsAtMs);
}

TEST(ai_budget_request_that_cannot_fit_personal_allowance_does_not_blame_shared_pools) {
  const AiBudgetPrincipal principal{{AiBudgetSubjectKind::Account, "account"}, AiBudgetTier::LoggedIn};
  AiBudgetSnapshot snapshot;
  snapshot.period = *AiBudgetPeriod::at(0);
  const AiBudgetLimits limits;
  CHECK_EQ(admitAiBudget({"call", principal, 6'450'000'000, 0}, limits, snapshot), AiBudgetCode::SubjectExhausted);
  snapshot.freeDay.spentNanos = limits.freeDailyNanos;
  snapshot.freeMonth.spentNanos = limits.freeMonthlyNanos;
  CHECK_EQ(admitAiBudget({"call", principal, 6'450'000'000, 0}, limits, snapshot), AiBudgetCode::SubjectExhausted);
  CHECK_EQ(aiBudgetView(principal, 0, limits, snapshot).code, AiBudgetCode::FreeMonthExhausted);
  snapshot.freeMonth.spentNanos = 0;
  CHECK_EQ(aiBudgetView(principal, 0, limits, snapshot).code, AiBudgetCode::FreeDayExhausted);
}

TEST(ai_budget_subscription_funding_survives_calendar_rollover_and_never_draws_free_money) {
  const AiBudgetPrincipal principal{{AiBudgetSubjectKind::Account, "account"}, AiBudgetTier::WindmillOne};
  const AiBudgetLimits limits;
  const AiBudgetGrant grant{"grant", "account", AiBudgetFundingSource::Subscription,
                            {86'400'000, 3'024'000'000}, limits.paidPeriodNanos, "txn"};
  REQUIRE(grant.valid());
  AiBudgetSnapshot snapshot;
  snapshot.period = grant.period;
  snapshot.window = AiBudgetWindow::BillingPeriod;
  snapshot.grant = grant;
  snapshot.subject = {3'000'000'000, 1'000'000'000};
  snapshot.freeMonth = {limits.freeMonthlyNanos, 1, 5};
  snapshot.freeDay = {limits.freeDailyNanos, 1, 5};
  CHECK_EQ(admitAiBudget({"call", principal, 3'000'000'000, 2'678'400'000}, limits, snapshot), AiBudgetCode::Ok);
  const auto view = aiBudgetView(principal, 2'678'400'000, limits, snapshot);
  CHECK_EQ(view.remainingNanos, 3'000'000'000);
  CHECK_EQ(view.window, AiBudgetWindow::BillingPeriod);
  CHECK_EQ(view.resetsAtMs, std::optional<long long>{grant.period.endMs});
  CHECK_EQ(admitAiBudget({"call", principal, 1, grant.period.endMs}, limits, snapshot), AiBudgetCode::FundingRequired);
  snapshot.grant.reset();
  const auto absent = aiBudgetView(principal, 2'678'400'000, limits, snapshot);
  CHECK_EQ(absent.code, AiBudgetCode::FundingRequired);
  CHECK_FALSE(absent.configured);
  CHECK_FALSE(absent.limitNanos);
}

TEST(ai_budget_owner_funding_has_the_calendar_period_without_stacking_on_subscription_funding) {
  const AiBudgetPrincipal owner{{AiBudgetSubjectKind::Account, "owner"}, AiBudgetTier::WindmillOne, true};
  const AiBudgetLimits limits;
  AiBudgetSnapshot snapshot;
  snapshot.period = *AiBudgetPeriod::at(0);
  snapshot.grant = AiBudgetGrant{"grant", "owner", AiBudgetFundingSource::Owner,
                                  snapshot.period, limits.paidPeriodNanos, "owner-calendar"};
  CHECK_EQ(admitAiBudget({"call", owner, 1, 0}, limits, snapshot), AiBudgetCode::Ok);
  CHECK_EQ(aiBudgetView(owner, 0, limits, snapshot).window, AiBudgetWindow::CalendarMonth);
  snapshot.grant->source = AiBudgetFundingSource::Subscription;
  snapshot.window = AiBudgetWindow::BillingPeriod;
  CHECK_EQ(admitAiBudget({"call", owner, 1, 0}, limits, snapshot), AiBudgetCode::Ok);
  CHECK_EQ(aiBudgetView(owner, 0, limits, snapshot).limitNanos, std::optional<long long>{7'000'000'000});
  CHECK_FALSE((AiBudgetPrincipal{{AiBudgetSubjectKind::Account, "owner"}, AiBudgetTier::LoggedIn, true}).valid());
  snapshot.grant->source = AiBudgetFundingSource::Owner;
  snapshot.grant->period.startMs = 1;
  CHECK_FALSE(snapshot.grant->valid());
}

TEST(ai_budget_concurrency_and_historical_debt_block_admission_independently_of_unused_money) {
  const AiBudgetPrincipal principal{{AiBudgetSubjectKind::Account, "account"}, AiBudgetTier::LoggedIn};
  const AiBudgetLimits limits;
  AiBudgetSnapshot snapshot;
  snapshot.period = *AiBudgetPeriod::at(0);
  snapshot.concurrentCalls = 1;
  auto view = aiBudgetView(principal, 0, limits, snapshot);
  CHECK_EQ(view.code, AiBudgetCode::ConcurrencyExhausted);
  CHECK_FALSE(view.budgetResetsAtMs);
  snapshot.concurrentCalls = 0;
  snapshot.subject.debtNanos = 1;
  CHECK_EQ(aiBudgetView(principal, 0, limits, snapshot).code, AiBudgetCode::DebtOutstanding);
  const AiBudgetPrincipal paid{principal.subject, AiBudgetTier::WindmillOne};
  snapshot.grant = AiBudgetGrant{"grant", "account", AiBudgetFundingSource::Subscription,
                                 snapshot.period, limits.paidPeriodNanos, "txn"};
  snapshot.window = AiBudgetWindow::BillingPeriod;
  CHECK_EQ(admitAiBudget({"call", paid, 1, 0}, limits, snapshot), AiBudgetCode::DebtOutstanding);
  snapshot.subject.debtNanos = 0;
  snapshot.concurrentCalls = 1;
  CHECK_EQ(admitAiBudget({"call", paid, 1, 0}, limits, snapshot), AiBudgetCode::Ok);
  snapshot.concurrentCalls = 2;
  CHECK_EQ(admitAiBudget({"call", paid, 1, 0}, limits, snapshot), AiBudgetCode::ConcurrencyExhausted);
}

TEST(ai_budget_malformed_identity_period_amount_and_negative_balances_fail_closed) {
  const AiBudgetPrincipal principal{{AiBudgetSubjectKind::Account, "account"}, AiBudgetTier::LoggedIn};
  AiBudgetSnapshot snapshot;
  snapshot.period = *AiBudgetPeriod::at(0);
  AiBudgetLimits limits;
  CHECK_EQ(admitAiBudget({"call", principal, 0, 0}, limits, snapshot), AiBudgetCode::Invalid);
  CHECK_EQ(admitAiBudget({"bad id", principal, 1, 0}, limits, snapshot), AiBudgetCode::Invalid);
  CHECK_EQ(admitAiBudget({"call", principal, 1, -1}, limits, snapshot), AiBudgetCode::Invalid);
  snapshot.subject.heldNanos = -1;
  CHECK_EQ(admitAiBudget({"call", principal, 1, 0}, limits, snapshot), AiBudgetCode::Invalid);
  snapshot.subject.heldNanos = 0;
  ++snapshot.period.endMs;
  CHECK_EQ(admitAiBudget({"call", principal, 1, 0}, limits, snapshot), AiBudgetCode::Invalid);
  snapshot.period = *AiBudgetPeriod::at(0);
  limits.freeConcurrency = 0;
  CHECK_EQ(admitAiBudget({"call", principal, 1, 0}, limits, snapshot), AiBudgetCode::Invalid);
  const long long maximum = std::numeric_limits<long long>::max();
  CHECK_EQ((AiBudgetBalance{maximum - 1, maximum, 0}).remainingNanos(maximum), 0);
}

TEST(ai_budget_dispatch_is_once_and_uncertain_liability_only_settles_with_exact_cost) {
  AiBudgetReservation reservation{"call", {AiBudgetSubjectKind::Account, "account"}, AiBudgetTier::LoggedIn,
                                  *AiBudgetPeriod::at(0), 10};
  CHECK_EQ(transitionAiBudget(reservation, AiBudgetState::Settled, 4), AiBudgetCode::InvalidState);
  CHECK_EQ(transitionAiBudget(reservation, AiBudgetState::Dispatched), AiBudgetCode::Ok);
  CHECK_EQ(transitionAiBudget(reservation, AiBudgetState::Dispatched), AiBudgetCode::AlreadyDispatched);
  CHECK_EQ(transitionAiBudget(reservation, AiBudgetState::Released), AiBudgetCode::InvalidState);
  CHECK_EQ(transitionAiBudget(reservation, AiBudgetState::Uncertain), AiBudgetCode::Ok);
  CHECK_EQ(transitionAiBudget(reservation, AiBudgetState::Uncertain), AiBudgetCode::Replay);
  CHECK_EQ(transitionAiBudget(reservation, AiBudgetState::Released), AiBudgetCode::InvalidState);
  CHECK_EQ(transitionAiBudget(reservation, AiBudgetState::Settled, -1), AiBudgetCode::Invalid);
  CHECK_EQ(transitionAiBudget(reservation, AiBudgetState::Settled, 4), AiBudgetCode::Ok);
  CHECK_EQ(transitionAiBudget(reservation, AiBudgetState::Settled, 4), AiBudgetCode::Replay);
  CHECK_EQ(transitionAiBudget(reservation, AiBudgetState::Settled, 5), AiBudgetCode::Conflict);
  CHECK_EQ(reservation.actualNanos, std::optional<long long>{4});
  CHECK_EQ(transitionAiBudget(reservation, AiBudgetState::Dispatched), AiBudgetCode::AlreadyDispatched);
}

TEST(ai_budget_release_is_only_for_unsent_calls_and_overrun_reconciliation_keeps_the_cost) {
  AiBudgetReservation reservation{"call", {AiBudgetSubjectKind::Account, "account"}, AiBudgetTier::LoggedIn,
                                  *AiBudgetPeriod::at(0), 10};
  auto unsent = reservation;
  CHECK_EQ(transitionAiBudget(unsent, AiBudgetState::Released), AiBudgetCode::Ok);
  CHECK_EQ(transitionAiBudget(unsent, AiBudgetState::Released), AiBudgetCode::Replay);
  CHECK_EQ(transitionAiBudget(unsent, AiBudgetState::Dispatched), AiBudgetCode::InvalidState);
  CHECK_EQ(reconcileAiBudgetOverrun(reservation), AiBudgetCode::InvalidState);
  CHECK_EQ(transitionAiBudget(reservation, AiBudgetState::Dispatched), AiBudgetCode::Ok);
  CHECK_EQ(transitionAiBudget(reservation, AiBudgetState::Settled, 12), AiBudgetCode::Ok);
  CHECK_EQ(reconcileAiBudgetOverrun(reservation), AiBudgetCode::Ok);
  CHECK_EQ(reconcileAiBudgetOverrun(reservation), AiBudgetCode::Replay);
  CHECK_EQ(reservation.actualNanos, std::optional<long long>{12});
  CHECK_EQ(transitionAiBudget(reservation, AiBudgetState::Settled, 12), AiBudgetCode::Replay);
}

TEST(ai_budget_replay_pins_original_attribution_across_tier_and_period_changes) {
  const AiBudgetReservation original{"call", {AiBudgetSubjectKind::Account, "account"}, AiBudgetTier::LoggedIn,
                                     *AiBudgetPeriod::at(0), 10};
  AiBudgetRequest retry{"call", {original.subject, AiBudgetTier::WindmillOne}, 10, original.period.endMs};
  CHECK(original.sameRequest(retry));
  ++retry.amountNanos;
  CHECK_FALSE(original.sameRequest(retry));
  retry.amountNanos = 10;
  retry.principal.subject.id = "other";
  CHECK_FALSE(original.sameRequest(retry));
}

TEST(ai_budget_thresholds_include_holds_and_are_exact_even_near_integer_limits) {
  CHECK_EQ(crossedAiBudgetThresholds({}, {49, 0, 0}, 100), std::vector<int>{});
  CHECK_EQ(crossedAiBudgetThresholds({}, {0, 50, 0}, 100), std::vector<int>{50});
  CHECK_EQ(crossedAiBudgetThresholds({50, 0, 0}, {40, 55, 0}, 100), (std::vector<int>{80, 95}));
  CHECK_EQ(crossedAiBudgetThresholds({}, {100, 0, 0}, 100), (std::vector<int>{50, 80, 95}));
  CHECK_EQ(crossedAiBudgetThresholds({95, 0, 0}, {50, 0, 0}, 100), std::vector<int>{});
  CHECK_EQ(crossedAiBudgetThresholds({}, {1, 0, 0}, 1), (std::vector<int>{50, 80, 95}));
  CHECK_EQ(crossedAiBudgetThresholds({}, {1, 0, 0}, 0), std::vector<int>{});
  const long long maximum = std::numeric_limits<long long>::max();
  CHECK_EQ(crossedAiBudgetThresholds({}, {maximum, maximum, 0}, maximum), (std::vector<int>{50, 80, 95}));
}
