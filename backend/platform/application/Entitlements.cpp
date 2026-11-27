#include "platform/application/Entitlements.h"

#include <algorithm>
#include <chrono>
#include <cstddef>
#include <string>
#include <utility>

namespace wm {

namespace {
// The floor of the trailing window. The ledger's rows are stamped by Postgres `now()`, so it reads the system clock,
// not the injected one that access is read against.
long long windowFloorMs() {
  const auto since = std::chrono::system_clock::now().time_since_epoch();
  return std::chrono::duration_cast<std::chrono::milliseconds>(since).count() - kAiWindowMs;
}

std::string folded(std::string_view text) {
  std::string out;
  for (const char c : text) {
    if (c == ' ' || c == '\t') continue;
    out.push_back(c >= 'A' && c <= 'Z' ? static_cast<char>(c + ('a' - 'A')) : c);
  }
  return out;
}
}

EmailList::EmailList(std::string_view listed) {
  std::size_t at = 0;
  while (at <= listed.size()) {
    const std::size_t end = std::min(listed.find(',', at), listed.size());
    std::string address = folded(listed.substr(at, end - at));
    if (!address.empty()) addresses_.push_back(std::move(address));
    at = end + 1;
  }
}

bool EmailList::contains(std::string_view email) const {
  const std::string wanted = folded(email);
  return !wanted.empty() && std::find(addresses_.begin(), addresses_.end(), wanted) != addresses_.end();
}

Entitlements::Entitlements(subscriptions::EntitlementReader& copy, Clock& clock, AiUsageRepository& usage,
                           Allowlists lists, std::shared_ptr<AiBudgetService> budgets)
    : budgets_(std::move(budgets)), copy_(copy), clock_(clock), usage_(usage), lists_(std::move(lists)) {}

bool Entitlements::isOwner(const std::string& email) const {
  return lists_.owners.contains(email);
}

subscriptions::Standing Entitlements::standingOf(const UserId& user, const std::string& email) const {
  return {isOwner(email), lists_.sandboxTesters.contains(email), copy_.find(user),
          static_cast<std::int64_t>(clock_.nowMs())};
}

// An owner holds Windmill One without the copy being read, so no failure to read it ever takes an owner's access.
bool Entitlements::hasWindmillOne(const UserId& user, const std::string& email) const {
  if (isOwner(email)) return true;
  return standingOf(user, email).hasWindmillOne();
}

AiBudgetPrincipal Entitlements::aiPrincipalFor(const UserId& user, const std::string& email) const {
  const AiBudgetSubject subject{AiBudgetSubjectKind::Account, user.str()};
  if (isOwner(email)) return {subject, AiBudgetTier::WindmillOne, true};
  const subscriptions::Standing standing = standingOf(user, email);
  const auto tier = standing.hasWindmillOne() ? AiBudgetTier::WindmillOne : AiBudgetTier::LoggedIn;
  return {subject, tier, standing.fundedAsOwner()};
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
  return AiAllowance{limit, usage_.spentSinceNanos(user, "", windowFloorMs())};
}

}
