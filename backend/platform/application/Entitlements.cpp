#include "platform/application/Entitlements.h"

#include "platform/domain/Billing.h"

#include <chrono>
#include <optional>

namespace wm {

namespace {
// The floor of the trailing window. No Clock is injected here on purpose: the ledger's rows are
// stamped by Postgres `now()` and this is the only other reader of that same wall time, so a
// second, settable clock would only let the two disagree.
long long windowFloorMs() {
  const auto since = std::chrono::system_clock::now().time_since_epoch();
  return std::chrono::duration_cast<std::chrono::milliseconds>(since).count() - kAiWindowMs;
}
}

Entitlements::Entitlements(SubscriptionRepository& subscriptions, AiUsageRepository& usage)
    : subscriptions_(subscriptions), usage_(usage) {}

// The repository resolves WHICH subscription decides this account (either binding, preferring any
// live row — see the port); here we only apply the access rule to whatever it returns. No mirrored
// subscription at all is simply no access.
bool Entitlements::hasWindmillOne(const UserId& user, const std::string& email) const {
  const std::optional<PaddleSubscription> subscription = subscriptions_.findFor(user, email);
  return subscription && grantsAccess(subscription->status);
}

AiAllowance Entitlements::aiAllowanceFor(const UserId& user, const std::string& email) const {
  const long long limit =
      hasWindmillOne(user, email) ? kProMonthlyAiNanos : kFreeMonthlyAiNanos;
  // An empty product is every product: one account, one total, whatever it was spent on.
  return AiAllowance{limit, usage_.spentSinceNanos(user, "", windowFloorMs())};
}

// Keyed by PRODUCT, which is the grain the ledger records — so this bucket holds everything journal
// spent for this account, the sweep and their own Talk alike. Coarser than "the sweep only", and
// deliberately so: the fact worth defending is that the foreground question the user asked cannot be
// starved by the background one they didn't, and a product-sized bucket already guarantees that.
AiAllowance Entitlements::sweepAllowanceFor(const UserId& user) const {
  return AiAllowance{kSweepMonthlyAiNanos, usage_.spentSinceNanos(user, "journal", windowFloorMs())};
}

}
