#pragma once

#include "platform/application/Heartbeat.h"
#include "products/roadmap/application/TreeRoom.h"
#include "products/roadmap/domain/Ids.h"
#include "products/roadmap/ports/OpLog.h"
#include "products/roadmap/ports/PresenceBus.h"
#include "products/roadmap/ports/TreeRepository.h"

#include <array>
#include <atomic>
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
// A class, not an enum: a test macro casts its condition to bool, and an enum's first value would read as false, so a
// save's outcome is only ever compared.
class Saved {
public:
  static const Saved saved;
  static const Saved held;
  static const Saved gone;
  bool operator==(const Saved&) const = default;

private:
  enum class Outcome { saved, held, gone };
  constexpr explicit Saved(Outcome outcome) : outcome_(outcome) {}
  Outcome outcome_;
};
inline constexpr Saved Saved::saved{Saved::Outcome::saved};
inline constexpr Saved Saved::held{Saved::Outcome::held};
inline constexpr Saved Saved::gone{Saved::Outcome::gone};
// The outcome a write's line carries when its save is held: applied, not yet stored, being retried. The registry
// completes the line of the write that asked for the save, so every door tells it alike.
inline constexpr char kHeldUnsaved[] = "held-unsaved";
// What a door tells the caller of such a write, in its own reply's shape.
inline constexpr char kHeldUnsavedSentence[] =
    "The change is applied and every open page has it, but saving it failed and the server is retrying the save. "
    "Sending it again is not needed. A server restart before the save succeeds would lose it, so read the record again "
    "later if it matters.";
// What a door tells the caller of a call that changed nothing in a room that is held: the call wrote nothing, and what
// the room holds unsaved is earlier work.
inline constexpr char kHeldEarlierSentence[] =
    "This call changed nothing in the tree. The tree holds earlier changes that are not saved yet, and the server is "
    "retrying the save; a server restart before it succeeds would lose them.";

// One per live room, shared with every write that waits on a save of it, so a room that closes or is retired under a
// waiting write still answers it.
struct SaveLine {
  // One save of the room at a time, held across its statements: two saves of one tree never pass each other, and a
  // write's op row lands after the save that covers it and before any later one. Taken before the strand, never under
  // it, so whoever waits here holds no reader up.
  std::timed_mutex gate;
  // The head the store last took from the room. Read and written under the gate.
  Seq stored = 0;
  // The room was dropped with what it held unsaved: nothing more of it is stored. Under the registry's lock.
  bool retired = false;
};

class RoomRegistry;

// A write's wait for the save that stores it. A door takes one under the strand, once its write has landed in the
// room (RoomRegistry::persist), builds its reply, lets the strand go and only then waits: the statement runs with the
// strand free, so a read of the tree, and a write to it, never waits behind the store. `saved`: the store holds the
// write, whichever save took it. `held`: the save that covered it failed and the registry is retrying; a write that
// queued behind that save is told so without a statement of its own. `gone`: the tree's row went away, or the room was
// retired, before the write was stored. Waited on under the strand it would never return.
class PendingSave {
public:
  // Nothing to wait for: a call that changed nothing, or a tree with no live room, is answered as it stands.
  PendingSave(Saved answered) : answered_(answered) {}
  Saved wait();

private:
  friend class RoomRegistry;
  PendingSave(RoomRegistry& registry, TreeId tree, std::shared_ptr<SaveLine> line, Seq seq)
      : registry_(&registry), tree_(std::move(tree)), line_(std::move(line)), seq_(seq) {}
  RoomRegistry* registry_ = nullptr;
  TreeId tree_{""};
  std::shared_ptr<SaveLine> line_;
  Seq seq_ = 0;
  Saved answered_ = Saved::saved;
};

// Owns the live TreeRooms, one per tree being viewed or edited. Idle ones are persisted and closed
// on its own heartbeat — a room is a cache of the row, not a residence. Every live room of one root's
// trees shares that root's RootAccess, which is made and changed under the root's lock alone: the
// open that makes it reads the root's row and its absent owning steps under it, and a change of the
// root's visibility or its removal writes the row under it, so no live room ever answers a reader its
// root's row does not. Each room records its own owning steps in it as its writes land, so a branch
// hides the moment the step that owns it is deleted, on every gate, and shows again with its revive.
//
// A room's save runs off its strand. Under the strand the save copies what the room holds unsaved and lets go; it
// stores the copy, then its op rows; under the strand again it clears the room's marks only if no write landed
// meanwhile, and otherwise leaves them all for the next save. One save of a room runs at a time (SaveLine). So the
// strand is held for memory work alone on this path, and a store that hangs holds up only the writes waiting on it.
class RoomRegistry {
public:
  // When a held room's save is tried again: `retry` runs once, `delay` from now. The registry's own heartbeat thread
  // unless one is given; a test gives its own and runs the retries itself.
  using RetryTimer = std::function<void(std::chrono::milliseconds delay, std::function<void()> retry)>;
  // A held room is retried after kFirstRetry, then after twice the wait before, up to kRetryCeiling between tries. Only
  // the timer and a write that changes the room try a held room's save: a read, a write that changes nothing and the
  // sweep cost it no statement and move no retry. While any room is held the registry files one report under
  // `roadmap.tree.save` when the first is held and one per kRetryCeiling after, with the number of rooms held; each
  // room's own hold is two lines, its beginning and its end, under an id minted for that hold.
  static constexpr std::chrono::milliseconds kFirstRetry{1000};
  static constexpr std::chrono::milliseconds kRetryCeiling{60000};
  // All the time every save may take together once the process is told to stop: the ones a write still waits for and
  // each room's last try. The deploy gives the container longer than this to stop (deploy/README.md).
  static constexpr std::chrono::milliseconds kShutdownSaveBudget{5000};

