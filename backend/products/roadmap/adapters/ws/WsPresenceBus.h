#pragma once

#include "products/roadmap/ports/PresenceBus.h"

#include <drogon/WebSocketConnection.h>

#include <functional>
#include <map>
#include <mutex>
#include <set>
#include <string>
#include <vector>

namespace wm {

// Tracks which sockets subscribe to which tree and fans a room's ops — and a caller's own progress
// — out to them. Class C presence is not on this bus: PresenceHub keeps its own roster and
// coalesces cursors at 20 Hz. In-process for now; a Redis/NATS bus makes this cross-instance (§4).
class WsPresenceBus : public PresenceBus {
public:
  // `user` is the connection's authenticated account (empty for anonymous viewers), remembered
  // so a private progress frame can be fanned out to just that user's own sessions.
  void subscribe(const TreeId& tree, const drogon::WebSocketConnectionPtr& conn, const UserId& user);
  void drop(const drogon::WebSocketConnectionPtr& conn);

  // Whether a subscription is still allowed to receive this tree. Read authorization used to be
  // granted once, at subscribe, and never asked again: a socket lives for hours, so an owner
  // re-privating their tree — the product's only revocation control — revoked nothing already
  // open, and a revoked session kept reading. Every fan-out passes through this gate, and a
  // connection it refuses is dropped from the tree rather than carried. Collab installs it (it owns
  // canRead and the session); the bus only obeys it. Installed once at wiring, before any traffic.
  using ReadGate = std::function<bool(const TreeId&, const drogon::WebSocketConnectionPtr&)>;
  void setReadGate(ReadGate gate);
  // Re-run the gate now, with no edit to carry: what a visibility change calls, so a revocation
  // does not wait for the tree's next broadcast — a tree nobody edits again would never re-check.
  void resweep(const TreeId& tree);
  // The same over every tree that has a subscriber: the periodic pass, for the revocations no
  // single tree's event announces (an idle tree, a revoked session, a presence roster).
  void resweepAll();
  // Every connection subscribed to anything, deduplicated. A session belongs to a CONNECTION, not
  // to a tree, so the periodic re-proof walks these once rather than once per tree it reads.
  std::vector<drogon::WebSocketConnectionPtr> connections() const;

  void broadcastSubgraph(const TreeId& tree, Seq seq, const Subgraph& subgraph) override;
  void broadcastProgress(const TreeId& tree, const UserId& user, const NodeId& node,
                         ProgressStatus status) override;

private:
  std::set<drogon::WebSocketConnectionPtr> subscribersOf(const TreeId& tree) const;
  // Who may still receive `tree`, with everyone the gate refused already dropped from it. The one
  // door every fan-out and every resweep goes through, so the check cannot be forgotten in one path
  // and remembered in another.
  std::vector<drogon::WebSocketConnectionPtr> admitted(const TreeId& tree);

  mutable std::mutex mutex_;
  std::map<std::string, std::set<drogon::WebSocketConnectionPtr>> subscribers_;
  std::map<drogon::WebSocketConnectionPtr, std::string> connUser_;  // conn -> account id (empty = anon)
  ReadGate gate_;
};

}
