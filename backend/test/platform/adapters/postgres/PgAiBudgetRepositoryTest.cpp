#include "platform/adapters/postgres/PgAiBudgetRepository.h"
#include "platform/adapters/llm/AiCallBudget.h"
#include "platform/adapters/llm/AnthropicClient.h"
#include "platform/application/AiBudgetService.h"
#include "platform/application/WriteObservation.h"
#include "test/PgTestPool.h"
#include "test/platform/Fakes.h"
#include "test/testing.h"

#include <algorithm>
#include <array>
#include <barrier>
#include <cstdlib>
#include <exception>
#include <limits>
#include <memory>
#include <string>
#include <thread>
#include <vector>

using namespace wm;

TEST(pg_ai_budget_principal_concurrency_is_one_free_or_two_paid_across_repositories) {
  if (!std::getenv("WM_PG_TEST")) SKIP("needs WM_PG_TEST");
  const long long at = 1'767'225'600'000;
  const AiBudgetLimits limits;
  for (const bool paid : {false, true}) {
    {
      PgLease conn{*pgTestPool()};
      pqxx::work txn{*conn};
      txn.exec("DELETE FROM ai_budget_alerts; DELETE FROM ai_budget_reservations; DELETE FROM ai_budget_balances; "
               "DELETE FROM ai_budget_grants; DELETE FROM ai_budget_device_accounts");
      txn.commit();
    }
    PgAiBudgetRepository repository{pgTestPool()};
    const AiBudgetPrincipal principal{{AiBudgetSubjectKind::Account, "account"},
        paid ? AiBudgetTier::WindmillOne : AiBudgetTier::LoggedIn};
    if (paid) CHECK_EQ(repository.fund({"grant", "account", AiBudgetFundingSource::Subscription,
                                      *AiBudgetPeriod::at(at), limits.paidPeriodNanos, "invoice"}, limits).code,
                       AiBudgetCode::Ok);
    std::array<AiBudgetCode, 12> codes{};
    std::array<std::exception_ptr, 12> failures;
    std::barrier start{12};
    std::vector<std::thread> calls;
    for (int index = 0; index < 12; ++index) calls.emplace_back([&, index] {
      PgAiBudgetRepository process{pgTestPool()};
      start.arrive_and_wait();
      try { codes[index] = process.reserve({"call-" + std::to_string(index), principal, 10, at}, limits).code; }
      catch (...) { failures[index] = std::current_exception(); }
    });
    for (auto& call : calls) call.join();
    int accepted = 0;
    int refused = 0;
    for (int index = 0; index < 12; ++index) {
      CHECK_FALSE(failures[index]);
      if (failures[index]) continue;
      if (codes[index] == AiBudgetCode::Ok) ++accepted;
      if (codes[index] == AiBudgetCode::ConcurrencyExhausted) ++refused;
    }
    CHECK_EQ(accepted, paid ? 2 : 1);
    CHECK_EQ(refused, paid ? 10 : 11);
    const auto snapshot = repository.snapshot(principal, at, limits);
    CHECK_EQ(snapshot.concurrentCalls, accepted);
    CHECK_EQ(snapshot.subject.heldNanos, accepted * 10);
  }
}

TEST(pg_ai_budget_free_month_and_day_caps_are_atomic_and_cannot_spend_paid_funding) {
  if (!std::getenv("WM_PG_TEST")) SKIP("needs WM_PG_TEST");
  const long long at = 1'767'225'600'000;
  for (const bool daily : {false, true}) {
    {
      PgLease conn{*pgTestPool()};
      pqxx::work txn{*conn};
      txn.exec("DELETE FROM ai_budget_alerts; DELETE FROM ai_budget_reservations; DELETE FROM ai_budget_balances; "
               "DELETE FROM ai_budget_grants; DELETE FROM ai_budget_device_accounts");
      txn.commit();
    }
    AiBudgetLimits limits;
    limits.freeMonthlyNanos = daily ? 1000 : 30;
    limits.freeDailyNanos = daily ? 30 : 1000;
    std::array<AiBudgetCode, 12> codes{};
    std::array<std::exception_ptr, 12> failures;
    std::barrier start{12};
    std::vector<std::thread> calls;
    for (int index = 0; index < 12; ++index) calls.emplace_back([&, index] {
      PgAiBudgetRepository process{pgTestPool()};
      const AiBudgetPrincipal principal{{index % 2 ? AiBudgetSubjectKind::Account : AiBudgetSubjectKind::Device,
          "subject-" + std::to_string(index)}, index % 2 ? AiBudgetTier::LoggedIn : AiBudgetTier::Anonymous};
      start.arrive_and_wait();
      try { codes[index] = process.reserve({"call-" + std::to_string(index), principal, 10, at}, limits).code; }
      catch (...) { failures[index] = std::current_exception(); }
    });
    for (auto& call : calls) call.join();
    int accepted = 0;
    int refused = 0;
    for (int index = 0; index < 12; ++index) {
      CHECK_FALSE(failures[index]);
      if (failures[index]) continue;
      if (codes[index] == AiBudgetCode::Ok) ++accepted;
      if (codes[index] == (daily ? AiBudgetCode::FreeDayExhausted : AiBudgetCode::FreeMonthExhausted)) ++refused;
    }
    CHECK_EQ(accepted, 3);
    CHECK_EQ(refused, 9);
    PgAiBudgetRepository repository{pgTestPool()};
    const AiBudgetPrincipal paid{{AiBudgetSubjectKind::Account, "paid"}, AiBudgetTier::WindmillOne};
    CHECK_EQ(repository.reserve({"unfunded", paid, 10, at}, limits).code, AiBudgetCode::FundingRequired);
    CHECK_EQ(repository.fund({"grant", "paid", AiBudgetFundingSource::Subscription,
                             *AiBudgetPeriod::at(at), limits.paidPeriodNanos, "invoice"}, limits).code, AiBudgetCode::Ok);
    CHECK_EQ(repository.reserve({"paid-call", paid, 100, at}, limits).code, AiBudgetCode::Ok);
    const auto free = repository.snapshot({{AiBudgetSubjectKind::Account, "fresh-account"}, AiBudgetTier::LoggedIn}, at, limits);
    CHECK_EQ(free.freeMonth.spentNanos, 0);
    CHECK_EQ(free.freeMonth.heldNanos, 30);
    CHECK_EQ(free.freeDay.heldNanos, 30);
    CHECK_EQ(repository.snapshot(paid, at, limits).subject.heldNanos, 100);
  }
}

TEST(pg_ai_budget_anonymous_lifetime_and_account_calendar_month_have_distinct_resets) {
  if (!std::getenv("WM_PG_TEST")) SKIP("needs WM_PG_TEST");
  {
    PgLease conn{*pgTestPool()};
    pqxx::work txn{*conn};
    txn.exec("DELETE FROM ai_budget_alerts; DELETE FROM ai_budget_reservations; DELETE FROM ai_budget_balances; "
             "DELETE FROM ai_budget_grants; DELETE FROM ai_budget_device_accounts");
    txn.commit();
  }
  const AiBudgetLimits limits;
  const long long january = 1'767'225'600'000;
  const long long february = AiBudgetPeriod::at(january)->endMs;
  PgAiBudgetRepository repository{pgTestPool()};
  const AiBudgetPrincipal device{{AiBudgetSubjectKind::Device, "device"}, AiBudgetTier::Anonymous};
  CHECK_EQ(repository.reserve({"first", device, 30'000'000, january}, limits).code, AiBudgetCode::Ok);
  CHECK_EQ(repository.markDispatched("first").code, AiBudgetCode::Ok);
  CHECK_EQ(repository.settle("first", 30'000'000).code, AiBudgetCode::Ok);
  CHECK_EQ(repository.reserve({"second", device, 20'000'000, february}, limits).code, AiBudgetCode::Ok);
  CHECK_EQ(repository.markDispatched("second").code, AiBudgetCode::Ok);
  CHECK_EQ(repository.settle("second", 20'000'000).code, AiBudgetCode::Ok);
  CHECK_EQ(repository.reserve({"empty", device, 1, february}, limits).code, AiBudgetCode::SubjectExhausted);
  const auto anonymous = repository.snapshot(device, february, limits);
  CHECK_EQ(anonymous.period, AiBudgetPeriod::lifetime());
  CHECK_EQ(anonymous.window, AiBudgetWindow::Lifetime);
  CHECK_EQ(anonymous.subject.spentNanos, 50'000'000);
  CHECK_EQ(anonymous.freeMonth.spentNanos, 20'000'000);
  const AiBudgetPrincipal account{{AiBudgetSubjectKind::Account, "account"}, AiBudgetTier::LoggedIn};
  CHECK_EQ(repository.reserve({"account-january", account, 250'000'000, january}, limits).code, AiBudgetCode::Ok);
  CHECK_EQ(repository.markDispatched("account-january").code, AiBudgetCode::Ok);
  CHECK_EQ(repository.settle("account-january", 250'000'000).code, AiBudgetCode::Ok);
  CHECK_EQ(repository.reserve({"account-january-extra", account, 1, january}, limits).code, AiBudgetCode::SubjectExhausted);
  CHECK_EQ(repository.reserve({"account-february", account, 250'000'000, february}, limits).code, AiBudgetCode::Ok);
  CHECK_EQ(repository.snapshot(account, february, limits).subject.spentNanos, 0);
  CHECK_EQ(repository.snapshot(account, february, limits).subject.heldNanos, 250'000'000);
  const auto alerts = repository.claimAlerts(february, 100, february + 1000);
  CHECK_EQ(std::count_if(alerts.begin(), alerts.end(), [](const auto& alert) {
    return alert.scope == AiBudgetScope::AnonymousLifetime;
  }), 3);
}

