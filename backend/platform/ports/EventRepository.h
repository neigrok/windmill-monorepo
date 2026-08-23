#pragma once

#include "platform/domain/Ids.h"

#include <cstdint>
#include <optional>
#include <string>
#include <vector>

namespace wm {

// `props` is compact JSON text of the flat props object, stored verbatim as jsonb.
struct FunnelEvent {
  std::string name;
  std::int64_t clientMs = 0;
  std::string props = "{}";
};

// Append-only telemetry sink; nullopt user means a ghost session.
struct EventRepository {
  virtual ~EventRepository() = default;
  virtual void append(const std::string& sessionKey, const std::optional<UserId>& user,
                      const std::vector<FunnelEvent>& events) = 0;
  virtual int countInLastDay(const std::string& sessionKey) = 0;
};

}
