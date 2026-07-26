#pragma once

#include "domain/Ids.h"

#include <cstdint>
#include <optional>
#include <string>
#include <vector>

namespace wm {

// One funnel event as the beacon sent it, already validated at the HTTP edge. `props` is
// the compact JSON text of the flat props object, stored verbatim as jsonb.
struct FunnelEvent {
  std::string name;
  std::int64_t clientMs = 0;
  std::string props = "{}";
};

// The append-only telemetry sink (event-spine): persist a batch under the browser's
// client-minted session key and the user the session resolved to — nullopt for a ghost.
struct EventRepository {
  virtual ~EventRepository() = default;
  virtual void append(const std::string& sessionKey, const std::optional<UserId>& user,
                      const std::vector<FunnelEvent>& events) = 0;
};

}
