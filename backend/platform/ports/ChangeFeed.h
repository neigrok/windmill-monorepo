#pragma once

#include "platform/domain/Ids.h"
#include "platform/domain/sync/Digest.h"
#include "platform/domain/sync/Scope.h"

#include <json/json.h>

#include <string>
#include <vector>

namespace wm::sync {

// §6.8: one scope an admission changed, as committed: its seq and digest, the rows the change frame carries,
// and what the per-socket access check reads (the owner, and a tree's open flag).
struct ScopeChange {
  ScopeKey key;
  UserId owner;
  bool open = false;
  Seq seq = 0;
  Digest256 digest;
  std::vector<Json::Value> rows;
};

// What one committed admission changed: the scopes it wrote in step order (its own, then any it created),
// and the scopes it killed, ascending.
struct CommittedChange {
  std::string epoch;
  std::vector<ScopeChange> changed;
  std::vector<ScopeKey> killed;
};

// Where committed changes go: the live channel in-process, a relay once several processes run the engine.
// Admission publishes after COMMIT and before it releases the scope's mutex, so one scope's changes
// arrive in seq order.
class ChangeFeed {
public:
  virtual ~ChangeFeed() = default;
  virtual void publish(const CommittedChange& change) = 0;
};

class NullChangeFeed : public ChangeFeed {
public:
  void publish(const CommittedChange&) override {}
};

}
