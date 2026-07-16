#pragma once

#include "domain/Command.h"
#include "domain/Ids.h"
#include "domain/Legend.h"
#include "domain/LooseGraph.h"
#include "domain/Tree.h"
#include "domain/TreeDiagnostics.h"
#include "ports/Op.h"
#include "ports/OpLog.h"
#include "ports/PresenceBus.h"

#include <optional>
#include <set>
#include <string>
#include <utility>

namespace wm {

// The authority for one tree. Runs on a single strand (supplied by infra), so its state is
// mutated by one thread at a time. It joins every subgraph — never rejects — assigns the next
// seq, and broadcasts. Validity is a separate read model (diagnose()).
class TreeRoom {
public:
  TreeRoom(TreeId id, std::string title, LooseGraph graph, Legend legend, Seq head,
           std::optional<UserId> owner, OpLog& ops, PresenceBus& bus);

  // Join a client-authored subgraph frame: dedupe on its frameId, fold its stamps into the
  // clock (so a later server mint stays ahead), join its graph + legend into the lattice,
  // assign the next seq, log its headline deed for the activity feed under `actor`, and
  // broadcast it verbatim. Returns the assigned seq, or nullopt if the frame was a duplicate.
  // No inverse is computed — undo is client-owned in the subgraph model. The server never
  // re-stamps the client's writes; it joins them as they are.
  std::optional<Seq> joinSubgraph(const Subgraph& incoming, const UserId& actor);

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
  const std::string& title() const { return title_; }
  Seq head() const { return head_; }

  // Authorization: who owns this tree (empty until claimed), and the first-writer claim
  // that fills it. Reads are public; writes require the owner (or claim an unowned tree).
  const std::optional<UserId>& owner() const { return owner_; }
  void claim(const UserId& user) { if (!owner_) owner_ = user; }

private:
  void markDirty(const GraphState& graph, const LegendState& legend);

  TreeId id_;
  std::string title_;
  LooseGraph graph_;
  Legend legend_;
  Seq head_;
  std::optional<UserId> owner_;
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
