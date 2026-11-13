#include "products/roadmap/domain/LooseGraph.h"

#include <algorithm>
#include <set>
#include <tuple>

namespace wm {

namespace {
NodeStateEntry entryOf(const NodeId& id, const NodeRecord& record) {
  NodeStateEntry entry;
  entry.id = id;
  entry.createdAt = record.life.addedAt;
  entry.deletedAt = record.life.removedAt;
  entry.label = record.label.value;
  entry.labelAt = record.label.stamp;
  entry.icon = record.icon.value;
  entry.iconAt = record.icon.stamp;
  entry.color = record.color.value;
  entry.colorAt = record.color.stamp;
  entry.order = record.order.value;
  entry.orderAt = record.order.stamp;
  entry.status = record.status.value;
  entry.statusAt = record.status.stamp;
  entry.description = record.description.value;
  entry.descriptionAt = record.description.stamp;
  entry.links = record.links.value;
  entry.linksAt = record.links.stamp;
  entry.opens = record.opens.value;
  entry.opensAt = record.opens.stamp;
  return entry;
}
}

LooseGraph::LooseGraph(const TreeData& seed, const Hlc& at) {
  for (const auto& node : seed.nodes) {
    createNode(node.id, node.label, node.icon, node.color, at, node.status);
    if (!node.order.empty()) setOrder(node.id, node.order, at);
    if (!node.description.empty()) setDescription(node.id, node.description, at);
    if (!node.links.empty()) setLinks(node.id, node.links, at);
    if (!node.opens.empty()) setOpens(node.id, node.opens, at);
  }
  for (const auto& node : seed.nodes) {
    for (const auto& prereq : node.prerequisites) addEdge(prereq, node.id, at);
  }
}

LooseGraph::LooseGraph(const GraphState& state) {
  for (const auto& node : state.nodes) {
    NodeRecord record;
    record.life.addedAt = node.createdAt;
    record.life.removedAt = node.deletedAt;
    record.label = {node.label, node.labelAt};
    record.icon = {node.icon, node.iconAt};
    record.color = {node.color, node.colorAt};
    record.order = {node.order, node.orderAt};
    record.status = {normalizeSeedStatus(node.status), node.statusAt};
    record.description = {node.description, node.descriptionAt};
    record.links = {node.links, node.linksAt};
    record.opens = {node.opens, node.opensAt};
    nodes_[node.id] = std::move(record);
  }
  for (const auto& edge : state.edges) {
    edges_[edge.edge] = ElementSet{edge.addedAt, edge.removedAt};
  }
}

bool LooseGraph::join(const GraphState& state) {
  bool took = false;
  for (const auto& node : state.nodes) {
    const auto [held, fresh] = nodes_.try_emplace(node.id);
    NodeRecord& record = held->second;
    bool nodeTook = record.life.add(node.createdAt);
    nodeTook |= record.life.remove(node.deletedAt);
    nodeTook |= record.label.merge(node.label, node.labelAt);
    nodeTook |= record.icon.merge(node.icon, node.iconAt);
    nodeTook |= record.color.merge(node.color, node.colorAt);
    nodeTook |= record.order.merge(node.order, node.orderAt);
    nodeTook |= record.status.merge(normalizeSeedStatus(node.status), node.statusAt);
    nodeTook |= record.description.merge(node.description, node.descriptionAt);
    nodeTook |= record.links.merge(node.links, node.linksAt);
    nodeTook |= record.opens.merge(node.opens, node.opensAt);
    if (fresh && !nodeTook) nodes_.erase(held);
    took |= nodeTook;
  }
  for (const auto& edge : state.edges) {
    const auto [held, fresh] = edges_.try_emplace(edge.edge);
    bool edgeTook = held->second.add(edge.addedAt);
    edgeTook |= held->second.remove(edge.removedAt);
    if (fresh && !edgeTook) edges_.erase(held);
    took |= edgeTook;
  }
  return took;
}

void LooseGraph::createNode(const NodeId& id, const std::string& label, const std::string& icon,
                            NodeColor color, const Hlc& at, const std::optional<std::string>& status) {
  NodeRecord& record = nodes_[id];
  record.life.add(at);
  record.label.merge(label, at);
  record.icon.merge(icon, at);
  record.color.merge(color, at);
  if (status) record.status.merge(normalizeSeedStatus(status), at);
}

void LooseGraph::deleteNode(const NodeId& id, const Hlc& at) {
  nodes_[id].life.remove(at);
}

void LooseGraph::setLabel(const NodeId& id, const std::string& label, const Hlc& at) {
  nodes_[id].label.merge(label, at);
}

void LooseGraph::setIcon(const NodeId& id, const std::string& icon, const Hlc& at) {
  nodes_[id].icon.merge(icon, at);
}

void LooseGraph::setColor(const NodeId& id, NodeColor color, const Hlc& at) {
  nodes_[id].color.merge(color, at);
}

void LooseGraph::setDescription(const NodeId& id, const std::string& description, const Hlc& at) {
  nodes_[id].description.merge(description, at);
}

void LooseGraph::setLinks(const NodeId& id, const std::vector<Link>& links, const Hlc& at) {
  nodes_[id].links.merge(links, at);
}

void LooseGraph::setOrder(const NodeId& id, const std::string& order, const Hlc& at) {
  nodes_[id].order.merge(order, at);
}

void LooseGraph::setOpens(const NodeId& id, const TreeId& opens, const Hlc& at) {
  nodes_[id].opens.merge(opens, at);
}

void LooseGraph::addEdge(const NodeId& from, const NodeId& to, const Hlc& at) {
  edges_[Edge{from, to}].add(at);
}

void LooseGraph::removeEdge(const NodeId& from, const NodeId& to, const Hlc& at) {
  edges_[Edge{from, to}].remove(at);
}

bool LooseGraph::hasNode(const NodeId& id) const {
  auto it = nodes_.find(id);
  return it != nodes_.end() && it->second.life.present();
}

bool LooseGraph::isTombstoned(const NodeId& id) const {
  auto it = nodes_.find(id);
  return it != nodes_.end() && it->second.life.addedAt.isSet() && !it->second.life.present();
}

bool LooseGraph::edgePresent(const NodeId& from, const NodeId& to) const {
  auto it = edges_.find(Edge{from, to});
  return it != edges_.end() && it->second.present();
}

std::string LooseGraph::descriptionOf(const NodeId& id) const {
  const auto record = nodes_.find(id);
  if (record == nodes_.end()) return "";
  return record->second.description.value;
}

std::vector<Link> LooseGraph::linksOf(const NodeId& id) const {
  const auto record = nodes_.find(id);
  if (record == nodes_.end()) return {};
  return record->second.links.value;
}

std::map<NodeId, TreeId> LooseGraph::pointers() const {
  std::map<NodeId, TreeId> held;
  for (const auto& [id, record] : nodes_)
    if (record.life.present() && !record.opens.value.empty()) held.emplace(id, record.opens.value);
  return held;
}

std::map<NodeId, StampedPointer> LooseGraph::stampedPointers() const {
  std::map<NodeId, StampedPointer> held;
  for (const auto& [id, record] : nodes_)
    if (record.life.present() && !record.opens.value.empty()) held.emplace(id, StampedPointer{record.opens.value, record.opens.stamp});
  return held;
}

std::optional<NodeSpec> LooseGraph::nodeView(const NodeId& id) const {
  if (!hasNode(id)) return std::nullopt;
  const NodeRecord& record = nodes_.at(id);
  NodeSpec spec;
  spec.id = id;
  spec.label = record.label.value;
  spec.icon = record.icon.value;
  spec.color = record.color.value;
  spec.order = record.order.value;
  spec.status = record.status.value;
  spec.description = record.description.value;
  spec.links = record.links.value;
  spec.opens = record.opens.value;
  for (const auto& edge : liveEdges()) {
    if (edge.to == id) spec.prerequisites.push_back(edge.from);
  }
  return spec;
}

std::vector<NodeId> LooseGraph::nodesWithColor(NodeColor color) const {
  std::vector<NodeId> ids;
  for (const auto& [id, record] : nodes_) {
    if (record.life.present() && record.color.value == color) ids.push_back(id);
  }
  return ids;
}

std::vector<NodeId> LooseGraph::deletedNodesWithColor(NodeColor color) const {
  std::vector<NodeId> ids;
  for (const auto& [id, record] : nodes_) {
    if (record.life.addedAt.isSet() && !record.life.present() && record.color.value == color) ids.push_back(id);
  }
  return ids;
}

bool LooseGraph::hueInUse(NodeColor color) const {
  for (const auto& [id, record] : nodes_) {
    if (record.life.present() && record.color.value == color) return true;
  }
  return false;
}

std::vector<NodeId> LooseGraph::presentNodeIds() const {
  std::vector<NodeId> ids;
  for (const auto& [id, record] : nodes_) {
    if (record.life.present()) ids.push_back(id);
  }
  return ids;
}

std::vector<Edge> LooseGraph::presentEdges() const {
  std::vector<Edge> live;
  for (const auto& [edge, element] : edges_) {
    if (element.present()) live.push_back(edge);
  }
  return live;
}

std::size_t LooseGraph::presentNodeCount() const {
  std::size_t count = 0;
  for (const auto& [id, record] : nodes_) if (record.life.present()) ++count;
  return count;
}

std::size_t LooseGraph::presentEdgeCount() const {
  std::size_t count = 0;
  for (const auto& [edge, element] : edges_) if (element.present()) ++count;
  return count;
}

std::vector<Edge> LooseGraph::liveEdges() const {
  std::vector<Edge> live;
  for (const auto& [edge, element] : edges_) {
    if (element.present() && edge.from != edge.to && hasNode(edge.from) && hasNode(edge.to)) {
      live.push_back(edge);
    }
  }
  return live;
}

std::vector<Edge> LooseGraph::edgesTouching(const std::vector<NodeId>& nodes) const {
  const std::set<NodeId> touched(nodes.begin(), nodes.end());
  std::vector<Edge> touching;
  for (const auto& [edge, element] : edges_) {
    if (!element.present()) continue;
    if (touched.count(edge.from) || touched.count(edge.to)) touching.push_back(edge);
  }
  return touching;
}

TreeData LooseGraph::toTreeData(const TreeId& id, const std::string& title) const {
  std::map<NodeId, std::vector<NodeId>> parents;
  for (const auto& edge : liveEdges()) parents[edge.to].push_back(edge.from);

  TreeData data;
  data.id = id;
  data.title = title;
  for (const auto& [nodeId, record] : nodes_) {
    if (!record.life.present()) continue;
    NodeSpec spec;
    spec.id = nodeId;
    spec.label = record.label.value;
    spec.icon = record.icon.value;
    spec.color = record.color.value;
    spec.order = record.order.value;
    spec.status = record.status.value;
    spec.description = record.description.value;
    spec.links = record.links.value;
    spec.opens = record.opens.value;
    if (auto it = parents.find(nodeId); it != parents.end()) spec.prerequisites = it->second;
    data.nodes.push_back(std::move(spec));
  }
  return data;
}

GraphState LooseGraph::exportState() const {
  GraphState state;
  for (const auto& [id, record] : nodes_) state.nodes.push_back(entryOf(id, record));
  for (const auto& [edge, element] : edges_) {
    state.edges.push_back(EdgeStateEntry{edge, element.addedAt, element.removedAt});
  }
  return state;
}

GraphState LooseGraph::forkState(const Hlc& plantedAt, ForkOpens opens) const {
  GraphState state = exportState();
  std::vector<NodeStateEntry*> present;
  for (NodeStateEntry& node : state.nodes) {
    node.status = std::nullopt;
    node.statusAt = Hlc{};
    if (opens == ForkOpens::cleared) {
      node.opens = TreeId{};
      node.opensAt = Hlc{};
    }
    if (nodes_.at(node.id).life.present()) present.push_back(&node);
  }
  std::sort(present.begin(), present.end(), [](const NodeStateEntry* a, const NodeStateEntry* b) {
    return std::tie(a->createdAt, a->id) < std::tie(b->createdAt, b->id);
  });
  Hlc at = plantedAt;
  for (NodeStateEntry* node : present) {
    node->createdAt = at;
    ++at.counter;
  }
  return state;
}

std::optional<ElementSet> LooseGraph::lifeOf(const NodeId& id) const {
  auto it = nodes_.find(id);
  if (it == nodes_.end()) return std::nullopt;
  return it->second.life;
}

std::optional<ElementSet> LooseGraph::lifeOf(const Edge& edge) const {
  auto it = edges_.find(edge);
  if (it == edges_.end()) return std::nullopt;
  return it->second;
}

std::optional<NodeStateEntry> LooseGraph::exportNode(const NodeId& id) const {
  auto it = nodes_.find(id);
  if (it == nodes_.end()) return std::nullopt;
  return entryOf(id, it->second);
}

std::optional<EdgeStateEntry> LooseGraph::exportEdge(const Edge& edge) const {
  auto it = edges_.find(edge);
  if (it == edges_.end()) return std::nullopt;
  return EdgeStateEntry{edge, it->second.addedAt, it->second.removedAt};
}

}
