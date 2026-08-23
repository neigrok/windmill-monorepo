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

// Tracks which sockets subscribe to which tree and fans a room's ops — and a caller's own
// progress — out to them. Presence is not on this bus: PresenceHub keeps its own roster.
// In-process only.
class WsPresenceBus : public PresenceBus {
public:
  // `user` is the connection's authenticated account (empty for anonymous viewers), remembered
  // so a private progress frame can be fanned out to just that user's own sessions.
  void subscribe(const TreeId& tree, const drogon::WebSocketConnectionPtr& conn, const UserId& user);
  void drop(const drogon::WebSocketConnectionPtr& conn);

  // Whether a subscription may still receive this tree. Every fan-out passes through it, and a
  // connection it refuses is dropped from the tree. Installed once at wiring, before any traffic.
  using ReadGate = std::function<bool(const TreeId&, const drogon::WebSocketConnectionPtr&)>;
  void setReadGate(ReadGate gate);
  // Re-run the gate now, with no edit to carry: what a visibility change calls, so a revocation
  // does not wait for the tree's next broadcast.
  void resweep(const TreeId& tree);
  // The same over every tree that has a subscriber.
  void resweepAll();
  // Every connection subscribed to anything, deduplicated: a session belongs to a connection, not
  // to a tree.
  std::vector<drogon::WebSocketConnectionPtr> connections() const;

  void broadcastSubgraph(const TreeId& tree, Seq seq, const Subgraph& subgraph) override;
  void broadcastProgress(const TreeId& tree, const UserId& user, const Progress& marks) override;

private:
  std::set<drogon::WebSocketConnectionPtr> subscribersOf(const TreeId& tree) const;
  // Who may still receive `tree`, with everyone the gate refused already dropped from it. The one
  // door every fan-out and every resweep goes through.
  std::vector<drogon::WebSocketConnectionPtr> admitted(const TreeId& tree);

  mutable std::mutex mutex_;
  std::map<std::string, std::set<drogon::WebSocketConnectionPtr>> subscribers_;
  std::map<drogon::WebSocketConnectionPtr, std::string> connUser_;  // conn -> account id (empty = anon)
  ReadGate gate_;
};

}
