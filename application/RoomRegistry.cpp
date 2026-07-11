#include "application/RoomRegistry.h"

#include <stdexcept>

namespace wm {

RoomRegistry::RoomRegistry(TreeRepository& repo, OpLog& ops, PresenceBus& bus, Hlc genesis)
    : repo_(repo), ops_(ops), bus_(bus), genesis_(std::move(genesis)) {}

TreeRoom& RoomRegistry::open(const TreeId& id) {
  std::lock_guard<std::mutex> lock(mutex_);
  auto existing = rooms_.find(id);
  if (existing != rooms_.end()) return *existing->second;

  std::optional<StoredTree> stored = repo_.load(id);
  if (!stored) throw std::runtime_error("no such tree \"" + id.str() + "\"");

  LooseGraph graph(stored->data, genesis_);
  auto room = std::make_unique<TreeRoom>(id, stored->data.title, std::move(graph), stored->head, ops_, bus_);
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
  repo_.save(id, it->second->snapshot(), it->second->head());
  rooms_.erase(it);
}

bool RoomRegistry::isOpen(const TreeId& id) const {
  std::lock_guard<std::mutex> lock(mutex_);
  return rooms_.count(id) > 0;
}

}
