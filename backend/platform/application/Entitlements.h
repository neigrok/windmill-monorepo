#pragma once

#include "platform/domain/AiUsage.h"
#include "platform/domain/Ids.h"
#include "platform/ports/AiUsageRepository.h"
#include "platform/ports/SubscriptionRepository.h"

#include <string>

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
               std::string owners = {});

  bool hasWindmillOne(const UserId& user, const std::string& email) const;

  // Asked apart from the plan: a surface can need this without inheriting anything about payment.
  bool isOwner(const std::string& email) const;

  // Everything the account spent across every product in the window, against its plan's ceiling.
  AiAllowance aiAllowanceFor(const UserId& user, const std::string& email) const;

  // Background work's own, far smaller bucket. Keyed on the PRODUCT, so every call under that key
  // shares one ceiling.
  AiAllowance sweepAllowanceFor(const UserId& user) const;

private:
  SubscriptionRepository& subscriptions_;
  AiUsageRepository& usage_;
  std::string owners_;   // comma-separated addresses, matched case-insensitively
};

}
