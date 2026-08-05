#pragma once

#include "platform/domain/Ids.h"  // UserId

#include <optional>
#include <string>

namespace wm {

// The face of the thing a fork link will plant, ALREADY RENDERED by the product that owns the
// words: `title` is what to call it, `meta` is the one line printed under it. Two opaque strings —
// the platform prints them and counts nothing, so what a "step" is and how it pluralises stays
// with the product that has steps.
struct ForkDescription {
  std::string title;
  std::string meta;
};

// The one product-shaped thing sign-in still does — planting a copy of something when a fork link is
// followed — behind a port, so the auth HTTP surface holds no product dependency. A deployment with
// no forkable product injects nothing and both steps simply no-op; the source id is an opaque string.
struct SignupFork {
  virtual ~SignupFork() = default;

  // The source's face for the fork EMAIL, at requestLink; empty if unreadable.
  virtual std::optional<ForkDescription> describe(const std::string& source) = 0;

  // Plant a copy of the source for the new user on completion; the new id, or empty if the
  // source was gone / the id was taken.
  virtual std::optional<std::string> plant(const std::string& source, const UserId& user) = 0;
};

}
