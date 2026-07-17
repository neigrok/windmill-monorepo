#pragma once

#include "application/TreeRoom.h"
#include "domain/Ids.h"
#include "ports/OpLog.h"
#include "ports/PresenceBus.h"
#include "ports/TreeRepository.h"

#include <array>
#include <map>
#include <memory>
#include <mutex>

namespace wm {

// Owns the live TreeRooms, one per tree being viewed or edited. Opens a room by loading
// its document (seeding the loose graph), and evicts idle ones after persisting.
class RoomRegistry {
public:
  RoomRegistry(TreeRepository& repo, OpLog& ops, PresenceBus& bus);

  TreeRoom& open(const TreeId& id);
  void evict(const TreeId& id);
  void persist(const TreeId& id);  // snapshot a live room's full state without evicting
  void claim(const TreeId& id, const UserId& owner);  // first-writer ownership, durable + in-room
  void setVisibility(const TreeId& id, Visibility visibility);  // share seam, durable + in-room
  bool isOpen(const TreeId& id) const;

  // Retitle, room-coherently: a live room takes the op through its lattice — stamped from
  // the room clock, broadcast to every subscriber, then persisted. A closed tree has no
  // live lattice, so the write goes straight to the column, stamped past `persistedStamp`
  // (the register the caller just loaded) by the receive rule — so it always dominates the
  // stored title and clears the repository's LWW guard. Caller holds the strand.
  void rename(const TreeId& id, const std::string& title, std::uint64_t nowMs, const Hlc& persistedStamp);

  // The per-tree strand: one writer per tree (§11). Every caller that touches a room —
  // socket commands, HTTP reads, eviction — must hold this while doing so. Striped over a
  // fixed lock array (not a per-id map) so an attacker naming endless tree ids can't grow
  // the lock table; same id always maps to the same stripe, so per-tree serialization holds.
  // Callers must never hold two strands at once (verified: no nested strandFor).
  std::mutex& strandFor(const TreeId& id);

private:
  static constexpr std::size_t kStrandStripes = 64;

  TreeRepository& repo_;
  OpLog& ops_;
  PresenceBus& bus_;
  mutable std::mutex mutex_;
  std::map<TreeId, std::unique_ptr<TreeRoom>> rooms_;
  std::array<std::mutex, kStrandStripes> strands_;
};

}
