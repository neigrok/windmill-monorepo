#pragma once

#include "products/roadmap/domain/GraphState.h"
#include "products/roadmap/domain/Ids.h"
#include "products/roadmap/domain/Legend.h"
#include "products/roadmap/domain/LooseGraph.h"
#include "products/roadmap/domain/Tree.h"

#include <map>
#include <set>
#include <string>
#include <variant>
#include <vector>

namespace wm {

// How a re-sent node's prerequisites meet the ones it already has: `merge` unions them, `replace`
// removes every present edge into that node the document does not name — live, or left behind by a
// delete and waiting to revive with the node. A node the document sends without prerequisites keeps
// its edges under either mode: left out is never cleared, while an empty list is a list.
enum class PrerequisiteMode { merge, replace };

// The registers a document may leave out of a node or a kind. A node's prerequisites are never one:
// they meet the node's edges by PrerequisiteMode. A kind's `hue` is never one either.
enum class NodeRegister { label, icon, color, order, position, status, description, links, opens };
enum class KindRegister { label, description, crossBranchExempt };

// One bulk arrival: a document upserted by id, and the ids it deletes outright. A tombstoned node
// loses every present edge touching it, in either direction. The two omitted maps name, per id, the
// registers the document did not spell out: the graft leaves those alone, so a node or kind the tree
// already holds keeps its value and a new one lands with the default. `opens` is the exception on a
// node the graft brings back from a delete: left out, it is cleared, so a revived node opens only the
// tree the document names. An id absent from its map
// carried every register, and an empty value is carried like any other. `nodeKinds` names the legend
// kind the document files a node under; resolveKinds turns it into the node's colour and keeps it, so a
// re-hue never repaints a node the batch filed (repaintOf).
// `omittedPrerequisites` names the nodes the document sent without a prerequisites list.
struct Graft {
  TreeData document;
  PrerequisiteMode prerequisites = PrerequisiteMode::merge;
  std::vector<NodeId> tombstones;
  std::map<NodeId, std::set<NodeRegister>> omittedNodeRegisters;
  std::map<KindId, std::set<KindRegister>> omittedKindRegisters;
  std::set<NodeId> omittedPrerequisites;
  std::map<NodeId, KindId> nodeKinds;
};

// The graft with every node's kind turned into the hue that kind wears in the legend the graft leaves:
// `legend` with the document's own kinds upserted, so one batch can add a kind and file nodes under it.
// Such a node carries its colour register. A kind that legend does not hold, or a colour sent beside it
// that disagrees, refuses the whole graft with resolveHue's refusal, naming `nodes[i].kind`.
std::variant<Graft, KindRefusal> resolveKinds(const Legend& legend, Graft graft);

// What joining a graft does beyond the upsert itself. `keptEdges` and `replacedEdges` are the same
// set under the two modes — present edges into a node the document re-sends (present or tombstoned:
// any id with a life record) that its prerequisites do not name — kept by merge, removed by
// replace, and kept by both into a node sent without prerequisites. Only present ids among the
// tombstones count.
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

// The legend half of the same frame, under the same rule: a kind the legend does not hold, new or
// removed, is created at `at` and lands after the last one, in document order, the way addKind would;
// a present kind keeps its creation and, rank never being on the wire, its place. A register lands
// only where the document changes what the legend holds, and a kind it changes nothing on is left out.
LegendState graftLegend(const Legend& legend, const Graft& graft, const Hlc& at);

// What a graft's re-hued kinds repaint, judged against the legend and graph as they stood before the batch by
// recolor_kind's rule (wearersOf), so a swap swaps: each node wearing a re-hued kind's old hue takes its new hue, but
// for a node the batch tombstones, files by kind (`nodeKinds`), or sends a colour that differs from the one it holds.
// `rehued` lists the held kinds whose hue the document changes.
struct Repaint {
  std::vector<KindId> rehued;
  std::map<NodeId, NodeColor> nodes;
};

Repaint repaintOf(const LooseGraph& graph, const Legend& legend, const Graft& graft);

// The whole frame a graft joins: graftState and graftLegend at one stamp `at`, with the colours its re-hued kinds
// repaint (repaintOf) at that stamp too. It lands nothing when the document changes no register the tree holds, adds
// no edge and removes nothing — a frame with no entry.
struct GraftFrame {
  GraphState graph;
  LegendState legend;

  bool landsNothing() const { return graph.nodes.empty() && graph.edges.empty() && legend.kinds.empty(); }
};

GraftFrame graftFrame(const LooseGraph& graph, const Legend& legend, const Graft& graft, const Hlc& at);

}
