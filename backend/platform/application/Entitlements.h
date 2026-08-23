#pragma once

#include "platform/domain/AiUsage.h"
#include "platform/domain/Ids.h"
#include "platform/ports/AiUsageRepository.h"
#include "platform/ports/SubscriptionRepository.h"

#include <string>

namespace wm {

// The window every AI ceiling is measured over: thirty days trailing, not a calendar month.
constexpr long long kAiWindowMs = 30LL * 24 * 60 * 60 * 1000;

// Who holds Windmill One, the brand's single paid tier, decided in one place: a live subscription
// (domain/Billing.h grantsAccess) grants it. Every product gates through here rather than reading
// the Paddle mirror itself. The AI budget lives here too — the same question in a second currency.
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

  // Background work's own, far smaller bucket, so a sweep cannot eat the allowance a user's own
  // question is then refused for. Keyed on the PRODUCT, so it meters every call under that key —
  // journal's Talk transcription spends the same ceiling journal's echo derivation does.
  AiAllowance sweepAllowanceFor(const UserId& user) const;

private:
  SubscriptionRepository& subscriptions_;
  AiUsageRepository& usage_;
  std::string owners_;   // comma-separated addresses, matched case-insensitively
};

}
