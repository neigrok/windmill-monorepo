#pragma once

#include "products/roadmap/domain/Ids.h"
#include "products/roadmap/domain/Tending.h"

#include <cstdint>
#include <optional>
#include <string>
#include <vector>

namespace wm {

// The durable home of a tend run (domain/Tending.h). A run outlives the browser that started it, so
// its state lives here rather than in the request. `save` is an upsert keyed on the run id: start
// persists the `running` row, the worker overwrites it with the terminal one. `countForUser` powers
// the allowance gate — how many runs this user has started since `sinceMs` (epoch ms).
struct TendRunRepository {
  virtual ~TendRunRepository() = default;

  virtual void save(const TendRun& run) = 0;
  virtual std::optional<TendRun> find(const std::string& id) = 0;
  virtual int countForUser(const UserId& user, std::uint64_t sinceMs) = 0;

  // The receipts ledger read: this user's runs started since `sinceMs`, newest first, capped at
  // `limit`. Excludes refusals — exactly the runs that spent allowance, so the ledger and the
  // meter's `used` count agree on what a tending is.
  virtual std::vector<TendRun> recentForUser(const UserId& user, std::uint64_t sinceMs, int limit) = 0;

  // The reaper, run once at startup: any run still marked `running` when the process boots was
  // orphaned by the restart that ended its owner and will never finish on its own. Mark every one
  // `failed` so a returning phone reads a settled run instead of polling forever. Returns how many
  // were reaped. Single-instance only — revisit when the server scales out.
  virtual int failOrphanedRuns() = 0;
};

}
