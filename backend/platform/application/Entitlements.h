#pragma once

#include "platform/domain/AiUsage.h"
#include "platform/domain/Ids.h"
#include "platform/ports/AiUsageRepository.h"
#include "platform/ports/SubscriptionRepository.h"

#include <string>
#include <vector>

namespace wm {

// The window every AI ceiling is measured over: thirty days trailing, not a calendar month.
constexpr long long kAiWindowMs = 30LL * 24 * 60 * 60 * 1000;

// The one seam every product asks about Windmill One and about AI budget; never read the Paddle
// mirror directly.
class Entitlements {
public:
  // `owners` is a comma-separated list of addresses from WINDMILL_OWNER_EMAILS, granting exactly
  // what a subscription grants and nothing more. Empty by default.
  Entitlements(SubscriptionRepository& subscriptions, AiUsageRepository& usage,
               std::string owners = {}, std::vector<std::string> passiveOperations = {});

  bool hasWindmillOne(const UserId& user, const std::string& email) const;

  // Asked apart from the plan: a surface can need this without inheriting anything about payment.
  bool isOwner(const std::string& email) const;

  // Active usage across every product in the window, against the account plan's ceiling.
  AiAllowance aiAllowanceFor(const UserId& user, const std::string& email) const;

  // Passive work has a separate operational ceiling for each product.
  AiAllowance sweepAllowanceFor(const UserId& user, const std::string& product) const;

private:
  SubscriptionRepository& subscriptions_;
  AiUsageRepository& usage_;
  std::vector<std::string> passiveOperations_;
  std::string owners_;   // comma-separated addresses, matched case-insensitively
};

}
