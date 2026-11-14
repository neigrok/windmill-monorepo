#include "products/roadmap/application/RoomRegistry.h"

#include "platform/application/StatementLimits.h"

#include <trantor/utils/Logger.h>

#include <algorithm>
#include <functional>
#include <stdexcept>
#include <tuple>
#include <utility>
#include <vector>

namespace wm {

namespace {
// A room opened with its snapshot behind its op log: the last row's seq is past the head the snapshot was saved at.
struct SnapshotBehindLog : std::exception {
  const char* what() const noexcept override { return "a room opened with its snapshot behind its op log"; }
};

// Rooms held with a save that keeps failing, or still held as the registry stopped: what the registry's own report
// is filed as when no single failure is at hand.
struct RoomsHeldUnsaved : std::exception {
  const char* what() const noexcept override { return "rooms are held with a save that keeps failing"; }
};

// Time that only moves forward, for the budget every save shares once the process is told to stop.
struct SteadyClock : Clock {
  std::uint64_t nowMs() override {
    return static_cast<std::uint64_t>(std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::steady_clock::now().time_since_epoch()).count());
  }
};

// Made as the program loads, so reading it from a signal handler initializes nothing.
SteadyClock steadyClock;

// The door a registry's own line is told at: the one of the call it serves, or the background for the timer's and a
// sweep's.
std::string doorNow() {
  const std::string door = currentWriteDoor();
  return door.empty() ? "background" : door;
}
}

RoomRegistry::RoomRegistry(TreeRepository& repo, OpLog& ops, PresenceBus& bus, RetryTimer retryTimer)
    : repo_(repo), ops_(ops), bus_(bus), retryTimer_(std::move(retryTimer)), heartbeat_("rooms", "roadmap") {
  if (!retryTimer_)
    retryTimer_ = [this](std::chrono::milliseconds delay, std::function<void()> retry) {
      heartbeat_.after(delay, std::move(retry));
    };
  heartbeat_.start(kSweepSeconds, kSweepSeconds, [this] { sweep(kIdleFor); });
}

RoomRegistry::~RoomRegistry() { stop(); }

void RoomRegistry::beginStopping() {
  std::uint64_t running = 0;
  stopDeadlineMs_.compare_exchange_strong(
      running, steadyClock.nowMs() + static_cast<std::uint64_t>(kShutdownSaveBudget.count()));
}

void RoomRegistry::stop() {
  // One budget for all of stopping, begun when the process was told to stop: a retry may be in the middle of a save
  // that hangs as the heartbeat is joined, and a save asked for after the budget is refused at once (save), so a store
  // that hangs cannot hold the process past it.
  beginStopping();
  const std::uint64_t deadline = stopDeadlineMs_;
  heartbeat_.stop();
  std::vector<std::pair<TreeId, std::shared_ptr<SaveLine>>> unsaved;
  {
    std::lock_guard<std::mutex> lock(mutex_);
    if (stopped_) return;
    stopped_ = true;
    for (const auto& [id, live] : rooms_)
      if (live.held || live.saving || live.room->holdsUnsavedWrites()) unsaved.emplace_back(id, live.line);
  }
  std::size_t lost = 0;
  for (const auto& [id, line] : unsaved) {
    // A write in mid-save holds the gate: it is waited for no longer than the budget either.
    std::unique_lock<std::timed_mutex> gate(
        line->gate, std::chrono::steady_clock::time_point{std::chrono::milliseconds{deadline}});
    if (!gate.owns_lock() || save(id, line, Asked::atShutdown) == Saved::held) ++lost;
  }
  if (lost > 0) reportHeld(lost, RoomsHeldUnsaved{}, "lost-at-shutdown");
}

