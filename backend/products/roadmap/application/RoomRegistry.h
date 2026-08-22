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

// Owns the live TreeRooms, one per tree being viewed or edited. Opens a room by loading its
// document (seeding the loose graph), and evicts idle ones after persisting — on its own
// heartbeat, since nothing else ever closes one. This sentence used to be a claim rather than a
// description: the only evict() caller was the whole-document PUT, so every tree the process ever
// touched stayed resident with its whole CRDT graph, and a scraper walking the public corpus could
// pin all of it. A room is now a cache of the row, not a residence.
class RoomRegistry {
public:
  RoomRegistry(TreeRepository& repo, OpLog& ops, PresenceBus& bus);

  // Returns the live room, or nullptr if no such tree exists. Throws ONLY on a genuine
  // infrastructure failure (the repository raising) — so a caller can tell absence (a benign
  // nullptr it answers "no such tree") from breakage (an exception whose detail must be logged,
  // never surfaced: a pqxx message carries a host, a port, a role). The two used to arrive as one
  // throw, which forced callers to leak the second to distinguish neither.
  TreeRoom* open(const TreeId& id);

  // The two facts an access decision needs, WITHOUT materializing a room — the live room's if it
  // is open (a just-shared tree reads shared at once), the stored row's otherwise. Every path that
  // may refuse asks this BEFORE open(), because open() drags the whole lattice off disk and pins
  // it: a denied read used to load and keep a private tree for a caller who was about to be told
  // it does not exist, which made refusal itself a way to grow the server's memory.
  std::optional<TreeAccess> accessOf(const TreeId& id);

  void evict(const TreeId& id);

  // A tree that has been retired: drop its room and announce the change. Deletion is the strongest
  // access change there is and the gate could not see it — accessOf answers from the live room, so
  // a soft-deleted tree whose room was still resident kept reading as its old self: existing
  // subscribers were never dropped, and a NEW anonymous socket was served the whole lattice off
  // the cached room, since open() answers a resident room without consulting the row. Deliberately
  // does NOT persist on the way out, unlike evict: a retired tree's unsaved edits are nothing to
  // keep, and writing them back to a row somebody just deleted is the opposite of the ask.
  // The row itself is the caller's to retire; this is the live half, and the caller holds the strand.
  void retire(const TreeId& id);
  void persist(const TreeId& id);  // snapshot a live room's full state without evicting
  void setVisibility(const TreeId& id, Visibility visibility);  // share seam, durable + in-room
  bool isOpen(const TreeId& id) const;
  std::size_t openRooms() const;

  // A visibility change is a revocation, and revocation has to reach whoever is already reading.
  // The registry knows the flip happened but not who is on a socket, so it announces it and the
  // socket layer (Collab, which owns canRead and the session) decides who may stay. Installed once
  // at wiring, before any connection.
  void whenAccessChanges(std::function<void(const TreeId&)> hook);

  // Persist-then-close every room untouched for `idleFor`, then — idleness alone is no bound, a
  // burst of fresh opens is all young — the least-recently-touched down to the room cap. Runs on
  // this registry's own heartbeat; the parameter is what lets a test state the idleness it means.
  void sweep(std::chrono::steady_clock::duration idleFor);

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
  // How many rooms one process may hold, and how long a room nobody touched may sit before it is
  // persisted and closed. Ten minutes is well past a reader's think-time, so an active tree is
  // never evicted out from under its editors; reopening one costs the same load a cold read pays.
  static constexpr std::size_t kMaxRooms = 256;
  static constexpr std::chrono::minutes kIdleFor{10};
  static constexpr double kSweepSeconds = 30.0;

  // A room and when it was last opened. Steady time, never wall time: idleness is a duration this
  // process measured itself, and a clock the machine steps backwards must not resurrect a room.
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
  // Last, so it destructs first: its destructor joins the sweeper, and that has to happen while
  // the repository and rooms a running sweep touches are still alive.
  Heartbeat heartbeat_;
};

}
