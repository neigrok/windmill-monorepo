#pragma once

#include "products/roadmap/domain/Access.h"
#include "products/roadmap/domain/Command.h"
#include "products/roadmap/domain/Crdt.h"
#include "products/roadmap/domain/Ids.h"
#include "products/roadmap/domain/Legend.h"
#include "products/roadmap/domain/LooseGraph.h"
#include "products/roadmap/domain/Subgraph.h"
#include "products/roadmap/domain/Subtree.h"
#include "products/roadmap/domain/Tree.h"
#include "products/roadmap/domain/TreeDiagnostics.h"
#include "products/roadmap/ports/OpLog.h"
#include "products/roadmap/ports/PresenceBus.h"

#include <algorithm>
#include <atomic>
#include <cstddef>
#include <cstdint>
#include <functional>
#include <map>
#include <memory>
#include <mutex>
#include <optional>
#include <set>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

namespace wm {

// What every tree under one root is read by: the root's owner, its visibility, whether it stands, and the owning steps
// under it that are absent. A subtree has no access of its own (SPEC.md, Authorization), so each live room of the root's
// trees shares this one, which RoomRegistry keeps beside the root: it is made from the stored rows under the root's
// lock, its owner, visibility and standing change there as the root's row does, and each owning step is recorded by
// the room of the tree that holds it, under that tree's strand, as every write lands. It is read without a strand.
class RootAccess {
public:
  // Told each owning step whose presence a record changed.
  using StepMoved = std::function<void(const OwningStep&)>;

  RootAccess(std::optional<UserId> owner, Visibility visibility, std::set<OwningStep> absent = {},
             StepMoved moved = {})
      : owner_(std::move(owner)), visibility_(visibility), absent_(std::move(absent)), moved_(std::move(moved)) {}
  const std::optional<UserId>& owner() const { return owner_; }
  Visibility visibility() const { return visibility_.load(); }
  bool stands() const { return stands_.load(); }
  void setVisibility(Visibility visibility) { visibility_.store(visibility); }
  void setStanding(bool stands) { stands_.store(stands); }
  // Whether a tree at `path` stands: the root stands and no owning step on the way is absent.
  bool admits(const std::vector<OwningStep>& path) const;
  // Whether `step`, an owning step under the root, is present. A change is told to the StepMoved given.
  void record(const OwningStep& step, bool present);
  // The owning steps of every tree under the root but those in `live` as the store holds them, `absent` being every
  // absent one it holds under the root: what a write that reached a tree's rows without its room leaves. Answers the
  // steps whose presence changed, for the caller to tell once it holds no lock, and the access is settled from here on.
  std::vector<OwningStep> settle(const std::set<OwningStep>& absent, const std::set<TreeId>& live);
  // Whether the access is known to hold every closed tree's owning steps as the store does. Unsettled, it is narrower
  // than the store, never wider: a write without a room only revives owning steps.
  bool settled() const { return settled_.load(); }
  void unsettle() { settled_.store(false); }

private:
  const std::optional<UserId> owner_;
  std::atomic<Visibility> visibility_;
  std::atomic<bool> stands_{true};
  std::atomic<bool> settled_{true};
  mutable std::mutex mutex_;
  std::set<OwningStep> absent_;
  const StepMoved moved_;
};

// The authority for one tree, on a single strand: one thread mutates its state at a time. It joins
// every subgraph — never rejects. Validity is a separate read model (diagnose()).
class TreeRoom {
public:
  // The HLC actor stamped on every server-minted write; authorship itself lives in AppliedOp.actor.
  static constexpr std::string_view kServerActor{"srv"};

  // `access` is the root's, shared by every live room of its trees; `root` names it, and is `id` for a root. `path` is the
  // tree's owning steps from the root down, empty for a root, and `subtrees` the subtree each step owns, by step.
  TreeRoom(TreeId id, Lww<std::string> title, Lww<std::string> guide, bool guideInherited, LooseGraph graph,
           Legend legend, Seq head, TreeId root, std::vector<OwningStep> path, std::map<NodeId, TreeId> subtrees,
           std::shared_ptr<RootAccess> access, std::uint64_t createdAt, PresenceBus& bus);

  // Dedupe on the frame's id, fold its stamps into the clock, join graph + legend + title + guide,
  // assign the next seq, and queue its headline deed under `actor` for the op log, mark the rows to save and
  // broadcast — all three as what landed, each entry cut to the registers that took, not the frame as sent.
  // nullopt means the frame lands nothing — a duplicate, or one whose every stamp the room already
  // holds — so it takes no seq, dirties nothing and is told to no one. Admits nothing on its own —
  // every door that can refuse asks admit() and unconfirmedBranches() first; a frame that removes an owning step its
  // `branches` do not name is a fault (std::logic_error), refused before anything lands. Every owning step the frame
  // leaves present or absent is recorded in the root's access before the frame is told.
  std::optional<Seq> joinSubgraph(const Subgraph& incoming, const UserId& actor);

