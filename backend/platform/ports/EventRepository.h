#pragma once

#include "platform/domain/Ids.h"

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
  // How many rows this session has already written in the last 24 hours. The intake is anonymous
  // and unauthenticated, so the only thing that can be counted is the session key the browser
  // minted — enough to stop one page beaconing a megabyte a second (PLATFORM-EDGE-4), not enough
  // to stop a script that mints a fresh key per call, which is what the retention window is for.
  virtual int countInLastDay(const std::string& sessionKey) = 0;
};

}
