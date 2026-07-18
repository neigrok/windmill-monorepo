#include "domain/Subgraph.h"

namespace wm {

void VersionVector::observe(const Hlc& stamp) {
  if (!stamp.isSet()) return;
  Hlc& mark = marks[stamp.actor];
  if (stamp > mark) mark = stamp;
}

bool VersionVector::covers(const Hlc& stamp) const {
  if (!stamp.isSet()) return true;  // the unset sentinel carries nothing to cover
  auto it = marks.find(stamp.actor);
  return it != marks.end() && !(stamp > it->second);
}

void VersionVector::join(const VersionVector& other) {
  for (const auto& [actor, mark] : other.marks) observe(mark);
}

namespace {
NodeStateEntry maskNode(const NodeStateEntry& node, const VersionVector& since) {
  NodeStateEntry masked;
  masked.id = node.id;
  if (!since.covers(node.createdAt)) masked.createdAt = node.createdAt;
  if (!since.covers(node.deletedAt)) masked.deletedAt = node.deletedAt;
  if (!since.covers(node.labelAt))    { masked.label = node.label;       masked.labelAt = node.labelAt; }
  if (!since.covers(node.iconAt))     { masked.icon = node.icon;         masked.iconAt = node.iconAt; }
  if (!since.covers(node.colorAt))    { masked.color = node.color;       masked.colorAt = node.colorAt; }
  if (!since.covers(node.orderAt))    { masked.order = node.order;       masked.orderAt = node.orderAt; }
  if (!since.covers(node.positionAt)) { masked.position = node.position; masked.positionAt = node.positionAt; }
  if (!since.covers(node.statusAt))   { masked.status = node.status;     masked.statusAt = node.statusAt; }
  if (!since.covers(node.descriptionAt)) { masked.description = node.description; masked.descriptionAt = node.descriptionAt; }
  if (!since.covers(node.linksAt))       { masked.links = node.links;             masked.linksAt = node.linksAt; }
  return masked;
}

bool nodeUncovered(const NodeStateEntry& node, const VersionVector& since) {
  return !since.covers(node.createdAt) || !since.covers(node.deletedAt) || !since.covers(node.labelAt)
      || !since.covers(node.iconAt) || !since.covers(node.colorAt) || !since.covers(node.orderAt)
      || !since.covers(node.positionAt) || !since.covers(node.statusAt) || !since.covers(node.descriptionAt)
      || !since.covers(node.linksAt);
}

KindStateEntry maskKind(const KindStateEntry& kind, const VersionVector& since) {
  KindStateEntry masked;
  masked.id = kind.id;
  if (!since.covers(kind.createdAt)) masked.createdAt = kind.createdAt;
  if (!since.covers(kind.deletedAt)) masked.deletedAt = kind.deletedAt;
  if (!since.covers(kind.hueAt))         { masked.hue = kind.hue;                 masked.hueAt = kind.hueAt; }
  if (!since.covers(kind.labelAt))       { masked.label = kind.label;             masked.labelAt = kind.labelAt; }
  if (!since.covers(kind.descriptionAt)) { masked.description = kind.description;  masked.descriptionAt = kind.descriptionAt; }
  if (!since.covers(kind.rankAt))        { masked.rank = kind.rank;               masked.rankAt = kind.rankAt; }
  return masked;
}

bool kindUncovered(const KindStateEntry& kind, const VersionVector& since) {
  return !since.covers(kind.createdAt) || !since.covers(kind.deletedAt) || !since.covers(kind.hueAt)
      || !since.covers(kind.labelAt) || !since.covers(kind.descriptionAt) || !since.covers(kind.rankAt);
}
}

VersionVector frontier(const GraphState& graph, const LegendState& legend) {
  VersionVector vector;
  for (const NodeStateEntry& node : graph.nodes) {
    vector.observe(node.createdAt);
    vector.observe(node.deletedAt);
    vector.observe(node.labelAt);
    vector.observe(node.iconAt);
    vector.observe(node.colorAt);
    vector.observe(node.orderAt);
    vector.observe(node.positionAt);
    vector.observe(node.statusAt);
    vector.observe(node.descriptionAt);
    vector.observe(node.linksAt);
  }
  for (const EdgeStateEntry& edge : graph.edges) {
    vector.observe(edge.addedAt);
    vector.observe(edge.removedAt);
  }
  for (const KindStateEntry& kind : legend.kinds) {
    vector.observe(kind.createdAt);
    vector.observe(kind.deletedAt);
    vector.observe(kind.hueAt);
    vector.observe(kind.labelAt);
    vector.observe(kind.descriptionAt);
    vector.observe(kind.rankAt);
  }
  return vector;
}

Subgraph deltaBetween(const GraphState& graph, const LegendState& legend, const VersionVector& since) {
  Subgraph delta;
  delta.intent = SubgraphIntent::delta;
  for (const NodeStateEntry& node : graph.nodes) {
    if (nodeUncovered(node, since)) delta.graph.nodes.push_back(maskNode(node, since));
  }
  for (const EdgeStateEntry& edge : graph.edges) {
    if (since.covers(edge.addedAt) && since.covers(edge.removedAt)) continue;
    EdgeStateEntry masked{edge.edge, {}, {}};
    if (!since.covers(edge.addedAt)) masked.addedAt = edge.addedAt;
    if (!since.covers(edge.removedAt)) masked.removedAt = edge.removedAt;
    delta.graph.edges.push_back(masked);
  }
  for (const KindStateEntry& kind : legend.kinds) {
    if (kindUncovered(kind, since)) delta.legend.kinds.push_back(maskKind(kind, since));
  }
  delta.coverage = frontier(graph, legend);
  return delta;
}

}