  // Why joining this arrival would breach the tree's caps, or nullopt. Asked against THIS room's
  // live state, not against the arrival alone. The frame overload asks graph, legend, title and guide.
  std::optional<Admission> admit(const Subgraph& incoming) const;
  std::optional<Admission> admit(const Graft& incoming) const { return wm::admit(graph_, incoming); }

  // The owning steps a write would remove without naming their subtrees (wm::unconfirmedBranches), read off this room's
  // live state under the strand the write then takes: a frame's by what its join would delete, a graft's by its
  // tombstones, a deletion's by the steps it names.
  std::vector<UnconfirmedBranch> unconfirmedBranches(const Subgraph& incoming) const;
  std::vector<UnconfirmedBranch> unconfirmedBranches(const Graft& incoming) const;
  std::vector<UnconfirmedBranch> unconfirmedBranches(const std::vector<NodeId>& deleting,
                                                     const std::set<TreeId>& branches) const;

  // What importTree(incoming) would do beyond the upsert — the edges it keeps, replaces or
  // tombstones — read off this room's live state, changing nothing.
  GraftFootprint footprintOf(const Graft& incoming) const { return wm::footprintOf(graph_, incoming); }
  // The nodes importTree(incoming) would repaint for the kinds it re-hues, read off this room's live state.
  Repaint repaintOf(const Graft& incoming) const { return wm::repaintOf(graph_, legend_, incoming); }
  // Whether importTree(incoming) at `nowMs` would land nothing, read off a copy of the room clock so
  // nothing moves: the preview a dry run answers.
  bool graftLandsNothing(const Graft& incoming, std::uint64_t nowMs) const {
    return graftFrame(graph_, legend_, incoming, HlcClock(clock_).tick(nowMs)).landsNothing();
  }

  // A node write's kind read off this room's own legend, under the strand the write then takes, so a
  // kind always lands as the hue it wears in the legend the write is applied to. `node` names the node
  // the write lands on, whose held colour beside the kind is an echo; a node being created names none.
  std::variant<std::optional<NodeColor>, KindRefusal> resolveHue(const HueChoice& choice,
                                                                 const std::optional<NodeId>& node,
                                                                 const std::string& path) const {
    return wm::resolveHue(legend_.kinds(), choice, node ? graph_.exportNode(*node) : std::nullopt, path);
  }
  std::variant<Graft, KindRefusal> resolveKinds(Graft incoming) const {
    return wm::resolveKinds(graph_, legend_, std::move(incoming));
  }
  std::variant<Graft, std::string> resolveLinks(Graft incoming) const {
    return wm::resolveLinks(graph_, std::move(incoming));
  }

  // The title and the guide, each set only when sent, stamped from the room clock and joined as one frame, so a
  // call that sets both lands both at one seq; it broadcasts and LWW-merges like any other field write, and leaves
  // no op row. rename and setGuide set one each.
  Seq describe(const std::optional<std::string>& title, const std::optional<std::string>& guide, std::uint64_t nowMs);
  Seq rename(const std::string& title, std::uint64_t nowMs) { return describe(title, std::nullopt, nowMs); }
  Seq setGuide(const std::string& guide, std::uint64_t nowMs) { return describe(std::nullopt, guide, nowMs); }

  // Server-origin edit: stamped from the room clock, applied, queued for the op log, broadcast as
  // one subgraph. The frameId is minted from the (unique) stamp.
  Seq applyCommand(const Command& command, std::uint64_t nowMs, const UserId& actor);
  // Several commands as ONE edit: one stamp, one frame, one seq, one op row (a Batch, so the log
  // tells the whole edit), so a reader never sees the tree between them. An empty list is a
  // no-op answering the current head. Admits nothing on its own; deleting an owning step whose subtree `branches` does
  // not name is a fault, refused before anything lands, as a frame's is.
  Seq applyCommands(const std::vector<Command>& commands, std::uint64_t nowMs, const UserId& actor,
                    const std::set<TreeId>& branches = {});

  // Stamped from the room clock, so a by-id collision is an upsert; the graft's tombstones and
  // replaced edges are removed at that same stamp, in the same frame. An empty `kinds` leaves the
  // legend untouched. A graft that lands nothing is not joined: no seq, no op, no frame, nothing to
  // save, and the answer is nullopt.
  std::optional<Seq> importTree(const Graft& incoming, std::uint64_t nowMs, const UserId& actor);

