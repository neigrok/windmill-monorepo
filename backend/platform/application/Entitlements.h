#pragma once

#include "platform/domain/AiUsage.h"
#include "platform/application/AiBudgetService.h"
#include "platform/domain/Ids.h"
#include "platform/ports/AiUsageRepository.h"
#include "platform/ports/SubscriptionRepository.h"

#include <memory>
#include <string>
#include <vector>

namespace wm {

// The legacy allowance window used when durable USD allowances are disabled.
constexpr long long kAiWindowMs = 30LL * 24 * 60 * 60 * 1000;

// The one seam every product asks about Windmill One and about AI budget; never read the Paddle
// mirror directly.
class Entitlements {
public:
  // Owner addresses grant One access and an explicit funded calendar-month AI allowance.
  Entitlements(SubscriptionRepository& subscriptions, AiUsageRepository& usage,
               std::string owners = {}, std::vector<std::string> passiveOperations = {},
               std::shared_ptr<AiBudgetService> budgets = nullptr);

  bool aiAllowancesEnabled() const { return bool(budgets_); }
  AiBudgetPrincipal aiPrincipalFor(const UserId& user, const std::string& email) const;
  AiBudgetView aiAllowanceView(const UserId& user, const std::string& email) const;

  bool hasWindmillOne(const UserId& user, const std::string& email) const;

  // Asked apart from the plan: a surface can need this without inheriting anything about payment.
  bool isOwner(const std::string& email) const;

  // Every enabled-mode call debits the principal; legacy mode uses active usage.
  AiAllowance aiAllowanceFor(const UserId& user, const std::string& email) const;

  // Passive work has a separate operational ceiling for each product.
  AiAllowance sweepAllowanceFor(const UserId& user, const std::string& product) const;

private:
  std::shared_ptr<AiBudgetService> budgets_;
  SubscriptionRepository& subscriptions_;
  AiUsageRepository& usage_;
  std::vector<std::string> passiveOperations_;
  std::string owners_;   // comma-separated addresses, matched case-insensitively
};

}
