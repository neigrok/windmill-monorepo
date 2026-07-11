#pragma once

#include "domain/Ids.h"
#include "ports/Op.h"

namespace wm {

// Fans an accepted op out to every subscriber of a tree (across instances, in the real
// adapter). Presence frames ride the same bus and are added with their own methods.
struct PresenceBus {
  virtual ~PresenceBus() = default;
  virtual void broadcastOp(const TreeId& tree, const AppliedOp& op) = 0;
};

}
