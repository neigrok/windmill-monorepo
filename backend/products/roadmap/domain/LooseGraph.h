#pragma once

#include "platform/domain/Crdt.h"
#include "products/roadmap/domain/GraphState.h"
#include "products/roadmap/domain/Ids.h"
#include "products/roadmap/domain/Tree.h"

#include <cstddef>
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
  Lww<std::string> order;  // fractional-index sort key, scoped to the parent; round-tripped, never interpreted
  Lww<std::optional<Vec2>> position;
  Lww<std::optional<std::string>> status;  // opaque authoring seed, round-tripped
  Lww<std::string> description;            // free annotation body
  Lww<std::vector<Link>> links;            // external references, the list as one register
};

// The redundant-edge pass walks a transitive closure whose inner loop is a sum of squared degrees,
// so the budget counts the WORK: a node ceiling, an edge ceiling, and their product. Over budget
// the pass is skipped and reports nothing — tidy finds no edge to drop, health reports 0 redundant.
bool withinReachabilityBudget(std::size_t nodes, std::size_t edges);

// The authoritative, possibly-invalid state of one tree. Every command merges into it;
// nothing is ever rejected. Validity is a separate read model (TreeDiagnostics).
class LooseGraph {
public:
  LooseGraph() = default;
  LooseGraph(const TreeData& seed, const Hlc& at);
  explicit LooseGraph(const GraphState& state);

  // Fold a partial state into this one, entry by entry, field by field: the same element-set and
  // LWW merges a command takes, applied to serialized records. Absence at every granularity — a
  // missing entry, a missing field, the unset stamp — means "no information", so joining a subgraph
  // delta only ever adds. Commutative, associative, idempotent.
  void join(const GraphState& state);

  void createNode(const NodeId& id, const std::string& label, const std::string& icon,
                  NodeColor color, const std::optional<Vec2>& position, const Hlc& at,
                  const std::optional<std::string>& status = std::nullopt);
  void deleteNode(const NodeId& id, const Hlc& at);
  void setLabel(const NodeId& id, const std::string& label, const Hlc& at);
  void setColor(const NodeId& id, NodeColor color, const Hlc& at);
  void setPosition(const NodeId& id, const Vec2& position, const Hlc& at);
  void setDescription(const NodeId& id, const std::string& description, const Hlc& at);
  void setLinks(const NodeId& id, const std::vector<Link>& links, const Hlc& at);
  void setOrder(const NodeId& id, const std::string& order, const Hlc& at);
  void addEdge(const NodeId& from, const NodeId& to, const Hlc& at);
  void removeEdge(const NodeId& from, const NodeId& to, const Hlc& at);

  bool hasNode(const NodeId& id) const;
  // A node that was created and then deleted — its record and every field survive, so it can
  // be resurrected. Distinct from a never-seen id (a pure dangling reference), which cannot.
  bool isTombstoned(const NodeId& id) const;
  bool edgePresent(const NodeId& from, const NodeId& to) const;
  std::optional<NodeSpec> nodeView(const NodeId& id) const;

  // Present nodes currently painted `color` — the repaint set for a RecolorKind, and
  // (via hueInUse) the in-use guard that blocks removing a kind whose hue is still worn.
  std::vector<NodeId> nodesWithColor(NodeColor color) const;
  bool hueInUse(NodeColor color) const;

  std::vector<NodeId> presentNodeIds() const;
  std::vector<Edge> presentEdges() const;
  // The same two counts without materializing the lists — what the capacity checks want, and they
  // run on every admitted write, once per node of an arriving frame.
  std::size_t presentNodeCount() const;
  std::size_t presentEdgeCount() const;
  std::vector<Edge> liveEdges() const;
  std::vector<Edge> redundantEdges() const;
  // Present edges no valid DAG keeps: a self-edge, or one whose endpoint is absent (never
  // created, or tombstoned). The prune set — removing them leaves the live graph unchanged.
  std::vector<Edge> danglingEdges() const;

  // One entry's element-set life — the add/remove stamps alone, without the fields exportNode
  // copies — so an arriving entry's join can be COUNTED instead of estimated. nullopt for a
  // never-seen key.
  std::optional<ElementSet> lifeOf(const NodeId& id) const;
  std::optional<ElementSet> lifeOf(const Edge& edge) const;

  TreeData toTreeData(const TreeId& id, const std::string& title) const;
  GraphState exportState() const;
  // One entry's full CRDT state, for sparse persistence: a save writes only the entries a
  // write touched, and these read them out one by one. nullopt for a never-seen key.
  std::optional<NodeStateEntry> exportNode(const NodeId& id) const;
  std::optional<EdgeStateEntry> exportEdge(const Edge& edge) const;

private:
  std::map<NodeId, NodeRecord> nodes_;
  std::map<Edge, ElementSet> edges_;
};

}
