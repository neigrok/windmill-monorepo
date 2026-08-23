#pragma once

#include "products/roadmap/domain/Ids.h"
#include "products/roadmap/domain/Subgraph.h"
#include "products/roadmap/domain/Tree.h"

namespace wm {

// Fans an accepted op out to every subscriber of a tree, plus a caller's own progress. Presence is
// NOT on this bus — PresenceHub owns that roster and coalesces it at 20 Hz.
struct PresenceBus {
  virtual ~PresenceBus() = default;

  // Fanned out verbatim to every subscriber, the sender included: an echo re-joins idempotently and
  // so surfaces drift rather than hiding it. `seq` is the tree's broadcast order, stamped by the room.
  virtual void broadcastSubgraph(const TreeId& tree, Seq seq, const Subgraph& subgraph) = 0;

  // Private to one user: fans out only to that user's own live sessions on the tree, never to
  // collaborators, carrying the registers just recorded with stamps and receipt instants intact. A
  // no-op where there are no sockets (stdio/HTTP MCP).
  virtual void broadcastProgress(const TreeId& tree, const UserId& user, const Progress& marks) = 0;
};

// The bus a socket-less process mounts: the MCP-only roots run their own rooms against the shared
// Postgres with nobody subscribed. Durability is the database.
struct NullPresenceBus : PresenceBus {
  void broadcastSubgraph(const TreeId&, Seq, const Subgraph&) override {}
  void broadcastProgress(const TreeId&, const UserId&, const Progress&) override {}
};

}
