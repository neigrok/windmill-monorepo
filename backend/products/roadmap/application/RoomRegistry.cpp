#include "products/roadmap/application/RoomRegistry.h"

#include <trantor/utils/Logger.h>

#include <algorithm>
#include <functional>
#include <stdexcept>
#include <tuple>
#include <utility>
#include <vector>

namespace wm {

RoomRegistry::RoomRegistry(TreeRepository& repo, OpLog& ops, PresenceBus& bus)
    : repo_(repo), ops_(ops), bus_(bus), heartbeat_("rooms", "roadmap") {
  heartbeat_.start(kSweepSeconds, kSweepSeconds, [this] { sweep(kIdleFor); });
}

TreeRoom* RoomRegistry::open(const TreeId& id) {
  {
    std::lock_guard<std::mutex> lock(mutex_);
    auto existing = rooms_.find(id);
    if (existing != rooms_.end()) {
      existing->second.touched = std::chrono::steady_clock::now();  // still in use: not idle
      return existing->second.room.get();
    }
  }

  // Load + replay outside the registry lock so one large tree's open can't freeze every other tree's
  // room operations. open(id) always runs under strandFor(id); the re-check below covers the general
  // case.
  std::optional<StoredTree> stored = repo_.load(id);
  if (!stored) return nullptr;  // no such tree — a benign absence the caller answers, never a throw

  std::shared_ptr<RootAccess> access;
  {
    std::lock_guard<std::mutex> rootLock(rootLockFor(stored->root));
    access = shareRootAccess(stored->root);
  }
  if (!access) return nullptr;  // the root went away since the row was read

  LooseGraph graph(stored->state);  // full CRDT state — lossless
  Legend legend(stored->legend);    // empty for legacy trees; the client derives then
  auto room = std::make_unique<TreeRoom>(id, stored->title, stored->guide, stored->guideInherited,
                                         std::move(graph), std::move(legend), stored->head, stored->root,
                                         stored->parent, stored->depth, stored->subtrees, std::move(access),
                                         stored->createdAt, bus_);
  // The document is a snapshot at stored->head. A row past that head is what an older ordering
  // could leave behind; replaying it reaches the true state and head, so new ops never collide on
  // seq. Under the current ordering (save, then land) the tail is empty.
  for (const AppliedOp& op : ops_.since(id, stored->head)) room->replay(op);

  std::lock_guard<std::mutex> lock(mutex_);
  auto existing = rooms_.find(id);
  if (existing != rooms_.end()) return existing->second.room.get();  // another thread won the race
  TreeRoom* ptr = room.get();
  rooms_.emplace(id, Live{std::move(room), std::chrono::steady_clock::now()});
  return ptr;
}

std::optional<TreeAccess> RoomRegistry::accessOf(const TreeId& id) {
  {
    std::lock_guard<std::mutex> lock(mutex_);
    auto it = rooms_.find(id);
    if (it != rooms_.end()) {
      const TreeRoom& room = *it->second.room;
      if (!room.rootAccess()->stands()) return std::nullopt;
      return TreeAccess{room.owner(), room.visibility(), room.root(), room.parent()};
    }
  }
  const std::optional<TreeAccess> stored = repo_.loadAccess(id);  // the root's row, no lattice
  if (!stored) return std::nullopt;
  // A live room of the same root answers for it: its access changes before its row narrows and after it widens.
  std::lock_guard<std::mutex> lock(mutex_);
  const std::shared_ptr<RootAccess> live = liveRootAccess(stored->root);
  if (!live) return stored;
  if (!live->stands()) return std::nullopt;
  return TreeAccess{live->owner(), live->visibility(), stored->root, stored->parent};
}

void RoomRegistry::evict(const TreeId& id) {
  std::lock_guard<std::mutex> lock(mutex_);
  auto it = rooms_.find(id);
  if (it == rooms_.end()) return;
  TreeRoom& room = *it->second.room;
  auto [state, legend] = room.dirtyState();
  // A tree whose row is gone takes its room's edits and op rows with it.
  if (repo_.save(id, state, legend, room.title(), room.guide(), room.head())) {
    room.markClean();
    land(id, room);  // the lattice is durable at this head; now the rows may say so
  }
  rooms_.erase(it);  // a row that did not land is dropped here, and the room's teardown says so
}

// The lattice is durable before this is called, so a failed append is an incident for the log
// and never a refusal for the caller: the write it describes has already happened. The rows
// stay queued for the room's next save, where the op log's (tree_id, op_id) uniqueness absorbs
// a row that committed before its connection dropped.
void RoomRegistry::land(const TreeId& id, TreeRoom& room) {
  if (room.pendingOps().empty()) return;
  WriteObservation observation{"roadmap.oplog.flush", "roadmap", "background"};
  WriteContext context{observation};
  const auto writes = observation.writeCount();
  try {
    room.landPendingOps(ops_);
    if (observation.writeCount() == writes) observation.skip();
    else observation.finish();
  } catch (const std::exception& error) {
    observation.fail(error);
  }
}

void RoomRegistry::retire(const TreeId& id) {
  {
    std::lock_guard<std::mutex> lock(mutex_);
    rooms_.erase(id);
  }
  if (accessChanged_) accessChanged_(id);
}

void RoomRegistry::retireErased(const std::vector<std::string>& trees) {
  for (const std::string& tree : trees) {
    const TreeId id{tree};
    {
      std::lock_guard<std::mutex> lock(mutex_);
      if (const std::shared_ptr<RootAccess> live = liveRootAccess(id)) live->setStanding(false);
    }
    std::lock_guard<std::mutex> strand(strandFor(id));
    retire(id);
  }
}

void RoomRegistry::sweep(std::chrono::steady_clock::duration idleFor) {
  const auto now = std::chrono::steady_clock::now();
  std::vector<TreeId> closing;
  {
    std::lock_guard<std::mutex> lock(mutex_);
    std::vector<std::pair<std::chrono::steady_clock::time_point, TreeId>> keeping;
    for (const auto& [id, live] : rooms_) {
      if (now - live.touched >= idleFor) closing.push_back(id);
      else keeping.emplace_back(live.touched, id);
    }
    // A caller opening trees faster than they go idle would otherwise grow rooms_ without limit
    // between two sweeps.
    if (keeping.size() > kMaxRooms) {
      std::sort(keeping.begin(), keeping.end());
      for (std::size_t i = 0; i + kMaxRooms < keeping.size(); ++i) closing.push_back(keeping[i].second);
    }
  }
  // Never under the map lock. Every caller that touches a room holds its strand first, so the sweep
  // takes the strand and only then the map — the one lock order this class ever uses.
  for (const TreeId& id : closing) {
    std::lock_guard<std::mutex> strand(strandFor(id));
    evict(id);
  }
  if (!closing.empty()) LOG_INFO << "swept " << closing.size() << " rooms, " << openRooms() << " still open";
}

bool RoomRegistry::persist(const TreeId& id) {
  TreeRoom* room = nullptr;
  GraphState state;
  LegendState legend;
  Lww<std::string> title;
  Lww<std::string> guide;
  Seq head = 0;
  {
    std::lock_guard<std::mutex> lock(mutex_);
    auto it = rooms_.find(id);
    if (it == rooms_.end()) return true;  // a closed room holds nothing unsaved
    room = it->second.room.get();
    std::tie(state, legend) = room->dirtyState();  // only what changed since the last save
    title = room->title();
    guide = room->guide();
    head = room->head();
  }
  // I/O outside the map lock. The caller holds the tree's strand, so no write can slip in between
  // the export above and the markClean below. The lattice lands first and the op rows after, so a
  // crash between the two leaves a lattice at `head` with no row at `head` — replay is a no-op and
  // the feed misses one deed — never a row the lattice cannot back.
  if (!repo_.save(id, state, legend, title, guide, head)) return false;  // the row is gone; so is what this room would add to it
  room->markClean();
  land(id, *room);
  return true;
}

bool RoomRegistry::rename(const TreeId& id, const std::string& title, std::uint64_t nowMs,
                          const Hlc& persistedStamp) {
  TreeRoom* room = nullptr;
  {
    std::lock_guard<std::mutex> lock(mutex_);
    auto it = rooms_.find(id);
    if (it != rooms_.end()) room = it->second.room.get();
  }
  if (!room) {
    HlcClock clock{std::string{TreeRoom::kServerActor}};
    clock.observe(persistedStamp);  // the receive rule: the mint always dominates the row
    repo_.rename(id, Lww<std::string>{title, clock.tick(nowMs)});
    return true;
  }
  room->rename(title, nowMs);  // joins + broadcasts under the caller-held strand
  if (persist(id)) return true;  // durable before the response, like the socket's ack
  retire(id);                    // the row went away under its live room, so the room goes too
  return false;
}

void RoomRegistry::setVisibility(const TreeId& root, Visibility visibility) {
  {
    std::lock_guard<std::mutex> rootLock(rootLockFor(root));
    std::shared_ptr<RootAccess> live;
    {
      std::lock_guard<std::mutex> lock(mutex_);
      live = liveRootAccess(root);
    }
    const Visibility was = live ? live->visibility() : visibility;
    if (live && visibility == Visibility::private_) live->setVisibility(visibility);
    try {
      repo_.setVisibility(root, visibility);
    } catch (...) {
      if (live) live->setVisibility(was);
      throw;
    }
    // A freshly-shared tree stops 404-ing at once.
    if (live) live->setVisibility(visibility);
  }
  // Announced outside the locks: whoever listens re-decides an access question and may go back to the
  // repository to do it.
  if (!accessChanged_) return;
  accessChanged_(root);
  for (const TreeId& tree : roomsUnder(root))
    if (tree != root) accessChanged_(tree);
}

void RoomRegistry::remove(const TreeId& id) {
  {
    std::lock_guard<std::mutex> rootLock(rootLockFor(id));
    std::shared_ptr<RootAccess> live;
    {
      std::lock_guard<std::mutex> lock(mutex_);
      live = liveRootAccess(id);  // none for a subtree's id: only a root keys one
    }
    if (live) live->setStanding(false);
    try {
      repo_.softDelete(id);
    } catch (...) {
      if (live) live->setStanding(true);
      throw;
    }
  }
  const std::vector<TreeId> fallen = roomsUnder(id);
  retire(id);
  if (accessChanged_)
    for (const TreeId& tree : fallen)
      if (tree != id) accessChanged_(tree);
}

std::shared_ptr<RootAccess> RoomRegistry::shareRootAccess(const TreeId& root) {
  {
    std::lock_guard<std::mutex> lock(mutex_);
    if (std::shared_ptr<RootAccess> live = liveRootAccess(root)) return live;
  }
  // Read under the root's lock, which every change to the root's access holds, so it cannot be stale.
  const std::optional<TreeAccess> stored = repo_.loadAccess(root);
  if (!stored) return nullptr;
  auto access = std::make_shared<RootAccess>(stored->owner, stored->visibility);
  std::lock_guard<std::mutex> lock(mutex_);
  roots_[root] = access;
  return access;
}

std::shared_ptr<RootAccess> RoomRegistry::liveRootAccess(const TreeId& root) {
  auto it = roots_.find(root);
  if (it == roots_.end()) return nullptr;
  std::shared_ptr<RootAccess> live = it->second.lock();
  if (!live) roots_.erase(it);  // every room that shared it has closed
  return live;
}

std::vector<TreeId> RoomRegistry::roomsUnder(const TreeId& root) const {
  std::lock_guard<std::mutex> lock(mutex_);
  std::vector<TreeId> under;
  for (const auto& [id, live] : rooms_)
    if (live.room->root() == root) under.push_back(id);
  return under;
}

std::mutex& RoomRegistry::rootLockFor(const TreeId& root) {
  return rootLocks_[std::hash<std::string>{}(root.str()) % kStrandStripes];
}

void RoomRegistry::whenAccessChanges(std::function<void(const TreeId&)> hook) {
  accessChanged_ = std::move(hook);
}

bool RoomRegistry::isOpen(const TreeId& id) const {
  std::lock_guard<std::mutex> lock(mutex_);
  return rooms_.count(id) > 0;
}

std::size_t RoomRegistry::openRooms() const {
  std::lock_guard<std::mutex> lock(mutex_);
  return rooms_.size();
}

std::mutex& RoomRegistry::strandFor(const TreeId& id) {
  return strands_[std::hash<std::string>{}(id.str()) % kStrandStripes];
}

}
