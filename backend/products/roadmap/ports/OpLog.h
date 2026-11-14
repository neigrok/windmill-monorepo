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

// What the log holds for a tree past a snapshot's head: how many rows, decodable or not, the last one's seq, and the
// greatest stamp any of them carries — not the last row's, since a replica whose clock ran ahead leaves a later row
// with an earlier stamp. All zero when the log holds no row past the head.
struct LogPast {
  std::size_t rows = 0;
  Seq lastSeq = 0;
  Hlc greatestStamp;
  bool operator==(const LogPast&) const = default;
};

// Append-only history of merged commands: what the activity feed reads. A tree's state is its stored
// snapshot alone; no row is ever merged back into a room.
struct OpLog {
  virtual ~OpLog() = default;
  virtual void append(const TreeId& tree, const AppliedOp& op) = 0;
  virtual std::vector<AppliedOp> since(const TreeId& tree, Seq afterSeq) const = 0;
  // A room opens with its head no earlier than the last row's seq, so the row of its next write collides with none,
  // and with its clock past the greatest stamp of the rows past its snapshot, so its next write is stamped after every
  // deed those rows hold.
  virtual LogPast past(const TreeId& tree, Seq head) const = 0;
};

}
