#include "products/roadmap/adapters/auth/ForkSignup.h"

#include <trantor/utils/Logger.h>

namespace wm {

ForkSignup::ForkSignup(ForkService& fork) : fork_(fork) {}

std::optional<ForkDescription> ForkSignup::describe(const std::string& source) {
  // An unreadable source stays undescribed, so the mail promises no tree it cannot name.
  std::optional<ForkService::Description> described = fork_.describe(TreeId{source});
  if (!described) return std::nullopt;
  const std::string meta =
      described->steps == 1 ? "1 step" : std::to_string(described->steps) + " steps";
  return ForkDescription{described->title, meta};
}

std::optional<std::string> ForkSignup::plant(const std::string& source, const UserId& user) {
  // The link is already spent, so a dropped plant is unrecoverable and must leave a trace.
  try {
    ForkService::Result r = fork_.fork(TreeId{source}, "", "", user);
    if (r.outcome == ForkService::Outcome::forked) return r.data.id.str();
    LOG_WARN << "pending fork of " << source << " dropped: source missing or id taken";
    return std::nullopt;
  } catch (const std::exception& e) {
    LOG_ERROR << "pending fork of " << source << " failed: " << e.what();
    return std::nullopt;
  }
}

}
