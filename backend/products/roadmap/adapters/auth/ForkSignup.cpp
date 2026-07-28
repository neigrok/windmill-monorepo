#include "products/roadmap/adapters/auth/ForkSignup.h"

#include <trantor/utils/Logger.h>

namespace wm {

ForkSignup::ForkSignup(ForkService& fork) : fork_(fork) {}

std::optional<AuthService::ForkDescription> ForkSignup::describe(const std::string& source) {
  // The source's live face, translated from the roadmap Description into the platform's — an
  // unreadable source stays undescribed so the mail promises no tree it can't name.
  if (std::optional<ForkService::Description> d = fork_.describe(TreeId{source}))
    return AuthService::ForkDescription{d->title, d->steps};
  return std::nullopt;
}

std::optional<std::string> ForkSignup::plant(const std::string& source, const UserId& user) {
  // Plant the pending fork into the new user's account. The link is already spent, so a drop is
  // unrecoverable and must leave a trace: a missing source or taken id warns, an exception errors.
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
