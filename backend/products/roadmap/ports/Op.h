#pragma once

#include "products/roadmap/domain/Command.h"
#include "products/roadmap/domain/Ids.h"

#include <string>

namespace wm {

// One merged command as it lands in the op log and on the wire: a per-tree sequence
// number, the client's idempotency id, the command, its HLC, and who issued it.
// `createdAtMs` is the log's wall-clock stamp (epoch ms); 0 on the write path (the DB
// assigns it), populated when read back for the activity feed.
struct AppliedOp {
  Seq seq = 0;
  std::string opId;
  Command command;
  Hlc hlc;
  UserId actor;
  std::uint64_t createdAtMs = 0;
};

}
