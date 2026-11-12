#pragma once

#include "products/roadmap/domain/Access.h"
#include "products/roadmap/domain/Command.h"
#include "products/roadmap/domain/Crdt.h"
#include "products/roadmap/domain/Ids.h"
#include "products/roadmap/domain/Legend.h"
#include "products/roadmap/domain/LooseGraph.h"
#include "products/roadmap/domain/Subgraph.h"
#include "products/roadmap/domain/Tree.h"
#include "products/roadmap/domain/TreeDiagnostics.h"
#include "products/roadmap/ports/OpLog.h"
#include "products/roadmap/ports/PresenceBus.h"

#include <cstddef>
#include <cstdint>
#include <optional>
#include <set>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

namespace wm {

// The authority for one tree, on a single strand: one thread mutates its state at a time. It joins
// every subgraph — never rejects. Validity is a separate read model (diagnose()).
class TreeRoom {
public:
  // The HLC actor stamped on every server-minted write; authorship itself lives in AppliedOp.actor.
  static constexpr std::string_view kServerActor{"srv"};

  TreeRoom(TreeId id, Lww<std::string> title, Lww<std::string> guide, bool guideInherited, LooseGraph graph,
           Legend legend, Seq head, std::optional<UserId> owner, Visibility visibility, std::uint64_t createdAt,
           PresenceBus& bus);

  // Dedupe on the frame's id, fold its stamps into the clock, join graph + legend + title + guide,
  // assign the next seq, queue its headline deed under `actor` for the op log, broadcast verbatim.
  // nullopt means a duplicate frame. Admits nothing on its own — every door that can refuse asks
  // admit() first.
  std::optional<Seq> joinSubgraph(const Subgraph& incoming, const UserId& actor);

