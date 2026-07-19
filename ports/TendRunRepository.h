#pragma once

#include "domain/Ids.h"
#include "domain/Tending.h"

#include <cstdint>
#include <optional>
#include <string>

namespace wm {

// The durable home of a tend run (domain/Tending.h). A run outlives the browser that started
// it, so its state lives here rather than in the request — a returning phone reads it back long
// after its socket died. `save` is an upsert keyed on the run id: start persists the `running`
// row, the worker overwrites it with the terminal one. `countForUser` powers the allowance gate
// — how many runs this user has started since `sinceMs` (epoch ms), the window the service caps.
struct TendRunRepository {
  virtual ~TendRunRepository() = default;

  virtual void save(const TendRun& run) = 0;
  virtual std::optional<TendRun> find(const std::string& id) = 0;
  virtual int countForUser(const UserId& user, std::uint64_t sinceMs) = 0;
};

}
