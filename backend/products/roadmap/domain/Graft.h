#pragma once

#include "products/roadmap/domain/GraphState.h"
#include "products/roadmap/domain/Ids.h"
#include "products/roadmap/domain/Legend.h"
#include "products/roadmap/domain/LooseGraph.h"
#include "products/roadmap/domain/Tree.h"

#include <map>
#include <set>
#include <vector>

namespace wm {

// How a re-sent node's prerequisites meet the ones it already has: `merge` unions them, `replace`
// removes every present edge into that node the document does not name — live, or left behind by a
// delete and waiting to revive with the node.
enum class PrerequisiteMode { merge, replace };

// The registers a document may leave out of a node or a kind. A node's prerequisites are never one:
// they meet the node's edges by PrerequisiteMode. A kind's `hue` is never one either.
enum class NodeRegister { label, icon, color, order, position, status, description, links, opens };
enum class KindRegister { label, description, crossBranchExempt };

// One bulk arrival: a document upserted by id, and the ids it deletes outright. A tombstoned node
// loses every present edge touching it, in either direction. The two omitted maps name, per id, the
// registers the document did not spell out: the graft leaves those alone, so a node or kind the tree
// already holds keeps its value and a new one lands with the default. An id absent from its map
// carried every register, and an empty value is carried like any other.
struct Graft {
  TreeData document;
  PrerequisiteMode prerequisites = PrerequisiteMode::merge;
  std::vector<NodeId> tombstones;
  std::map<NodeId, std::set<NodeRegister>> omittedNodeRegisters;
  std::map<KindId, std::set<KindRegister>> omittedKindRegisters;
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

// The frame that joins: what the document changes, and every removal the footprint names, at one
// stamp `at` that dominates the graph, so a removal beats the edge's addedAt and a later re-add beats
// the removal. A node the graph does not hold, new or deleted, is created at `at`; a present one keeps
// its creation. A register or an edge lands only where the document changes what the graph holds, and
// a node it changes nothing on is left out. A document edge touching a tombstoned node is dropped.
GraphState graftState(const LooseGraph& graph, const Graft& graft, const Hlc& at);

// The legend half of the same frame: every kind the document carries, stamped `at`, save that an
// omitted register is stamped unset — which no stored stamp loses to, and which lands the default
// on a kind the legend never held. Rank is never on the wire, so it is treated as omitted too: a
// kind `legend` holds keeps its place, and a new kind lands after the last one, in document order,
// the way addKind would. Empty when the document carries no kinds.
LegendState graftLegend(const Legend& legend, const Graft& graft, const Hlc& at);

}
