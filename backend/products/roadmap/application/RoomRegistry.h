#pragma once

#include "platform/application/Heartbeat.h"
#include "products/roadmap/application/TreeRoom.h"
#include "products/roadmap/domain/Ids.h"
#include "products/roadmap/ports/OpLog.h"
#include "products/roadmap/ports/PresenceBus.h"
#include "products/roadmap/ports/TreeRepository.h"

#include <array>
#include <chrono>
#include <cstddef>
#include <functional>
#include <map>
#include <memory>
#include <mutex>
#include <optional>

namespace wm {

// Owns the live TreeRooms, one per tree being viewed or edited. Idle ones are persisted and closed
// on its own heartbeat — a room is a cache of the row, not a residence.
class RoomRegistry {
public:
  RoomRegistry(TreeRepository& repo, OpLog& ops, PresenceBus& bus);

  // nullptr means no such tree; a throw means infrastructure failure, whose detail must be logged
  // and never surfaced (a pqxx message carries a host, a port, a role).
  TreeRoom* open(const TreeId& id);

  // Answers WITHOUT materializing a room. Every path that may refuse asks this BEFORE open(), which
  // drags the whole lattice off disk and pins it.
  std::optional<TreeAccess> accessOf(const TreeId& id);

  void evict(const TreeId& id);

  // Drops a retired tree's room and announces the change; deliberately does NOT persist on the way
  // out. Caller holds the strand.
  void retire(const TreeId& id);
  void persist(const TreeId& id);  // snapshot a live room's full state without evicting
  void setVisibility(const TreeId& id, Visibility visibility);  // share seam, durable + in-room
  bool isOpen(const TreeId& id) const;
  std::size_t openRooms() const;

  // Announces a visibility change so the socket layer can drop readers who may no longer stay.
  // Installed once at wiring, before any connection.
  void whenAccessChanges(std::function<void(const TreeId&)> hook);

  // Persist-then-close every room untouched for `idleFor`, then the least-recently-touched down to
  // the room cap.
  void sweep(std::chrono::steady_clock::duration idleFor);

  // A live room takes the rename through its lattice; a closed tree's goes straight to the column,
  // stamped past `persistedStamp` so it dominates the stored title. Caller holds the strand.
  void rename(const TreeId& id, const std::string& title, std::uint64_t nowMs, const Hlc& persistedStamp);

  // One writer per tree: every caller that touches a room holds this. Striped over a fixed lock
  // array so unknown tree ids can't grow it; never hold two strands at once.
  std::mutex& strandFor(const TreeId& id);

private:
  static constexpr std::size_t kStrandStripes = 64;
  static constexpr std::size_t kMaxRooms = 256;
  static constexpr std::chrono::minutes kIdleFor{10};
  static constexpr double kSweepSeconds = 30.0;

  // Steady time, never wall time: a clock stepped backwards must not resurrect a room.
  struct Live {
    std::unique_ptr<TreeRoom> room;
    std::chrono::steady_clock::time_point touched;
  };

  TreeRepository& repo_;
  OpLog& ops_;
  PresenceBus& bus_;
  mutable std::mutex mutex_;
  std::map<TreeId, Live> rooms_;
  std::function<void(const TreeId&)> accessChanged_;
  std::array<std::mutex, kStrandStripes> strands_;
  // Last, so it destructs first: its destructor joins the sweeper, which must happen while the
  // members above are still alive.
  Heartbeat heartbeat_;
};

}
