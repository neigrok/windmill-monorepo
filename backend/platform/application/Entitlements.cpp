#include "platform/application/Entitlements.h"

#include "platform/domain/Billing.h"

#include <optional>

namespace wm {

Entitlements::Entitlements(SubscriptionRepository& subscriptions) : subscriptions_(subscriptions) {}

// The repository resolves WHICH subscription decides this account (either binding, preferring any
// live row — see the port); here we only apply the access rule to whatever it returns. No mirrored
// subscription at all is simply no access.
bool Entitlements::hasWindmillOne(const UserId& user, const std::string& email) const {
  const std::optional<PaddleSubscription> subscription = subscriptions_.findFor(user, email);
  return subscription && grantsAccess(subscription->status);
}

}