TEST(pg_ai_budget_ambiguous_free_calls_preserve_holds_and_concurrency_after_month_rollover) {
  if (!std::getenv("WM_PG_TEST")) SKIP("needs WM_PG_TEST");
  {
    PgLease conn{*pgTestPool()};
    pqxx::work txn{*conn};
    txn.exec("DELETE FROM ai_budget_alerts; DELETE FROM ai_budget_reservations; DELETE FROM ai_budget_balances; "
             "DELETE FROM ai_budget_grants; DELETE FROM ai_budget_device_accounts");
    txn.commit();
  }
  AiBudgetLimits limits;
  limits.freeDailyNanos = 60'000'000;
  const long long january = 1'767'225'600'000;
  const long long february = AiBudgetPeriod::at(january)->endMs;
  const AiBudgetPrincipal account{{AiBudgetSubjectKind::Account, "account"}, AiBudgetTier::LoggedIn};
  PgAiBudgetRepository repository{pgTestPool()};
  CHECK_EQ(repository.reserve({"old", account, 50'000'000, january}, limits).code, AiBudgetCode::Ok);
  CHECK_EQ(repository.markDispatched("old").code, AiBudgetCode::Ok);
  CHECK_EQ(repository.markUncertain("old").code, AiBudgetCode::Ok);
  CHECK_EQ(repository.release("old").code, AiBudgetCode::InvalidState);
  PgAiBudgetRepository restarted{pgTestPool()};
  CHECK_EQ(restarted.reserve({"new", account, 1, february}, limits).code, AiBudgetCode::ConcurrencyExhausted);
  const AiBudgetPrincipal other{{AiBudgetSubjectKind::Account, "other"}, AiBudgetTier::LoggedIn};
  CHECK_EQ(restarted.reserve({"other", other, 20'000'000, february}, limits).code, AiBudgetCode::FreeDayExhausted);
  const auto held = restarted.snapshot(account, february, limits);
  CHECK_EQ(held.subject.spentNanos, 0);
  CHECK_EQ(held.subject.heldNanos, 50'000'000);
  CHECK_EQ(held.freeMonth.heldNanos, 50'000'000);
  CHECK_EQ(held.freeDay.heldNanos, 50'000'000);
  CHECK_EQ(restarted.settle("old", 40'000'000).code, AiBudgetCode::Ok);
  const auto settled = restarted.snapshot(account, february, limits);
  CHECK_EQ(settled.subject.spentNanos, 0);
  CHECK_EQ(settled.subject.heldNanos, 0);
  CHECK_EQ(settled.concurrentCalls, 0);
  CHECK_EQ(restarted.snapshot(account, january, limits).subject.spentNanos, 40'000'000);
}

