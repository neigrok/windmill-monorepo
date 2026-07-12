#include "adapters/ws/WsPresenceBus.h"

#include "adapters/json/CommandJson.h"
#include "adapters/json/TreeJson.h"

#include <vector>

namespace wm {

void WsPresenceBus::subscribe(const TreeId& tree, const drogon::WebSocketConnectionPtr& conn, const UserId& user) {
  std::lock_guard<std::mutex> lock(mutex_);
  subscribers_[tree.str()].insert(conn);
  connUser_[conn] = user.str();
}

void WsPresenceBus::drop(const drogon::WebSocketConnectionPtr& conn) {
  std::lock_guard<std::mutex> lock(mutex_);
  for (auto& [tree, conns] : subscribers_) conns.erase(conn);
  connUser_.erase(conn);
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

void WsPresenceBus::broadcastProgress(const TreeId& tree, const UserId& user, const NodeId& node,
                                      ProgressStatus status) {
  if (user.empty()) return;  // anonymous progress has no owner to notify

  Json::Value frame(Json::objectValue);
  frame["t"] = "progress";
  frame["treeId"] = tree.str();
  frame["nodeId"] = node.str();
  frame["status"] = progressStatusName(status);
  const std::string text = dump(frame);

  std::vector<drogon::WebSocketConnectionPtr> targets;
  {
    std::lock_guard<std::mutex> lock(mutex_);
    auto it = subscribers_.find(tree.str());
    if (it == subscribers_.end()) return;
    for (const auto& conn : it->second) {
      auto owner = connUser_.find(conn);
      if (owner != connUser_.end() && owner->second == user.str()) targets.push_back(conn);
    }
  }
  for (const auto& conn : targets)
    if (conn->connected()) conn->send(text);
}

void WsPresenceBus::broadcastRaw(const TreeId& tree, const std::string& text,
                                 const drogon::WebSocketConnectionPtr& except) {
  for (const auto& conn : subscribersOf(tree)) {
    if (conn != except && conn->connected()) conn->send(text);
  }
}

}
