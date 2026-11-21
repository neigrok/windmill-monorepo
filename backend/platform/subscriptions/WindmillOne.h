#pragma once

#include "platform/subscriptions/Feed.h"

#include <json/json.h>

#include <cstdint>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

namespace wm::subscriptions {

// D-2: each environment keeps an Entitlement of its own.
enum class Environment { Production, Sandbox };

// One account's hold on Windmill One at one instant (§6.1, §6.2): its row of the copy read against the clock, the owner
// list and the sandbox allowlist. Access is the clock before an `accessUntil`, so it lapses with nothing running (INV-3)
// and no request asks the subscription service (INV-10).
struct Standing {
  bool owner = false;
  bool allowlisted = false;                       // on the sandbox allowlist: its sandbox purchases count
  std::optional<EntitlementResponse> entitlement;  // the copy's row; none for an account the feed never named
  std::int64_t now = 0;
  bool recordedClaim = false;  // a claim the service recorded that the copy has not reached yet (§5.3)

  bool grants(Environment environment) const;
  bool hasWindmillOne() const;
  // The Entitlement a surface shows: sandbox only for an allowlisted account sandbox grants while production does not.
  Environment shown() const;
  // A sandbox period funds no grant, so an account only sandbox entitles is funded as owner access is (§6.2).
  bool fundedAsOwner() const;
};

// The paid line as configuration opens it (§5.3): the stores a person may buy through, every one closed by default, and
// what a month of Windmill One funds.
struct PaidLine {
  // `purchasableStores` is SUBSCRIPTIONS_PURCHASABLE_STORES: `app_store` and `play_store`, comma-separated. Any other
  // name, `paddle` included, opens nothing, so a typo leaves that store closed and the server serving;
  // `namesUnknownStore` says one was given.
  PaidLine(std::string_view purchasableStores, long long aiAllowanceNanos);

  std::vector<std::string> openStores;  // in D-1's order
  bool namesUnknownStore = false;
  long long aiAllowanceNanos = 0;
};

// §5.3 SubscriptionResponse: whether the account holds Windmill One, as every gate reads it; the Entitlement shown and
// which environment it is, whether the account is on the sandbox allowlist, where its governing subscription is managed,
// the stores it may buy through now (INV-12), none beside a recorded claim, and the offer beside them, which is there
// exactly when a store is.
struct SubscriptionResponse {
  SubscriptionResponse(const Standing& standing, const PaidLine& line);

  Json::Value body;
};

}
