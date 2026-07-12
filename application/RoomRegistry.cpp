#include "application/RoomRegistry.h"

#include <functional>
#include <stdexcept>

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
                                         stored->head, stored->owner, ops_, bus_);
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
  repo_.save(id, it->second->exportState(), it->second->exportLegend(), it->second->title(), it->second->head());
  rooms_.erase(it);
}

void RoomRegistry::persist(const TreeId& id) {
  GraphState state;
  LegendState legend;
  std::string title;
  Seq head = 0;
  {
    std::lock_guard<std::mutex> lock(mutex_);
    auto it = rooms_.find(id);
    if (it == rooms_.end()) return;
    state = it->second->exportState();
    legend = it->second->exportLegend();
    title = it->second->title();
    head = it->second->head();
  }
  repo_.save(id, state, legend, title, head);  // I/O outside the map lock
}

void RoomRegistry::claim(const TreeId& id, const UserId& owner) {
  repo_.claim(id, owner);  // durable, and a no-op if the tree already has an owner
  std::lock_guard<std::mutex> lock(mutex_);
  auto it = rooms_.find(id);
  if (it != rooms_.end()) it->second->claim(owner);  // keep the live room's cache in step
}

bool RoomRegistry::isOpen(const TreeId& id) const {
  std::lock_guard<std::mutex> lock(mutex_);
  return rooms_.count(id) > 0;
}

std::mutex& RoomRegistry::strandFor(const TreeId& id) {
  return strands_[std::hash<std::string>{}(id.str()) % kStrandStripes];
}

}
