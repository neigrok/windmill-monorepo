#include "products/roadmap/domain/LooseGraph.h"

#include <deque>
#include <set>

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
  entry.position = record.position.value;
  entry.positionAt = record.position.stamp;
  entry.status = record.status.value;
  entry.statusAt = record.status.stamp;
  entry.description = record.description.value;
  entry.descriptionAt = record.description.stamp;
  entry.links = record.links.value;
  entry.linksAt = record.links.stamp;
  return entry;
}
}

LooseGraph::LooseGraph(const TreeData& seed, const Hlc& at) {
  for (const auto& node : seed.nodes) {
    createNode(node.id, node.label, node.icon, node.color, node.position, at, node.status);
    if (!node.order.empty()) setOrder(node.id, node.order, at);
    if (!node.description.empty()) setDescription(node.id, node.description, at);
    if (!node.links.empty()) setLinks(node.id, node.links, at);
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
    record.position = {node.position, node.positionAt};
    record.status = {node.status, node.statusAt};
    record.description = {node.description, node.descriptionAt};
    record.links = {node.links, node.linksAt};
    nodes_[node.id] = std::move(record);
  }
  for (const auto& edge : state.edges) {
    edges_[edge.edge] = ElementSet{edge.addedAt, edge.removedAt};
  }
}

void LooseGraph::join(const GraphState& state) {
  for (const auto& node : state.nodes) {
    NodeRecord& record = nodes_[node.id];
    record.life.add(node.createdAt);
    record.life.remove(node.deletedAt);
    record.label.merge(node.label, node.labelAt);
    record.icon.merge(node.icon, node.iconAt);
    record.color.merge(node.color, node.colorAt);
    record.order.merge(node.order, node.orderAt);
    record.position.merge(node.position, node.positionAt);
    record.status.merge(node.status, node.statusAt);
    record.description.merge(node.description, node.descriptionAt);
    record.links.merge(node.links, node.linksAt);
  }
  for (const auto& edge : state.edges) {
    ElementSet& element = edges_[edge.edge];
    element.add(edge.addedAt);
    element.remove(edge.removedAt);
  }
}

void LooseGraph::createNode(const NodeId& id, const std::string& label, const std::string& icon,
                            NodeColor color, const std::optional<Vec2>& position, const Hlc& at,
                            const std::optional<std::string>& status) {
  NodeRecord& record = nodes_[id];
  record.life.add(at);
  record.label.merge(label, at);
  record.icon.merge(icon, at);
  record.color.merge(color, at);
  if (position) record.position.merge(position, at);
  if (status) record.status.merge(status, at);
}

void LooseGraph::deleteNode(const NodeId& id, const Hlc& at) {
  nodes_[id].life.remove(at);
}

void LooseGraph::setLabel(const NodeId& id, const std::string& label, const Hlc& at) {
  nodes_[id].label.merge(label, at);
}

void LooseGraph::setColor(const NodeId& id, NodeColor color, const Hlc& at) {
  nodes_[id].color.merge(color, at);
}

void LooseGraph::setPosition(const NodeId& id, const Vec2& position, const Hlc& at) {
  nodes_[id].position.merge(position, at);
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

std::optional<NodeSpec> LooseGraph::nodeView(const NodeId& id) const {
  if (!hasNode(id)) return std::nullopt;
  const NodeRecord& record = nodes_.at(id);
  NodeSpec spec;
  spec.id = id;
  spec.label = record.label.value;
  spec.icon = record.icon.value;
  spec.color = record.color.value;
  spec.order = record.order.value;
  spec.position = record.position.value;
  spec.status = record.status.value;
  spec.description = record.description.value;
  spec.links = record.links.value;
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

std::vector<Edge> LooseGraph::liveEdges() const {
  std::vector<Edge> live;
  for (const auto& [edge, element] : edges_) {
    if (element.present() && edge.from != edge.to && hasNode(edge.from) && hasNode(edge.to)) {
      live.push_back(edge);
    }
  }
  return live;
}

std::vector<Edge> LooseGraph::danglingEdges() const {
  std::vector<Edge> dangling;
  for (const auto& [edge, element] : edges_) {
    if (!element.present()) continue;
    if (edge.from == edge.to || !hasNode(edge.from) || !hasNode(edge.to)) dangling.push_back(edge);
  }
  return dangling;
}

std::vector<Edge> LooseGraph::redundantEdges() const {
  if (presentNodeIds().size() > kMaxReductionNodes) return {};  // bound the superlinear reachability

  std::map<NodeId, std::vector<NodeId>> parents;
  for (const auto& edge : liveEdges()) parents[edge.to].push_back(edge.from);

  std::map<NodeId, std::set<NodeId>> memo;
  auto ancestorsOf = [&](const NodeId& start) -> const std::set<NodeId>& {
    auto cached = memo.find(start);
    if (cached != memo.end()) return cached->second;
    std::set<NodeId> ancestors;
    std::deque<NodeId> queue(parents[start].begin(), parents[start].end());
    while (!queue.empty()) {
      NodeId current = queue.front();
      queue.pop_front();
      if (!ancestors.insert(current).second) continue;
      for (const auto& parent : parents[current]) queue.push_back(parent);
    }
    return memo.emplace(start, std::move(ancestors)).first->second;
  };

  std::vector<Edge> redundant;
  for (const auto& [child, directParents] : parents) {
    for (const auto& from : directParents) {
      for (const auto& other : directParents) {
        if (other != from && ancestorsOf(other).count(from)) {
          redundant.push_back(Edge{from, child});
          break;
        }
      }
    }
  }
  return redundant;
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
    spec.position = record.position.value;
    spec.status = record.status.value;
    spec.description = record.description.value;
    spec.links = record.links.value;
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
