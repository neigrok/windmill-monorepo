#include "products/roadmap/domain/Graft.h"

#include <algorithm>
#include <map>
#include <set>

namespace wm {

GraftFootprint footprintOf(const LooseGraph& graph, const Graft& graft) {
  const std::set<NodeId> tombstoned(graft.tombstones.begin(), graft.tombstones.end());
  std::map<NodeId, std::set<NodeId>> named;  // each re-sent node -> the prerequisites the document names
  for (const NodeSpec& node : graft.document.nodes)
    if (graph.hasNode(node.id))
      named[node.id] = std::set<NodeId>(node.prerequisites.begin(), node.prerequisites.end());

  GraftFootprint footprint;
  for (const Edge& edge : graph.liveEdges()) {
    if (tombstoned.count(edge.from) || tombstoned.count(edge.to)) continue;  // counted below, once
    auto resent = named.find(edge.to);
    if (resent == named.end() || resent->second.count(edge.from)) continue;
    if (graft.prerequisites == PrerequisiteMode::merge) footprint.keptEdges.push_back(edge);
    else footprint.replacedEdges.push_back(edge);
  }
  for (const NodeId& id : tombstoned)
    if (graph.hasNode(id)) footprint.tombstonedNodes.push_back(id);
  for (const Edge& edge : graph.presentEdges())
    if (tombstoned.count(edge.from) || tombstoned.count(edge.to)) footprint.tombstonedEdges.push_back(edge);
  return footprint;
}

GraphState graftState(const LooseGraph& graph, const Graft& graft, const Hlc& at) {
  const std::set<NodeId> tombstoned(graft.tombstones.begin(), graft.tombstones.end());
  GraphState state = LooseGraph(graft.document, at).exportState();
  state.edges.erase(std::remove_if(state.edges.begin(), state.edges.end(),
                                   [&](const EdgeStateEntry& entry) {
                                     return tombstoned.count(entry.edge.from) || tombstoned.count(entry.edge.to);
                                   }),
                    state.edges.end());

  const GraftFootprint footprint = footprintOf(graph, graft);
  for (const NodeId& id : footprint.tombstonedNodes) {
    NodeStateEntry entry;
    entry.id = id;
    entry.deletedAt = at;
    state.nodes.push_back(entry);
  }
  for (const Edge& edge : footprint.replacedEdges) state.edges.push_back(EdgeStateEntry{edge, {}, at});
  for (const Edge& edge : footprint.tombstonedEdges) state.edges.push_back(EdgeStateEntry{edge, {}, at});
  return state;
}

}
