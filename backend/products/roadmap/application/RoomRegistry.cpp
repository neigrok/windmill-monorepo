#include "products/roadmap/application/RoomRegistry.h"

#include <trantor/utils/Logger.h>

#include <algorithm>
#include <functional>
#include <stdexcept>
#include <tuple>
#include <utility>
#include <vector>

namespace wm {

RoomRegistry::RoomRegistry(TreeRepository& repo, OpLog& ops, PresenceBus& bus)
    : repo_(repo), ops_(ops), bus_(bus), heartbeat_("rooms") {
  heartbeat_.start(kSweepSeconds, kSweepSeconds, [this] { sweep(kIdleFor); });
}

TreeRoom* RoomRegistry::open(const TreeId& id) {
  {
    std::lock_guard<std::mutex> lock(mutex_);
    auto existing = rooms_.find(id);
    if (existing != rooms_.end()) {
      existing->second.touched = std::chrono::steady_clock::now();  // still in use: not idle
      return existing->second.room.get();
    }
  }

  // Load + replay outside the registry lock so one large tree's open can't freeze every other tree's
  // room operations. open(id) always runs under strandFor(id); the re-check below covers the general
  // case.
  std::optional<StoredTree> stored = repo_.load(id);
  if (!stored) return nullptr;  // no such tree — a benign absence the caller answers, never a throw

  LooseGraph graph(stored->state);  // full CRDT state — lossless
  Legend legend(stored->legend);    // empty for legacy trees; the client derives then
  auto room = std::make_unique<TreeRoom>(id, stored->title, std::move(graph), std::move(legend),
                                         stored->head, stored->owner, stored->visibility,
                                         stored->createdAt, ops_, bus_);
  // The document is a snapshot at stored->head; replay the op-log tail to reach the
  // true current state (and the true head), so new ops never collide on seq.
  for (const AppliedOp& op : ops_.since(id, stored->head)) room->replay(op);

  std::lock_guard<std::mutex> lock(mutex_);
  auto existing = rooms_.find(id);
  if (existing != rooms_.end()) return existing->second.room.get();  // another thread won the race
  TreeRoom* ptr = room.get();
  rooms_.emplace(id, Live{std::move(room), std::chrono::steady_clock::now()});
  return ptr;
}

std::optional<TreeAccess> RoomRegistry::accessOf(const TreeId& id) {
  {
    std::lock_guard<std::mutex> lock(mutex_);
    auto it = rooms_.find(id);
    // The live room first: setVisibility flips it and the row together, and a room that was never
    // saved after a flip would otherwise answer from a stale column.
    if (it != rooms_.end()) return TreeAccess{it->second.room->owner(), it->second.room->visibility()};
  }
  return repo_.loadAccess(id);  // one row, no lattice — absence answers nullopt, exactly like load
}

void RoomRegistry::evict(const TreeId& id) {
  std::lock_guard<std::mutex> lock(mutex_);
  auto it = rooms_.find(id);
  if (it == rooms_.end()) return;
  auto [state, legend] = it->second.room->dirtyState();
  repo_.save(id, state, legend, it->second.room->title(), it->second.room->head());
  rooms_.erase(it);
}

void RoomRegistry::retire(const TreeId& id) {
  {
    std::lock_guard<std::mutex> lock(mutex_);
    rooms_.erase(id);
  }
  if (accessChanged_) accessChanged_(id);
}

void RoomRegistry::sweep(std::chrono::steady_clock::duration idleFor) {
  const auto now = std::chrono::steady_clock::now();
  std::vector<TreeId> closing;
  {
    std::lock_guard<std::mutex> lock(mutex_);
    std::vector<std::pair<std::chrono::steady_clock::time_point, TreeId>> keeping;
    for (const auto& [id, live] : rooms_) {
      if (now - live.touched >= idleFor) closing.push_back(id);
      else keeping.emplace_back(live.touched, id);
    }
    // A caller opening trees faster than they go idle would otherwise grow rooms_ without limit
    // between two sweeps.
    if (keeping.size() > kMaxRooms) {
      std::sort(keeping.begin(), keeping.end());
      for (std::size_t i = 0; i + kMaxRooms < keeping.size(); ++i) closing.push_back(keeping[i].second);
    }
  }
  // Never under the map lock. Every caller that touches a room holds its strand first, so the sweep
  // takes the strand and only then the map — the one lock order this class ever uses.
  for (const TreeId& id : closing) {
    std::lock_guard<std::mutex> strand(strandFor(id));
    evict(id);
  }
  if (!closing.empty()) LOG_INFO << "swept " << closing.size() << " rooms, " << openRooms() << " still open";
}

void RoomRegistry::persist(const TreeId& id) {
  TreeRoom* room = nullptr;
  GraphState state;
  LegendState legend;
  Lww<std::string> title;
  Seq head = 0;
  {
    std::lock_guard<std::mutex> lock(mutex_);
    auto it = rooms_.find(id);
    if (it == rooms_.end()) return;
    room = it->second.room.get();
    std::tie(state, legend) = room->dirtyState();  // only what changed since the last save
    title = room->title();
    head = room->head();
  }
  // I/O outside the map lock. The caller holds the tree's strand, so no write can slip in between
  // the export above and the markClean below.
  repo_.save(id, state, legend, title, head);
  room->markClean();
}

void RoomRegistry::rename(const TreeId& id, const std::string& title, std::uint64_t nowMs,
                          const Hlc& persistedStamp) {
  TreeRoom* room = nullptr;
  {
    std::lock_guard<std::mutex> lock(mutex_);
    auto it = rooms_.find(id);
    if (it != rooms_.end()) room = it->second.room.get();
  }
  if (!room) {
    HlcClock clock{std::string{TreeRoom::kServerActor}};
    clock.observe(persistedStamp);  // the receive rule: the mint always dominates the row
    repo_.rename(id, Lww<std::string>{title, clock.tick(nowMs)});
    return;
  }
  room->rename(title, nowMs);  // joins + broadcasts under the caller-held strand
  persist(id);                 // durable before the response, like the socket's ack
}

void RoomRegistry::setVisibility(const TreeId& id, Visibility visibility) {
  repo_.setVisibility(id, visibility);  // durable
  {
    std::lock_guard<std::mutex> lock(mutex_);
    auto it = rooms_.find(id);
    // The live room's read gate flips immediately, so a freshly-shared tree stops 404-ing at once.
    if (it != rooms_.end()) it->second.room->setVisibility(visibility);
  }
  // Announced outside the lock: whoever listens re-decides an access question and may go back to the
  // repository to do it.
  if (accessChanged_) accessChanged_(id);
}

void RoomRegistry::whenAccessChanges(std::function<void(const TreeId&)> hook) {
  accessChanged_ = std::move(hook);
}

bool RoomRegistry::isOpen(const TreeId& id) const {
  std::lock_guard<std::mutex> lock(mutex_);
  return rooms_.count(id) > 0;
}

std::size_t RoomRegistry::openRooms() const {
  std::lock_guard<std::mutex> lock(mutex_);
  return rooms_.size();
}

std::mutex& RoomRegistry::strandFor(const TreeId& id) {
  return strands_[std::hash<std::string>{}(id.str()) % kStrandStripes];
}

}