  // One clock per tree, so no two writes collide on a stamp. `nowMs` is wall time from the Clock port.
  Hlc nextStamp(std::uint64_t nowMs);
  // A stamp issued for this tree that the loaded state does not show — the greatest among the op rows past the
  // snapshot, when it is behind its log: the next stamp the room mints is past it.
  void observe(const Hlc& issued) { clock_.observe(issued); }
  // The head taken past the last op row of a log the snapshot is behind: the room then has that head to save.
  void takeHeadPast(Seq lastRow) {
    if (lastRow <= head_) return;
    head_ = lastRow;
    unsaved_ = true;
    ++writes_;
  }
  // Whether the room holds anything its store does not: a write since the last save, or an op row still to land. A
  // subtree created under one of its steps is stored by its own transaction, the head with it, and leaves nothing.
  bool unsaved() const { return unsaved_ || !pendingOps_.empty(); }
  // The first of the two alone: a room without one, and with no save of it running, is one whose row the store holds
  // level with it.
  bool holdsUnsavedWrites() const { return unsaved_; }
  // How many writes the room has taken. A save reads it as it copies the dirty slice under the strand and again once
  // the store took the slice: the same number means no write landed between, so the slice was all the room had dirty.
  std::uint64_t writes() const { return writes_; }

  // wm::validate over this room's live state: a malformed or over-cap field, a node edit naming no
  // present node, or a legend rule. Server-driven undo/redo bypasses it.
  std::optional<std::string> validate(const Command& command) const;

  std::variant<NodePatchPlan, std::string, KindRefusal> planNodePatches(const std::vector<NodePatch>& updates) const {
    return wm::planNodePatches(graph_, legend_, updates);
  }
  std::variant<EdgeChangePlan, std::string> planEdgeChanges(const EdgeChanges& changes) const {
    return wm::planEdgeChanges(graph_, changes);
  }
  std::variant<KindUpdatePlan, std::string> planKindUpdate(const KindUpdate& update) const {
    return wm::planKindUpdate(graph_, legend_, update);
  }

  // The seq the next event on this tree's stream takes.
  Seq nextSeq() const { return head_ + 1; }
  // A write whose commit's answer was lost may have stored a later head than this room holds: the room takes it, so its
  // next seq is past every seq stored.
  void catchUp(Seq storedHead) { head_ = std::max(head_, storedHead); }
  // A subtree created under `step` and stored with this tree's head at nextSeq(): the stream takes that seq, the step owns
  // it from here on (ownSubtree) and every subscriber is told. It changes no register, dirties nothing and queues no op
  // row.
  void appendSubtree(const NodeId& step, const Subtree& subtree);
  // `step` owns `subtree` from here on, in every projection the room makes: what the stored rows say, which a room that
  // missed the subtree's creation takes. It takes no seq and tells no one.
  void ownSubtree(const NodeId& step, const TreeId& subtree);

  // The op rows this room's writes minted and no save has yet landed, in seq order. RoomRegistry copies them with the
  // slice it saves and appends them AFTER the lattice is saved at the head they carry — so the log can never run ahead
  // of the lattice — and the ones that landed leave the queue through dropLandedOps: the first `landed` of it, which
  // are the rows copied, since a write queues its row at the back. An append that throws leaves its row and the rest
  // queued for the next save, and the log's `(tree_id, op_id)` uniqueness absorbs the retry.
  const std::vector<AppliedOp>& pendingOps() const { return pendingOps_; }
  void dropLandedOps(std::size_t landed);

  // A room closing with rows still queued drops them — the lattice they describe is durable, only
  // the feed misses those deeds — and says so in the log.
  ~TreeRoom();

  TreeDiagnostics diagnose() const;
  // The tree each present step opens, without the copy of every node snapshot() makes: the subtree it owns, whatever its
  // pointer holds (SPEC.md, Model, Subtrees), else the tree its pointer names (LooseGraph::pointers).
  std::map<NodeId, TreeId> pointers() const;
  // The same, each with the stamp its pointer was set under; a subtree a step owns is opened under none.
  std::map<NodeId, StampedPointer> stampedPointers() const;
  // The subtree each present step owns, by step.
  std::map<NodeId, TreeId> subtrees() const;
  // The document: each present node opens the tree pointers() says it does.
  TreeData snapshot() const;
  // How many times snapshot() copied the whole tree out of this room: what a cost test reads.
  std::size_t snapshots() const { return snapshots_; }
  std::vector<Kind> kinds() const { return legend_.kinds(); }  // the snapshot's legend, without its nodes
  GraphState exportState() const;
  LegendState exportLegend() const;
  // What a peer at `since` is missing — graph, legend, title and guide — covering the room's whole
  // frontier. A peer that says the last seq it applied, `position`, is also sent, whole, every entry and tree register
  // that landed late past it (LandSeqs): under a stamp the vector may already be past. A subtree's own title register
  // is read by nothing (SPEC.md, Model, Subtrees), so it is neither sent nor covered: its subscriber is sent its
  // owning step's label beside the delta.
  Subgraph deltaSince(const VersionVector& since, std::optional<Seq> position = std::nullopt) const;
  // The seq at which each entry and tree register last landed late; a save stores the ones of the rows it writes.
  const LandSeqs& landSeqs() const { return landSeqs_; }
  // The land seqs the stored rows hold, as the room opens.
  void restoreLandSeqs(LandSeqs stored) { landSeqs_ = std::move(stored); }
  // The stamps the room has held, by which a register that lands is judged late.
  const HeldStamps& held() const { return held_; }

