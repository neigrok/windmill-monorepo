#pragma once

#include "platform/domain/Ids.h"
#include "platform/ports/SubscriptionRepository.h"

#include <string>

namespace wm {

// Who holds Windmill One — the brand's single paid tier — decided by one rule in one place. A live
// subscription (active / trialing / past_due; see domain/Billing.h grantsAccess) grants it. The
// products ask this a domain question: Talk, echoes, and tending all gate through here instead of
// each reaching into the Paddle subscription mirror and re-deriving the rule. When a second tier or
// a per-feature grant ever exists it is added here, and every caller inherits it at once.
class Entitlements {
public:
  explicit Entitlements(SubscriptionRepository& subscriptions);

  bool hasWindmillOne(const UserId& user, const std::string& email) const;

private:
  SubscriptionRepository& subscriptions_;
};

}
