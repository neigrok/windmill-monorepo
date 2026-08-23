#include "products/roadmap/adapters/ws/WsPresenceBus.h"

#include "products/roadmap/adapters/json/SubgraphJson.h"
#include "products/roadmap/adapters/json/TreeJson.h"

#include <utility>
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

void WsPresenceBus::setReadGate(ReadGate gate) { gate_ = std::move(gate); }

std::set<drogon::WebSocketConnectionPtr> WsPresenceBus::subscribersOf(const TreeId& tree) const {
  std::lock_guard<std::mutex> lock(mutex_);
  auto it = subscribers_.find(tree.str());
  if (it == subscribers_.end()) return {};
  return it->second;
}

std::vector<drogon::WebSocketConnectionPtr> WsPresenceBus::admitted(const TreeId& tree) {
  const std::set<drogon::WebSocketConnectionPtr> subscribers = subscribersOf(tree);
  if (!gate_) return {subscribers.begin(), subscribers.end()};

  // The gate is asked with no lock held: it reads the tree's access row, and holding this mutex
  // across that would put the whole bus behind it.
  std::vector<drogon::WebSocketConnectionPtr> admitted;
  std::vector<drogon::WebSocketConnectionPtr> denied;
  for (const auto& conn : subscribers) {
    if (gate_(tree, conn)) admitted.push_back(conn);
    else denied.push_back(conn);
  }
  if (!denied.empty()) {
    std::lock_guard<std::mutex> lock(mutex_);
    auto it = subscribers_.find(tree.str());
    // Dropped from THIS tree only; connUser_ stays until the connection closes.
    if (it != subscribers_.end())
      for (const auto& conn : denied) it->second.erase(conn);
  }
  return admitted;
}

void WsPresenceBus::resweep(const TreeId& tree) { admitted(tree); }

void WsPresenceBus::resweepAll() {
  // Snapshot the tree list first: admitted() takes this mutex itself.
  std::vector<TreeId> trees;
  {
    std::lock_guard<std::mutex> lock(mutex_);
    for (const auto& [tree, conns] : subscribers_)
      if (!conns.empty()) trees.push_back(TreeId{tree});
  }
  for (const TreeId& tree : trees) admitted(tree);
}

std::vector<drogon::WebSocketConnectionPtr> WsPresenceBus::connections() const {
  std::lock_guard<std::mutex> lock(mutex_);
  std::set<drogon::WebSocketConnectionPtr> distinct;
  for (const auto& [tree, conns] : subscribers_) distinct.insert(conns.begin(), conns.end());
  return {distinct.begin(), distinct.end()};
}

void WsPresenceBus::broadcastSubgraph(const TreeId& tree, Seq seq, const Subgraph& subgraph) {
  Json::Value frame = toJson(subgraph);
  frame["seq"] = static_cast<Json::Int64>(seq);  // the room's broadcast order
  // A broadcast is a live delta whatever intent the frame arrived with: echoing a client's
  // 'flush' intent would make every subscriber treat it as a re-baselining graft.
  frame["intent"] = "live";
  std::string text = dump(frame);
  for (const auto& conn : admitted(tree)) {
    if (conn->connected()) conn->send(text);
  }
}

void WsPresenceBus::broadcastProgress(const TreeId& tree, const UserId& user, const Progress& marks) {
  if (user.empty()) return;  // anonymous progress has no owner to notify
  if (marks.marks.empty()) return;

  // One codec, both directions: the echo is the same `{marks:[…]}` frame the graft serves.
  Json::Value frame = toJson(marks);
  frame["t"] = "progress";
  frame["treeId"] = tree.str();
  const std::string text = dump(frame);

  // The same gate as an op broadcast: a mark echoed to this account's other tabs must not reach
  // a tab whose read was revoked while it sat open.
  std::vector<drogon::WebSocketConnectionPtr> targets;
  {
    const std::vector<drogon::WebSocketConnectionPtr> readers = admitted(tree);
    std::lock_guard<std::mutex> lock(mutex_);
    for (const auto& conn : readers) {
      auto owner = connUser_.find(conn);
      if (owner != connUser_.end() && owner->second == user.str()) targets.push_back(conn);
    }
  }
  for (const auto& conn : targets)
    if (conn->connected()) conn->send(text);
}

}
