#include "platform/subscriptions/WindmillOne.h"

namespace wm::subscriptions {

bool Standing::grants(Environment environment) const {
  if (!entitlement) return false;
  const std::optional<std::int64_t>& until = environment == Environment::Production
      ? entitlement->productionAccessUntil : entitlement->sandboxAccessUntil;
  return until && now < *until;
}

bool Standing::hasWindmillOne() const {
  return owner || grants(Environment::Production) || (allowlisted && grants(Environment::Sandbox));
}

Environment Standing::shown() const {
  const bool sandboxAlone = grants(Environment::Sandbox) && !grants(Environment::Production);
  return allowlisted && sandboxAlone ? Environment::Sandbox : Environment::Production;
}

bool Standing::fundedAsOwner() const {
  return owner || shown() == Environment::Sandbox;
}

}
