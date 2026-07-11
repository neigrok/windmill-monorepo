#pragma once

#include "application/TreeRoom.h"
#include "domain/Ids.h"
#include "ports/OpLog.h"
#include "ports/PresenceBus.h"
#include "ports/TreeRepository.h"

#include <map>
#include <memory>
#include <mutex>

namespace wm {

// Owns the live TreeRooms, one per tree being viewed or edited. Opens a room by loading
// its document (seeding the loose graph), and evicts idle ones after persisting.
class RoomRegistry {
public:
  RoomRegistry(TreeRepository& repo, OpLog& ops, PresenceBus& bus, Hlc genesis);

  TreeRoom& open(const TreeId& id);
  void evict(const TreeId& id);
  bool isOpen(const TreeId& id) const;

  // The per-tree strand: one writer per tree (§11). Every caller that touches a room —
  // socket commands, HTTP reads, eviction — must hold this while doing so.
  std::mutex& strandFor(const TreeId& id);

private:
  TreeRepository& repo_;
  OpLog& ops_;
  PresenceBus& bus_;
  Hlc genesis_;
  mutable std::mutex mutex_;
  std::map<TreeId, std::unique_ptr<TreeRoom>> rooms_;
  std::mutex strandsMutex_;
  std::map<TreeId, std::unique_ptr<std::mutex>> strands_;
};

}
