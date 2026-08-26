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

// One line of the bodyweight export: text end to end, rendered by the store. Day ascending.
struct ExportedBodyweight {
  std::string date;
  std::string weightKg;
  std::string recordedAt;

  bool operator==(const ExportedBodyweight&) const = default;
};

// The weigh-ins' door to gym storage. Every read and write is owner-scoped by the UserId it
// carries; absent is byte-identical to forbidden. One row per (account, local day).
struct BodyweightRepository {
  virtual ~BodyweightRepository() = default;

  virtual std::vector<Bodyweight> entries(const UserId& user, const BodyweightRange& range) = 0;  // day ascending
  // The newest day's row whatever window a read asked for, so one read draws the chart and the
  // reading at the head of the log; absent when the account has never weighed in.
  virtual std::optional<Bodyweight> latest(const UserId& user) = 0;
  // Upsert by (account, day), and the later `recordedAtMs` wins: an incoming write at or after the
  // stored row's instant replaces it, an older one leaves it standing. Always answers the row as it
  // now stands, so a replayed stale write reads back the newer correction rather than undoing it.
  virtual Bodyweight save(const Bodyweight& incoming) = 0;
  // Absent and already gone are one answer. `dateLocal` is well-formed by the time it reaches here.
  virtual void remove(const UserId& user, const std::string& dateLocal) = 0;
  virtual std::vector<ExportedBodyweight> exported(const UserId& user) = 0;
};

}
