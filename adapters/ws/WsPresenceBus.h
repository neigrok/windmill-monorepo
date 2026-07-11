#pragma once

#include "ports/PresenceBus.h"

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
  void subscribe(const TreeId& tree, const drogon::WebSocketConnectionPtr& conn);
  void drop(const drogon::WebSocketConnectionPtr& conn);

  void broadcastOp(const TreeId& tree, const AppliedOp& op) override;
  void broadcastRaw(const TreeId& tree, const std::string& text, const drogon::WebSocketConnectionPtr& except);

private:
  std::set<drogon::WebSocketConnectionPtr> subscribersOf(const TreeId& tree) const;

  mutable std::mutex mutex_;
  std::map<std::string, std::set<drogon::WebSocketConnectionPtr>> subscribers_;
};

}
