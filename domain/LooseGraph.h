#pragma once

#include "domain/Crdt.h"
#include "domain/GraphState.h"
#include "domain/Ids.h"
#include "domain/Tree.h"

#include <map>
#include <optional>
#include <string>
#include <vector>

namespace wm {

struct NodeRecord {
  ElementSet life;
  Lww<std::string> label;
  Lww<std::string> icon;
  Lww<NodeColor> color;
  Lww<std::optional<Vec2>> position;
  Lww<std::optional<std::string>> status;  // opaque authoring seed, round-tripped
};

// The authoritative, possibly-invalid state of one tree. Every command merges into it;
// nothing is ever rejected. Validity is a separate read model (TreeDiagnostics).
class LooseGraph {
public:
  LooseGraph() = default;
  LooseGraph(const TreeData& seed, const Hlc& at);
  explicit LooseGraph(const GraphState& state);

  void createNode(const NodeId& id, const std::string& label, const std::string& icon,
                  NodeColor color, const std::optional<Vec2>& position, const Hlc& at,
                  const std::optional<std::string>& status = std::nullopt);
  void deleteNode(const NodeId& id, const Hlc& at);
  void setLabel(const NodeId& id, const std::string& label, const Hlc& at);
  void setColor(const NodeId& id, NodeColor color, const Hlc& at);
  void setPosition(const NodeId& id, const Vec2& position, const Hlc& at);
  void addEdge(const NodeId& from, const NodeId& to, const Hlc& at);
  void removeEdge(const NodeId& from, const NodeId& to, const Hlc& at);

  bool hasNode(const NodeId& id) const;
  bool edgePresent(const NodeId& from, const NodeId& to) const;
  std::optional<NodeSpec> nodeView(const NodeId& id) const;

  // Present nodes currently painted `color` — the repaint set for a RecolorKind, and
  // (via hueInUse) the in-use guard that blocks removing a kind whose hue is still worn.
  std::vector<NodeId> nodesWithColor(NodeColor color) const;
  bool hueInUse(NodeColor color) const;

  std::vector<NodeId> presentNodeIds() const;
  std::vector<Edge> presentEdges() const;
  std::vector<Edge> liveEdges() const;
  std::vector<Edge> redundantEdges() const;

  TreeData toTreeData(const TreeId& id, const std::string& title) const;
  GraphState exportState() const;

private:
  std::map<NodeId, NodeRecord> nodes_;
  std::map<Edge, ElementSet> edges_;
};

}
