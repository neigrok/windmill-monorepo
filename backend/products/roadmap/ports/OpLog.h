#pragma once

#include "products/roadmap/domain/Ids.h"
#include "products/roadmap/ports/Op.h"

#include <vector>

namespace wm {

// Append-only history of merged commands. The source of truth is the tree document;
// this log powers the activity feed, per-user undo, and reconnect replay.
struct OpLog {
  virtual ~OpLog() = default;
  virtual void append(const TreeId& tree, const AppliedOp& op) = 0;
  virtual std::vector<AppliedOp> since(const TreeId& tree, Seq afterSeq) const = 0;
};

}
