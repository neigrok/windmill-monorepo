#pragma once

#include "platform/domain/sync/Scope.h"
#include "platform/ports/SyncStore.h"

#include <optional>
#include <string>

namespace wm::probe {

// The receipts the probe's commands resolve their replays by (§6.4), per scope, written in the admitting
// transaction: the run a probe.start id resolved to, and the board a probe.copy destination was copied from.
class ProbeReceipts {
public:
  virtual ~ProbeReceipts() = default;

  virtual std::optional<std::string> startedRun(sync::SyncTxn&, const sync::ScopeKey& scope, const std::string& called) = 0;
  virtual void recordStart(sync::SyncTxn&, const sync::ScopeKey& scope, const std::string& called, const std::string& resolved) = 0;
  virtual std::optional<std::string> copiedFrom(sync::SyncTxn&, const sync::ScopeKey& scope, const std::string& destination) = 0;
  virtual void recordCopy(sync::SyncTxn&, const sync::ScopeKey& scope, const std::string& destination, const std::string& source) = 0;
};

}
