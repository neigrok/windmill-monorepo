#pragma once

#include "platform/application/AuthService.h"  // AuthService::ForkDescription
#include "platform/domain/Ids.h"                // UserId

#include <optional>
#include <string>

namespace wm {

// The one product-shaped thing sign-in still does — planting a copy of a tree when a fork link is
// followed — behind a port, so the auth HTTP surface holds no product dependency. A deployment with
// no forkable product injects nothing and both steps simply no-op; the source id is an opaque string.
struct SignupFork {
  virtual ~SignupFork() = default;

  // The source's face for the fork EMAIL (title + step count), at requestLink; empty if unreadable.
  virtual std::optional<AuthService::ForkDescription> describe(const std::string& source) = 0;

  // Plant a copy of the source for the new user on completion; the new tree id, or empty if the
  // source was gone / the id was taken.
  virtual std::optional<std::string> plant(const std::string& source, const UserId& user) = 0;
};

}
