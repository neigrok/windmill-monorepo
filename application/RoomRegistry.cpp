#include "application/RoomRegistry.h"

#include <functional>
#include <stdexcept>
#include <tuple>

namespace wm {

RoomRegistry::RoomRegistry(TreeRepository& repo, OpLog& ops, PresenceBus& bus)
    : repo_(repo), ops_(ops), bus_(bus) {}

TreeRoom& RoomRegistry::open(const TreeId& id) {
  {
    std::lock_guard<std::mutex> lock(mutex_);
    auto existing = rooms_.find(id);
    if (existing != rooms_.end()) return *existing->second;
  }

  // Load + replay outside the registry lock so one cold/large tree's open can't freeze
  // every other tree's room operations. open(id) always runs under strandFor(id), so no
  // second thread builds the same id concurrently; the re-check below covers the general case.
  std::optional<StoredTree> stored = repo_.load(id);
  if (!stored) throw std::runtime_error("no such tree \"" + id.str() + "\"");

  LooseGraph graph(stored->state);  // full CRDT state — lossless
  Legend legend(stored->legend);    // empty for legacy trees; the client derives then
  auto room = std::make_unique<TreeRoom>(id, stored->title, std::move(graph), std::move(legend),
                                         stored->head, stored->owner, stored->visibility, ops_, bus_);
  // The document is a snapshot at stored->head; replay the op-log tail to reach the
  // true current state (and the true head), so new ops never collide on seq.
  for (const AppliedOp& op : ops_.since(id, stored->head)) room->replay(op);

  std::lock_guard<std::mutex> lock(mutex_);
  auto existing = rooms_.find(id);
  if (existing != rooms_.end()) return *existing->second;  // another thread won the race
  TreeRoom& ref = *room;
  rooms_.emplace(id, std::move(room));
  return ref;
}

void RoomRegistry::evict(const TreeId& id) {
  std::lock_guard<std::mutex> lock(mutex_);
  auto it = rooms_.find(id);
  if (it == rooms_.end()) return;
  auto [state, legend] = it->second->dirtyState();
  repo_.save(id, state, legend, it->second->title(), it->second->head());
  rooms_.erase(it);
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
    room = it->second.get();
    std::tie(state, legend) = room->dirtyState();  // only what changed since the last save
    title = room->title();
    head = room->head();
  }
  // I/O outside the map lock. The caller holds the tree's strand, so the room can neither
  // take new writes nor be evicted between the export above and the markClean below.
  repo_.save(id, state, legend, title, head);
  room->markClean();
}

void RoomRegistry::rename(const TreeId& id, const std::string& title, std::uint64_t nowMs,
                          const Hlc& persistedStamp) {
  TreeRoom* room = nullptr;
  {
    std::lock_guard<std::mutex> lock(mutex_);
    auto it = rooms_.find(id);
    if (it != rooms_.end()) room = it->second.get();
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

void RoomRegistry::claim(const TreeId& id, const UserId& owner) {
  repo_.claim(id, owner);  // durable, and a no-op if the tree already has an owner
  std::lock_guard<std::mutex> lock(mutex_);
  auto it = rooms_.find(id);
  if (it != rooms_.end()) it->second->claim(owner);  // keep the live room's cache in step
}

void RoomRegistry::setVisibility(const TreeId& id, Visibility visibility) {
  repo_.setVisibility(id, visibility);  // durable
  std::lock_guard<std::mutex> lock(mutex_);
  auto it = rooms_.find(id);
  // Mirror the claim seam: a just-shared live room's read gate flips immediately, so the
  // freshly-shared tree stops 404-ing at once — not only after eviction and reload.
  if (it != rooms_.end()) it->second->setVisibility(visibility);
}

bool RoomRegistry::isOpen(const TreeId& id) const {
  std::lock_guard<std::mutex> lock(mutex_);
  return rooms_.count(id) > 0;
}

std::mutex& RoomRegistry::strandFor(const TreeId& id) {
  return strands_[std::hash<std::string>{}(id.str()) % kStrandStripes];
}

}
