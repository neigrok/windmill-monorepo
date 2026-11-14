#pragma once

#include "platform/subscriptions/Feed.h"

#include <cstdint>
#include <optional>

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

  bool grants(Environment environment) const;
  bool hasWindmillOne() const;
  // The Entitlement a surface shows: sandbox only for an allowlisted account sandbox grants while production does not.
  Environment shown() const;
  // A sandbox period funds no grant, so an account only sandbox entitles is funded as owner access is (§6.2).
  bool fundedAsOwner() const;
};

}
