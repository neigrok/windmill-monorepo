#pragma once

#include "platform/domain/AiUsage.h"
#include "platform/domain/Ids.h"
#include "platform/ports/AiUsageRepository.h"
#include "platform/ports/SubscriptionRepository.h"

#include <string>

namespace wm {

// The window every AI ceiling is measured over: thirty days TRAILING, not a calendar month. A
// calendar total cannot stop an account spending the month in an afternoon — on the first it is
// empty again however much yesterday cost, which is precisely the shape a runaway takes.
constexpr long long kAiWindowMs = 30LL * 24 * 60 * 60 * 1000;

// Who holds Windmill One — the brand's single paid tier — decided by one rule in one place. A live
// subscription (active / trialing / past_due; see domain/Billing.h grantsAccess) grants it. The
// products ask this a domain question: Talk, echoes, and tending all gate through here instead of
// each reaching into the Paddle subscription mirror and re-deriving the rule. When a second tier or
// a per-feature grant ever exists it is added here, and every caller inherits it at once.
//
// The AI budget is the first thing to take that promise up. It is the same question in a second
// currency — what may this account still be given — so it lives beside the plan rather than in an
// AiBudgetService that would have to re-derive the plan to answer at all. Two ceilings measure two
// different things and both stay: the natural-unit allowances (30/300 tend runs) are the promise a
// pricing page can state, and the dollar ceilings below are OUR fuse, never shown to anybody.
class Entitlements {
public:
  Entitlements(SubscriptionRepository& subscriptions, AiUsageRepository& usage);

  bool hasWindmillOne(const UserId& user, const std::string& email) const;

  // Everything this account has spent across every product in the trailing window, against the
  // ceiling its plan grants.
  AiAllowance aiAllowanceFor(const UserId& user, const std::string& email) const;

  // Background work's OWN bucket, and far smaller. A six-hourly journal sweep nobody asked for must
  // not be able to eat the allowance the question they DID ask is then refused for, and one shared
  // per-user budget made exactly that possible.
  //
  // It is keyed on the PRODUCT, so what it actually meters is all of journal's model spend, not the
  // sweep alone. That moment arrived on 2026-08-22: voice (OpenAI transcription) became journal's
  // second vendor call and is metered under the same product key, so a member who uses Talk heavily
  // spends this ceiling and their echoes then stop deriving — quietly, because derivePage simply
  // reports the budget and writes nothing. Whether Talk belongs in the sweep's bucket at all is a
  // product decision nobody has made yet; until it is made, this is what the key does.
  AiAllowance sweepAllowanceFor(const UserId& user) const;

private:
  SubscriptionRepository& subscriptions_;
  AiUsageRepository& usage_;
};

}
