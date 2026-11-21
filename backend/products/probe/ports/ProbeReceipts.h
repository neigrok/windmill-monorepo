#pragma once

#include "platform/domain/sync/Scope.h"
#include "platform/ports/SyncStore.h"

#include <optional>
#include <string>

namespace wm::probe {

// The arguments a probe.branch created its child board with, besides the child itself.
struct BranchReceipt {
  std::string parent;
  std::string title;

  bool operator==(const BranchReceipt&) const = default;
};

// The receipts the probe's commands resolve their replays by (§6.4), per scope, written in the admitting
// transaction: the run a probe.start id resolved to, the board a probe.copy destination was copied from,
// and the arguments a probe.branch child was created with.
class ProbeReceipts {
public:
  virtual ~ProbeReceipts() = default;

  virtual std::optional<std::string> startedRun(sync::SyncTxn&, const sync::ScopeKey& scope, const std::string& called) = 0;
  virtual void recordStart(sync::SyncTxn&, const sync::ScopeKey& scope, const std::string& called, const std::string& resolved) = 0;
  virtual std::optional<std::string> copiedFrom(sync::SyncTxn&, const sync::ScopeKey& scope, const std::string& destination) = 0;
  virtual void recordCopy(sync::SyncTxn&, const sync::ScopeKey& scope, const std::string& destination, const std::string& source) = 0;
  virtual std::optional<BranchReceipt> branched(sync::SyncTxn&, const sync::ScopeKey& scope, const std::string& child) = 0;
  virtual void recordBranch(sync::SyncTxn&, const sync::ScopeKey& scope, const std::string& child, const BranchReceipt& receipt) = 0;
};

}
