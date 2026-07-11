#include "adapters/ws/WsPresenceBus.h"

#include "adapters/json/CommandJson.h"
#include "adapters/json/TreeJson.h"

namespace wm {

void WsPresenceBus::subscribe(const TreeId& tree, const drogon::WebSocketConnectionPtr& conn) {
  std::lock_guard<std::mutex> lock(mutex_);
  subscribers_[tree.str()].insert(conn);
}

void WsPresenceBus::drop(const drogon::WebSocketConnectionPtr& conn) {
  std::lock_guard<std::mutex> lock(mutex_);
  for (auto& [tree, conns] : subscribers_) conns.erase(conn);
}

std::set<drogon::WebSocketConnectionPtr> WsPresenceBus::subscribersOf(const TreeId& tree) const {
  std::lock_guard<std::mutex> lock(mutex_);
  auto it = subscribers_.find(tree.str());
  if (it == subscribers_.end()) return {};
  return it->second;
}

void WsPresenceBus::broadcastOp(const TreeId& tree, const AppliedOp& op) {
  Json::Value frame = opFrame(op);
  frame["treeId"] = tree.str();
  std::string text = dump(frame);
  for (const auto& conn : subscribersOf(tree)) {
    if (conn->connected()) conn->send(text);
  }
}

void WsPresenceBus::broadcastRaw(const TreeId& tree, const std::string& text,
                                 const drogon::WebSocketConnectionPtr& except) {
  for (const auto& conn : subscribersOf(tree)) {
    if (conn != except && conn->connected()) conn->send(text);
  }
}

}
