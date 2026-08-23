#pragma once

#include "platform/domain/Crdt.h"
#include "products/roadmap/domain/GraphState.h"
#include "products/roadmap/domain/Ids.h"
#include "products/roadmap/domain/Legend.h"

#include <map>
#include <optional>
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
struct Subgraph {
  TreeId treeId;
  std::string frameId;
  std::string actor;
  SubgraphIntent intent = SubgraphIntent::live;
  std::optional<Lww<std::string>> title;
  GraphState graph;
  LegendState legend;
  std::vector<Gesture> gestures;
  std::optional<VersionVector> coverage;
  bool operator==(const Subgraph&) const = default;
};

// Every stamp a full serialized state carries, folded together; a live room keeps this incrementally.
VersionVector frontier(const GraphState& graph, const LegendState& legend);

// The subgraph a peer at `since` is missing: every entry stamped beyond the vector, with
// already-covered fields masked back to "no information". Its coverage is the sender's full frontier.
Subgraph deltaBetween(const GraphState& graph, const LegendState& legend, const VersionVector& since);

}
