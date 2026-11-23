#include "platform/application/Entitlements.h"

#include "test/platform/Fakes.h"
#include "test/testing.h"

#include <chrono>
#include <optional>
#include <stdexcept>
#include <string>

using namespace wm;
using namespace wm::fake;

namespace {

long long nowMs() {
  const auto since = std::chrono::system_clock::now().time_since_epoch();
  return std::chrono::duration_cast<std::chrono::milliseconds>(since).count();
}

// What every gate reads for one account, one line: Windmill One, the AI tier, whether it is funded as owner access is,
// and the Entitlement a surface shows.
std::string answers(const Entitlements& entitlements, const UserId& user, const std::string& email) {
  const AiBudgetPrincipal principal = entitlements.aiPrincipalFor(user, email);
  const subscriptions::Standing standing = entitlements.standingOf(user, email);
  return std::string(entitlements.hasWindmillOne(user, email) ? "one" : "free") + " " +
         std::string(aiBudgetTierName(principal.tier)) + (principal.owner ? " owner-funded" : "") + " shows " +
         (standing.shown() == subscriptions::Environment::Sandbox ? "sandbox" : "production");
}

}

TEST(windmill_one_ends_with_the_copy_s_access_until_by_the_clock_alone) {
  FakeEntitlementCopy copy;
  FakeClock clock;
  FakeAiUsageRepository usage;
  const Entitlements entitlements{copy, clock, usage};
  const UserId buyer{"buyer"};
  copy.plant(buyer, 1'800'000'000'000);

  std::string seen;
  for (const UnixMs at : {1'799'999'999'999ULL, 1'800'000'000'000ULL, 1'800'000'000'001ULL}) {
    clock.now = at;
    seen += std::to_string(at) + " " + answers(entitlements, buyer, "buyer@example.com") + "\n";
  }
  CHECK_EQ(seen, std::string("1799999999999 one windmill_one shows production\n"
                             "1800000000000 free logged_in shows production\n"
                             "1800000000001 free logged_in shows production\n"));
}

TEST(a_sandbox_entitlement_grants_an_allowlisted_account_and_no_other) {
  FakeEntitlementCopy copy;
  FakeClock clock;
  FakeAiUsageRepository usage;
  const Entitlements entitlements{copy, clock, usage, {.sandboxTesters = EmailList{"Tester@Example.com, review@example.com"}}};
  const UserId tester{"tester"};
  const UserId stranger{"stranger"};
  const UserId both{"both"};
  copy.plant(tester, std::nullopt, 1'700'000'300'000);
  copy.plant(stranger, std::nullopt, 1'700'000'300'000);
  copy.plant(both, 1'700'000'600'000, 1'700'000'300'000);

  std::string seen;
  for (const UnixMs at : {1'700'000'000'000ULL, 1'700'000'300'000ULL}) {
    clock.now = at;
    seen += std::to_string(at) + "\n";
    seen += "  tester " + answers(entitlements, tester, "tester@example.com") + "\n";
    seen += "  stranger " + answers(entitlements, stranger, "stranger@example.com") + "\n";
    seen += "  both " + answers(entitlements, both, "review@example.com") + "\n";
  }
  // A sandbox period funds no grant, so a tester only sandbox entitles is funded as owner access is (§6.2); one that
  // production entitles is funded by its periods.
  CHECK_EQ(seen, std::string("1700000000000\n"
                             "  tester one windmill_one owner-funded shows sandbox\n"
                             "  stranger free logged_in shows production\n"
                             "  both one windmill_one shows production\n"
                             "1700000300000\n"
                             "  tester free logged_in shows production\n"
                             "  stranger free logged_in shows production\n"
                             "  both one windmill_one shows production\n"));
}

// The live copy holds no row until the subscription service serves its feed: then only the owner list grants anything.
TEST(an_account_the_feed_never_named_holds_windmill_one_only_as_an_owner) {
  FakeEntitlementCopy copy;
  FakeClock clock;
  FakeAiUsageRepository usage;
  const Entitlements entitlements{copy, clock, usage, {.owners = EmailList{"Sam@Example.com, other@windmill.works"}}};

  CHECK_EQ(answers(entitlements, UserId{"u1"}, "sam@example.com"), std::string("one windmill_one owner-funded shows production"));
  CHECK_EQ(answers(entitlements, UserId{"u2"}, "stranger@example.com"), std::string("free logged_in shows production"));
  CHECK_EQ(entitlements.isOwner("other@windmill.works"), true);
  CHECK_EQ(entitlements.isOwner(" OTHER@WINDMILL.WORKS "), true);
  CHECK_EQ(entitlements.isOwner(""), false);
  CHECK_EQ(entitlements.isOwner("sam@example.co"), false);
  CHECK_EQ(entitlements.isOwner("am@example.com"), false);

  const Entitlements nobody{copy, clock, usage};
  CHECK_EQ(answers(nobody, UserId{"u1"}, "sam@example.com"), std::string("free logged_in shows production"));
  CHECK_EQ(nobody.isOwner("sam@example.com"), false);
}

