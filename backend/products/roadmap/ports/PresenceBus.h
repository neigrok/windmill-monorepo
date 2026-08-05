#pragma once

#include "products/roadmap/domain/Ids.h"
#include "products/roadmap/domain/Subgraph.h"
#include "products/roadmap/domain/Tree.h"

namespace wm {

// Fans an accepted op out to every subscriber of a tree (across instances, in the real
// adapter). Presence frames ride the same bus and are added with their own methods.
struct PresenceBus {
  virtual ~PresenceBus() = default;

  // A joined subgraph fanned out verbatim to every subscriber — the sender included, since an
  // echo re-joins idempotently and so surfaces drift rather than hiding it. `seq` is the
  // tree's broadcast order, stamped on by the room.
  virtual void broadcastSubgraph(const TreeId& tree, Seq seq, const Subgraph& subgraph) = 0;

  // A progress change is private to one user, so it fans out only to that user's own live
  // sessions on the tree (their other tabs, and a browser watching an agent's edits) — never
  // to collaborators. A no-op where there are no sockets (stdio/HTTP MCP).
  virtual void broadcastProgress(const TreeId& tree, const UserId& user, const NodeId& node,
                                 ProgressStatus status) = 0;
};

// The bus a socket-less process mounts: the MCP-only roots (windmill_mcp, windmill_mcp_http) run
// their own rooms against the shared Postgres with nobody subscribed, so fanout has nowhere to go.
// Durability is the database — the web server picks an agent's edits up on its next room load.
struct NullPresenceBus : PresenceBus {
  void broadcastSubgraph(const TreeId&, Seq, const Subgraph&) override {}
  void broadcastProgress(const TreeId&, const UserId&, const NodeId&, ProgressStatus) override {}
};

}
