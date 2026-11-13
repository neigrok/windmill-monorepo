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
#include <cstdint>
#include <exception>
#include <functional>
#include <map>
#include <memory>
#include <mutex>
#include <optional>
#include <string>
#include <vector>

namespace wm {

// A live room's save found its tree's row gone — an erasure or a removal took it — and wrote nothing back.
struct TreeRowGone : std::exception {
  const char* what() const noexcept override { return "the tree's row went away under its live room"; }
};

// What a save of a room came to. `saved`: the store holds the room's writes, and their op rows landed after. `held`:
// the save failed — the room keeps the writes, which every open page has already been sent, and the registry tries
// the save again until the store takes them; a caller is told the change is applied and held, and need not resend it.
// `gone`: the tree's row is gone or retired, so nothing was written and the room has nothing a caller may attest.
enum class Saved { saved, held, gone };
// The outcome a write's line carries when its save is held: applied, not yet stored, being retried. The registry
// completes the line of the write that asked for the save, so every door tells it alike.
inline constexpr char kHeldUnsaved[] = "held-unsaved";
// What a door tells the caller of such a write, in its own reply's shape.
inline constexpr char kHeldUnsavedSentence[] =
    "The change is applied and every open page has it, but saving it failed. The server holds it and is retrying the "
    "save; do not send it again.";

// Owns the live TreeRooms, one per tree being viewed or edited. Idle ones are persisted and closed
// on its own heartbeat — a room is a cache of the row, not a residence. Every live room of one root's
// trees shares that root's RootAccess, which is made and changed under the root's lock alone: the
// open that makes it reads the root's row under it, and a change of the root's visibility or its
// removal writes the row under it, so no live room ever answers a reader its root's row does not.
class RoomRegistry {
public:
  // When a held room's save is tried again: `retry` runs once, `delay` from now. The registry's own heartbeat thread
  // unless one is given; a test gives its own and runs the retries itself.
  using RetryTimer = std::function<void(std::chrono::milliseconds delay, std::function<void()> retry)>;
  // A held room is retried after kFirstRetry, then after twice the wait before, up to kRetryCeiling between tries. Its
  // failure is reported when it is first held and then at most once per kRetryCeiling of waiting.
  static constexpr std::chrono::milliseconds kFirstRetry{1000};
  static constexpr std::chrono::milliseconds kRetryCeiling{60000};

  RoomRegistry(TreeRepository& repo, OpLog& ops, PresenceBus& bus, RetryTimer retryTimer = {});
  // Stops the heartbeat, so no retry runs after it, then tries each held room's save once more.
  void stop();

  // nullptr means no such tree; a throw means infrastructure failure, whose detail must be logged
  // and never surfaced (a pqxx message carries a host, a port, a role). A room found held tries its save
  // again first, so no call that reaches the tree — a retried write that changes nothing, a read — leaves
  // the store behind when it can be reached; one whose row has gone meanwhile is retired and answers nullptr.
  TreeRoom* open(const TreeId& id);

  // Answers WITHOUT materializing a room. Every path that may refuse asks this BEFORE open(), which
  // drags the whole lattice off disk and pins it. A tree of any depth is answered its root's access:
  // the live RootAccess while any room of the root's trees is open, else the root's row.
  std::optional<TreeAccess> accessOf(const TreeId& id);

  // Save, then land the queued op rows, then close. A row that fails to land after the save is
  // dropped with the room — logged, never surfaced — since the lattice it describes is durable. A room
  // whose save fails is held and stays open, its writes being nowhere else: answered false, where a
  // room that closed, or was not open, answers true.
  bool evict(const TreeId& id);

