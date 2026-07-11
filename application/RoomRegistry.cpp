#include "application/RoomRegistry.h"

#include <stdexcept>

namespace wm {

RoomRegistry::RoomRegistry(TreeRepository& repo, OpLog& ops, PresenceBus& bus, Hlc genesis)
    : repo_(repo), ops_(ops), bus_(bus), genesis_(std::move(genesis)) {}

TreeRoom& RoomRegistry::open(const TreeId& id) {
  auto existing = rooms_.find(id);
  if (existing != rooms_.end()) return *existing->second;

  std::optional<StoredTree> stored = repo_.load(id);
  if (!stored) throw std::runtime_error("no such tree \"" + id.str() + "\"");

  LooseGraph graph(stored->data, genesis_);
  auto room = std::make_unique<TreeRoom>(id, stored->data.title, std::move(graph), stored->head, ops_, bus_);
  TreeRoom& ref = *room;
  rooms_.emplace(id, std::move(room));
  return ref;
}

void RoomRegistry::evict(const TreeId& id) {
  auto it = rooms_.find(id);
  if (it == rooms_.end()) return;
  repo_.save(id, it->second->snapshot(), it->second->head());
  rooms_.erase(it);
}

bool RoomRegistry::isOpen(const TreeId& id) const {
  return rooms_.count(id) > 0;
}

}
