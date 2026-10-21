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
// The floor of the trailing window; the ledger's rows are stamped by Postgres `now()`, so no Clock
// is injected.
long long windowFloorMs() {
  const auto since = std::chrono::system_clock::now().time_since_epoch();
  return std::chrono::duration_cast<std::chrono::milliseconds>(since).count() - kAiWindowMs;
}
}

Entitlements::Entitlements(SubscriptionRepository& subscriptions, AiUsageRepository& usage,
                           std::string owners, std::vector<std::string> passiveOperations,
                           std::shared_ptr<AiBudgetService> budgets)
    : budgets_(std::move(budgets)), subscriptions_(subscriptions), usage_(usage),
      passiveOperations_(std::move(passiveOperations)), owners_(std::move(owners)) {}

// No mirrored subscription is no access.
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
  // The owner list is the only grant here that is not a subscription.
  if (isOwner(email)) return true;

  const std::optional<PaddleSubscription> subscription = subscriptions_.findFor(user, email);
  return subscription && grantsAccess(subscription->status);
}

AiBudgetPrincipal Entitlements::aiPrincipalFor(const UserId& user, const std::string& email) const {
  const bool owner = isOwner(email);
  const auto tier = hasWindmillOne(user, email) ? AiBudgetTier::WindmillOne : AiBudgetTier::LoggedIn;
  return {{AiBudgetSubjectKind::Account, user.str()}, tier, owner};
}

AiBudgetView Entitlements::aiAllowanceView(const UserId& user, const std::string& email) const {
  if (!budgets_) return {};
  return budgets_->view(aiPrincipalFor(user, email));
}

AiAllowance Entitlements::aiAllowanceFor(const UserId& user, const std::string& email) const {
  if (budgets_) {
    const auto view = aiAllowanceView(user, email);
    if (!view.configured || !view.limitNanos) return {};
    return {*view.limitNanos, *view.limitNanos - view.remainingNanos};
  }
  const long long limit =
      hasWindmillOne(user, email) ? kProMonthlyAiNanos : kFreeMonthlyAiNanos;
  // An empty product is every product.
  return AiAllowance{limit, usage_.spentSinceNanos(
      user, "", windowFloorMs(), {AiOperationMatch::Exclude, passiveOperations_})};
}

AiAllowance Entitlements::sweepAllowanceFor(const UserId& user, const std::string& product) const {
  return AiAllowance{kSweepMonthlyAiNanos, usage_.spentSinceNanos(
      user, product, windowFloorMs(), {AiOperationMatch::Include, passiveOperations_})};
}

}
