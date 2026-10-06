#pragma once

#include "products/gym/domain/Bodyweight.h"

#include <optional>
#include <string>
#include <vector>

namespace wm::gym {

// Inclusive calendar bounds, each `YYYY-MM-DD` or empty for "from the first weigh-in" / "to the
// last". Validated by the caller (`wellFormedLocalDate`) before it reaches a store.
struct BodyweightRange {
  std::string from;
  std::string to;

  bool operator==(const BodyweightRange&) const = default;
};

// The weigh-ins as the engine stores them, read: one row per (account, local day). Owner-scoped by the
// UserId it carries; absent is byte-identical to forbidden.
struct BodyweightRepository {
  virtual ~BodyweightRepository() = default;

  virtual std::vector<Bodyweight> entries(const UserId& user, const BodyweightRange& range) = 0;  // day ascending
  // The newest day's row whatever window a read asked for, so one read draws the chart and the
  // reading at the head of the log; absent when the account has never weighed in.
  virtual std::optional<Bodyweight> latest(const UserId& user) = 0;
};

}
