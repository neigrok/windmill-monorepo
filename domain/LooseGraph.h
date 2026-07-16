#pragma once

#include "domain/Crdt.h"
#include "domain/GraphState.h"
#include "domain/Ids.h"
#include "domain/Tree.h"

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
  Lww<std::optional<Vec2>> position;
  Lww<std::optional<std::string>> status;  // opaque authoring seed, round-tripped
  Lww<std::string> description;            // free annotation body
  Lww<std::vector<Link>> links;            // external references, the list as one register
};

// The authoritative, possibly-invalid state of one tree. Every command merges into it;
// nothing is ever rejected. Validity is a separate read model (TreeDiagnostics).
class LooseGraph {
public:
  LooseGraph() = default;
  LooseGraph(const TreeData& seed, const Hlc& at);
  explicit LooseGraph(const GraphState& state);

  // Fold a partial state into this one, entry by entry, field by field: the same
  // element-set and LWW merges a command takes, applied to serialized records. Absence at
  // every granularity — a missing entry, a missing field, the unset stamp — means "no
  // information", so joining a subgraph delta only ever adds. Commutative, associative,
  // idempotent; the one convergence primitive the whole sync framework rides on.
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
  std::vector<Edge> liveEdges() const;
  std::vector<Edge> redundantEdges() const;
  // Present edges no valid DAG keeps: a self-edge, or one whose endpoint is absent (never
  // created, or tombstoned). The prune set — removing them leaves the live graph unchanged.
  std::vector<Edge> danglingEdges() const;

  TreeData toTreeData(const TreeId& id, const std::string& title) const;
  GraphState exportState() const;
  // One entry's full CRDT state, for sparse persistence: a save writes only the entries a
  // write touched, and these read them out one by one. nullopt for a never-seen key.
  std::optional<NodeStateEntry> exportNode(const NodeId& id) const;
  std::optional<EdgeStateEntry> exportEdge(const Edge& edge) const;

private:
  static constexpr std::size_t kMaxReductionNodes = 1500;  // reduction is optional cleanup; skip above this

  std::map<NodeId, NodeRecord> nodes_;
  std::map<Edge, ElementSet> edges_;
};

}
