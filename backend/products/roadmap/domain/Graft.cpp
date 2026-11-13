#include "products/roadmap/domain/Graft.h"

#include "products/roadmap/domain/Command.h"

#include <algorithm>
#include <map>
#include <optional>
#include <set>

namespace wm {

std::variant<Graft, KindRefusal> resolveKinds(const LooseGraph& graph, const Legend& legend, Graft graft) {
  std::vector<Kind> landed = legend.kinds();
  for (const Kind& kind : graft.document.kinds) {
    const auto held = std::find_if(landed.begin(), landed.end(), [&](const Kind& k) { return k.id == kind.id; });
    if (held == landed.end()) landed.push_back(kind);
    else held->hue = kind.hue;
  }
  const auto colorSent = [&](const NodeId& id) {
    const auto omitted = graft.omittedNodeRegisters.find(id);
    return omitted == graft.omittedNodeRegisters.end() || !omitted->second.count(NodeRegister::color);
  };
  std::vector<std::string> unnamed;
  for (std::size_t i = 0; i < graft.document.nodes.size(); ++i) {
    const NodeId& id = graft.document.nodes[i].id;
    const bool held = graph.hasNode(id) || graph.isTombstoned(id);
    if (!held && !colorSent(id) && !graft.nodeKinds.count(id))
      unnamed.push_back("nodes[" + std::to_string(i) + "] \"" + id.str() + "\"");
  }
  if (std::optional<KindRefusal> refusal = unnamedHueRefusal(landed, unnamed)) return *refusal;
  for (std::size_t i = 0; i < graft.document.nodes.size(); ++i) {
    NodeSpec& node = graft.document.nodes[i];
    const auto named = graft.nodeKinds.find(node.id);
    if (named == graft.nodeKinds.end()) continue;
    const auto omitted = graft.omittedNodeRegisters.find(node.id);
    const auto hue = resolveHue(landed, HueChoice{colorSent(node.id) ? std::optional(node.color) : std::nullopt, named->second},
                                graph.exportNode(node.id), "nodes[" + std::to_string(i) + "].");
    if (const auto* refusal = std::get_if<KindRefusal>(&hue)) return *refusal;
    node.color = *std::get<std::optional<NodeColor>>(hue);
    if (omitted != graft.omittedNodeRegisters.end()) omitted->second.erase(NodeRegister::color);
  }
  return graft;
}

std::variant<Graft, std::string> resolveLinks(const LooseGraph& graph, Graft graft) {
  for (std::size_t i = 0; i < graft.document.nodes.size(); ++i) {
    NodeSpec& node = graft.document.nodes[i];
    auto shown = shownLinks(graph.linksOf(node.id), std::move(node.links), "nodes[" + std::to_string(i) + "].links");
    if (const auto* refusal = std::get_if<std::string>(&shown)) return *refusal;
    node.links = std::get<std::vector<Link>>(std::move(shown));
  }
  return graft;
}

LegendState graftLegend(const Legend& current, const Graft& graft, const Hlc& at) {
  using Entry = KindStateEntry;
  std::map<KindId, Entry> upserted;  // by id, so the frame lists each kind once, in id order
  double nextRank = current.nextRank();
  for (const Kind& kind : graft.document.kinds) {
    const std::optional<Entry> held = current.exportKind(kind.id);  // present, or what a remove left
    const auto omitted = graft.omittedKindRegisters.find(kind.id);
    const auto carried = [&](KindRegister reg) {
      return omitted == graft.omittedKindRegisters.end() || !omitted->second.count(reg);
    };
    Entry entry;
    entry.id = kind.id;
    if (!current.has(kind.id)) {  // new or revived, placed after the last kind as addKind would place it
      entry.createdAt = at;
      entry.rank = nextRank++;
      entry.rankAt = at;
    }
    // A register lands at the graft's stamp when the batch carried it and it changes what the legend
    // holds, an empty value included; one left out, or sent as the legend already holds it, stays unset.
    const auto land = [&](bool inBatch, auto Entry::*field, Hlc Entry::*stamp, const auto& sent) {
      if (!inBatch || !landsOver(held, field, sent)) return;
      entry.*field = sent;
      entry.*stamp = at;
    };
    land(true, &Entry::hue, &Entry::hueAt, kind.hue);
    land(carried(KindRegister::label), &Entry::label, &Entry::labelAt, kind.label);
    land(carried(KindRegister::description), &Entry::description, &Entry::descriptionAt, kind.description);
    if (entry != Entry{.id = kind.id}) upserted.emplace(kind.id, std::move(entry));  // it lands something
  }

  LegendState legend;
  for (auto& [id, entry] : upserted) legend.kinds.push_back(std::move(entry));
  return legend;
}

Repaint repaintOf(const LooseGraph& graph, const Legend& legend, const Graft& graft) {
  std::set<NodeId> leftToTheBatch(graft.tombstones.begin(), graft.tombstones.end());
  // A node the batch files by kind lands the hue that kind wears after the batch, whatever it wore.
  for (const auto& [node, kind] : graft.nodeKinds) leftToTheBatch.insert(node);
  for (const NodeSpec& node : graft.document.nodes) {
    const auto omitted = graft.omittedNodeRegisters.find(node.id);
    const bool carried = omitted == graft.omittedNodeRegisters.end() || !omitted->second.count(NodeRegister::color);
    // A colour the batch sends wins when it lands: one sent as held is an echo.
    if (carried && landsOver(graph.exportNode(node.id), &NodeStateEntry::color, node.color)) leftToTheBatch.insert(node.id);
  }
  Repaint repaint;
  for (const Kind& kind : graft.document.kinds) {
    const std::optional<NodeColor> held = legend.hueOf(kind.id);
    if (!held || *held == kind.hue) continue;
    repaint.rehued.push_back(kind.id);
    for (const NodeId& node : wearersOf(graph, legend, kind.id))
      if (!leftToTheBatch.count(node)) repaint.nodes[node] = kind.hue;
  }
  return repaint;
}

GraftFrame graftFrame(const LooseGraph& graph, const Legend& legend, const Graft& graft, const Hlc& at) {
  GraftFrame frame{graftState(graph, graft, at), graftLegend(legend, graft, at)};
  for (const auto& [id, hue] : repaintOf(graph, legend, graft).nodes) {
    auto entry = std::find_if(frame.graph.nodes.begin(), frame.graph.nodes.end(),
                              [&](const NodeStateEntry& held) { return held.id == id; });
    if (entry == frame.graph.nodes.end()) entry = frame.graph.nodes.insert(entry, NodeStateEntry{.id = id});
    entry->color = hue;
    entry->colorAt = at;
  }
  return frame;
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
    if (graft.prerequisites == PrerequisiteMode::merge || graft.omittedPrerequisites.count(edge.to))
      footprint.keptEdges.push_back(edge);
    else footprint.replacedEdges.push_back(edge);
  }
  for (const NodeId& id : tombstoned)
    if (graph.hasNode(id)) footprint.tombstonedNodes.push_back(id);
  for (const Edge& edge : graph.presentEdges())
    if (tombstoned.count(edge.from) || tombstoned.count(edge.to)) footprint.tombstonedEdges.push_back(edge);
  return footprint;
}

