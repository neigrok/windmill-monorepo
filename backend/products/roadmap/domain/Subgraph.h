#pragma once

#include "products/roadmap/domain/Crdt.h"
#include "products/roadmap/domain/GraphState.h"
#include "products/roadmap/domain/Ids.h"
#include "products/roadmap/domain/Legend.h"

#include <map>
#include <optional>
#include <set>
#include <string>
#include <vector>

namespace wm {

// A causal frontier: the greatest stamp seen from each actor. Frontiers join by pointwise max.
// Keyed by actor string, so distinct replicas (a tab, a device, the server) never alias.
struct VersionVector {
  std::map<std::string, Hlc> marks;

  void observe(const Hlc& stamp);
  bool covers(const Hlc& stamp) const;
  void join(const VersionVector& other);
  bool operator==(const VersionVector&) const = default;
};

// Why a subgraph is on the wire. `live` = one gesture, sent now; `flush` = a coalesced offline
// session; `delta` = an anti-entropy payload computed against a stated vector, the only intent that
// carries coverage; `graft` = state joined for its own sake, never advancing coverage.
enum class SubgraphIntent { live, flush, delta, graft };

// Descriptive metadata carried alongside the writes it produced; never re-executed on a peer.
struct Gesture {
  std::string id;
  std::string kind;
  std::string label;
  bool operator==(const Gesture&) const = default;
};

// The one envelope every sync scenario shares: a partial, stamped slice of a tree's lattice.
// Absent sections/entries/fields mean "no information". `coverage` is present only on a `delta`.
// `title` and `guide` are the tree's own registers, beside its graph and legend. `branches` names the subtrees the frame
// knowingly takes with the owning steps it deletes: a confirmation for the server alone, never a register, never joined
// and never sent on.
struct Subgraph {
  TreeId treeId;
  std::string frameId;
  std::string actor;
  SubgraphIntent intent = SubgraphIntent::live;
  std::optional<Lww<std::string>> title;
  std::optional<Lww<std::string>> guide;
  GraphState graph;
  LegendState legend;
  std::vector<Gesture> gestures;
  std::optional<VersionVector> coverage;
  std::set<TreeId> branches;
  bool operator==(const Subgraph&) const = default;

  // Whether no entry and no tree register of this frame carries a set stamp. Such a frame can land nothing in any
  // room, whatever the room holds, so it asks for no write.
  bool carriesNoStamp() const;
};

// Every stamp a full serialized state carries, folded together; a live room keeps this incrementally.
VersionVector frontier(const GraphState& graph, const LegendState& legend);
// Every stamp one frame carries: its graph, its legend and the tree registers it sets.
VersionVector frontier(const Subgraph& frame);

// The entries a peer is sent whole whatever its vector covers.
struct Landed {
  std::set<NodeId> nodes;
  std::set<Edge> edges;
  std::set<KindId> kinds;
};

// The seq at which each node, edge and kind, and each of the tree's own registers, last changed on the server: its land
// seq. A vector describes a writer only while that writer's writes land in stamp order, and a write can land late,
// under a stamp below one of its writer's already held. It still lands at a new seq, so a peer that says the last seq
// it applied is also sent everything that landed past it. An entry with none here landed at 0, which is past no
// position: a row stored before land seqs were kept is cut by the vector alone.
struct LandSeqs {
  std::map<NodeId, Seq> nodes;
  std::map<Edge, Seq> edges;
  std::map<KindId, Seq> kinds;
  Seq title = 0;
  Seq guide = 0;
  bool operator==(const LandSeqs&) const = default;

  // Everything of `graph` and `legend` landed at `seq`.
  void land(const GraphState& graph, const LegendState& legend, Seq seq);
  // The entries that landed past `position`.
  Landed past(Seq position) const;
};

// The subgraph a peer at `since` is missing: every entry stamped beyond the vector, with
// already-covered fields masked back to "no information", and every entry of `late` whole. Its coverage is the sender's
// full frontier.
Subgraph deltaBetween(const GraphState& graph, const LegendState& legend, const VersionVector& since,
                      const Landed& late = {});

// What a caller who cannot write a tree receives of its nodes: none says which tree it opens, because
// a tree id is the read capability of an unlisted tree. A lattice entry left without a stamp is dropped.
GraphState readerView(GraphState graph);
TreeData readerView(TreeData document);

}
