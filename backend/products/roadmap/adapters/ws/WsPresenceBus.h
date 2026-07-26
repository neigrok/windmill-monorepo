#pragma once

#include "products/roadmap/ports/PresenceBus.h"

#include <drogon/WebSocketConnection.h>

#include <map>
#include <mutex>
#include <set>
#include <string>

namespace wm {

// Tracks which sockets subscribe to which tree and fans ops/presence out to them.
// In-process for now; a Redis/NATS bus makes this cross-instance later (§4).
class WsPresenceBus : public PresenceBus {
public:
  // `user` is the connection's authenticated account (empty for anonymous viewers), remembered
  // so a private progress frame can be fanned out to just that user's own sessions.
  void subscribe(const TreeId& tree, const drogon::WebSocketConnectionPtr& conn, const UserId& user);
  void drop(const drogon::WebSocketConnectionPtr& conn);

  void broadcastSubgraph(const TreeId& tree, Seq seq, const Subgraph& subgraph) override;
  void broadcastProgress(const TreeId& tree, const UserId& user, const NodeId& node,
                         ProgressStatus status) override;
  void broadcastRaw(const TreeId& tree, const std::string& text, const drogon::WebSocketConnectionPtr& except);

private:
  std::set<drogon::WebSocketConnectionPtr> subscribersOf(const TreeId& tree) const;

  mutable std::mutex mutex_;
  std::map<std::string, std::set<drogon::WebSocketConnectionPtr>> subscribers_;
  std::map<drogon::WebSocketConnectionPtr, std::string> connUser_;  // conn -> account id (empty = anon)
};

}