  // Why joining this arrival would breach the tree's caps, or nullopt. Asked against THIS room's
  // live state, not against the arrival alone. The frame overload asks graph, legend, title and guide.
  std::optional<Admission> admit(const Subgraph& incoming) const;
  std::optional<Admission> admit(const Graft& incoming) const { return wm::admit(graph_, incoming); }

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
  // A write's links judged against the ones the node's record holds, read under the strand the write then takes, so
  // nothing lands between read and write.
  std::variant<std::vector<Link>, std::string> shownLinks(const NodeId& node, std::vector<Link> sent,
                                                          const std::string& path) const {
    return wm::shownLinks(graph_.linksOf(node), std::move(sent), path);
  }
  std::variant<std::vector<Link>, std::string> withLinksAdded(const NodeId& node, const std::vector<Link>& added,
                                                              const std::string& path) const {
    return wm::withLinksAdded(graph_.linksOf(node), added, path);
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
  // replays the whole edit), so a reader never sees the tree between them. An empty list is a
  // no-op answering the current head. Admits nothing on its own.
  Seq applyCommands(const std::vector<Command>& commands, std::uint64_t nowMs, const UserId& actor);

  // Stamped from the room clock, so a by-id collision is an upsert; the graft's tombstones and
  // replaced edges are removed at that same stamp, in the same frame. An empty `kinds` leaves the
  // legend untouched. A graft that lands nothing is not joined: no seq, no op, no frame, nothing to
  // save, and the answer is nullopt.
  std::optional<Seq> importTree(const Graft& incoming, std::uint64_t nowMs, const UserId& actor);

  // One clock per tree, so no two writes collide on a stamp. `nowMs` is wall time from the Clock port.
  Hlc nextStamp(std::uint64_t nowMs);

  // wm::validate over this room's live state: a malformed or over-cap field, a node edit naming no
  // present node, or a legend rule. Server-driven undo/redo bypasses it.
  std::optional<std::string> validate(const Command& command) const;

  // wm::changedPart over the node as this room holds it; on a node it does not hold, the edit lands whole.
  std::optional<Command> changedPart(const NodeId& node, const Command& command) const {
    const std::optional<NodeSpec> held = graph_.nodeView(node);
    if (!held) return command;
    return wm::changedPart(*held, command);
  }
  std::variant<NodePatchPlan, std::string, KindRefusal> planNodePatches(const std::vector<NodePatch>& updates) const {
    return wm::planNodePatches(graph_, legend_, updates);
  }
  std::variant<EdgeChangePlan, std::string> planEdgeChanges(const EdgeChanges& changes) const {
    return wm::planEdgeChanges(graph_, changes);
  }

  // Advances head + dedup set; does not re-persist or re-broadcast.
  void replay(const AppliedOp& op);

  // The op rows this room's writes minted and no save has yet landed, in seq order. A row leaves
  // the queue only through landPendingOps, which RoomRegistry calls AFTER the lattice is saved at
  // the head those rows carry — so the log can never run ahead of the lattice. Each row is
  // appended and dropped in turn, so an append that throws leaves the rest queued for the next
  // save, and the log's `(tree_id, op_id)` uniqueness absorbs the retry.
  const std::vector<AppliedOp>& pendingOps() const { return pendingOps_; }
  void landPendingOps(OpLog& log);

  // A room closing with rows still queued drops them — the lattice they describe is durable, only
  // the feed misses those deeds — and says so in the log.
  ~TreeRoom();

  TreeDiagnostics diagnose() const;
  // The tree each present node opens (LooseGraph::pointers), without the copy of every node snapshot() makes.
  std::map<NodeId, TreeId> pointers() const { return graph_.pointers(); }
  std::map<NodeId, StampedPointer> stampedPointers() const { return graph_.stampedPointers(); }
  TreeData snapshot() const;
  // How many times snapshot() copied the whole tree out of this room: what a cost test reads.
  std::size_t snapshots() const { return snapshots_; }
  std::vector<Kind> kinds() const { return legend_.kinds(); }  // the snapshot's legend, without its nodes
  GraphState exportState() const;
  LegendState exportLegend() const;
  // What a peer at `since` is missing — graph, legend, title and guide — covering the room's whole
  // frontier.
  Subgraph deltaSince(const VersionVector& since) const;

  // Exports only the entries dirtied since the last markClean(); replay() flips the room all-dirty.
  // The caller holds the strand across export and clean.
  std::pair<GraphState, LegendState> dirtyState() const;
  void markClean();

  // The tree's pointers as `caller` may be told of them: all of them for a caller who can write the
  // tree, none for anyone else, who is never told a node opens a tree.
  std::map<NodeId, TreeId> pointersFor(const std::optional<UserId>& caller) const;
  // The node's live prerequisites (incoming DAG edges); empty if the node is absent.
  std::vector<NodeId> prerequisitesOf(const NodeId& node) const;
  bool hasNode(const NodeId& node) const;  // present: created, not tombstoned
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

  // Empty only on a legacy row nobody owns. Writes require the owner; reads are gated by visibility().
  const std::optional<UserId>& owner() const { return owner_; }
  Visibility visibility() const { return visibility_; }
  void setVisibility(Visibility visibility) { visibility_ = visibility; }

private:
  void markDirty(const GraphState& graph, const LegendState& legend);

  TreeId id_;
  Lww<std::string> title_;
  Lww<std::string> guide_;
  bool guideInherited_;
  LooseGraph graph_;
  Legend legend_;
  Seq head_;
  std::optional<UserId> owner_;
  Visibility visibility_;
  std::uint64_t createdAt_;
  std::set<std::string> appliedOpIds_;
  std::vector<AppliedOp> pendingOps_;
  PresenceBus& bus_;
  HlcClock clock_;
  std::set<NodeId> dirtyNodes_;
  std::set<Edge> dirtyEdges_;
  std::set<KindId> dirtyKinds_;
  bool allDirty_ = false;  // replayed op tail: footprint unknown, save everything once
  mutable std::size_t snapshots_ = 0;
};

}
