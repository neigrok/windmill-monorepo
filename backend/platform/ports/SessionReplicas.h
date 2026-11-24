#pragma once

#include "platform/domain/Ids.h"

#include <string>

namespace wm {

// The replica each session last pushed for (web-device-parity.md §7, Cleared): the sync push records it, and GET /v1/me
// answers it, so a browser that arrives under the same session with another replica can tell its store was cleared.
// Whoever keeps sessions keeps their replicas, and a session's deletion takes its replica with it.
struct SessionReplicas {
  // What recording a replica did to the session.
  enum class Recorded {
    // The session holds the replica now.
    changed,
    // It held the replica already, and nothing was written.
    unchanged,
    // No session of the account has the digest: it is gone, or it is another account's. Nothing was written.
    absent,
  };

  virtual ~SessionReplicas() = default;
  // `account`'s session whose token's digest is `sessionDigest` last pushed for `replica`.
  virtual Recorded recordSyncReplica(const std::string& sessionDigest, const UserId& account, const std::string& replica) = 0;
};

}
