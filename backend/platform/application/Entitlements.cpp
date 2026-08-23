#include "platform/application/Entitlements.h"

#include "platform/domain/Billing.h"

#include <algorithm>
#include <chrono>
#include <cstddef>
#include <optional>
#include <string>
#include <utility>

namespace wm {

namespace {
// The floor of the trailing window. No Clock is injected: the ledger's rows are stamped by
// Postgres `now()`, and a second settable clock would only let the two disagree.
long long windowFloorMs() {
  const auto since = std::chrono::system_clock::now().time_since_epoch();
  return std::chrono::duration_cast<std::chrono::milliseconds>(since).count() - kAiWindowMs;
}
}

Entitlements::Entitlements(SubscriptionRepository& subscriptions, AiUsageRepository& usage,
                           std::string owners)
    : subscriptions_(subscriptions), usage_(usage), owners_(std::move(owners)) {}

// The repository resolves which subscription decides this account; this applies the access rule to
// whatever it returns. No mirrored subscription is no access.
bool Entitlements::isOwner(const std::string& email) const {
  if (owners_.empty() || email.empty()) return false;

  // Compared lowercased and trimmed, since the list is typed by a person into a deploy variable.
  // Split on commas only — no address contains one.
  const auto folded = [](std::string text) {
    std::string out;
    for (const char c : text) {
      if (c == ' ' || c == '\t') continue;
      out.push_back(c >= 'A' && c <= 'Z' ? static_cast<char>(c + ('a' - 'A')) : c);
    }
    return out;
  };
  const std::string wanted = folded(email);
  if (wanted.empty()) return false;

  std::size_t at = 0;
  while (at <= owners_.size()) {
    const std::size_t end = std::min(owners_.find(',', at), owners_.size());
    if (folded(owners_.substr(at, end - at)) == wanted) return true;
    at = end + 1;
  }
  return false;
}

bool Entitlements::hasWindmillOne(const UserId& user, const std::string& email) const {
  // The owner list first: it is the only grant here that is not a subscription.
  if (isOwner(email)) return true;

  const std::optional<PaddleSubscription> subscription = subscriptions_.findFor(user, email);
  return subscription && grantsAccess(subscription->status);
}

AiAllowance Entitlements::aiAllowanceFor(const UserId& user, const std::string& email) const {
  const long long limit =
      hasWindmillOne(user, email) ? kProMonthlyAiNanos : kFreeMonthlyAiNanos;
  // An empty product is every product.
  return AiAllowance{limit, usage_.spentSinceNanos(user, "", windowFloorMs())};
}

// Keyed by PRODUCT, the grain the ledger records, so this bucket holds everything that product
// spent for the account. That is enough to keep a background pass from starving a foreground one.
AiAllowance Entitlements::sweepAllowanceFor(const UserId& user) const {
  return AiAllowance{kSweepMonthlyAiNanos, usage_.spentSinceNanos(user, "journal", windowFloorMs())};
}

}
