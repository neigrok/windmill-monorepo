#pragma once

#include "products/roadmap/ports/PresenceBus.h"

#include <drogon/WebSocketConnection.h>

#include <functional>
#include <map>
#include <mutex>
#include <set>
#include <string>
#include <utility>
#include <vector>

namespace wm {

// What a subscription may receive of a tree: nothing, what every reader does, or all its writer does.
enum class Reach { none, reader, writer };

// Tracks which sockets subscribe to which tree and fans a room's ops — and a caller's own
// progress — out to them. Presence is not on this bus: PresenceHub keeps its own roster.
class WsPresenceBus : public PresenceBus {
public:
  // `user` is the connection's authenticated account (empty for anonymous viewers), remembered
  // so a private progress frame can be fanned out to just that user's own sessions.
  void subscribe(const TreeId& tree, const drogon::WebSocketConnectionPtr& conn, const UserId& user);
  void drop(const drogon::WebSocketConnectionPtr& conn);

  // What a subscription may still receive of this tree. Every fan-out passes through it, and a
  // connection it answers `none` is dropped from the tree. Installed once at wiring, before any
  // traffic; with none installed every subscriber is a reader.
  using ReadGate = std::function<Reach(const TreeId&, const drogon::WebSocketConnectionPtr&)>;
  void setReadGate(ReadGate gate);
  // Re-run the gate now, with no edit to carry, so a revocation does not wait for the tree's
  // next broadcast.
  void resweep(const TreeId& tree);
  // The same over every tree that has a subscriber.
  void resweepAll();
  // Every connection subscribed to anything, deduplicated.
  std::vector<drogon::WebSocketConnectionPtr> connections() const;

  void broadcastSubgraph(const TreeId& tree, Seq seq, const Subgraph& subgraph) override;
  void broadcastProgress(const TreeId& tree, const UserId& user, const Progress& marks) override;

private:
  std::set<drogon::WebSocketConnectionPtr> subscribersOf(const TreeId& tree) const;
  // Who may still receive `tree` and how much of it, with everyone the gate refused already dropped.
  std::vector<std::pair<drogon::WebSocketConnectionPtr, Reach>> admitted(const TreeId& tree);

  mutable std::mutex mutex_;
  std::map<std::string, std::set<drogon::WebSocketConnectionPtr>> subscribers_;
  std::map<drogon::WebSocketConnectionPtr, std::string> connUser_;  // empty = anonymous
  ReadGate gate_;
};

}
