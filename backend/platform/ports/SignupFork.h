#pragma once

#include "platform/domain/Ids.h"  // UserId

#include <optional>
#include <string>

namespace wm {

// Already rendered by the product that owns the words; the platform only prints them.
struct ForkDescription {
  std::string title;
  std::string meta;
};

// Plants a copy of a source when a fork link is followed. Injecting nothing no-ops both steps;
// the source id is an opaque string.
struct SignupFork {
  virtual ~SignupFork() = default;

  // Empty if unreadable.
  virtual std::optional<ForkDescription> describe(const std::string& source) = 0;

  // The new id, or empty if the source was gone or the id taken.
  virtual std::optional<std::string> plant(const std::string& source, const UserId& user) = 0;
};

}
