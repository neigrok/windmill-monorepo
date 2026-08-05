#include "platform/application/Entitlements.h"

#include "test/platform/Fakes.h"
#include "test/testing.h"

#include <string>

using namespace wm;
using namespace wm::fake;

namespace {

bool holds(const std::string& status) {
  FakeSubscriptionRepository subs;
  subs.subscribe(UserId{"u"}, status);
  return Entitlements{subs}.hasWindmillOne(UserId{"u"}, "u@example.com");
}

}

TEST(an_account_with_no_mirrored_subscription_holds_nothing) {
  FakeSubscriptionRepository subs;
  CHECK_EQ(Entitlements{subs}.hasWindmillOne(UserId{"u"}, "u@example.com"), false);
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
