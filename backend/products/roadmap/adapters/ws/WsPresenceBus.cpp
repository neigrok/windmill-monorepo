#include "products/roadmap/adapters/ws/WsPresenceBus.h"

#include "products/roadmap/adapters/json/SubgraphJson.h"
#include "products/roadmap/adapters/json/TreeJson.h"

#include "platform/application/WriteObservation.h"

#include <algorithm>
#include <exception>
#include <optional>
#include <string>
#include <utility>
#include <vector>

namespace wm {

namespace {
// More than a wave's worth of connections dropped within its window: what the registry-wide report is filed as.
struct SubscribersDropped : std::exception {
  const char* what() const noexcept override { return "a wave of tree-socket connections was dropped"; }
};

const char* nameOf(Outbound::Rule rule) {
  switch (rule) {
    case Outbound::Rule::stalled: return "stalled";
    case Outbound::Rule::behind: return "behind";
    case Outbound::Rule::ceiling: return "ceiling";
  }
  return "stalled";
}

// The bytes a text frame of `payload` bytes takes on the wire from a server: the payload after a header of two
// bytes, four from 126 bytes of payload and ten from 65,536.
std::size_t wireBytesOf(std::size_t payload) {
  return payload + (payload < 126 ? 2 : payload < 65'536 ? 4 : 10);
}

void close(const drogon::WebSocketConnectionPtr& conn, const Lane& lane, const Outbound::Dropped& drop) {
  const std::size_t mib = drop.pendingBytes / (1024 * 1024);
  LOG_WARN << "roadmap_ws_subscriber_dropped door=websocket rule=" << nameOf(drop.rule) << " queued="
           << (mib < 1 ? "under-1m" : mib < 16 ? "under-16m" : mib < 64 ? "under-64m" : "over-64m")
           << " idle_ms=" << drop.idle.count();
  lane.watch->dropped(drop);
  // Closed from the loop's queue, never from inside the hand-over that found it: on its own loop a connection's close
  // runs the socket's close handler at once, and whoever is sending may hold a lock that handler takes.
  if (!lane.loop) return conn->forceClose();
  lane.loop->queueInLoop([conn] { conn->forceClose(); });
}
}

std::optional<Outbound::Dropped> Outbound::judged(std::size_t sent, std::chrono::steady_clock::time_point now) {
  if (!began_) {
    began_ = true;
    sent_ = sent;
    idleSince_ = now;
  }
  std::size_t written = sent - sent_;
  sent_ = sent;
  if (written > 0) idleSince_ = now;
  while (written > 0 && !pending_.empty()) {
    Run& oldest = pending_.front();
    const std::size_t taken = std::min(written, oldest.bytes);
    oldest.bytes -= taken;
    written -= taken;
    pendingBytes_ -= taken;
    if (oldest.kind == FrameKind::first) firstBytes_ -= taken;
    if (oldest.kind == FrameKind::live) liveBytes_ -= taken;
    if (oldest.bytes == 0) pending_.pop_front();
  }
  const auto idle = std::chrono::duration_cast<std::chrono::milliseconds>(now - idleSince_);
  std::optional<Rule> broken;
  if (pendingBytes_ > kPendingCeilingBytes) broken = Rule::ceiling;
  else if (firstBytes_ == 0 && liveBytes_ > kLiveBacklogBytes) broken = Rule::behind;
  else if (pendingBytes_ > 0 && idle > kStalledAfter) broken = Rule::stalled;
  if (!broken) return std::nullopt;
  dropped_ = true;
  return Dropped{*broken, pendingBytes_, idle};
}

std::optional<Outbound::Dropped> Outbound::handing(std::size_t wireBytes, FrameKind kind, std::size_t sent,
                                                   std::chrono::steady_clock::time_point now) {
  if (const std::optional<Dropped> drop = judged(sent, now)) return drop;
  if (pending_.empty()) idleSince_ = now;  // nothing was owed: the wait for a write begins with this frame
  if (!pending_.empty() && pending_.back().kind == kind) pending_.back().bytes += wireBytes;
  else pending_.push_back(Run{wireBytes, kind});
  pendingBytes_ += wireBytes;
  if (kind == FrameKind::first) firstBytes_ += wireBytes;
  if (kind == FrameKind::live) liveBytes_ += wireBytes;
  return std::nullopt;
}

void DropWatch::dropped(const Outbound::Dropped& drop) {
  std::size_t stalled = 0;
  std::size_t behind = 0;
  std::size_t ceiling = 0;
  {
    std::lock_guard<std::mutex> lock(mutex_);
    const auto at = now_();
    recent_.emplace_back(at, drop.rule);
    while (at - recent_.front().first > kWaveWindow) recent_.pop_front();
    if (recent_.size() <= kWaveDrops) return;
    if (reported_ && at - *reported_ < kWaveWindow) return;
    reported_ = at;
    for (const auto& [when, rule] : recent_) {
      stalled += rule == Outbound::Rule::stalled;
      behind += rule == Outbound::Rule::behind;
      ceiling += rule == Outbound::Rule::ceiling;
    }
  }
  WriteObservation wave{"roadmap.ws.drop_wave", "roadmap", "websocket", freshWriteRequestId()};
  LOG_ERROR << "roadmap_ws_drop_wave stalled=" << stalled << " behind=" << behind << " ceiling=" << ceiling
            << " window_s=" << std::chrono::duration_cast<std::chrono::seconds>(kWaveWindow).count()
            << " request_id=" << wave.requestId();
  wave.fail(SubscribersDropped{}, "drop-wave");
}

void handOver(const drogon::WebSocketConnectionPtr& conn, const std::shared_ptr<Lane>& lane, const std::string& text,
              FrameKind kind) {
  if (!conn->connected() || lane->outbound.dropped()) return;
  if (const std::optional<Outbound::Dropped> drop =
          lane->outbound.handing(wireBytesOf(text.size()), kind, conn->bytesSent(), lane->watch->now())) {
    close(conn, *lane, *drop);
    return;
  }
  conn->send(text);
}

void judge(const drogon::WebSocketConnectionPtr& conn, const std::shared_ptr<Lane>& lane) {
  if (!conn->connected() || lane->outbound.dropped()) return;
  if (const std::optional<Outbound::Dropped> drop = lane->outbound.judged(conn->bytesSent(), lane->watch->now()))
    close(conn, *lane, *drop);
}

WsPresenceBus::Connection& WsPresenceBus::entryOf(const drogon::WebSocketConnectionPtr& conn) {
  Connection& entry = connections_[conn];
  if (!entry.lane)
    entry.lane = std::make_shared<Lane>(Lane{trantor::EventLoop::getEventLoopOfCurrentThread(), watch_, Outbound{}});
  return entry;
}

void WsPresenceBus::open(const drogon::WebSocketConnectionPtr& conn) {
  std::lock_guard<std::mutex> lock(mutex_);
  entryOf(conn);
}

void WsPresenceBus::send(const drogon::WebSocketConnectionPtr& conn, std::shared_ptr<const std::string> text,
                         FrameKind kind) {
  std::shared_ptr<Lane> lane;
  {
    std::lock_guard<std::mutex> lock(mutex_);
    const auto entry = connections_.find(conn);
    if (entry == connections_.end()) return;
    lane = entry->second.lane;
  }
  if (kind == FrameKind::presence && (!lane->loop || lane->loop->isInLoopThread())) {
    handOver(conn, lane, *text, kind);
    return;
  }
  sendInOrder(conn, lane, std::move(text), kind);
}

void WsPresenceBus::dropStalled() {
  std::vector<std::pair<drogon::WebSocketConnectionPtr, std::shared_ptr<Lane>>> open;
  {
    std::lock_guard<std::mutex> lock(mutex_);
    for (const auto& [conn, entry] : connections_) open.emplace_back(conn, entry.lane);
  }
  for (const auto& [conn, lane] : open) {
    if (!lane->loop) judge(conn, lane);
    else lane->loop->queueInLoop([conn = conn, lane = lane] { judge(conn, lane); });
  }
}

WsPresenceBus::FirstFrames WsPresenceBus::subscribe(const TreeId& tree, const drogon::WebSocketConnectionPtr& conn,
                                                    const UserId& user) {
  std::lock_guard<std::mutex> lock(mutex_);
  subscribers_[tree.str()].insert(conn);
  Connection& entry = entryOf(conn);
  entry.user = user.str();
  return FirstFrames{PlaceInOrder{conn, entry.lane}, PlaceInOrder{conn, entry.lane}};
}

void WsPresenceBus::unsubscribe(const TreeId& tree, const drogon::WebSocketConnectionPtr& conn) {
  std::lock_guard<std::mutex> lock(mutex_);
  if (auto it = subscribers_.find(tree.str()); it != subscribers_.end()) it->second.erase(conn);
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
    else admitted.push_back({conn, reach, {}, nullptr});
  }
  std::lock_guard<std::mutex> lock(mutex_);
  // Dropped from THIS tree only; what the connection's subscription remembered stays until it closes.
  if (auto it = subscribers_.find(tree.str()); it != subscribers_.end())
    for (const auto& conn : denied) it->second.erase(conn);
  std::vector<Admitted> open;
  for (Admitted& one : admitted) {
    const auto remembered = connections_.find(one.conn);
    if (remembered == connections_.end()) continue;  // closed since the gate was asked
    one.user = remembered->second.user;
    one.lane = remembered->second.lane;
    open.push_back(std::move(one));
  }
  return open;
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

void WsPresenceBus::closeEvery() {
  std::vector<std::pair<drogon::WebSocketConnectionPtr, std::shared_ptr<Lane>>> open;
  {
    std::lock_guard<std::mutex> lock(mutex_);
    for (const auto& [conn, entry] : connections_) open.emplace_back(conn, entry.lane);
  }
  for (const auto& [conn, lane] : open) {
    if (!lane->loop) conn->shutdown(drogon::CloseCode::kEndpointGone);
    else lane->loop->queueInLoop([conn = conn] { conn->shutdown(drogon::CloseCode::kEndpointGone); });
  }
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
      sendInOrder(one.conn, one.lane, whole, FrameKind::live);
      continue;
    }
    if (!readers) {
      Subgraph view = subgraph;
      view.graph = readerView(std::move(view.graph));
      readers = live(view);
    }
    sendInOrder(one.conn, one.lane, readers, FrameKind::live);
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
    if (one.conn->connected()) sendInOrder(one.conn, one.lane, text, FrameKind::live);
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
    if (one.user == user.str() && one.conn->connected()) sendInOrder(one.conn, one.lane, text, FrameKind::live);
}

}