// An owner holds Windmill One without the copy being read: a copy that cannot be read takes nothing from an owner, and
// fails everyone else's read loudly rather than answering free.
TEST(an_owner_holds_windmill_one_and_its_ai_tier_without_the_copy_being_read) {
  struct UnreadableCopy : subscriptions::EntitlementReader {
    int reads = 0;
    std::optional<subscriptions::EntitlementResponse> find(const UserId&) override {
      ++reads;
      throw std::runtime_error("the copy cannot be read");
    }
  } copy;
  FakeClock clock;
  FakeAiUsageRepository usage;
  const Entitlements entitlements{copy, clock, usage, {.owners = EmailList{"owner@example.com"}}};

  CHECK(entitlements.hasWindmillOne(UserId{"owner"}, "owner@example.com"));
  const AiBudgetPrincipal principal = entitlements.aiPrincipalFor(UserId{"owner"}, "Owner@Example.com");
  CHECK(principal.tier == AiBudgetTier::WindmillOne);
  CHECK(principal.owner);
  CHECK_EQ(copy.reads, 0);

  bool refused = false;
  try {
    entitlements.hasWindmillOne(UserId{"someone"}, "someone@example.com");
  } catch (const std::runtime_error&) {
    refused = true;
  }
  CHECK(refused);
  CHECK_EQ(copy.reads, 1);
}

TEST(a_free_account_spends_up_to_the_free_ceiling_and_not_past_it) {
  FakeEntitlementCopy copy;
  FakeClock clock;
  FakeAiUsageRepository usage;
  Entitlements entitlements{copy, clock, usage};

  usage.spentByProduct[""] = kFreeMonthlyAiNanos - 1;
  const AiAllowance under = entitlements.aiAllowanceFor(UserId{"u"}, "u@example.com");
  CHECK_EQ(under.limitNanos, kFreeMonthlyAiNanos);
  CHECK_EQ(under.spentNanos, kFreeMonthlyAiNanos - 1);
  CHECK_EQ(under.remainingNanos(), 1);
  CHECK_EQ(under.allows(), true);

  // Exactly at the ceiling is spent, not allowed.
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
  FakeEntitlementCopy copy;
  FakeClock clock;
  FakeAiUsageRepository usage;
  copy.subscribe(UserId{"u"});
  Entitlements entitlements{copy, clock, usage};

  usage.spentByProduct[""] = kFreeMonthlyAiNanos;
  const AiAllowance under = entitlements.aiAllowanceFor(UserId{"u"}, "u@example.com");
  CHECK_EQ(under.limitNanos, kProMonthlyAiNanos);
  CHECK_EQ(under.remainingNanos(), kProMonthlyAiNanos - kFreeMonthlyAiNanos);
  CHECK_EQ(under.allows(), true);

  usage.spentByProduct[""] = kProMonthlyAiNanos;
  CHECK_EQ(entitlements.aiAllowanceFor(UserId{"u"}, "u@example.com").allows(), false);
}

TEST(the_legacy_allowance_reads_every_product_over_the_trailing_thirty_days) {
  FakeEntitlementCopy copy;
  FakeClock clock;
  FakeAiUsageRepository usage;
  Entitlements entitlements{copy, clock, usage};

  const long long before = nowMs();
  entitlements.aiAllowanceFor(UserId{"u"}, "u@example.com");
  const long long after = nowMs();

  REQUIRE_EQ(usage.asked.size(), std::size_t{1});
  CHECK_EQ(usage.asked[0].user.str(), std::string{"u"});
  CHECK_EQ(usage.asked[0].product, std::string{""});
  CHECK_EQ(usage.asked[0].sinceMs >= before - kAiWindowMs, true);
  CHECK_EQ(usage.asked[0].sinceMs <= after - kAiWindowMs, true);
  CHECK_EQ(kAiWindowMs, 2'592'000'000LL);
}