  RoomRegistry(TreeRepository& repo, OpLog& ops, PresenceBus& bus, RetryTimer retryTimer = {});
  // A registry that goes away has stopped: whatever owns one need not remember to.
  ~RoomRegistry();
  // The process was told to stop: the budget begins, once. From here every save runs within what is left of it — a
  // statement waits and runs no later than its end, and a save asked for after it is refused at once — and a door that
  // asks `stopping` takes no more writes. Safe to call from a signal handler: it reads a clock and sets one number.
  void beginStopping();
  bool stopping() const { return stopDeadlineMs_ != 0; }
  // Stops the heartbeat, so no retry runs after it, then tries once more the save of each room that holds a write the
  // store does not — held or not — the wait for a retry or a write in mid-save and all of those saves within what is
  // left of the budget (it begins here if nobody told the registry earlier). The rooms still unsaved after that are
  // lost with the process: one line and one report say how many.
  void stop();

  // nullptr means no such tree; a throw means infrastructure failure, whose detail must be logged
  // and never surfaced (a pqxx message carries a host, a port, a role). A held room is answered as it stands: opening
  // it tries no save.
  TreeRoom* open(const TreeId& id);

  // Answers WITHOUT materializing a room. Every path that may refuse asks this BEFORE open(), which
  // drags the whole lattice off disk and pins it. A tree of any depth is answered its root's access, and
  // nothing while its branch does not stand: the live RootAccess while any room of the root's trees is
  // open, else the stored rows. A live room answers from memory alone. A closed subtree the stored rows
  // admit is read again under its root's lock with no access live — when the store holds every write of
  // the root's trees — so a parent room that saved a deletion and closed since the first read admits
  // nobody; one they hide is answered hidden at once.
  std::optional<TreeAccess> accessOf(const TreeId& id);
  // A write that reached a tree's rows without its room (PUT) may have revived owning steps the live access of its root
  // holds absent: the access, if there is one, takes every closed tree's owning steps under `root` from the store again.
  // A read of the store that fails is reported as `roadmap.tree.standing` and throws nothing: the access is left
  // unsettled — narrower than the store, never wider — and the sweep settles it, as a room's open records its own
  // steps.
  void settleOwningSteps(const TreeId& root);

  // Save, then land the queued op rows, then close; a room with nothing unsaved closes with no save. A row
  // that fails to land after the save is dropped with the room — logged, never surfaced — since the lattice
  // it describes is durable. A room whose save is held, or fails here, stays open, its writes being nowhere
  // else, and waits for its retry, and so does one a write landed in while it was saved: answered false, where a
  // room that closed, or was not open, answers true. The caller holds no strand: the save runs off it.
  bool evict(const TreeId& id);
  // The save of whatever the tree's room holds unsaved, run here and waited for, for a caller that is about to write
  // the tree's row itself and holds no write of its own in the room (a write waits on what persist answers). `held`
  // for a room that is held, or whose save fails here: a held room's save is the timer's, and costs no statement.
  // The caller holds no strand.
  Saved flush(const TreeId& id);
  // Whether the store holds every write of the tree's room and no save of it is running, so nothing the registry does
  // is writing, or about to write, the tree's row: what a caller that writes the row itself asks before it does. A
  // tree with no live room is flushed. Caller holds the strand.
  bool flushed(const TreeId& id) const;
  // Closes a flushed room, with no statement; false, and the room stays, when it is not flushed. Caller holds the
  // strand.
  bool close(const TreeId& id);

