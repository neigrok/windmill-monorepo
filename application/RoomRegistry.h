#pragma once

#include "application/TreeRoom.h"
#include "domain/Ids.h"
#include "ports/OpLog.h"
#include "ports/PresenceBus.h"
#include "ports/TreeRepository.h"

#include <map>
#include <memory>

namespace wm {

// Owns the live TreeRooms, one per tree being viewed or edited. Opens a room by loading
// its document (seeding the loose graph), and evicts idle ones after persisting.
class RoomRegistry {
public:
  RoomRegistry(TreeRepository& repo, OpLog& ops, PresenceBus& bus, Hlc genesis);

  TreeRoom& open(const TreeId& id);
  void evict(const TreeId& id);
  bool isOpen(const TreeId& id) const;

private:
  TreeRepository& repo_;
  OpLog& ops_;
  PresenceBus& bus_;
  Hlc genesis_;
  std::map<TreeId, std::unique_ptr<TreeRoom>> rooms_;
};

}
