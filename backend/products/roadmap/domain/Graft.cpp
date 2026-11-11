#include "products/roadmap/domain/Graft.h"

#include <map>
#include <set>

namespace wm {

LegendState graftLegend(const Legend& current, const Graft& graft, const Hlc& at) {
  if (graft.document.kinds.empty()) return {};
  std::map<KindId, double> appended;  // a new kind's place after the legend's last, in document order
  const double base = current.nextRank();
  for (const Kind& kind : graft.document.kinds)
    if (!current.has(kind.id)) appended.emplace(kind.id, base + static_cast<double>(appended.size()));

  LegendState legend = Legend(graft.document.kinds, at).exportState();
  for (KindStateEntry& kind : legend.kinds) {
    const auto place = appended.find(kind.id);
    kind.rank = place == appended.end() ? 0 : place->second;
    kind.rankAt = place == appended.end() ? Hlc{} : at;
    const auto omitted = graft.omittedKindRegisters.find(kind.id);
    if (omitted == graft.omittedKindRegisters.end()) continue;
    if (omitted->second.count(KindRegister::label)) { kind.label.clear(); kind.labelAt = Hlc{}; }
    if (omitted->second.count(KindRegister::description)) { kind.description.clear(); kind.descriptionAt = Hlc{}; }
    if (omitted->second.count(KindRegister::crossBranchExempt)) {
      kind.crossBranchExempt = false;
      kind.crossBranchExemptAt = Hlc{};
    }
  }
  return legend;
}

GraftFootprint footprintOf(const LooseGraph& graph, const Graft& graft) {
  const std::set<NodeId> tombstoned(graft.tombstones.begin(), graft.tombstones.end());
  std::map<NodeId, std::set<NodeId>> named;  // each re-sent node -> the prerequisites the document names
  for (const NodeSpec& node : graft.document.nodes)
    if (graph.lifeOf(node.id))  // present or tombstoned: a revived node brings its old edges with it
      named[node.id] = std::set<NodeId>(node.prerequisites.begin(), node.prerequisites.end());

  GraftFootprint footprint;
  for (const Edge& edge : graph.presentEdges()) {
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
  std::map<NodeId, NodeStateEntry> upserted;  // by id, so the frame lists each node once, in id order
  std::set<Edge> added;
  for (const NodeSpec& node : graft.document.nodes) {
    const auto omitted = graft.omittedNodeRegisters.find(node.id);
    const auto carried = [&](NodeRegister held) {
      return omitted == graft.omittedNodeRegisters.end() || !omitted->second.count(held);
    };
    // A carried register lands at the graft's stamp, an empty value included; an omitted one stays unset.
    NodeStateEntry entry;
    entry.id = node.id;
    entry.createdAt = at;
    if (carried(NodeRegister::label)) { entry.label = node.label; entry.labelAt = at; }
    if (carried(NodeRegister::icon)) { entry.icon = node.icon; entry.iconAt = at; }
    if (carried(NodeRegister::color)) { entry.color = node.color; entry.colorAt = at; }
    if (carried(NodeRegister::order)) { entry.order = node.order; entry.orderAt = at; }
    if (carried(NodeRegister::position)) { entry.position = node.position; entry.positionAt = at; }
    if (carried(NodeRegister::status)) { entry.status = normalizeSeedStatus(node.status); entry.statusAt = at; }
    if (carried(NodeRegister::description)) { entry.description = node.description; entry.descriptionAt = at; }
    if (carried(NodeRegister::links)) { entry.links = node.links; entry.linksAt = at; }
    if (carried(NodeRegister::opens)) { entry.opens = node.opens; entry.opensAt = at; }
    upserted.emplace(node.id, std::move(entry));
    for (const NodeId& prereq : node.prerequisites) {
      const Edge edge{prereq, node.id};
      if (!tombstoned.count(edge.from) && !tombstoned.count(edge.to)) added.insert(edge);
    }
  }

  GraphState state;
  for (auto& [id, entry] : upserted) state.nodes.push_back(std::move(entry));
  for (const Edge& edge : added) state.edges.push_back(EdgeStateEntry{edge, at, {}});
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