  // Drops a retired tree's room and announces the change; deliberately does NOT persist on the way
  // out. Caller holds the strand.
  void retire(const TreeId& id);
  // Retires, each under its own strand, the rooms of trees whose rows were deleted outside this
  // registry — the trees of an erased account.
  void retireErased(const std::vector<std::string>& trees);
  // The save of a live room's dirty slice, without evicting, and of its queued op rows after: asked for here, under
  // the strand, by the write that has just landed, with no statement sent, and run where the caller waits on what is
  // answered, with the strand let go. There it is `gone` when the tree's row is gone or retired (TreeRowGone names it
  // where it is reported), and the room is retired with it. `saved` also when the rows fail to land: the save is what
  // a caller's reply attests, and the rows retry on the next save. A save that fails throws nothing: the room is held
  // and a retry is set on the timer. A held room is tried again only when it has changed since its save was last
  // tried; otherwise it is answered `held` with no statement sent. Caller holds the strand.
  [[nodiscard]] PendingSave persist(const TreeId& id);
  // What a call that changed nothing says of the room's save: `held` while it is, `saved` otherwise.
  Saved standing(const TreeId& id) const;
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

  // One writer per tree: every caller that touches a room holds this. Striped over a fixed lock
  // array so unknown tree ids can't grow it; never hold two strands at once.
  std::mutex& strandFor(const TreeId& id);

private:
  friend class PendingSave;
  // What asks for a save: a write that has just landed in the room; a caller in passing — a close, the sweep's or a
  // PUT's, or a subtree's create — which never tries a held room; the retry timer; or the registry as it stops. Only
  // the timer's failures move the next wait.
  enum class Asked { byAWrite, inPassing, byTheTimer, atShutdown };
  // One save of the room `line` belongs to, as the class comment tells it. The caller holds the line's gate and no
  // strand. A room that closed since the save was asked for has everything stored; one retired has not.
  Saved save(const TreeId& id, const std::shared_ptr<SaveLine>& line, Asked asked);
  // Holds the room for a save tried at head `triedAt` that failed. `gone` when the room was retired under the save.
  Saved hold(const TreeId& id, const std::shared_ptr<SaveLine>& line, const std::exception& failure, Asked asked,
             Seq triedAt);
  // One report for the registry, with the number of rooms held, under a request of its own.
  void reportHeld(std::size_t rooms, const std::exception& failure, const char* outcome);
  // Appends the rows in order and answers how many landed: the first failure stops it.
  std::size_t land(const TreeId& id, const std::vector<AppliedOp>& rows);
  // The access every live room of `root`'s trees shares, made from the root's row and its absent owning steps when none is
  // live. Called under the root's lock; nullptr when the root does not stand.
  std::shared_ptr<RootAccess> shareRootAccess(const TreeId& root);
  // Every live room below `step` is told its access changed: the step's branch hid or showed.
  void announceBelow(const TreeId& root, const OwningStep& step);
  // `live` takes the store's owning steps for every tree under `root` that has no live room, under the root's lock, and
  // the rooms below each step that moved are told once it is released. A read of the store that fails is reported as
  // `roadmap.tree.standing` and leaves `live` unsettled.
  void settle(const TreeId& root, RootAccess& live);
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

  // A sweep runs every kSweepSeconds, so every kSweepsPerReport-th one that finds rooms held is a ceiling apart.
  static constexpr std::size_t kSweepsPerReport = 2;
  // A room whose save failed, until one lands: the id its two lines carry, minted for this hold, by which a retry set
  // for an earlier one tries nothing; how many saves were tried; the wait before the next timed one; when the hold
  // began; and the head its save was last tried at, so a write that failed save already covered tries none.
  struct Held {
    std::string id;
    std::uint64_t attempts = 1;
    std::chrono::milliseconds wait = kFirstRetry;
    std::chrono::steady_clock::time_point since;
    Seq triedAt = 0;
  };
  // Steady time, never wall time: a clock stepped backwards must not resurrect a room.
  // `saving` while a save of the room is between its copy and its clearing of the marks: a statement may be writing
  // the tree's row.
  struct Live {
    std::unique_ptr<TreeRoom> room;
    std::chrono::steady_clock::time_point touched;
    std::optional<Held> held;
    std::shared_ptr<SaveLine> line = std::make_shared<SaveLine>();
    bool saving = false;
  };

  TreeRepository& repo_;
  OpLog& ops_;
  PresenceBus& bus_;
  RetryTimer retryTimer_;
  mutable std::mutex mutex_;
  std::map<TreeId, Live> rooms_;
  std::map<TreeId, std::weak_ptr<RootAccess>> roots_;
  std::size_t sweepsHeld_ = 0;  // sweeps running that found a room held
  bool stopped_ = false;
  std::atomic<std::uint64_t> stopDeadlineMs_{0};  // when the budget ends, on the steady clock; 0 while the server runs
  std::function<void(const TreeId&)> accessChanged_;
  std::array<std::mutex, kStrandStripes> strands_;
  std::array<std::mutex, kStrandStripes> rootLocks_;
  // Last, so it destructs first: its destructor joins the sweeper, which must happen while the
  // members above are still alive.
  Heartbeat heartbeat_;
};

}