void RoomRegistry::reportHeld(std::size_t rooms, const std::exception& failure, const char* outcome) {
  WriteObservation report{"roadmap.tree.save", "roadmap", doorNow(), freshWriteRequestId()};
  LOG_ERROR << "roadmap_tree_save outcome=" << outcome << " rooms=" << rooms << " request_id=" << report.requestId();
  report.fail(failure, outcome);
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

  // Loaded outside the registry lock so one large tree's open can't freeze every other tree's
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

  // The room is the stored snapshot and nothing else: the op log is the feed's history, and a row of it never states
  // a frame faithfully enough to be merged back. Rows past the snapshot's head — what a crash between the two stores
  // could leave before rows were made to land after the save — change nothing the room holds; the head is taken past
  // the last of them, so the row of the room's next write collides with none, and the clock past the greatest stamp
  // among them, so the server's next write is not stamped below a deed they hold.
  const LogPast past = ops_.past(id, stored->head);
  LooseGraph graph(stored->state);  // full CRDT state — lossless
  Legend legend(stored->legend);    // empty for legacy trees; the client derives then
  auto room = std::make_unique<TreeRoom>(id, stored->title, stored->guide, stored->guideInherited,
                                         std::move(graph), std::move(legend), stored->head, stored->root,
                                         stored->path, stored->subtrees, std::move(access), stored->createdAt, bus_);
  room->restoreLandSeqs(stored->landed);
  room->takeHeadPast(past.lastSeq);
  room->observe(past.greatestStamp);
  // The room's first save moves the stored head past those rows, and nothing then shows the tree was ever behind:
  // it is told here, once, as the unexpected state it is, under a request of its own so the call that opened the
  // room keeps its own report. The line counts the rows and names no tree, whose id a client may have minted.
  if (past.rows > 0) {
    WriteObservation behind{"roadmap.room.open_behind_log", "roadmap", doorNow(), freshWriteRequestId()};
    LOG_ERROR << "roadmap_room_opened_behind_log rows=" << past.rows << " request_id=" << behind.requestId();
    behind.fail(SnapshotBehindLog{}, "snapshot-behind-log");
  }

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
      if (!room.stands()) return std::nullopt;
      return TreeAccess{room.owner(), room.visibility(), room.root(), room.path()};
    }
  }
  const std::optional<StoredAccess> stored = repo_.loadAccess(id);  // the root's row and the tree's path, no lattice
  if (!stored) return std::nullopt;
  const TreeAccess& read = stored->access;
  // A live room of the same root answers for it: its access changes before its row narrows and after it widens, and it
  // holds every owning step as the rooms hold them, saved or not.
  std::lock_guard<std::mutex> rootLock(rootLockFor(read.root));
  {
    std::lock_guard<std::mutex> lock(mutex_);
    if (const std::shared_ptr<RootAccess> live = liveRootAccess(read.root)) {
      if (!live->admits(read.path)) return std::nullopt;
      return TreeAccess{live->owner(), live->visibility(), read.root, read.path};
    }
  }
  if (read.path.empty()) return read;
  // A stored answer that hides the tree is answered as it is: at worst a revive saved since the first read is missed,
  // which is narrower, never wider. One that admits it is read again, now that no room of the root is live and none can
  // open while the root's lock is held, so the store holds every write of its trees: a parent room that held a deletion
  // may have saved and closed since the first read.
  if (!stored->stands) return std::nullopt;
  const std::optional<StoredAccess> settled = repo_.loadAccess(id);
  if (!settled || !settled->stands) return std::nullopt;
  return settled->access;
}

void RoomRegistry::settleOwningSteps(const TreeId& root) {
  std::shared_ptr<RootAccess> live;
  {
    std::lock_guard<std::mutex> lock(mutex_);
    live = liveRootAccess(root);
  }
  if (live) settle(root, *live);
}

void RoomRegistry::settle(const TreeId& root, RootAccess& live) {
  std::vector<OwningStep> moved;
  {
    // Under the root's lock no tree of the root's can finish opening, so each one without a live room holds as the store
    // says, and a room that opens after records its own steps as it opens. The rooms are read before the rows: one
    // that saves and closes while the rows are read is still taken as live, with the steps it recorded, where rows
    // read before its save would bring a step it deleted back.
    std::lock_guard<std::mutex> rootLock(rootLockFor(root));
    WriteObservation standing{"roadmap.tree.standing", "roadmap", doorNow()};
    try {
      const std::vector<TreeId> rooms = roomsUnder(root);
      const std::set<OwningStep> absent = repo_.absentStepsUnder(root);
      moved = live.settle(absent, std::set<TreeId>(rooms.begin(), rooms.end()));
      standing.skip();
    } catch (const std::bad_alloc&) {
      throw;
    } catch (const std::exception& failure) {
      standing.fail(failure);
      live.unsettle();
      return;
    }
  }
  // Told with no lock held: whoever listens asks accessOf again, which may take the root's lock.
  for (const OwningStep& step : moved) announceBelow(root, step);
}

