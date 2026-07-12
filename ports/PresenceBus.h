#pragma once

#include "domain/Ids.h"
#include "domain/Tree.h"
#include "ports/Op.h"

namespace wm {

// Fans an accepted op out to every subscriber of a tree (across instances, in the real
// adapter). Presence frames ride the same bus and are added with their own methods.
struct PresenceBus {
  virtual ~PresenceBus() = default;
  virtual void broadcastOp(const TreeId& tree, const AppliedOp& op) = 0;

  // A progress change is private to one user, so it fans out only to that user's own live
  // sessions on the tree (their other tabs, and a browser watching an agent's edits) — never
  // to collaborators. A no-op where there are no sockets (stdio/HTTP MCP).
  virtual void broadcastProgress(const TreeId& tree, const UserId& user, const NodeId& node,
                                 ProgressStatus status) = 0;
};

}
