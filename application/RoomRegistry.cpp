#include "application/RoomRegistry.h"

#include <stdexcept>

namespace wm {

RoomRegistry::RoomRegistry(TreeRepository& repo, OpLog& ops, PresenceBus& bus)
    : repo_(repo), ops_(ops), bus_(bus) {}

TreeRoom& RoomRegistry::open(const TreeId& id) {
  std::lock_guard<std::mutex> lock(mutex_);
  auto existing = rooms_.find(id);
  if (existing != rooms_.end()) return *existing->second;

  std::optional<StoredTree> stored = repo_.load(id);
  if (!stored) throw std::runtime_error("no such tree \"" + id.str() + "\"");

  LooseGraph graph(stored->state);  // full CRDT state — lossless
  auto room = std::make_unique<TreeRoom>(id, stored->title, std::move(graph), stored->head, ops_, bus_);
  // The document is a snapshot at stored->head; replay the op-log tail to reach the
  // true current state (and the true head), so new ops never collide on seq.
  for (const AppliedOp& op : ops_.since(id, stored->head)) room->replay(op);
  TreeRoom& ref = *room;
  rooms_.emplace(id, std::move(room));
  return ref;
}

void RoomRegistry::evict(const TreeId& id) {
  std::lock_guard<std::mutex> lock(mutex_);
  auto it = rooms_.find(id);
  if (it == rooms_.end()) return;
  repo_.save(id, it->second->exportState(), it->second->title(), it->second->head());
  rooms_.erase(it);
}

void RoomRegistry::persist(const TreeId& id) {
  GraphState state;
  std::string title;
  Seq head = 0;
  {
    std::lock_guard<std::mutex> lock(mutex_);
    auto it = rooms_.find(id);
    if (it == rooms_.end()) return;
    state = it->second->exportState();
    title = it->second->title();
    head = it->second->head();
  }
  repo_.save(id, state, title, head);  // I/O outside the map lock
}

bool RoomRegistry::isOpen(const TreeId& id) const {
  std::lock_guard<std::mutex> lock(mutex_);
  return rooms_.count(id) > 0;
}

std::mutex& RoomRegistry::strandFor(const TreeId& id) {
  std::lock_guard<std::mutex> lock(strandsMutex_);
  std::unique_ptr<std::mutex>& strand = strands_[id];
  if (!strand) strand = std::make_unique<std::mutex>();
  return *strand;
}

}