Saved RoomRegistry::flush(const TreeId& id) {
  std::shared_ptr<SaveLine> line;
  {
    std::lock_guard<std::mutex> lock(mutex_);
    const auto it = rooms_.find(id);
    if (it == rooms_.end()) return Saved::saved;  // a closed room holds nothing unsaved
    line = it->second.line;
  }
  std::lock_guard<std::timed_mutex> gate(line->gate);
  return save(id, line, Asked::inPassing);
}

bool RoomRegistry::evict(const TreeId& id) {
  // A held room stays for its retry, which alone tries its save, and a room whose save fails here stays, held. A tree
  // whose row is gone takes its room's edits and op rows with it.
  if (flush(id) == Saved::held) return false;
  std::lock_guard<std::mutex> strand(strandFor(id));
  return close(id);
}

bool RoomRegistry::flushed(const TreeId& id) const {
  std::lock_guard<std::mutex> lock(mutex_);
  const auto it = rooms_.find(id);
  if (it == rooms_.end()) return true;
  return !it->second.held && !it->second.saving && !it->second.room->holdsUnsavedWrites();
}

bool RoomRegistry::close(const TreeId& id) {
  if (!flushed(id)) return false;
  std::lock_guard<std::mutex> lock(mutex_);
  rooms_.erase(id);  // a row that did not land is dropped here, and the room's teardown says so
  return true;
}

// The lattice is durable before this is called, so a failed append is an incident for the log
// and never a refusal for the caller: the write it describes has already happened. The rows
// stay queued for the room's next save, where the op log's (tree_id, op_id) uniqueness absorbs
// a row that committed before its connection dropped.
std::size_t RoomRegistry::land(const TreeId& id, const std::vector<AppliedOp>& rows) {
  if (rows.empty()) return 0;
  WriteObservation observation{"roadmap.oplog.flush", "roadmap", "background"};
  WriteContext context{observation};
  const auto writes = observation.writeCount();
  std::size_t landed = 0;
  try {
    for (const AppliedOp& row : rows) {
      ops_.append(id, row);
      ++landed;
    }
    if (observation.writeCount() == writes) observation.skip();
    else observation.finish();
  } catch (const std::exception& error) {
    observation.fail(error);
  }
  return landed;
}

