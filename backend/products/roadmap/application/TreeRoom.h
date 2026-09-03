#pragma once

#include "platform/domain/Access.h"
#include "products/roadmap/domain/Command.h"
#include "platform/domain/Crdt.h"
#include "products/roadmap/domain/Ids.h"
#include "products/roadmap/domain/Legend.h"
#include "products/roadmap/domain/LooseGraph.h"
#include "products/roadmap/domain/Tree.h"
#include "products/roadmap/domain/TreeDiagnostics.h"
#include "products/roadmap/ports/Op.h"
#include "products/roadmap/ports/OpLog.h"
#include "products/roadmap/ports/PresenceBus.h"

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

  TreeRoom(TreeId id, Lww<std::string> title, LooseGraph graph, Legend legend, Seq head,
           std::optional<UserId> owner, Visibility visibility, std::uint64_t createdAt,
           OpLog& ops, PresenceBus& bus);

  // Dedupe on the frame's id, fold its stamps into the clock, join graph + legend + title, assign
  // the next seq, log its headline deed under `actor`, broadcast verbatim. nullopt means a duplicate
  // frame. Admits nothing on its own — every door that can refuse asks admit() first.
  std::optional<Seq> joinSubgraph(const Subgraph& incoming, const UserId& actor);

  // Why joining this arrival would breach the tree's caps, or nullopt. Asked against THIS room's
  // live state, not against the arrival alone. The frame overload asks graph, legend and title.
  std::optional<Admission> admit(const Subgraph& incoming) const;
  std::optional<Admission> admit(const TreeData& incoming) const { return wm::admit(graph_, incoming); }

  // Stamped from the room clock and joined as one title-only frame, so it broadcasts and LWW-merges
  // like any other field write.
  Seq rename(const std::string& title, std::uint64_t nowMs);

  // Server-origin edit: stamped from the room clock, applied, logged, broadcast as one subgraph.
  // The frameId is minted from the (unique) stamp.
  Seq applyCommand(const Command& command, std::uint64_t nowMs, const UserId& actor);
  // Several commands as ONE edit: one stamp, one frame, one seq, one feed deed (the frame's
  // headline), so a reader never sees the tree between them. Admits nothing on its own.
  Seq applyCommands(const std::vector<Command>& commands, std::uint64_t nowMs, const UserId& actor);

  // Stamped from the room clock, so a by-id collision is an upsert. Nothing is removed; an empty
  // `kinds` leaves the legend untouched.
  Seq importTree(const TreeData& incoming, std::uint64_t nowMs, const UserId& actor);

  // One clock per tree, so no two writes collide on a stamp. `nowMs` is wall time from the Clock port.
  Hlc nextStamp(std::uint64_t nowMs);

  // Graph commands are always admissible; legend commands may not be. Server-driven undo/redo
  // bypasses it.
  std::optional<std::string> validate(const Command& command) const;

  // Advances head + dedup set; does not re-persist or re-broadcast.
  void replay(const AppliedOp& op);

  TreeDiagnostics diagnose() const;
  TreeData snapshot() const;
  GraphState exportState() const;
  LegendState exportLegend() const;

  // Exports only the entries dirtied since the last markClean(); replay() flips the room all-dirty.
  // The caller holds the strand across export and clean.
  std::pair<GraphState, LegendState> dirtyState() const;
  void markClean();

  // The node's live prerequisites (incoming DAG edges); empty if the node is absent.
  std::vector<NodeId> prerequisitesOf(const NodeId& node) const;
  bool hasNode(const NodeId& node) const;  // present: created, not tombstoned
  bool hasEdge(const NodeId& from, const NodeId& to) const;
  // Present edges with either endpoint among `nodes`: what deleting them would leave dangling.
  std::vector<Edge> edgesTouching(const std::vector<NodeId>& nodes) const;
  // An unset stamp means the create-time baseline, never renamed.
  const Lww<std::string>& title() const { return title_; }
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
  LooseGraph graph_;
  Legend legend_;
  Seq head_;
  std::optional<UserId> owner_;
  Visibility visibility_;
  std::uint64_t createdAt_;
  std::set<std::string> appliedOpIds_;
  OpLog& ops_;
  PresenceBus& bus_;
  HlcClock clock_;
  std::set<NodeId> dirtyNodes_;
  std::set<Edge> dirtyEdges_;
  std::set<KindId> dirtyKinds_;
  bool allDirty_ = false;  // replayed op tail: footprint unknown, save everything once
};

}
