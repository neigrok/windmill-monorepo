#include "products/roadmap/adapters/ws/WsPresenceBus.h"

#include "products/roadmap/adapters/json/SubgraphJson.h"
#include "products/roadmap/adapters/json/TreeJson.h"

#include <optional>
#include <string>
#include <utility>
#include <vector>

namespace wm {

void handOver(const drogon::WebSocketConnectionPtr& conn, const std::shared_ptr<Outbound>& outbound, const std::string& text) {
  if (!conn->connected()) return;
  if (outbound) {
    if (outbound->dropped()) return;
    if (const std::optional<Outbound::Stalled> stalled =
            outbound->handing(text.size(), conn->bytesSent(), std::chrono::steady_clock::now())) {
      const std::size_t mib = stalled->queuedBytes / (1024 * 1024);
      LOG_WARN << "roadmap_ws_subscriber_dropped door=websocket queued="
               << (mib < 4 ? "under-4m" : mib < 16 ? "under-16m" : "over-16m") << " idle_ms=" << stalled->idle.count();
      conn->forceClose();
      return;
    }
  }
  conn->send(text);
}

WsPresenceBus::FirstFrames WsPresenceBus::subscribe(const TreeId& tree, const drogon::WebSocketConnectionPtr& conn,
                                                    const UserId& user) {
  trantor::EventLoop* loop = trantor::EventLoop::getEventLoopOfCurrentThread();
  std::lock_guard<std::mutex> lock(mutex_);
  subscribers_[tree.str()].insert(conn);
  Subscriber& subscriber = connections_[conn];
  if (!subscriber.outbound) subscriber.outbound = std::make_shared<Outbound>();
  subscriber.user = user.str();
  subscriber.loop = loop;
  return FirstFrames{PlaceInOrder{loop, conn, subscriber.outbound}, PlaceInOrder{loop, conn, subscriber.outbound}};
}

void WsPresenceBus::drop(const drogon::WebSocketConnectionPtr& conn) {
  std::lock_guard<std::mutex> lock(mutex_);
  for (auto& [tree, conns] : subscribers_) conns.erase(conn);
  connections_.erase(conn);
}

void WsPresenceBus::setReadGate(ReadGate gate) { gate_ = std::move(gate); }

std::set<drogon::WebSocketConnectionPtr> WsPresenceBus::subscribersOf(const TreeId& tree) const {
  std::lock_guard<std::mutex> lock(mutex_);
  auto it = subscribers_.find(tree.str());
  if (it == subscribers_.end()) return {};
  return it->second;
}

std::vector<WsPresenceBus::Admitted> WsPresenceBus::admitted(const TreeId& tree) {
  // The gate is asked with no lock held: it reads the tree's access row, and holding this mutex
  // across that would put the whole bus behind it.
  std::vector<Admitted> admitted;
  std::vector<drogon::WebSocketConnectionPtr> denied;
  for (const auto& conn : subscribersOf(tree)) {
    const Reach reach = gate_ ? gate_(tree, conn) : Reach::reader;
    if (reach == Reach::none) denied.push_back(conn);
    else admitted.push_back({conn, reach, {}, nullptr, nullptr});
  }
  std::lock_guard<std::mutex> lock(mutex_);
  // Dropped from THIS tree only; what the connection's subscription remembered stays until it closes.
  if (auto it = subscribers_.find(tree.str()); it != subscribers_.end())
    for (const auto& conn : denied) it->second.erase(conn);
  for (Admitted& one : admitted) {
    const auto remembered = connections_.find(one.conn);
    if (remembered == connections_.end()) continue;  // closed since the gate was asked
    one.user = remembered->second.user;
    one.loop = remembered->second.loop;
    one.outbound = remembered->second.outbound;
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
  const auto live = [seq](const Subgraph& form) {
    Json::Value frame = toJson(form);
    frame["seq"] = static_cast<Json::Int64>(seq);  // the room's broadcast order
    // A broadcast is a live delta whatever intent the frame arrived with: echoing a client's
    // 'flush' intent would make every subscriber treat it as a re-baselining graft.
    frame["intent"] = "live";
    return std::make_shared<const std::string>(dump(frame));
  };
  // Each form is serialized once, and only when a subscriber receives it. A reader's frame goes out
  // even with nothing left in it: its seq is the next one that reader waits for.
  std::shared_ptr<const std::string> whole;
  std::shared_ptr<const std::string> readers;
  for (const Admitted& one : admitted(tree)) {
    if (!one.conn->connected()) continue;
    if (one.reach == Reach::writer) {
      if (!whole) whole = live(subgraph);
      sendInOrder(one.loop, one.conn, whole, one.outbound);
      continue;
    }
    if (!readers) {
      Subgraph view = subgraph;
      view.graph = readerView(std::move(view.graph));
      readers = live(view);
    }
    sendInOrder(one.loop, one.conn, readers, one.outbound);
  }
}

void WsPresenceBus::broadcastSubtree(const TreeId& tree, Seq seq, const NodeId& step, const Subtree& subtree) {
  Json::Value frame(Json::objectValue);
  frame["t"] = "subtree";
  frame["treeId"] = tree.str();
  frame["seq"] = static_cast<Json::Int64>(seq);
  frame["step"] = step.str();
  frame["subtree"]["id"] = subtree.id.str();
  frame["subtree"]["depth"] = subtree.depth;
  const auto text = std::make_shared<const std::string>(dump(frame));
  for (const Admitted& one : admitted(tree))
    if (one.conn->connected()) sendInOrder(one.loop, one.conn, text);
}

void WsPresenceBus::broadcastProgress(const TreeId& tree, const UserId& user, const Progress& marks) {
  if (user.empty()) return;  // anonymous progress has no owner to notify
  if (marks.marks.empty()) return;

  // One codec, both directions: the echo is the same `{marks:[…]}` frame the graft serves.
  Json::Value frame = toJson(marks);
  frame["t"] = "progress";
  frame["treeId"] = tree.str();
  const auto text = std::make_shared<const std::string>(dump(frame));

  // The same gate as an op broadcast: a mark echoed to this account's other tabs must not reach
  // a tab whose read was revoked while it sat open.
  for (const Admitted& one : admitted(tree))
    if (one.user == user.str() && one.conn->connected()) sendInOrder(one.loop, one.conn, text, one.outbound);
}

}