void RoomRegistry::retire(const TreeId& id) {
  {
    std::lock_guard<std::mutex> lock(mutex_);
    const auto it = rooms_.find(id);
    if (it != rooms_.end()) {
      it->second.line->retired = true;  // a write still waiting on a save of this room is answered that it is gone
      rooms_.erase(it);
    }
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
  // Never under the map lock, and under no strand: each room's save runs off its own.
  for (const TreeId& id : closing) evict(id);
  if (!closing.empty()) LOG_INFO << "swept " << closing.size() << " rooms, " << openRooms() << " still open";
  // Each live access a write without a room left unsettled takes the store's owning steps again.
  std::vector<std::pair<TreeId, std::shared_ptr<RootAccess>>> unsettled;
  {
    std::lock_guard<std::mutex> lock(mutex_);
    for (const auto& [root, weak] : roots_)
      if (const std::shared_ptr<RootAccess> live = weak.lock(); live && !live->settled())
        unsettled.emplace_back(root, live);
  }
  for (const auto& [root, live] : unsettled) settle(root, *live);
  // The registry's own report of rooms that stay held: one a ceiling, however many rooms there are.
  std::size_t held = 0;
  {
    std::lock_guard<std::mutex> lock(mutex_);
    for (const auto& [id, live] : rooms_) held += live.held.has_value();
  }
  if (held == 0) {
    sweepsHeld_ = 0;
    return;
  }
  if (++sweepsHeld_ % kSweepsPerReport == 0) reportHeld(held, RoomsHeldUnsaved{}, "failed");
}

Saved RoomRegistry::standing(const TreeId& id) const {
  std::lock_guard<std::mutex> lock(mutex_);
  const auto it = rooms_.find(id);
  return it != rooms_.end() && it->second.held ? Saved::held : Saved::saved;
}

PendingSave RoomRegistry::persist(const TreeId& id) {
  std::lock_guard<std::mutex> lock(mutex_);
  const auto it = rooms_.find(id);
  if (it == rooms_.end()) return Saved::saved;  // a closed room holds nothing unsaved
  return PendingSave{*this, id, it->second.line, it->second.room->head()};
}

Saved PendingSave::wait() {
  if (!line_) return answered_;
  std::lock_guard<std::timed_mutex> gate(line_->gate);
  const Saved saved = registry_->save(tree_, line_, RoomRegistry::Asked::byAWrite);
  // An earlier save stored this write: one that failed since, or found the row gone, was of a later write, whose own
  // wait is told of it.
  if (saved == Saved::saved || line_->stored >= seq_) return Saved::saved;
  // The write that waited is told on its own line as applied and held, whichever door it came through.
  if (saved == Saved::held) settleCurrentWriteAs(kHeldUnsaved);
  return saved;
}

Saved RoomRegistry::save(const TreeId& id, const std::shared_ptr<SaveLine>& line, Asked asked) {
  GraphState state;
  LegendState legend;
  Lww<std::string> title;
  Lww<std::string> guide;
  Seq head = 0;
  std::vector<AppliedOp> rows;
  LandSeqs landSeqs;
  std::uint64_t writes = 0;
  std::optional<Held> held;
  {
    std::lock_guard<std::mutex> strand(strandFor(id));
    std::lock_guard<std::mutex> lock(mutex_);
    const auto it = rooms_.find(id);
    if (it == rooms_.end() || it->second.line != line) return line->retired ? Saved::gone : Saved::saved;
    const TreeRoom& room = *it->second.room;
    held = it->second.held;
    if (!room.unsaved()) return Saved::saved;  // nothing to save: no statement is sent, and no room is held for it
    // A held room is the timer's. A close, and whoever waits to write the tree's row, waits for the retry. A write
    // tries the save only when the room changed since the last try: one the failed save already covered — it queued
    // behind that save — shares its answer. Neither costs a statement.
    if (held && asked == Asked::inPassing) return Saved::held;
    if (held && asked == Asked::byAWrite && held->triedAt == room.head()) return Saved::held;
    std::tie(state, legend) = room.dirtyState();  // only what changed since the last save
    title = room.title();
    guide = room.guide();
    head = room.head();
    rows = room.pendingOps();
    landSeqs = room.landSeqs();
    writes = room.writes();
    it->second.saving = true;
  }
  // I/O under the gate alone: no strand, no map lock. The lattice lands first and the op rows after, so a crash
  // between the two leaves a lattice at `head` with no row at `head` — the feed misses one deed — never a row the
  // lattice cannot back. Once the process is told to stop, both run within what is left of the one budget.
  std::optional<StatementLimits> untilStopped;
  if (const std::uint64_t deadline = stopDeadlineMs_) untilStopped.emplace(kShutdownSaveBudget, steadyClock, deadline);
  bool rowStands = false;
  try {
    rowStands = repo_.save(id, state, legend, title, guide, head, landSeqs);
  } catch (const std::bad_alloc&) {
    throw;
  } catch (const std::exception& failure) {
    // The room keeps what it holds, dirty and with its rows queued: nothing is undone, since every open page has
    // already been sent the change, and the save is tried again without waiting for a caller.
    return hold(id, line, failure, asked, head);
  }
  const std::size_t landed = rowStands ? land(id, rows) : 0;

  std::lock_guard<std::mutex> strand(strandFor(id));
  TreeRoom* room = nullptr;
  {
    std::lock_guard<std::mutex> lock(mutex_);
    const auto it = rooms_.find(id);
    // Retired while its save ran: what the store took it holds, and the room is no longer there to be told.
    if (it == rooms_.end() || it->second.line != line) return rowStands ? Saved::saved : Saved::gone;
    it->second.held.reset();
    it->second.saving = false;
    room = it->second.room.get();
  }
  // The row is gone, and so is what this room would add to it: the room goes too, and a hold ends there, and says so.
  if (!rowStands) {
    if (held) LOG_WARN << "roadmap_tree_save outcome=row-gone hold=" << held->id << " attempts=" << held->attempts + 1;
    retire(id);
    return Saved::gone;
  }
  line->stored = head;
  // A write that landed while the store took the copy left marks the copy does not cover: they all stay, and the next
  // save stores them again with the rest.
  if (room->writes() == writes) room->markClean();
  room->dropLandedOps(landed);
  if (held)
    LOG_WARN << "roadmap_tree_save outcome=saved-after-retry hold=" << held->id << " attempts=" << held->attempts + 1
             << " held_ms=" << std::chrono::duration_cast<std::chrono::milliseconds>(
                    std::chrono::steady_clock::now() - held->since).count();
  return Saved::saved;
}

// A hold begins with one line under an id minted for it, and ends with one (save). The first room held when none
// was is the registry's report of the outage; the sweep files the ones after. Each timed failure doubles the wait up
// to the ceiling and sets the next retry; a write's or a close's failure leaves the timer's chain as it is.
Saved RoomRegistry::hold(const TreeId& id, const std::shared_ptr<SaveLine>& line, const std::exception& failure,
                         Asked asked, Seq triedAt) {
  std::optional<std::chrono::milliseconds> retryIn;
  std::string hold;
  bool began = false;
  bool first = false;
  {
    std::lock_guard<std::mutex> lock(mutex_);
    auto it = rooms_.find(id);
    if (it == rooms_.end() || it->second.line != line) return Saved::gone;  // retired while its save ran
    it->second.saving = false;
    std::optional<Held>& held = it->second.held;
    if (!held) {
      first = std::none_of(rooms_.begin(), rooms_.end(), [](const auto& entry) { return entry.second.held.has_value(); });
      held = Held{freshWriteRequestId().substr(0, 16), 1, kFirstRetry, std::chrono::steady_clock::now()};
      began = true;
      retryIn = held->wait;
    } else {
      ++held->attempts;
      if (asked == Asked::byTheTimer) {
        held->wait = std::min(held->wait * 2, kRetryCeiling);
        retryIn = held->wait;
      }
    }
    held->triedAt = triedAt;
    hold = held->id;
  }
  if (began) LOG_WARN << "roadmap_tree_save outcome=held-unsaved hold=" << hold << " door=" << doorNow();
  if (first) reportHeld(1, failure, "failed");
  if (!retryIn) return Saved::held;
  retryTimer_(*retryIn, [this, id, line, hold] {
    std::lock_guard<std::timed_mutex> gate(line->gate);
    {
      std::lock_guard<std::mutex> lock(mutex_);
      const auto it = rooms_.find(id);
      // Saved, retired or closed since; a room held anew has a retry of its own.
      if (it == rooms_.end() || !it->second.held || it->second.held->id != hold) return;
    }
    save(id, line, Asked::byTheTimer);  // a row that went away under the held room retires it there
  });
  return Saved::held;
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
  // Read under the root's lock, which every change to the root's access holds, and with no room of the root's trees
  // live, so the store holds every write of theirs: it cannot be stale.
  const std::optional<StoredAccess> stored = repo_.loadAccess(root);
  if (!stored) return nullptr;
  std::set<OwningStep> absent;
  WriteObservation standing{"roadmap.tree.standing", "roadmap", doorNow()};
  try {
    absent = repo_.absentStepsUnder(root);
    standing.skip();
  } catch (const std::exception& failure) {
    standing.fail(failure);
    throw;
  }
  auto access = std::make_shared<RootAccess>(stored->access.owner, stored->access.visibility, std::move(absent),
                                             [this, root](const OwningStep& step) { announceBelow(root, step); });
  std::lock_guard<std::mutex> lock(mutex_);
  roots_[root] = access;
  return access;
}

void RoomRegistry::announceBelow(const TreeId& root, const OwningStep& step) {
  if (!accessChanged_) return;
  std::vector<TreeId> below;
  {
    std::lock_guard<std::mutex> lock(mutex_);
    for (const auto& [id, live] : rooms_) {
      const std::vector<OwningStep>& path = live.room->path();
      if (live.room->root() == root && std::find(path.begin(), path.end(), step) != path.end()) below.push_back(id);
    }
  }
  for (const TreeId& tree : below) accessChanged_(tree);
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