GraphState graftState(const LooseGraph& graph, const Graft& graft, const Hlc& at) {
  using Entry = NodeStateEntry;
  const std::set<NodeId> tombstoned(graft.tombstones.begin(), graft.tombstones.end());
  std::map<NodeId, Entry> upserted;  // by id, so the frame lists each node once, in id order
  std::set<Edge> added;
  for (const NodeSpec& node : graft.document.nodes) {
    const std::optional<Entry> held = graph.exportNode(node.id);  // present, or what a delete left
    const auto omitted = graft.omittedNodeRegisters.find(node.id);
    const auto carried = [&](NodeRegister reg) {
      return omitted == graft.omittedNodeRegisters.end() || !omitted->second.count(reg);
    };
    Entry entry;
    entry.id = node.id;
    if (!graph.hasNode(node.id)) entry.createdAt = at;  // new or revived; a present node keeps its creation
    // A register lands at the graft's stamp when the batch carried it and it changes what the graph
    // holds, an empty value included; one left out, or sent as the graph already holds it, stays unset.
    const auto land = [&](bool inBatch, auto Entry::*field, Hlc Entry::*stamp, const auto& sent) {
      if (!inBatch || !landsOver(held, field, sent)) return;
      entry.*field = sent;
      entry.*stamp = at;
    };
    land(carried(NodeRegister::label), &Entry::label, &Entry::labelAt, node.label);
    land(carried(NodeRegister::icon), &Entry::icon, &Entry::iconAt, node.icon);
    land(carried(NodeRegister::color), &Entry::color, &Entry::colorAt, node.color);
    land(carried(NodeRegister::order), &Entry::order, &Entry::orderAt, node.order);
    land(carried(NodeRegister::status), &Entry::status, &Entry::statusAt, normalizeSeedStatus(node.status));
    land(carried(NodeRegister::description), &Entry::description, &Entry::descriptionAt, node.description);
    land(carried(NodeRegister::links), &Entry::links, &Entry::linksAt, node.links);
    // A node the graft brings back opens the tree the batch names and no other, as a node created on a deleted id
    // does: left out, the pointer the delete left is cleared.
    const bool broughtBack = held && !graph.hasNode(node.id);
    land(carried(NodeRegister::opens) || broughtBack, &Entry::opens, &Entry::opensAt, node.opens);
    if (entry != Entry{.id = node.id}) upserted.emplace(node.id, std::move(entry));  // it lands something
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
  for (const NodeId& id : footprint.tombstonedNodes) state.nodes.push_back(Entry{.id = id, .deletedAt = at});
  for (const Edge& edge : footprint.replacedEdges) state.edges.push_back(EdgeStateEntry{edge, {}, at});
  for (const Edge& edge : footprint.tombstonedEdges) state.edges.push_back(EdgeStateEntry{edge, {}, at});
  return state;
}

}
