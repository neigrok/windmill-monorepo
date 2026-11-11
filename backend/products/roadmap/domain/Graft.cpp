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
    const std::optional<NodeStateEntry> held = graph.exportNode(node.id);  // present, or what a delete left
    const auto omitted = graft.omittedNodeRegisters.find(node.id);
    NodeStateEntry entry;
    entry.id = node.id;
    if (!graph.hasNode(node.id)) entry.createdAt = at;  // new or revived; a present node keeps its creation
    // A register lands at the graft's stamp when the batch carried it and it changes what the graph
    // holds, an empty value included; one left out, or sent as the graph already holds it, stays unset.
    const auto land = [&](NodeRegister reg, auto NodeStateEntry::*value, Hlc NodeStateEntry::*stamp,
                          const auto& sent) {
      const bool carried = omitted == graft.omittedNodeRegisters.end() || !omitted->second.count(reg);
      if (!carried || (held && (*held).*value == sent)) return;
      entry.*value = sent;
      entry.*stamp = at;
    };
    land(NodeRegister::label, &NodeStateEntry::label, &NodeStateEntry::labelAt, node.label);
    land(NodeRegister::icon, &NodeStateEntry::icon, &NodeStateEntry::iconAt, node.icon);
    land(NodeRegister::color, &NodeStateEntry::color, &NodeStateEntry::colorAt, node.color);
    land(NodeRegister::order, &NodeStateEntry::order, &NodeStateEntry::orderAt, node.order);
    land(NodeRegister::position, &NodeStateEntry::position, &NodeStateEntry::positionAt, node.position);
    land(NodeRegister::status, &NodeStateEntry::status, &NodeStateEntry::statusAt, normalizeSeedStatus(node.status));
    land(NodeRegister::description, &NodeStateEntry::description, &NodeStateEntry::descriptionAt, node.description);
    land(NodeRegister::links, &NodeStateEntry::links, &NodeStateEntry::linksAt, node.links);
    land(NodeRegister::opens, &NodeStateEntry::opens, &NodeStateEntry::opensAt, node.opens);
    if (entry != NodeStateEntry{.id = node.id}) upserted.emplace(node.id, std::move(entry));  // it lands something
    for (const NodeId& prereq : node.prerequisites) {
      const Edge edge{prereq, node.id};
      if (tombstoned.count(edge.from) || tombstoned.count(edge.to) || graph.edgePresent(edge.from, edge.to)) continue;
      added.insert(edge);
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
