#pragma once

#include "domain/Command.h"
#include "domain/Ids.h"

#include <string>

namespace wm {

// One merged command as it lands in the op log and on the wire: a per-tree sequence
// number, the client's idempotency id, the command, its HLC, and who issued it.
struct AppliedOp {
  Seq seq = 0;
  std::string opId;
  Command command;
  Hlc hlc;
  UserId actor;
};

}