TEST(pg_ai_budget_paid_grants_survive_calendar_boundaries_expire_and_pin_ambiguous_old_calls) {
  if (!std::getenv("WM_PG_TEST")) SKIP("needs WM_PG_TEST");
  {
    PgLease conn{*pgTestPool()};
    pqxx::work txn{*conn};
    txn.exec("DELETE FROM ai_budget_alerts; DELETE FROM ai_budget_reservations; DELETE FROM ai_budget_balances; "
             "DELETE FROM ai_budget_grants; DELETE FROM ai_budget_device_accounts");
    txn.commit();
  }
  const AiBudgetLimits limits;
  const long long january = 1'767'225'600'000;
  const long long february = AiBudgetPeriod::at(january)->endMs;
  const AiBudgetPeriod billing{january + 14 * 86'400'000LL, february + 14 * 86'400'000LL};
  const AiBudgetPrincipal principal{{AiBudgetSubjectKind::Account, "paid"}, AiBudgetTier::WindmillOne};
  PgAiBudgetRepository repository{pgTestPool()};
  const AiBudgetGrant grant{"grant-one", "paid", AiBudgetFundingSource::Subscription, billing,
                            limits.paidPeriodNanos, "invoice-one"};
  CHECK_EQ(repository.fund(grant, limits).code, AiBudgetCode::Ok);
  CHECK_EQ(repository.reserve({"old", principal, 4'000'000'000, billing.startMs}, limits).code, AiBudgetCode::Ok);
  CHECK_EQ(repository.markDispatched("old").code, AiBudgetCode::Ok);
  CHECK_EQ(repository.markUncertain("old").code, AiBudgetCode::Ok);
  const auto acrossMonth = repository.snapshot(principal, february, limits);
  CHECK_EQ(acrossMonth.period, billing);
  CHECK_EQ(acrossMonth.window, AiBudgetWindow::BillingPeriod);
  CHECK_EQ(acrossMonth.subject.heldNanos, 4'000'000'000);
  CHECK_EQ(repository.reserve({"too-much", principal, 3'000'000'001, february}, limits).code, AiBudgetCode::SubjectExhausted);
  CHECK_EQ(repository.reserve({"expired", principal, 1, billing.endMs}, limits).code, AiBudgetCode::FundingRequired);
  const AiBudgetGrant renewal{"grant-two", "paid", AiBudgetFundingSource::Subscription,
      {billing.endMs, billing.endMs + 28 * 86'400'000LL}, limits.paidPeriodNanos, "invoice-two"};
  CHECK_EQ(repository.fund(renewal, limits).code, AiBudgetCode::Ok);
  const auto renewed = repository.snapshot(principal, billing.endMs, limits);
  CHECK_EQ(renewed.subject.spentNanos, 0);
  CHECK_EQ(renewed.subject.heldNanos, 0);
  CHECK_EQ(renewed.concurrentCalls, 1);
  CHECK_EQ(repository.reserve({"new", principal, 3'000'000'000, billing.endMs}, limits).code, AiBudgetCode::Ok);
  CHECK_EQ(repository.reserve({"third", principal, 1, billing.endMs}, limits).code, AiBudgetCode::ConcurrencyExhausted);
  const auto replay = repository.reserve({"old", principal, 4'000'000'000, billing.endMs}, limits);
  REQUIRE(replay.reservation);
  CHECK_EQ(replay.code, AiBudgetCode::Replay);
  CHECK_EQ(replay.reservation->grantId, std::optional<std::string>{"grant-one"});
  CHECK_EQ(repository.markDispatched("old").code, AiBudgetCode::AlreadyDispatched);
  CHECK_EQ(repository.settle("old", 4'000'000'000).code, AiBudgetCode::Ok);
  CHECK_EQ(repository.snapshot(principal, february, limits).subject.spentNanos, 4'000'000'000);
  CHECK_EQ(repository.snapshot(principal, billing.endMs, limits).subject.spentNanos, 0);
  CHECK_EQ(repository.snapshot(principal, billing.endMs, limits).subject.heldNanos, 3'000'000'000);
}

TEST(pg_ai_budget_funding_is_idempotent_nonoverlapping_and_owner_months_are_unique) {
  if (!std::getenv("WM_PG_TEST")) SKIP("needs WM_PG_TEST");
  {
    PgLease conn{*pgTestPool()};
    pqxx::work txn{*conn};
    txn.exec("DELETE FROM ai_budget_alerts; DELETE FROM ai_budget_reservations; DELETE FROM ai_budget_balances; "
             "DELETE FROM ai_budget_grants; DELETE FROM ai_budget_device_accounts");
    txn.commit();
  }
  const AiBudgetLimits limits;
  const long long at = 1'767'225'600'000;
  const AiBudgetGrant grant{"grant", "paid", AiBudgetFundingSource::Subscription,
                            *AiBudgetPeriod::at(at), limits.paidPeriodNanos, "invoice"};
  std::array<AiBudgetCode, 12> codes{};
  std::array<std::exception_ptr, 12> failures;
  std::barrier start{12};
  std::vector<std::thread> calls;
  for (int index = 0; index < 12; ++index) calls.emplace_back([&, index] {
    PgAiBudgetRepository process{pgTestPool()};
    start.arrive_and_wait();
    try { codes[index] = process.fund(grant, limits).code; }
    catch (...) { failures[index] = std::current_exception(); }
  });
  for (auto& call : calls) call.join();
  CHECK_EQ(std::count(codes.begin(), codes.end(), AiBudgetCode::Ok), 1);
  CHECK_EQ(std::count(codes.begin(), codes.end(), AiBudgetCode::Replay), 11);
  for (const auto& failure : failures) CHECK_FALSE(failure);
  PgAiBudgetRepository repository{pgTestPool()};
  auto duplicate = grant;
  duplicate.id = "new-delivery-id";
  CHECK_EQ(repository.fund(duplicate, limits).code, AiBudgetCode::Replay);
  for (int mutation = 0; mutation < 4; ++mutation) {
    auto conflict = grant;
    conflict.id = "different-grant";
    if (mutation == 0) conflict.accountId = "other-account";
    if (mutation == 1) conflict.fundingReference = "second-invoice";
    if (mutation == 2) { conflict.fundingReference = "third-invoice"; conflict.period.startMs += 1; }
    if (mutation == 3) conflict.amountNanos += 1;
    CHECK_EQ(repository.fund(conflict, limits).code, mutation == 3 ? AiBudgetCode::Invalid : AiBudgetCode::Conflict);
  }
  const AiBudgetPrincipal owner{{AiBudgetSubjectKind::Account, "owner"}, AiBudgetTier::WindmillOne, true};
  std::array<std::optional<AiBudgetGrant>, 12> ownerGrants;
  failures.fill({});
  calls.clear();
  for (int index = 0; index < 12; ++index) calls.emplace_back([&, index] {
    PgAiBudgetRepository process{pgTestPool()};
    start.arrive_and_wait();
    try { ownerGrants[index] = process.snapshot(owner, at, limits).grant; }
    catch (...) { failures[index] = std::current_exception(); }
  });
  for (auto& call : calls) call.join();
  for (int index = 0; index < 12; ++index) {
    CHECK_FALSE(failures[index]);
    CHECK_EQ(ownerGrants[index], ownerGrants[0]);
  }
  const auto first = repository.snapshot(owner, at, limits);
  const auto replay = repository.snapshot(owner, at + 100, limits);
  REQUIRE(first.grant);
  CHECK_EQ(first.grant, replay.grant);
  CHECK_EQ(first.grant->amountNanos, 7'000'000'000);
  CHECK_EQ(first.grant->source, AiBudgetFundingSource::Owner);
  CHECK_EQ(first.window, AiBudgetWindow::CalendarMonth);
  const auto next = repository.snapshot(owner, first.period.endMs, limits);
  REQUIRE(next.grant);
  CHECK(first.grant->id != next.grant->id);
  const auto subscribedOwner = repository.snapshot({{AiBudgetSubjectKind::Account, "paid"}, AiBudgetTier::WindmillOne, true}, at, limits);
  CHECK_EQ(subscribedOwner.grant, std::optional<AiBudgetGrant>{grant});
  PgLease conn{*pgTestPool()};
  pqxx::work txn{*conn};
  CHECK_EQ(txn.exec("SELECT count(*) FROM ai_budget_grants")[0][0].as<int>(), 3);
}

TEST(pg_ai_budget_subscription_priority_preserves_owner_balance_and_funds_monthly_fallback) {
  if (!std::getenv("WM_PG_TEST")) SKIP("needs WM_PG_TEST");
  {
    PgLease conn{*pgTestPool()};
    pqxx::work txn{*conn};
    txn.exec("DELETE FROM ai_budget_alerts; DELETE FROM ai_budget_reservations; DELETE FROM ai_budget_balances; "
             "DELETE FROM ai_budget_grants; DELETE FROM ai_budget_device_accounts");
    txn.commit();
  }
  const AiBudgetLimits limits;
  const long long at = 1'767'225'600'000;
  const AiBudgetPrincipal owner{{AiBudgetSubjectKind::Account, "owner"}, AiBudgetTier::WindmillOne, true};
  PgAiBudgetRepository repository{pgTestPool()};
  const auto initial = repository.snapshot(owner, at, limits);
  REQUIRE(initial.grant);
  const AiBudgetPrincipal revokedOwner{owner.subject, AiBudgetTier::WindmillOne, false};
  const auto revokedBeforeSubscription = repository.snapshot(revokedOwner, at, limits);
  CHECK_FALSE(revokedBeforeSubscription.grant);
  CHECK_EQ(repository.reserve({"revoked-before", revokedOwner, 1, at}, limits).code,
           AiBudgetCode::FundingRequired);
  CHECK_EQ(repository.reserve({"owner-call", owner, 2'000'000'000, at}, limits).code, AiBudgetCode::Ok);
  CHECK_EQ(repository.markDispatched("owner-call").code, AiBudgetCode::Ok);
  const AiBudgetGrant subscription{"subscription", "owner", AiBudgetFundingSource::Subscription,
      {at + 9 * 86'400'000LL, at + 19 * 86'400'000LL}, limits.paidPeriodNanos, "invoice"};
  CHECK_EQ(repository.fund(subscription, limits).code, AiBudgetCode::Ok);
  const auto subscribed = repository.snapshot(owner, subscription.period.startMs, limits);
  CHECK_EQ(subscribed.grant, std::optional<AiBudgetGrant>{subscription});
  CHECK_EQ(repository.snapshot(revokedOwner, subscription.period.startMs, limits).grant,
           std::optional<AiBudgetGrant>{subscription});
  CHECK_EQ(subscribed.subject.spentNanos, 0);
  CHECK_EQ(subscribed.subject.heldNanos, 0);
  CHECK_EQ(subscribed.concurrentCalls, 1);
  CHECK_EQ(repository.reserve({"subscription-call", owner, 3'000'000'000, subscription.period.startMs}, limits).code,
           AiBudgetCode::Ok);
  CHECK_EQ(repository.markDispatched("subscription-call").code, AiBudgetCode::Ok);
  CHECK_EQ(repository.reserve({"third-call", owner, 1, subscription.period.startMs}, limits).code,
           AiBudgetCode::ConcurrencyExhausted);
  CHECK_EQ(repository.settle("owner-call", 1'000'000'000).code, AiBudgetCode::Ok);
  CHECK_EQ(repository.snapshot(owner, subscription.period.startMs, limits).subject.heldNanos, 3'000'000'000);
  CHECK_EQ(repository.settle("subscription-call", 2'000'000'000).code, AiBudgetCode::Ok);
  const auto fallback = repository.snapshot(owner, subscription.period.endMs, limits);
  CHECK_EQ(fallback.grant, initial.grant);
  const auto revokedAfterSubscription = repository.snapshot(revokedOwner, subscription.period.endMs, limits);
  CHECK_FALSE(revokedAfterSubscription.grant);
  CHECK_EQ(repository.reserve({"revoked-after", revokedOwner, 1, subscription.period.endMs}, limits).code,
           AiBudgetCode::FundingRequired);
  {
    PgLease conn{*pgTestPool()};
    pqxx::work txn{*conn};
    const pqxx::result grants = txn.exec("SELECT id, amount_nanos FROM ai_budget_grants "
                                        "WHERE account_id = 'owner' ORDER BY source");
    REQUIRE_EQ(grants.size(), 2u);
    CHECK_EQ(grants[0][0].as<std::string>(), initial.grant->id);
    CHECK_EQ(grants[0][1].as<long long>(), initial.grant->amountNanos);
    CHECK_EQ(grants[1][0].as<std::string>(), subscription.id);
    CHECK_EQ(grants[1][1].as<long long>(), subscription.amountNanos);
  }
  CHECK_EQ(fallback.subject.spentNanos, 1'000'000'000);
  CHECK_EQ(fallback.subject.heldNanos, 0);
  CHECK_EQ(fallback.concurrentCalls, 0);
  CHECK_EQ(repository.reserve({"owner-rest", owner, 6'000'000'001, subscription.period.endMs}, limits).code,
           AiBudgetCode::SubjectExhausted);
  CHECK_EQ(repository.reserve({"owner-rest", owner, 6'000'000'000, subscription.period.endMs}, limits).code,
           AiBudgetCode::Ok);
  CHECK_EQ(repository.release("owner-rest").code, AiBudgetCode::Ok);
  auto duplicateOwner = *initial.grant;
  duplicateOwner.id = "duplicate-owner";
  duplicateOwner.fundingReference = "duplicate-owner-funding";
  CHECK_EQ(repository.fund(duplicateOwner, limits).code, AiBudgetCode::Conflict);
  const auto nextMonth = repository.snapshot(owner, initial.period.endMs, limits);
  REQUIRE(nextMonth.grant);
  CHECK(nextMonth.grant->id != initial.grant->id);
  CHECK_EQ(nextMonth.subject.spentNanos, 0);

  const AiBudgetPrincipal laterOwner{{AiBudgetSubjectKind::Account, "later-owner"}, AiBudgetTier::WindmillOne, true};
  auto expiredSubscription = subscription;
  expiredSubscription.id = "expired-subscription";
  expiredSubscription.accountId = "later-owner";
  expiredSubscription.fundingReference = "expired-invoice";
  CHECK_EQ(repository.fund(expiredSubscription, limits).code, AiBudgetCode::Ok);
  const auto newFallback = repository.snapshot(laterOwner, expiredSubscription.period.endMs, limits);
  REQUIRE(newFallback.grant);
  CHECK_EQ(newFallback.grant->source, AiBudgetFundingSource::Owner);
  CHECK_EQ(newFallback.grant->period, *AiBudgetPeriod::at(at));
  CHECK_EQ(newFallback.grant->amountNanos, 7'000'000'000);

  const AiBudgetPrincipal exactOwner{{AiBudgetSubjectKind::Account, "exact-owner"}, AiBudgetTier::WindmillOne, true};
  const auto exactOwnerGrant = repository.snapshot(exactOwner, at, limits);
  REQUIRE(exactOwnerGrant.grant);
  const AiBudgetGrant exactSubscription{"exact-subscription", "exact-owner", AiBudgetFundingSource::Subscription,
      exactOwnerGrant.period, limits.paidPeriodNanos, "exact-invoice"};
  CHECK_EQ(repository.fund(exactSubscription, limits).code, AiBudgetCode::Ok);
  CHECK_EQ(repository.snapshot(exactOwner, at, limits).grant, std::optional<AiBudgetGrant>{exactSubscription});
}

TEST(pg_ai_budget_device_claim_preserves_current_spend_inflight_cost_and_permanent_account_binding) {
  if (!std::getenv("WM_PG_TEST")) SKIP("needs WM_PG_TEST");
  {
    PgLease conn{*pgTestPool()};
    pqxx::work txn{*conn};
    txn.exec("DELETE FROM ai_budget_alerts; DELETE FROM ai_budget_reservations; DELETE FROM ai_budget_balances; "
             "DELETE FROM ai_budget_grants; DELETE FROM ai_budget_device_accounts");
    txn.commit();
  }
  const AiBudgetLimits limits;
  const long long at = 1'767'225'600'000;
  const AiBudgetPrincipal device{{AiBudgetSubjectKind::Device, "device"}, AiBudgetTier::Anonymous};
  const AiBudgetPrincipal account{{AiBudgetSubjectKind::Account, "account"}, AiBudgetTier::LoggedIn};
  PgAiBudgetRepository repository{pgTestPool()};
  CHECK_EQ(repository.reserve({"settled", device, 20'000'000, at}, limits).code, AiBudgetCode::Ok);
  CHECK_EQ(repository.markDispatched("settled").code, AiBudgetCode::Ok);
  CHECK_EQ(repository.settle("settled", 20'000'000).code, AiBudgetCode::Ok);
  CHECK_EQ(repository.reserve({"inflight", device, 25'000'000, at}, limits).code, AiBudgetCode::Ok);
  CHECK_EQ(repository.markDispatched("inflight").code, AiBudgetCode::Ok);
  CHECK_EQ(repository.bindDevice("device", "account", at, limits), AiBudgetCode::Ok);
  CHECK_EQ(repository.bindDevice("device", "account", at, limits), AiBudgetCode::Replay);
  CHECK_EQ(repository.bindDevice("device", "other-account", at, limits), AiBudgetCode::Conflict);
  const auto claimed = repository.snapshot(account, at, limits);
  CHECK_EQ(claimed.subject.spentNanos, 20'000'000);
  CHECK_EQ(claimed.subject.heldNanos, 25'000'000);
  CHECK_EQ(claimed.concurrentCalls, 1);
  CHECK_EQ(repository.reserve({"future-anon", device, 1, at}, limits).code, AiBudgetCode::DeviceBound);
  CHECK_EQ(repository.reserve({"future-account", account, 1, at}, limits).code, AiBudgetCode::ConcurrencyExhausted);
  CHECK_EQ(repository.settle("inflight", 20'000'000).code, AiBudgetCode::Ok);
  const auto complete = repository.snapshot(account, at, limits);
  CHECK_EQ(complete.subject.spentNanos, 40'000'000);
  CHECK_EQ(complete.subject.heldNanos, 0);
  CHECK_EQ(complete.freeMonth.spentNanos, 40'000'000);
  CHECK_EQ(complete.freeDay.spentNanos, 40'000'000);
  CHECK_EQ(repository.reserve({"extra", account, 210'000'001, at}, limits).code, AiBudgetCode::SubjectExhausted);
  CHECK_EQ(repository.reserve({"remaining", account, 210'000'000, at}, limits).code, AiBudgetCode::Ok);
  CHECK_EQ(repository.release("remaining").code, AiBudgetCode::Ok);
  const long long nextMonth = AiBudgetPeriod::at(at)->endMs;
  CHECK_EQ(repository.snapshot(account, nextMonth, limits).subject.spentNanos, 0);
  CHECK_EQ(repository.reserve({"anon-next-month", device, 1, nextMonth}, limits).code, AiBudgetCode::DeviceBound);
  PgLease conn{*pgTestPool()};
  pqxx::work txn{*conn};
  CHECK_EQ(txn.exec("SELECT count(*) FROM ai_budget_grants")[0][0].as<int>(), 0);
}

TEST(pg_ai_budget_claimed_old_device_liability_follows_account_without_charging_new_month_twice) {
  if (!std::getenv("WM_PG_TEST")) SKIP("needs WM_PG_TEST");
  {
    PgLease conn{*pgTestPool()};
    pqxx::work txn{*conn};
    txn.exec("DELETE FROM ai_budget_alerts; DELETE FROM ai_budget_reservations; DELETE FROM ai_budget_balances; "
             "DELETE FROM ai_budget_grants; DELETE FROM ai_budget_device_accounts");
    txn.commit();
  }
  const AiBudgetLimits limits;
  const long long january = 1'767'225'600'000;
  const long long february = AiBudgetPeriod::at(january)->endMs;
  const AiBudgetPrincipal device{{AiBudgetSubjectKind::Device, "device"}, AiBudgetTier::Anonymous};
  const AiBudgetPrincipal account{{AiBudgetSubjectKind::Account, "account"}, AiBudgetTier::LoggedIn};
  PgAiBudgetRepository repository{pgTestPool()};
  CHECK_EQ(repository.reserve({"old", device, 40'000'000, january}, limits).code, AiBudgetCode::Ok);
  CHECK_EQ(repository.markDispatched("old").code, AiBudgetCode::Ok);
  CHECK_EQ(repository.markUncertain("old").code, AiBudgetCode::Ok);
  CHECK_EQ(repository.bindDevice("device", "account", february, limits), AiBudgetCode::Ok);
  const auto held = repository.snapshot(account, february, limits);
  CHECK_EQ(held.subject.spentNanos, 0);
  CHECK_EQ(held.subject.heldNanos, 40'000'000);
  CHECK_EQ(held.concurrentCalls, 1);
  CHECK_EQ(repository.settle("old", 30'000'000).code, AiBudgetCode::Ok);
  const auto settled = repository.snapshot(account, february, limits);
  CHECK_EQ(settled.subject.spentNanos, 0);
  CHECK_EQ(settled.subject.heldNanos, 0);
  CHECK_EQ(settled.freeMonth.spentNanos, 0);
  CHECK_EQ(repository.snapshot(account, january, limits).subject.spentNanos, 30'000'000);
  CHECK_EQ(repository.snapshot(account, january, limits).freeMonth.spentNanos, 30'000'000);
}

TEST(pg_ai_budget_alerts_are_threshold_deduplicated_leased_and_retried_with_stale_claim_protection) {
  if (!std::getenv("WM_PG_TEST")) SKIP("needs WM_PG_TEST");
  {
    PgLease conn{*pgTestPool()};
    pqxx::work txn{*conn};
    txn.exec("DELETE FROM ai_budget_alerts; DELETE FROM ai_budget_reservations; DELETE FROM ai_budget_balances; "
             "DELETE FROM ai_budget_grants; DELETE FROM ai_budget_device_accounts");
    txn.commit();
  }
  AiBudgetLimits limits;
  limits.freeMonthlyNanos = 100;
  limits.freeDailyNanos = 100;
  limits.loggedInMonthlyNanos = 100;
  const long long at = 1'767'225'600'000;
  const AiBudgetPrincipal account{{AiBudgetSubjectKind::Account, "account"}, AiBudgetTier::LoggedIn};
  PgAiBudgetRepository repository{pgTestPool()};
  CHECK_EQ(repository.reserve({"first", account, 95, at}, limits).code, AiBudgetCode::Ok);
  CHECK_EQ(repository.reserve({"first", account, 95, at}, limits).code, AiBudgetCode::Replay);
  CHECK_EQ(repository.release("first").code, AiBudgetCode::Ok);
  CHECK_EQ(repository.reserve({"second", account, 95, at}, limits).code, AiBudgetCode::Ok);
  const auto alerts = repository.claimAlerts(at, 100, at + 1000);
  REQUIRE_EQ(alerts.size(), 9u);
  CHECK(repository.claimAlerts(at, 100, at + 1000).empty());
  std::vector<std::string> actual;
  for (const auto& alert : alerts) {
    actual.push_back(std::string(aiBudgetScopeName(alert.scope)) + ":" + std::to_string(alert.thresholdPercent));
    CHECK_EQ(alert.limitNanos, 100);
    CHECK_EQ(alert.spentNanos, 0);
    CHECK_EQ(alert.heldNanos, 95);
    CHECK_FALSE(alert.fundingSource);
  }
  std::sort(actual.begin(), actual.end());
  const std::vector<std::string> expected{"account_month:50", "account_month:80", "account_month:95",
      "free_day:50", "free_day:80", "free_day:95", "free_month:50", "free_month:80", "free_month:95"};
  CHECK_EQ(actual, expected);
  CHECK_EQ(repository.retryAlert(alerts[0].id, alerts[0].claimToken, at + 2000), AiBudgetCode::Ok);
  CHECK_EQ(repository.retryAlert(alerts[0].id, alerts[0].claimToken, at + 2000), AiBudgetCode::Replay);
  for (std::size_t index = 1; index < alerts.size(); ++index) {
    CHECK_EQ(repository.completeAlert(alerts[index].id, alerts[index].claimToken), AiBudgetCode::Ok);
    CHECK_EQ(repository.completeAlert(alerts[index].id, alerts[index].claimToken), AiBudgetCode::Replay);
  }
  CHECK(repository.claimAlerts(at + 1500, 100, at + 2500).empty());
  const auto retry = repository.claimAlerts(at + 2000, 100, at + 3000);
  REQUIRE_EQ(retry.size(), 1u);
  CHECK_EQ(retry[0].id, alerts[0].id);
  CHECK(retry[0].claimToken != alerts[0].claimToken);
  CHECK_EQ(repository.completeAlert(alerts[0].id, alerts[0].claimToken), AiBudgetCode::Conflict);
  const auto expired = repository.claimAlerts(at + 3000, 100, at + 4000);
  REQUIRE_EQ(expired.size(), 1u);
  CHECK_EQ(expired[0].id, retry[0].id);
  CHECK(expired[0].claimToken != retry[0].claimToken);
  CHECK_EQ(repository.completeAlert(retry[0].id, retry[0].claimToken), AiBudgetCode::Conflict);
  CHECK_EQ(repository.completeAlert(expired[0].id, expired[0].claimToken), AiBudgetCode::Ok);
  CHECK_EQ(repository.snapshot(account, at + 4000, limits).subject.heldNanos, 95);
  CHECK(repository.claimAlerts(at + 5000, 100, at + 6000).empty());
  const AiBudgetPrincipal paid{{AiBudgetSubjectKind::Account, "owner"}, AiBudgetTier::WindmillOne, true};
  CHECK_EQ(repository.reserve({"paid", paid, 6'650'000'000, at}, limits).code, AiBudgetCode::Ok);
  const auto paidAlerts = repository.claimAlerts(at, 100, at + 1000);
  REQUIRE_EQ(paidAlerts.size(), 3u);
  for (const auto& alert : paidAlerts) {
    CHECK_EQ(alert.scope, AiBudgetScope::FundedPeriod);
    CHECK_EQ(alert.fundingSource, std::optional<AiBudgetFundingSource>{AiBudgetFundingSource::Owner});
  }
}

TEST(pg_ai_budget_paid_overruns_preserve_exact_cost_isolate_other_principals_and_survive_renewal) {
  if (!std::getenv("WM_PG_TEST")) SKIP("needs WM_PG_TEST");
  {
    PgLease conn{*pgTestPool()};
    pqxx::work txn{*conn};
    txn.exec("DELETE FROM ai_budget_alerts; DELETE FROM ai_budget_reservations; DELETE FROM ai_budget_balances; "
             "DELETE FROM ai_budget_grants; DELETE FROM ai_budget_device_accounts");
    txn.commit();
  }
  const AiBudgetLimits limits;
  const long long at = 1'767'225'600'000;
  const AiBudgetPrincipal owner{{AiBudgetSubjectKind::Account, "owner"}, AiBudgetTier::WindmillOne, true};
  PgAiBudgetRepository repository{pgTestPool()};
  for (const auto& id : {"first", "second"}) {
    CHECK_EQ(repository.reserve({id, owner, 1, at}, limits).code, AiBudgetCode::Ok);
    CHECK_EQ(repository.markDispatched(id).code, AiBudgetCode::Ok);
  }
  CHECK_EQ(repository.settle("first", std::numeric_limits<long long>::max()).code, AiBudgetCode::Ok);
  CHECK_EQ(repository.settle("second", std::numeric_limits<long long>::max()).code, AiBudgetCode::Ok);
  {
    PgLease conn{*pgTestPool()};
    pqxx::work txn{*conn};
    const auto rows = txn.exec("SELECT spent_nanos::text, held_nanos::text, debt_nanos::text FROM ai_budget_balances "
                               "WHERE scope = 'funded_period'");
    REQUIRE_EQ(rows.size(), 1u);
    CHECK_EQ(rows[0][0].as<std::string>(), std::string("18446744073709551614"));
    CHECK_EQ(rows[0][1].as<std::string>(), std::string("0"));
    CHECK_EQ(rows[0][2].as<std::string>(), std::string("18446744073709551612"));
  }
  const long long nextMonth = AiBudgetPeriod::at(at)->endMs;
  CHECK_EQ(repository.reserve({"renewed", owner, 1, nextMonth}, limits).code, AiBudgetCode::DebtOutstanding);
  const AiBudgetPrincipal other{{AiBudgetSubjectKind::Account, "other-owner"}, AiBudgetTier::WindmillOne, true};
  CHECK_EQ(repository.reserve({"other", other, 1, nextMonth}, limits).code, AiBudgetCode::Ok);
  const AiBudgetPrincipal free{{AiBudgetSubjectKind::Account, "free"}, AiBudgetTier::LoggedIn};
  CHECK_EQ(repository.reserve({"free", free, 1, nextMonth}, limits).code, AiBudgetCode::Ok);
  CHECK_EQ(repository.reconcileOverrun("first").code, AiBudgetCode::Ok);
  CHECK_EQ(repository.reconcileOverrun("first").code, AiBudgetCode::Replay);
  CHECK_EQ(repository.reserve({"renewed", owner, 1, nextMonth}, limits).code, AiBudgetCode::DebtOutstanding);
  CHECK_EQ(repository.reconcileOverrun("second").code, AiBudgetCode::Ok);
  CHECK_EQ(repository.reserve({"renewed", owner, 1, nextMonth}, limits).code, AiBudgetCode::Ok);
  CHECK_EQ(repository.snapshot(owner, at, limits).subject.spentNanos, std::numeric_limits<long long>::max());
  CHECK_EQ(repository.snapshot(owner, nextMonth, limits).subject.spentNanos, 0);
}

TEST(pg_ai_budget_estimated_provider_calls_settle_actuals_without_freezing_funded_free_accounts) {
  if (!std::getenv("WM_PG_TEST")) SKIP("needs WM_PG_TEST");
  {
    PgLease conn{*pgTestPool()};
    pqxx::work txn{*conn};
    txn.exec("DELETE FROM ai_budget_alerts; DELETE FROM ai_budget_reservations; DELETE FROM ai_budget_balances; "
             "DELETE FROM ai_budget_grants; DELETE FROM ai_budget_device_accounts");
    txn.commit();
  }
  struct Reporter final : FailureReporter {
    std::vector<std::string> issues;
    void report(const std::string& kind, const std::string& operation, const std::string& detail) override {
      issues.push_back(kind + ":" + operation + ":" + detail);
    }
  };
  struct ReporterScope {
    std::shared_ptr<Reporter> reporter = std::make_shared<Reporter>();
    ReporterScope() { installWriteReporter(reporter); }
    ~ReporterScope() { installWriteReporter({}); }
  } observation;
  const AiBudgetLimits limits;
  const long long at = 1'767'225'600'000;
  PgAiBudgetRepository repository{pgTestPool()};
  auto service = std::make_shared<AiBudgetService>(repository, [limits] { return limits; }, [at] { return at; });
  wm::fake::FakeAuthRepository accounts;
  const auto account = accounts.createUser(Email{"free@example.com"}, "Free");
  wm::fake::FakeSubscriptionRepository subscriptions;
  wm::fake::FakeAiUsageRepository usage;
  Entitlements entitlements{subscriptions, usage, {}, {}, service};
  auto budget = std::make_shared<AiCallBudget>(service, entitlements, accounts, *observation.reporter);
  const auto principal = entitlements.aiPrincipalFor(account.id, account.email.value);
  AiSpend spend;
  spend.user = account.id;
  spend.product = "gym";
  spend.operation = "ask";
  spend.model = "claude-sonnet-5";
  Json::Value request;
  request["model"] = spend.model;
  request["max_tokens"] = 100;
  request["messages"][0]["role"] = "user";
  request["messages"][0]["content"] = "A short training question";
  const auto shortEstimate = anthropicReservationNanos(request);
  REQUIRE(shortEstimate);
  CHECK(*shortEstimate < limits.loggedInMonthlyNanos);
  Json::Value reply;
  reply["stop_reason"] = "end_turn";
  reply["usage"]["input_tokens"] = 5000;
  reply["usage"]["output_tokens"] = 100;
  reply["usage"]["cache_read_input_tokens"] = 0;
  reply["usage"]["cache_creation_input_tokens"] = 0;
  const auto actual = anthropicActualNanos(spend.model, reply["usage"]);
  REQUIRE(actual);
  CHECK(*actual > *shortEstimate);
  std::vector<long long> heldAtProvider;
  auto call = metered([&](const Json::Value& body) -> std::optional<Json::Value> {
    const auto estimate = anthropicReservationNanos(body);
    CHECK(estimate);
    if (!estimate) return std::nullopt;
    const auto snapshot = repository.snapshot(principal, at, limits);
    CHECK_EQ(snapshot.concurrentCalls, 1);
    CHECK_EQ(snapshot.subject.heldNanos, *estimate);
    heldAtProvider.push_back(snapshot.subject.heldNanos);
    return reply;
  }, spend, {}, {}, {}, {}, budget);
  CHECK(call(request).has_value());
  auto history = request;
  history["messages"][0]["content"] = std::string(12'000, 'x');
  const auto historyEstimate = anthropicReservationNanos(history);
  REQUIRE(historyEstimate);
  CHECK(*historyEstimate > *shortEstimate);
  CHECK(call(history).has_value());
  CHECK_EQ(heldAtProvider, (std::vector<long long>{*shortEstimate, *historyEstimate}));
  const auto settled = repository.snapshot(principal, at, limits);
  CHECK_EQ(settled.subject.spentNanos, 2 * *actual);
  CHECK_EQ(settled.subject.heldNanos, 0);
  CHECK_EQ(settled.subject.debtNanos, 0);
  CHECK_EQ(settled.freeMonth.spentNanos, 2 * *actual);
  CHECK_EQ(settled.freeMonth.debtNanos, 0);
  CHECK_EQ(settled.freeDay.debtNanos, 0);
  const AiBudgetPrincipal other{{AiBudgetSubjectKind::Account, "other"}, AiBudgetTier::LoggedIn};
  CHECK_EQ(repository.reserve({"other-call", other, 1, at}, limits).code, AiBudgetCode::Ok);
  CHECK(observation.reporter->issues.empty());
  PgLease conn{*pgTestPool()};
  pqxx::work txn{*conn};
  const auto rows = txn.exec("SELECT id, actual_nanos, overrun_reconciled FROM ai_budget_reservations "
                             "WHERE state = 'settled' ORDER BY id");
  REQUIRE_EQ(rows.size(), 2u);
  std::vector<std::string> ids;
  for (std::size_t index = 0; index < rows.size(); ++index) {
    CHECK_EQ(rows[index][1].as<long long>(), *actual);
    CHECK(rows[index][2].as<bool>());
    ids.push_back(rows[index][0].as<std::string>());
  }
  txn.commit();
  for (const auto& id : ids) {
    CHECK_EQ(service->settle(id, *actual).code, AiBudgetCode::Replay);
    CHECK_EQ(service->reconcileOverrun(id).code, AiBudgetCode::Replay);
  }
  CHECK(observation.reporter->issues.empty());
}

TEST(pg_ai_budget_concurrent_variances_cannot_spend_the_same_free_pool_remainder) {
  if (!std::getenv("WM_PG_TEST")) SKIP("needs WM_PG_TEST");
  const long long at = 1'767'225'600'000;
  for (const bool daily : {false, true}) {
    {
      PgLease conn{*pgTestPool()};
      pqxx::work txn{*conn};
      txn.exec("DELETE FROM ai_budget_alerts; DELETE FROM ai_budget_reservations; DELETE FROM ai_budget_balances; "
               "DELETE FROM ai_budget_grants; DELETE FROM ai_budget_device_accounts");
      txn.commit();
    }
    AiBudgetLimits limits;
    limits.freeMonthlyNanos = daily ? 1000 : 100;
    limits.freeDailyNanos = daily ? 100 : 1000;
    limits.loggedInMonthlyNanos = 1000;
    PgAiBudgetRepository repository{pgTestPool()};
    for (const auto* id : {"first", "second"}) {
      const AiBudgetPrincipal principal{{AiBudgetSubjectKind::Account, id}, AiBudgetTier::LoggedIn};
      CHECK_EQ(repository.reserve({id, principal, 10, at}, limits).code, AiBudgetCode::Ok);
      CHECK_EQ(repository.markDispatched(id).code, AiBudgetCode::Ok);
    }
    std::array<AiBudgetResult, 2> results;
    std::array<std::exception_ptr, 2> failures;
    std::barrier start{2};
    std::vector<std::thread> calls;
    for (int index = 0; index < 2; ++index) calls.emplace_back([&, index] {
      PgAiBudgetRepository process{pgTestPool()};
      start.arrive_and_wait();
      try { results[index] = process.settle(index ? "second" : "first", 60); }
      catch (...) { failures[index] = std::current_exception(); }
    });
    for (auto& call : calls) call.join();
    int covered = 0;
    for (int index = 0; index < 2; ++index) {
      CHECK_FALSE(failures[index]);
      CHECK_EQ(results[index].code, AiBudgetCode::Ok);
      REQUIRE(results[index].reservation);
      if (results[index].reservation->overrunReconciled) ++covered;
    }
    CHECK_EQ(covered, 1);
    const AiBudgetPrincipal other{{AiBudgetSubjectKind::Account, "other"}, AiBudgetTier::LoggedIn};
    const auto snapshot = repository.snapshot(other, at, limits);
    CHECK_EQ(snapshot.freeMonth.spentNanos, 120);
    CHECK_EQ(snapshot.freeDay.spentNanos, 120);
    CHECK_EQ(snapshot.freeMonth.heldNanos, 0);
    CHECK_EQ(snapshot.freeDay.heldNanos, 0);
    CHECK_EQ(snapshot.freeMonth.debtNanos, 50);
    CHECK_EQ(snapshot.freeDay.debtNanos, 50);
    CHECK_EQ(repository.reserve({"blocked", other, 1, at}, limits).code, AiBudgetCode::DebtOutstanding);
  }
}

TEST(pg_ai_budget_paid_variance_uses_only_the_original_grant_and_preserves_other_holds) {
  if (!std::getenv("WM_PG_TEST")) SKIP("needs WM_PG_TEST");
  {
    PgLease conn{*pgTestPool()};
    pqxx::work txn{*conn};
    txn.exec("DELETE FROM ai_budget_alerts; DELETE FROM ai_budget_reservations; DELETE FROM ai_budget_balances; "
             "DELETE FROM ai_budget_grants; DELETE FROM ai_budget_device_accounts");
    txn.commit();
  }
  struct Reporter final : FailureReporter {
    std::vector<std::string> operations;
    void report(const std::string&, const std::string& operation, const std::string&) override {
      operations.push_back(operation);
    }
  };
  struct ReporterScope {
    std::shared_ptr<Reporter> reporter = std::make_shared<Reporter>();
    ReporterScope() { installWriteReporter(reporter); }
    ~ReporterScope() { installWriteReporter({}); }
  } observation;
  AiBudgetLimits limits;
  limits.paidPeriodNanos = 100;
  const long long january = 1'767'225'600'000;
  const long long february = AiBudgetPeriod::at(january)->endMs;
  const AiBudgetPrincipal account{{AiBudgetSubjectKind::Account, "paid"}, AiBudgetTier::WindmillOne};
  PgAiBudgetRepository repository{pgTestPool()};
  const AiBudgetGrant first{"first-grant", "paid", AiBudgetFundingSource::Subscription,
      {january, february + 86'400'000}, 100, "first-invoice"};
  const AiBudgetGrant second{"second-grant", "paid", AiBudgetFundingSource::Subscription,
      {first.period.endMs, AiBudgetPeriod::at(february)->endMs}, 100, "second-invoice"};
  CHECK_EQ(repository.fund(first, limits).code, AiBudgetCode::Ok);
  CHECK_EQ(repository.fund(second, limits).code, AiBudgetCode::Ok);
  CHECK_EQ(repository.reserve({"covered", account, 25, january}, limits).code, AiBudgetCode::Ok);
  CHECK_EQ(repository.markDispatched("covered").code, AiBudgetCode::Ok);
  CHECK_EQ(repository.reserve({"held", account, 70, february}, limits).code, AiBudgetCode::Ok);
  AiBudgetService service{repository, [limits] { return limits; }, [february] { return february; }};
  const auto covered = service.settle("covered", 30);
  REQUIRE(covered.reservation);
  CHECK(covered.reservation->overrunReconciled);
  CHECK_EQ(covered.reservation->grantId, std::optional<std::string>{first.id});
  const auto exact = repository.snapshot(account, february, limits);
  CHECK_EQ(exact.subject.spentNanos, 30);
  CHECK_EQ(exact.subject.heldNanos, 70);
  CHECK_EQ(exact.subject.debtNanos, 0);
  CHECK(observation.reporter->operations.empty());
  CHECK_EQ(repository.release("held").code, AiBudgetCode::Ok);
  CHECK_EQ(repository.reserve({"unfunded", account, 10, february}, limits).code, AiBudgetCode::Ok);
  CHECK_EQ(repository.markDispatched("unfunded").code, AiBudgetCode::Ok);
  CHECK_EQ(repository.reserve({"new-period-hold", account, 90, second.period.startMs}, limits).code, AiBudgetCode::Ok);
  const auto unfunded = service.settle("unfunded", 80);
  REQUIRE(unfunded.reservation);
  CHECK_FALSE(unfunded.reservation->overrunReconciled);
  CHECK_EQ(service.settle("unfunded", 80).code, AiBudgetCode::Replay);
  CHECK_EQ(observation.reporter->operations, (std::vector<std::string>{"ai.budget.settle"}));
  const auto original = repository.snapshot(account, february, limits);
  CHECK_EQ(original.subject.spentNanos, 110);
  CHECK_EQ(original.subject.heldNanos, 0);
  CHECK_EQ(original.subject.debtNanos, 70);
  const auto renewed = repository.snapshot(account, second.period.startMs, limits);
  CHECK_EQ(renewed.subject.spentNanos, 0);
  CHECK_EQ(renewed.subject.heldNanos, 90);
  CHECK_EQ(renewed.subject.debtNanos, 70);
  CHECK_EQ(repository.reserve({"blocked", account, 1, second.period.startMs}, limits).code, AiBudgetCode::DebtOutstanding);
  const AiBudgetPrincipal free{{AiBudgetSubjectKind::Account, "free"}, AiBudgetTier::LoggedIn};
  CHECK_EQ(repository.reserve({"free-call", free, 1, second.period.startMs}, limits).code, AiBudgetCode::Ok);
  CHECK_EQ(repository.snapshot(free, second.period.startMs, limits).freeMonth.debtNanos, 0);
  CHECK_EQ(repository.markDispatched("new-period-hold").code, AiBudgetCode::Ok);
  const auto priorDebt = service.settle("new-period-hold", 91);
  REQUIRE(priorDebt.reservation);
  CHECK_FALSE(priorDebt.reservation->overrunReconciled);
  CHECK_EQ(repository.snapshot(account, second.period.startMs, limits).subject.debtNanos, 71);
  CHECK_EQ(observation.reporter->operations, (std::vector<std::string>{"ai.budget.settle", "ai.budget.settle"}));
}

TEST(pg_ai_budget_free_variance_keeps_original_day_and_month_funding_after_rollover) {
  if (!std::getenv("WM_PG_TEST")) SKIP("needs WM_PG_TEST");
  const long long january = 1'767'225'600'000;
  const long long february = AiBudgetPeriod::at(january)->endMs;
  for (const long long originalSpend : {60, 80}) {
    {
      PgLease conn{*pgTestPool()};
      pqxx::work txn{*conn};
      txn.exec("DELETE FROM ai_budget_alerts; DELETE FROM ai_budget_reservations; DELETE FROM ai_budget_balances; "
               "DELETE FROM ai_budget_grants; DELETE FROM ai_budget_device_accounts");
      txn.commit();
    }
    AiBudgetLimits limits;
    limits.freeMonthlyNanos = 100;
    limits.freeDailyNanos = 100;
    limits.loggedInMonthlyNanos = 1000;
    PgAiBudgetRepository repository{pgTestPool()};
    const AiBudgetPrincipal account{{AiBudgetSubjectKind::Account, "account"}, AiBudgetTier::LoggedIn};
    const AiBudgetPrincipal pending{{AiBudgetSubjectKind::Account, "pending"}, AiBudgetTier::LoggedIn};
    CHECK_EQ(repository.reserve({"january-spend", account, originalSpend, january}, limits).code, AiBudgetCode::Ok);
    CHECK_EQ(repository.markDispatched("january-spend").code, AiBudgetCode::Ok);
    CHECK_EQ(repository.settle("january-spend", originalSpend).code, AiBudgetCode::Ok);
    CHECK_EQ(repository.reserve({"pending", pending, 10, january}, limits).code, AiBudgetCode::Ok);
    CHECK_EQ(repository.markDispatched("pending").code, AiBudgetCode::Ok);
    CHECK_EQ(repository.markUncertain("pending").code, AiBudgetCode::Ok);
    CHECK_EQ(repository.reserve({"february-spend", account, 80, february}, limits).code, AiBudgetCode::Ok);
    CHECK_EQ(repository.markDispatched("february-spend").code, AiBudgetCode::Ok);
    CHECK_EQ(repository.settle("february-spend", 80).code, AiBudgetCode::Ok);
    const auto result = repository.settle("pending", 30);
    REQUIRE(result.reservation);
    CHECK_EQ(result.reservation->overrunReconciled, originalSpend == 60);
    const auto original = repository.snapshot(pending, january, limits);
    CHECK_EQ(original.subject.spentNanos, 30);
    CHECK_EQ(original.freeMonth.spentNanos, originalSpend + 30);
    CHECK_EQ(original.freeDay.spentNanos, originalSpend + 30);
    const auto current = repository.snapshot(pending, february, limits);
    CHECK_EQ(current.subject.spentNanos, 0);
    CHECK_EQ(current.subject.heldNanos, 0);
    CHECK_EQ(current.freeMonth.spentNanos, 80);
    CHECK_EQ(current.freeDay.spentNanos, 80);
    CHECK_EQ(current.freeMonth.debtNanos, originalSpend == 60 ? 0 : 20);
    CHECK_EQ(current.freeDay.debtNanos, originalSpend == 60 ? 0 : 20);
  }
}

TEST(pg_ai_budget_variance_checks_account_spend_and_all_bound_device_holds) {
  if (!std::getenv("WM_PG_TEST")) SKIP("needs WM_PG_TEST");
  const long long at = 1'767'225'600'000;
  for (const bool settleDevice : {false, true}) for (const bool covered : {false, true}) {
    {
      PgLease conn{*pgTestPool()};
      pqxx::work txn{*conn};
      txn.exec("DELETE FROM ai_budget_alerts; DELETE FROM ai_budget_reservations; DELETE FROM ai_budget_balances; "
               "DELETE FROM ai_budget_grants; DELETE FROM ai_budget_device_accounts");
      txn.commit();
    }
    AiBudgetLimits limits;
    limits.anonymousLifetimeNanos = 100;
    limits.loggedInMonthlyNanos = 100;
    const AiBudgetPrincipal account{{AiBudgetSubjectKind::Account, "account"}, AiBudgetTier::LoggedIn};
    const AiBudgetPrincipal device{{AiBudgetSubjectKind::Device, "device"}, AiBudgetTier::Anonymous};
    const AiBudgetPrincipal otherDevice{{AiBudgetSubjectKind::Device, "other-device"}, AiBudgetTier::Anonymous};
    PgAiBudgetRepository repository{pgTestPool()};
    CHECK_EQ(repository.reserve({"device-spend", device, 20, at}, limits).code, AiBudgetCode::Ok);
    CHECK_EQ(repository.markDispatched("device-spend").code, AiBudgetCode::Ok);
    CHECK_EQ(repository.settle("device-spend", 20).code, AiBudgetCode::Ok);
    if (settleDevice) {
      const long long prior = covered ? 55 : 60;
      CHECK_EQ(repository.reserve({"account-spend", account, prior, at}, limits).code, AiBudgetCode::Ok);
      CHECK_EQ(repository.markDispatched("account-spend").code, AiBudgetCode::Ok);
      CHECK_EQ(repository.settle("account-spend", prior).code, AiBudgetCode::Ok);
    }
    CHECK_EQ(repository.reserve({"pending", settleDevice ? device : account, 5, at}, limits).code, AiBudgetCode::Ok);
    CHECK_EQ(repository.markDispatched("pending").code, AiBudgetCode::Ok);
    CHECK_EQ(repository.reserve({"other-hold", otherDevice, 10, at}, limits).code, AiBudgetCode::Ok);
    CHECK_EQ(repository.bindDevice("device", "account", at, limits), AiBudgetCode::Ok);
    CHECK_EQ(repository.bindDevice("other-device", "account", at, limits), AiBudgetCode::Ok);
    const long long actual = settleDevice ? 15 : covered ? 70 : 75;
    const auto result = repository.settle("pending", actual);
    REQUIRE(result.reservation);
    CHECK_EQ(result.reservation->overrunReconciled, covered);
    const auto snapshot = repository.snapshot(account, at, limits);
    CHECK_EQ(snapshot.subject.spentNanos, covered ? 90 : 95);
    CHECK_EQ(snapshot.subject.heldNanos, 10);
    CHECK_EQ(snapshot.subject.debtNanos, covered ? 0 : actual - 5);
    CHECK_EQ(snapshot.freeMonth.spentNanos, snapshot.subject.spentNanos);
    CHECK_EQ(snapshot.freeMonth.heldNanos, 10);
    CHECK_EQ(snapshot.freeMonth.debtNanos, snapshot.subject.debtNanos);
    CHECK_EQ(repository.snapshot(otherDevice, at, limits).subject.heldNanos, 10);
    CHECK_EQ(repository.release("other-hold").code, AiBudgetCode::Ok);
    CHECK_EQ(repository.reserve({"next", account, 1, at}, limits).code,
             covered ? AiBudgetCode::Ok : AiBudgetCode::DebtOutstanding);
  }
}

TEST(pg_ai_budget_late_bound_anonymous_variance_uses_binding_cap_without_charging_new_month) {
  if (!std::getenv("WM_PG_TEST")) SKIP("needs WM_PG_TEST");
  const long long january = 1'767'225'600'000;
  const long long february = AiBudgetPeriod::at(january)->endMs;
  for (const bool covered : {false, true}) {
    {
      PgLease conn{*pgTestPool()};
      pqxx::work txn{*conn};
      txn.exec("DELETE FROM ai_budget_alerts; DELETE FROM ai_budget_reservations; DELETE FROM ai_budget_balances; "
               "DELETE FROM ai_budget_grants; DELETE FROM ai_budget_device_accounts");
      txn.commit();
    }
    AiBudgetLimits limits;
    limits.anonymousLifetimeNanos = 100;
    limits.loggedInMonthlyNanos = covered ? 40 : 30;
    PgAiBudgetRepository repository{pgTestPool()};
    const AiBudgetPrincipal device{{AiBudgetSubjectKind::Device, "device"}, AiBudgetTier::Anonymous};
    const AiBudgetPrincipal account{{AiBudgetSubjectKind::Account, "account"}, AiBudgetTier::LoggedIn};
    CHECK_EQ(repository.reserve({"old-spend", device, 20, january}, limits).code, AiBudgetCode::Ok);
    CHECK_EQ(repository.markDispatched("old-spend").code, AiBudgetCode::Ok);
    CHECK_EQ(repository.settle("old-spend", 20).code, AiBudgetCode::Ok);
    CHECK_EQ(repository.reserve({"pending", device, 5, january}, limits).code, AiBudgetCode::Ok);
    CHECK_EQ(repository.markDispatched("pending").code, AiBudgetCode::Ok);
    CHECK_EQ(repository.reserve({"new-spend", account, 25, february}, limits).code, AiBudgetCode::Ok);
    CHECK_EQ(repository.markDispatched("new-spend").code, AiBudgetCode::Ok);
    CHECK_EQ(repository.settle("new-spend", 25).code, AiBudgetCode::Ok);
    CHECK_EQ(repository.bindDevice("device", "account", february, limits), AiBudgetCode::Ok);
    const auto result = repository.settle("pending", 15);
    REQUIRE(result.reservation);
    CHECK_EQ(result.reservation->overrunReconciled, covered);
    const auto original = repository.snapshot(account, january, limits);
    CHECK_EQ(original.subject.spentNanos, 35);
    CHECK_EQ(original.subject.heldNanos, 0);
    CHECK_EQ(original.freeMonth.spentNanos, 35);
    const auto current = repository.snapshot(account, february, limits);
    CHECK_EQ(current.subject.spentNanos, 25);
    CHECK_EQ(current.subject.heldNanos, 0);
    CHECK_EQ(current.subject.debtNanos, covered ? 0 : 10);
    CHECK_EQ(current.freeMonth.spentNanos, 25);
    CHECK_EQ(current.freeMonth.debtNanos, covered ? 0 : 10);
  }
}

TEST(pg_ai_budget_partial_database_failure_rolls_back_all_counters_and_reports_one_private_issue) {
  if (!std::getenv("WM_PG_TEST")) SKIP("needs WM_PG_TEST");
  {
    PgLease conn{*pgTestPool()};
    pqxx::work txn{*conn};
    txn.exec("DELETE FROM ai_budget_alerts; DELETE FROM ai_budget_reservations; DELETE FROM ai_budget_balances; "
             "DELETE FROM ai_budget_grants; DELETE FROM ai_budget_device_accounts");
    txn.commit();
  }
  struct Reporter final : FailureReporter {
    int issues = 0;
    std::string operation;
    std::string detail;
    void report(const std::string&, const std::string& where, const std::string& value) override {
      ++issues;
      operation = where;
      detail = value;
    }
  };
  const AiBudgetLimits limits;
  const long long at = 1'767'225'600'000;
  const AiBudgetPrincipal principal{{AiBudgetSubjectKind::Account, "PRIVATE_ACCOUNT"}, AiBudgetTier::LoggedIn};
  PgAiBudgetRepository repository{pgTestPool()};
  CHECK_EQ(repository.reserve({"PRIVATE_CALL", principal, 40, at}, limits).code, AiBudgetCode::Ok);
  CHECK_EQ(repository.markDispatched("PRIVATE_CALL").code, AiBudgetCode::Ok);
  {
    PgLease conn{*pgTestPool()};
    pqxx::work txn{*conn};
    txn.exec("ALTER TABLE ai_budget_balances ADD CONSTRAINT ai_budget_test_failure "
             "CHECK (scope <> 'account_month' OR spent_nanos = 0)");
    txn.commit();
  }
  auto reporter = std::make_shared<Reporter>();
  std::vector<WriteCompletion> completions;
  installWriteReporter(reporter);
  installWriteSink([&](const WriteCompletion& completion) { completions.push_back(completion); });
  AiBudgetService service{repository, [limits] { return limits; }, [at] { return at; }};
  bool threw = false;
  try { service.settle("PRIVATE_CALL", 25); }
  catch (const pqxx::check_violation&) { threw = true; }
  catch (...) { installWriteSink({}); installWriteReporter({}); throw; }
  installWriteSink({});
  installWriteReporter({});
  {
    PgLease conn{*pgTestPool()};
    pqxx::work txn{*conn};
    txn.exec("ALTER TABLE ai_budget_balances DROP CONSTRAINT ai_budget_test_failure");
    txn.commit();
  }
  CHECK(threw);
  CHECK_EQ(reporter->issues, 1);
  CHECK_EQ(reporter->operation, std::string("ai.budget.settle"));
  CHECK(reporter->detail.find("PRIVATE") == std::string::npos);
  REQUIRE_EQ(completions.size(), 1u);
  CHECK_EQ(completions[0].operation, std::string("ai.budget.settle"));
  CHECK_EQ(completions[0].outcome, std::string("failed"));
  CHECK(writeCompletionJson(completions[0]).find("PRIVATE") == std::string::npos);
  const auto before = repository.snapshot(principal, at, limits);
  CHECK_EQ(before.subject.spentNanos, 0);
  CHECK_EQ(before.subject.heldNanos, 40);
  CHECK_EQ(before.freeMonth.spentNanos, 0);
  CHECK_EQ(before.freeMonth.heldNanos, 40);
  CHECK_EQ(before.freeDay.spentNanos, 0);
  CHECK_EQ(before.freeDay.heldNanos, 40);
  CHECK_EQ(repository.settle("PRIVATE_CALL", 25).code, AiBudgetCode::Ok);
  CHECK_EQ(repository.snapshot(principal, at, limits).subject.spentNanos, 25);
}

TEST(pg_ai_budget_replay_and_dispatch_are_single_claim_and_conflicting_subjects_are_refused) {
  if (!std::getenv("WM_PG_TEST")) SKIP("needs WM_PG_TEST");
  {
    PgLease conn{*pgTestPool()};
    pqxx::work txn{*conn};
    txn.exec("DELETE FROM ai_budget_alerts; DELETE FROM ai_budget_reservations; DELETE FROM ai_budget_balances; "
             "DELETE FROM ai_budget_grants; DELETE FROM ai_budget_device_accounts");
    txn.commit();
  }
  const AiBudgetLimits limits;
  const long long at = 1'767'225'600'000;
  const AiBudgetRequest request{"stable", {{AiBudgetSubjectKind::Account, "account"}, AiBudgetTier::LoggedIn}, 40, at};
  std::array<AiBudgetCode, 12> reserves{};
  std::array<AiBudgetCode, 12> dispatches{};
  std::array<std::exception_ptr, 12> failures;
  std::barrier start{12};
  std::vector<std::thread> calls;
  for (int index = 0; index < 12; ++index) calls.emplace_back([&, index] {
    PgAiBudgetRepository process{pgTestPool()};
    start.arrive_and_wait();
    try {
      reserves[index] = process.reserve(request, limits).code;
      dispatches[index] = process.markDispatched(request.id).code;
    } catch (...) { failures[index] = std::current_exception(); }
  });
  for (auto& call : calls) call.join();
  for (const auto& failure : failures) CHECK_FALSE(failure);
  CHECK_EQ(std::count(reserves.begin(), reserves.end(), AiBudgetCode::Ok), 1);
  CHECK_EQ(std::count(reserves.begin(), reserves.end(), AiBudgetCode::Replay), 11);
  CHECK_EQ(std::count(dispatches.begin(), dispatches.end(), AiBudgetCode::Ok), 1);
  CHECK_EQ(std::count(dispatches.begin(), dispatches.end(), AiBudgetCode::AlreadyDispatched), 11);
  PgAiBudgetRepository repository{pgTestPool()};
  auto retry = request;
  retry.atMs = AiBudgetPeriod::at(at)->endMs;
  retry.principal.tier = AiBudgetTier::WindmillOne;
  const auto replay = repository.reserve(retry, limits);
  REQUIRE(replay.reservation);
  CHECK_EQ(replay.code, AiBudgetCode::Replay);
  CHECK_EQ(replay.reservation->tier, AiBudgetTier::LoggedIn);
  CHECK_EQ(replay.reservation->admittedAtMs, at);
  retry.principal.subject.id = "other-account";
  CHECK_EQ(repository.reserve(retry, limits).code, AiBudgetCode::Conflict);
  CHECK_EQ(repository.settle("stable", 25).code, AiBudgetCode::Ok);
  CHECK_EQ(repository.settle("stable", 25).code, AiBudgetCode::Replay);
  CHECK_EQ(repository.settle("stable", 26).code, AiBudgetCode::Conflict);
  auto invalid = request;
  invalid.id = "invalid id";
  CHECK_EQ(repository.reserve(invalid, limits).code, AiBudgetCode::Invalid);
  invalid = request;
  invalid.id = "invalid-tier";
  invalid.principal.tier = AiBudgetTier::Anonymous;
  CHECK_EQ(repository.reserve(invalid, limits).code, AiBudgetCode::Invalid);
  CHECK_EQ(repository.bindDevice("invalid device", "account", at, limits), AiBudgetCode::Invalid);
  PgLease conn{*pgTestPool()};
  pqxx::work txn{*conn};
  CHECK_EQ(txn.exec("SELECT count(*) FROM ai_budget_reservations")[0][0].as<int>(), 1);
}
