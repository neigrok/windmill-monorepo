#pragma once

#include "products/roadmap/domain/GraphState.h"
#include "products/roadmap/domain/Ids.h"
#include "products/roadmap/domain/LooseGraph.h"
#include "products/roadmap/domain/Tree.h"

#include <vector>

namespace wm {

// How a re-sent node's prerequisites meet the ones it already has: `merge` unions them, `replace`
// removes every present edge into that node the document does not name — live, or left behind by a
// delete and waiting to revive with the node.
enum class PrerequisiteMode { merge, replace };

// One bulk arrival: a document upserted by id, and the ids it deletes outright. A tombstoned node
// loses every present edge touching it, in either direction.
struct Graft {
  TreeData document;
  PrerequisiteMode prerequisites = PrerequisiteMode::merge;
  std::vector<NodeId> tombstones;
};

// What joining a graft does beyond the upsert itself. `keptEdges` and `replacedEdges` are the same
// set under the two modes — present edges into a node the document re-sends (present or tombstoned:
// any id with a life record) that its prerequisites do not name — kept by merge, removed by
// replace. Only present ids among the tombstones count.
struct GraftFootprint {
  std::vector<Edge> keptEdges;
  std::vector<Edge> replacedEdges;
  std::vector<NodeId> tombstonedNodes;
  std::vector<Edge> tombstonedEdges;
};

GraftFootprint footprintOf(const LooseGraph& graph, const Graft& graft);

// The frame that joins: the document stamped `at`, and every removal the footprint names stamped
// `at` too. One stamp that dominates the graph, so a removal beats the edge's addedAt and a later
// re-add beats the removal. A document edge touching a tombstoned node is dropped, never added.
GraphState graftState(const LooseGraph& graph, const Graft& graft, const Hlc& at);

}
