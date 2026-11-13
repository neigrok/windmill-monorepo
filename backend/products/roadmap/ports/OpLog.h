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

// Append-only history of merged commands: what the activity feed reads. A tree's state is its stored
// snapshot alone; no row is ever merged back into a room.
struct OpLog {
  virtual ~OpLog() = default;
  virtual void append(const TreeId& tree, const AppliedOp& op) = 0;
  virtual std::vector<AppliedOp> since(const TreeId& tree, Seq afterSeq) const = 0;
  // The seq of the last row the log holds for the tree, 0 when it holds none: a room opens with its head no earlier,
  // so the row of its next write collides with none.
  virtual Seq lastSeq(const TreeId& tree) const = 0;
};

}
