#include "platform/application/Entitlements.h"

#include "test/testing.h"

#include <map>
#include <optional>
#include <string>

using namespace wm;

namespace {

// A minimal billing mirror: one row per user, whatever status the test plants. Nothing here knows
// the access rule — that is exactly what Entitlements is being asked to own.
struct FakeSubscriptions : SubscriptionRepository {
  std::map<std::string, PaddleSubscription> byUser;

  void upsertCustomer(const PaddleCustomer&) override {}
  void upsertSubscription(const PaddleSubscription& subscription) override {
    byUser[subscription.userId] = subscription;
  }
  std::optional<PaddleSubscription> findFor(const UserId& user, const std::string&) override {
    auto it = byUser.find(user.str());
    if (it == byUser.end()) return std::nullopt;
    return it->second;
  }
  void plant(const UserId& user, const std::string& status) {
    PaddleSubscription subscription;
    subscription.userId = user.str();
    subscription.status = status;
    byUser[user.str()] = subscription;
  }
};

bool holds(const std::string& status) {
  FakeSubscriptions subs;
  subs.plant(UserId{"u"}, status);
  return Entitlements{subs}.hasWindmillOne(UserId{"u"}, "u@example.com");
}

}

TEST(an_account_with_no_mirrored_subscription_holds_nothing) {
  FakeSubscriptions subs;
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
