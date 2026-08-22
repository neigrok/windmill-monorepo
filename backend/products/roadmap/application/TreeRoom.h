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

namespace wm {

// The authority for one tree. Runs on a single strand (supplied by infra), so its state is
// mutated by one thread at a time. It joins every subgraph — never rejects — assigns the next
// seq, and broadcasts. Validity is a separate read model (diagnose()).
class TreeRoom {
public:
  // The actor that stamps every server-minted write. Authorship lives in AppliedOp.actor;
  // the HLC actor only breaks ties and keys the version vector, so one stable server
  // identity is exactly right. (A multi-instance deploy would qualify it per instance.)
  static constexpr std::string_view kServerActor{"srv"};

  TreeRoom(TreeId id, Lww<std::string> title, LooseGraph graph, Legend legend, Seq head,
           std::optional<UserId> owner, Visibility visibility, std::uint64_t createdAt,
           OpLog& ops, PresenceBus& bus);

  // Join a client-authored subgraph frame: dedupe on its frameId, fold its stamps into the
  // clock (so a later server mint stays ahead), join its graph + legend + title register
  // into the lattice, assign the next seq, log its headline deed for the activity feed under
  // `actor`, and broadcast it verbatim. Returns the assigned seq, or nullopt if the frame was
  // a duplicate. No inverse is computed — undo is client-owned in the subgraph model. The
  // server never re-stamps the client's writes; it joins them as they are. It admits nothing on
  // its own: the graph caps are decided by admit() below, which every door that can refuse asks
  // first, because a socket, an import and a document each refuse in their own idiom.
  std::optional<Seq> joinSubgraph(const Subgraph& incoming, const UserId& actor);

  // Why joining this arrival would breach the tree's caps, or nullopt. The whole-graph rule
  // (domain/Command.h) asked against THIS room's live state, because what a join costs is what
  // the tree would hold once it lands — not what the arrival carries. A frame joins four
  // payloads at once, so the frame overload asks all of them: graph, legend and title alike.
  std::optional<Admission> admit(const Subgraph& incoming) const;
  std::optional<Admission> admit(const TreeData& incoming) const { return wm::admit(graph_, incoming); }

  // Server-origin rename: stamp a title register write from the room clock and join it as
  // one title-only frame — so it broadcasts to every live subscriber and LWW-merges against
  // any concurrent client rename, exactly like every other field write. Returns the seq.
  Seq rename(const std::string& title, std::uint64_t nowMs);

  // Server-origin edit (MCP tools, where the server is the author): stamp the command from
  // the room clock, apply it, log it for the activity feed, and broadcast the writes it
  // produced as one subgraph — so an agent's edit reaches every socket the same way a
  // client's does. The frameId is minted from the (unique) stamp. Returns the assigned seq.
  Seq applyCommand(const Command& command, std::uint64_t nowMs, const UserId& actor);

  // Graft a whole tree slice in as one frame: stamp every node/edge/kind from the room clock
  // (so the import dominates by-id on collision — an upsert), join it, log one headline deed,
  // and broadcast it. Nodes/edges/kinds already present are overwritten; new ones are added;
  // nothing is removed. An empty `kinds` leaves the legend untouched. Returns the assigned seq.
  Seq importTree(const TreeData& incoming, std::uint64_t nowMs, const UserId& actor);

  // The next HLC stamp for this tree, minted under the caller's strand from the room's own
  // clock. One clock per tree means every write — from a socket, an MCP tool, or an undo —
  // shares a single causal domain, so no two writes can ever collide on a stamp. `nowMs` is
  // wall time from the Clock port; the clock folds it with everything it has already seen.
  Hlc nextStamp(std::uint64_t nowMs);

  // Why a client command would be refused, or nullopt if it is admissible. Graph commands
  // are always admissible; legend commands may not be (§F6 validation). Checked at the
  // edge before submit; server-driven undo/redo bypasses it (its ops are trusted).
  std::optional<std::string> validate(const Command& command) const;

  // Re-apply an op already in the log (loading the tail after a snapshot). Merges and
  // advances head + dedup set, but does not re-persist or re-broadcast.
  void replay(const AppliedOp& op);

  TreeDiagnostics diagnose() const;
  TreeData snapshot() const;
  GraphState exportState() const;
  LegendState exportLegend() const;

  // Sparse persistence: every write marks the entries it touched, and dirtyState() exports
  // just those — the slice a save upserts, instead of the whole tree. replay() can't know
  // its footprint cheaply, so it flips the room to all-dirty and the next save writes the
  // full state. markClean() after a successful save; the caller holds the strand throughout,
  // so no write can slip in between export and clean.
  std::pair<GraphState, LegendState> dirtyState() const;
  void markClean();

  // The node's live prerequisites (incoming DAG edges), for the progress advisory check.
  // Works on any graph, clean or not; empty if the node is absent.
  std::vector<NodeId> prerequisitesOf(const NodeId& node) const;
  bool hasNode(const NodeId& node) const;  // present (created, not tombstoned) — gates progress writes
  // The title register: its value, plus the stamp of the rename that set it (unset means
  // the create-time baseline — the tree was never renamed).
  const Lww<std::string>& title() const { return title_; }
  Seq head() const { return head_; }
  // When the tree was planted (epoch ms) — the row fact a read serves alongside the document,
  // so a progress card can count weeks from planting rather than the calendar. Immutable, so
  // unlike owner/visibility a live room never has to be told it changed.
  std::uint64_t createdAt() const { return createdAt_; }

  // Authorization: who owns this tree — set once, when the row is inserted, and empty only on
  // a legacy row nobody owns. Writes require the owner and nothing else (canWrite); reads are
  // gated by visibility() — a private tree is owner-only, unlisted/public readable by id.
  const std::optional<UserId>& owner() const { return owner_; }
  Visibility visibility() const { return visibility_; }
  void setVisibility(Visibility visibility) { visibility_ = visibility; }

private:
  void markDirty(const GraphState& graph, const LegendState& legend);

  TreeId id_;
  Lww<std::string> title_;  // the title register, stamp persisted with the tree row
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
