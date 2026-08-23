#pragma once

#include "products/roadmap/domain/Ids.h"
#include "products/roadmap/domain/Tending.h"

#include <cstdint>
#include <optional>
#include <string>
#include <vector>

namespace wm {

// The durable home of a tend run (domain/Tending.h). `save` is an upsert keyed on the run id: start
// persists the `running` row, the worker overwrites it with the terminal one. `countForUser` powers
// the allowance gate — runs this user started since `sinceMs` (epoch ms).
struct TendRunRepository {
  virtual ~TendRunRepository() = default;

  virtual void save(const TendRun& run) = 0;
  virtual std::optional<TendRun> find(const std::string& id) = 0;
  virtual int countForUser(const UserId& user, std::uint64_t sinceMs) = 0;

  // This user's runs started since `sinceMs`, newest first, capped at `limit`. Excludes refusals, so
  // this ledger and the meter's `used` count agree on what a tending is.
  virtual std::vector<TendRun> recentForUser(const UserId& user, std::uint64_t sinceMs, int limit) = 0;

  // Run once at startup: any run still marked `running` when the process boots was orphaned by a
  // restart and will never finish on its own. Marks every one `failed` and returns how many were
  // reaped. Single-instance only — revisit when the server scales out.
  virtual int failOrphanedRuns() = 0;
};

}
