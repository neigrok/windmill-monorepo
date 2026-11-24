#pragma once

#include <string>

namespace wm {

// The replica each session last pushed for (web-device-parity.md §7, Cleared): the sync push records it, and GET /v1/me
// answers it, so a browser that arrives under the same session with another replica can tell its store was cleared.
// Whoever keeps sessions keeps their replicas, and a session's deletion takes its replica with it.
struct SessionReplicas {
  virtual ~SessionReplicas() = default;
  // The session whose token's digest is `sessionDigest` last pushed for `replica`. True only when that changed what the
  // session holds: a session already holding it, or one that is gone, records nothing.
  virtual bool recordSyncReplica(const std::string& sessionDigest, const std::string& replica) = 0;
};

}
