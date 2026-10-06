#pragma once

#include "products/roadmap/domain/Command.h"
#include "products/roadmap/domain/Ids.h"

#include <string>
#include <vector>

namespace wm {

// One merged command as it lands in the op log and on the wire. `createdAtMs` is the log's
// wall-clock stamp (epoch ms); 0 on the write path (the DB assigns it), populated when read back.
struct AppliedOp {
  Seq seq = 0;
  std::string opId;
  Command command;
  Hlc hlc;
  UserId actor;
  std::uint64_t createdAtMs = 0;
};

// Append-only history of merged commands. The source of truth is the tree document;
// this log powers the activity feed, per-user undo, and reconnect replay.
struct OpLog {
  virtual ~OpLog() = default;
  virtual void append(const TreeId& tree, const AppliedOp& op) = 0;
  virtual std::vector<AppliedOp> since(const TreeId& tree, Seq afterSeq) const = 0;
};

}