  // Exports only the entries dirtied since the last markClean(). The caller holds the strand for each; a save that
  // lets it go between the two cleans only when writes() reads as it did at the export.
  std::pair<GraphState, LegendState> dirtyState() const;
  void markClean();

  // The tree each step opens (pointers()) as `caller` may be told of it: all of them for a caller who can write the
  // tree, none for anyone else, whose marks are their own.
  std::map<NodeId, TreeId> pointersFor(const std::optional<UserId>& caller) const;
  // The node's live prerequisites (incoming DAG edges); empty if the node is absent.
  std::vector<NodeId> prerequisitesOf(const NodeId& node) const;
  bool hasNode(const NodeId& node) const;  // present: created, not tombstoned
  // A present node's label; none for a node the tree does not hold.
  std::optional<std::string> labelOf(const NodeId& node) const;
  bool hasEdge(const NodeId& from, const NodeId& to) const;
  // Present edges with either endpoint among `nodes`: what deleting them would leave dangling.
  std::vector<Edge> edgesTouching(const std::vector<NodeId>& nodes) const;
  // An unset stamp means the create-time baseline, never written since.
  const Lww<std::string>& title() const { return title_; }
  const Lww<std::string>& guide() const { return guide_; }
  // A guide a fork copied from someone else's tree, until a guide frame wins over it: its author's
  // words, never the owner's own.
  bool guideInherited() const { return guideInherited_; }
  Seq head() const { return head_; }
  // epoch ms; immutable.
  std::uint64_t createdAt() const { return createdAt_; }

  // The root's, for a tree of any depth. The owner is empty only on a legacy row nobody owns; writes require it.
  const std::optional<UserId>& owner() const { return access_->owner(); }
  Visibility visibility() const { return access_->visibility(); }
  const TreeId& root() const { return root_; }
  // Where the tree hangs: its owning steps from the root down, the step that owns it (none for a root), and how deep it
  // sits. Fixed when the tree is created, so read without the strand.
  const std::vector<OwningStep>& path() const { return path_; }
  std::optional<OwningStep> parent() const {
    if (path_.empty()) return std::nullopt;
    return path_.back();
  }
  int depth() const { return static_cast<int>(path_.size()); }
  const std::shared_ptr<RootAccess>& rootAccess() const { return access_; }
  // Whether the tree stands: its root stands and every owning step on its path is present, as the root's access holds
  // them.
  bool stands() const { return access_->admits(path_); }
  // The read gate a door asks of a live room: the tree stands and `caller` may read its root.
  bool readableBy(const std::optional<UserId>& caller) const {
    return stands() && canRead(caller, access_->owner(), access_->visibility());
  }

private:
  void markDirty(const GraphState& graph, const LegendState& legend);
  // A write that would remove an owning step `branches` do not name is a door's fault, never a landing.
  void insistConfirmed(const std::vector<NodeId>& removed, const std::set<TreeId>& branches) const;
  // Each owning step's presence, as the graph now holds it, recorded in the root's access.
  void recordOwningSteps();

  TreeId id_;
  Lww<std::string> title_;
  Lww<std::string> guide_;
  bool guideInherited_;
  LooseGraph graph_;
  Legend legend_;
  Seq head_;
  TreeId root_;
  std::vector<OwningStep> path_;
  std::map<NodeId, TreeId> subtrees_;
  std::shared_ptr<RootAccess> access_;
  std::uint64_t createdAt_;
  std::set<std::string> appliedOpIds_;
  std::vector<AppliedOp> pendingOps_;
  PresenceBus& bus_;
  HlcClock clock_;
  LandSeqs landSeqs_;
  HeldStamps held_;
  bool unsaved_ = false;  // a write has landed since the store last took the room
  std::uint64_t writes_ = 0;
  std::set<NodeId> dirtyNodes_;
  std::set<Edge> dirtyEdges_;
  std::set<KindId> dirtyKinds_;
  mutable std::size_t snapshots_ = 0;
};

}