  // Drops a retired tree's room and announces the change; deliberately does NOT persist on the way
  // out. Caller holds the strand.
  void retire(const TreeId& id);
  // Retires, each under its own strand, the rooms of trees whose rows were deleted outside this
  // registry — the trees of an erased account.
  void retireErased(const std::vector<std::string>& trees);
  // Save a live room's dirty slice without evicting, then land its queued op rows. `gone` when the
  // tree's row is gone or retired (TreeRowGone names it where it is reported). `saved` also when the rows
  // fail to land: the save is what a caller's reply attests, and the rows retry on the next persist. A save
  // that fails throws nothing: the room is held, the failure is reported as `roadmap.tree.save`, and a
  // retry is set on the timer. Caller holds the strand.
  Saved persist(const TreeId& id);
  // The share seam, for a root: its row and the access every live room of its trees shares, the narrower first, so
  // making it private shuts its subtrees before its row says so, and opening it opens them after. Each of those rooms
  // is announced. Caller holds the root's strand.
  void setVisibility(const TreeId& root, Visibility visibility);
  // Soft-deletes the tree's row and retires its room. A root's shared access falls first, so every live room of its
  // trees answers as absent before its row does, and each is announced. Caller holds the tree's strand.
  void remove(const TreeId& id);
  bool isOpen(const TreeId& id) const;
  std::size_t openRooms() const;

  // Announces a visibility change so the socket layer can drop readers who may no longer stay.
  // Installed once at wiring, before any connection.
  void whenAccessChanges(std::function<void(const TreeId&)> hook);

  // Persist-then-close every room untouched for `idleFor`, then the least-recently-touched down to
  // the room cap.
  void sweep(std::chrono::steady_clock::duration idleFor);

  // A live room takes the rename through its lattice; a closed tree's goes straight to the column,
  // stamped past `persistedStamp` so it dominates the stored title. `gone` when the live room's row is
  // gone, and the room is retired. Caller holds the strand.
  Saved rename(const TreeId& id, const std::string& title, std::uint64_t nowMs, const Hlc& persistedStamp);

  // One writer per tree: every caller that touches a room holds this. Striped over a fixed lock
  // array so unknown tree ids can't grow it; never hold two strands at once.
  std::mutex& strandFor(const TreeId& id);

private:
  // What asks for a save: a write that has just landed in the room, a call or a sweep that found the room, or the
  // retry timer. Only the timer's failures count toward the next wait and the next report.
  enum class Asked { byAWrite, inPassing, byTheTimer };
  Saved save(const TreeId& id, Asked asked);
  void hold(const TreeId& id, const std::exception& failure, Asked asked);
  void land(const TreeId& id, TreeRoom& room);
  // The access every live room of `root`'s trees shares, made from the root's row when none is live. Called under the
  // root's lock; nullptr when the root does not stand.
  std::shared_ptr<RootAccess> shareRootAccess(const TreeId& root);
  // The live one, or nullptr. Caller holds mutex_.
  std::shared_ptr<RootAccess> liveRootAccess(const TreeId& root);
  // The live rooms of `root`'s trees, the root's own among them.
  std::vector<TreeId> roomsUnder(const TreeId& root) const;
  // One lock per root: taken under a strand, never the other way round, and only mutex_ is taken under it.
  std::mutex& rootLockFor(const TreeId& root);

  static constexpr std::size_t kStrandStripes = 64;
  static constexpr std::size_t kMaxRooms = 256;
  static constexpr std::chrono::minutes kIdleFor{10};
  static constexpr double kSweepSeconds = 30.0;

  // A room whose save failed, until one lands: which hold it is, so a retry set for an earlier one that has since
  // landed tries nothing; how many saves were tried; the wait before the next timed one; and how much waiting has
  // passed since the failure was last reported.
  struct Held {
    std::uint64_t hold = 0;
    std::uint64_t attempts = 1;
    std::chrono::milliseconds wait = kFirstRetry;
    std::chrono::milliseconds unreported{0};
  };
  // Steady time, never wall time: a clock stepped backwards must not resurrect a room.
  struct Live {
    std::unique_ptr<TreeRoom> room;
    std::chrono::steady_clock::time_point touched;
    std::optional<Held> held;
  };

  TreeRepository& repo_;
  OpLog& ops_;
  PresenceBus& bus_;
  RetryTimer retryTimer_;
  mutable std::mutex mutex_;
  std::map<TreeId, Live> rooms_;
  std::map<TreeId, std::weak_ptr<RootAccess>> roots_;
  std::uint64_t holds_ = 0;
  std::function<void(const TreeId&)> accessChanged_;
  std::array<std::mutex, kStrandStripes> strands_;
  std::array<std::mutex, kStrandStripes> rootLocks_;
  // Last, so it destructs first: its destructor joins the sweeper, which must happen while the
  // members above are still alive.
  Heartbeat heartbeat_;
};

}
