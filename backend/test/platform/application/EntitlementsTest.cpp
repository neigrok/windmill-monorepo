#include "platform/application/Entitlements.h"

#include "test/platform/Fakes.h"
#include "test/testing.h"

#include <chrono>
#include <string>

using namespace wm;
using namespace wm::fake;

namespace {

bool holds(const std::string& status) {
  FakeSubscriptionRepository subs;
  FakeAiUsageRepository usage;
  subs.subscribe(UserId{"u"}, status);
  return Entitlements{subs, usage}.hasWindmillOne(UserId{"u"}, "u@example.com");
}

long long nowMs() {
  const auto since = std::chrono::system_clock::now().time_since_epoch();
  return std::chrono::duration_cast<std::chrono::milliseconds>(since).count();
}

}

TEST(an_account_with_no_mirrored_subscription_holds_nothing) {
  FakeSubscriptionRepository subs;
  FakeAiUsageRepository usage;
  CHECK_EQ((Entitlements{subs, usage}.hasWindmillOne(UserId{"u"}, "u@example.com")), false);
}

TEST(a_live_subscription_grants_windmill_one) {
  CHECK_EQ(holds("active"), true);
  CHECK_EQ(holds("trialing"), true);
  CHECK_EQ(holds("past_due"), true);      // kept through dunning, on purpose
}

TEST(a_lapsed_or_paused_subscription_grants_nothing) {
  CHECK_EQ(holds("paused"), false);
  CHECK_EQ(holds("canceled"), false);
  CHECK_EQ(holds("unknown_future_status"), false);
}

TEST(a_free_account_spends_up_to_the_free_ceiling_and_not_past_it) {
  FakeSubscriptionRepository subs;
  FakeAiUsageRepository usage;
  Entitlements entitlements{subs, usage};

  usage.spentByProduct[""] = kFreeMonthlyAiNanos - 1;
  const AiAllowance under = entitlements.aiAllowanceFor(UserId{"u"}, "u@example.com");
  CHECK_EQ(under.limitNanos, kFreeMonthlyAiNanos);
  CHECK_EQ(under.spentNanos, kFreeMonthlyAiNanos - 1);
  CHECK_EQ(under.remainingNanos(), 1);
  CHECK_EQ(under.allows(), true);

  // Exactly at the ceiling is spent, not allowed — the limit is the last nano you may reach, not
  // one more call.
  usage.spentByProduct[""] = kFreeMonthlyAiNanos;
  const AiAllowance at = entitlements.aiAllowanceFor(UserId{"u"}, "u@example.com");
  CHECK_EQ(at.remainingNanos(), 0);
  CHECK_EQ(at.allows(), false);

  usage.spentByProduct[""] = kFreeMonthlyAiNanos + 1'000;
  const AiAllowance over = entitlements.aiAllowanceFor(UserId{"u"}, "u@example.com");
  CHECK_EQ(over.remainingNanos(), 0);
  CHECK_EQ(over.allows(), false);
}

TEST(windmill_one_raises_the_ceiling_to_the_pro_one) {
  FakeSubscriptionRepository subs;
  FakeAiUsageRepository usage;
  subs.subscribe(UserId{"u"});
  Entitlements entitlements{subs, usage};

  // The spend that exhausts a free account leaves a subscriber with room, and the pro ceiling
  // refuses at its own line.
  usage.spentByProduct[""] = kFreeMonthlyAiNanos;
  const AiAllowance under = entitlements.aiAllowanceFor(UserId{"u"}, "u@example.com");
  CHECK_EQ(under.limitNanos, kProMonthlyAiNanos);
  CHECK_EQ(under.remainingNanos(), kProMonthlyAiNanos - kFreeMonthlyAiNanos);
  CHECK_EQ(under.allows(), true);

  usage.spentByProduct[""] = kProMonthlyAiNanos;
  CHECK_EQ(entitlements.aiAllowanceFor(UserId{"u"}, "u@example.com").allows(), false);
}

TEST(the_sweep_bucket_is_its_own_and_a_maxed_one_leaves_the_account_free_to_ask) {
  FakeSubscriptionRepository subs;
  FakeAiUsageRepository usage;
  Entitlements entitlements{subs, usage};

  // Journal has spent its whole background bucket; the account's own total is nowhere near its
  // ceiling. The sweep stops. Nothing the person asks for does.
  usage.spentByProduct["journal"] = kSweepMonthlyAiNanos;
  usage.spentByProduct[""] = kSweepMonthlyAiNanos;

  const AiAllowance sweep = entitlements.sweepAllowanceFor(UserId{"u"});
  CHECK_EQ(sweep.limitNanos, kSweepMonthlyAiNanos);
  CHECK_EQ(sweep.spentNanos, kSweepMonthlyAiNanos);
  CHECK_EQ(sweep.allows(), false);

  const AiAllowance account = entitlements.aiAllowanceFor(UserId{"u"}, "u@example.com");
  CHECK_EQ(account.limitNanos, kFreeMonthlyAiNanos);
  CHECK_EQ(account.spentNanos, kSweepMonthlyAiNanos);
  CHECK_EQ(account.allows(), true);
}

TEST(both_ceilings_are_measured_over_the_trailing_thirty_days) {
  FakeSubscriptionRepository subs;
  FakeAiUsageRepository usage;
  Entitlements entitlements{subs, usage};

  const long long before = nowMs();
  entitlements.aiAllowanceFor(UserId{"u"}, "u@example.com");
  entitlements.sweepAllowanceFor(UserId{"u"});
  const long long after = nowMs();

  CHECK_EQ(usage.asked.size(), std::size_t{2});
  // The account's ceiling reads every product; the sweep's reads journal's bucket alone.
  CHECK_EQ(usage.asked[0].user.str(), std::string{"u"});
  CHECK_EQ(usage.asked[0].product, std::string{""});
  CHECK_EQ(usage.asked[1].product, std::string{"journal"});
  for (const FakeAiUsageRepository::Query& query : usage.asked) {
    CHECK_EQ(query.sinceMs >= before - kAiWindowMs, true);
    CHECK_EQ(query.sinceMs <= after - kAiWindowMs, true);
  }
  CHECK_EQ(kAiWindowMs, 2'592'000'000LL);  // thirty days, and not a calendar month
}
