#pragma once

#include "products/roadmap/domain/Crdt.h"
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
  Lww<std::optional<std::string>> status;  // opaque authoring seed, round-tripped
  Lww<std::string> description;            // free annotation body
  Lww<std::vector<Link>> links;            // external references, the list as one register
  Lww<TreeId> opens;                       // the tree this node opens; an empty id opens none
};

// Whether a fork's nodes open the trees its source's do: its source's owner keeps every pointer as it
// stands, and anyone else starts with none, so no tree plants a pointer in a stranger's fork.
enum class ForkOpens { kept, cleared };

// The authoritative, possibly-invalid state of one tree. Every command merges into it;
// nothing is ever rejected. Validity is a separate read model (TreeDiagnostics).
class LooseGraph {
public:
  LooseGraph() = default;
  LooseGraph(const TreeData& seed, const Hlc& at);
  explicit LooseGraph(const GraphState& state);

  // Fold a partial state into this one, entry by entry, field by field. Absence at every granularity
  // — a missing entry, a missing field, the unset stamp — means "no information", so a join only ever
  // adds. Commutative, associative, idempotent. Answers what landed: each entry cut to the stamps of it that took,
  // with the values they carried, and left out when none did — so a state whose every stamp is held answers empty, and
  // an entry none of whose stamps took leaves the graph without a record it did not have.
  GraphState join(const GraphState& state);

  void createNode(const NodeId& id, const std::string& label, const std::string& icon,
                  NodeColor color, const Hlc& at, const std::optional<std::string>& status = std::nullopt);
  void deleteNode(const NodeId& id, const Hlc& at);
  void setLabel(const NodeId& id, const std::string& label, const Hlc& at);
  void setIcon(const NodeId& id, const std::string& icon, const Hlc& at);
  void setColor(const NodeId& id, NodeColor color, const Hlc& at);
  void setDescription(const NodeId& id, const std::string& description, const Hlc& at);
  void setLinks(const NodeId& id, const std::vector<Link>& links, const Hlc& at);
  void setOrder(const NodeId& id, const std::string& order, const Hlc& at);
  void setOpens(const NodeId& id, const TreeId& opens, const Hlc& at);
  void addEdge(const NodeId& from, const NodeId& to, const Hlc& at);
  void removeEdge(const NodeId& from, const NodeId& to, const Hlc& at);

  bool hasNode(const NodeId& id) const;
  // A node that was created and then deleted — its record and every field survive, so it can
  // be resurrected. Distinct from a never-seen id (a pure dangling reference), which cannot.
  bool isTombstoned(const NodeId& id) const;
  bool edgePresent(const NodeId& from, const NodeId& to) const;
  std::optional<NodeSpec> nodeView(const NodeId& id) const;
  // The one register an append reads, without the edge scan nodeView pays; "" for a never-seen id.
  std::string descriptionOf(const NodeId& id) const;
  // The links a node's record holds, present or deleted, without the edge scan; none for a never-seen id.
  std::vector<Link> linksOf(const NodeId& id) const;

  // The tree each present node opens, by node; a node that opens none is left out.
  std::map<NodeId, TreeId> pointers() const;
  // The same, each with the stamp its pointer was set under.
  std::map<NodeId, StampedPointer> stampedPointers() const;

  // Present nodes currently painted `color`: the repaint set for a RecolorKind, and the guard
  // blocking removal of a kind whose hue is still worn.
  std::vector<NodeId> nodesWithColor(NodeColor color) const;
  // Deleted nodes whose colour register holds `color`, whether or not anyone wrote it: a RecolorKind
  // repaints them with the present ones, so a node brought back is under its kind. A record never
  // created is not one.
  std::vector<NodeId> deletedNodesWithColor(NodeColor color) const;
  bool hueInUse(NodeColor color) const;

  std::vector<NodeId> presentNodeIds() const;
  std::vector<Edge> presentEdges() const;
  // The same two counts without materializing the lists; they run on every admitted write.
  std::size_t presentNodeCount() const;
  std::size_t presentEdgeCount() const;
  std::vector<Edge> liveEdges() const;
  // Present edges with either endpoint among `nodes` — what tombstoning those nodes would dangle.
  std::vector<Edge> edgesTouching(const std::vector<NodeId>& nodes) const;

  // One entry's element-set life — the add/remove stamps alone — so an arriving entry's join can be
  // COUNTED instead of estimated. nullopt for a never-seen key.
  std::optional<ElementSet> lifeOf(const NodeId& id) const;
  std::optional<ElementSet> lifeOf(const Edge& edge) const;

  TreeData toTreeData(const TreeId& id, const std::string& title) const;
  GraphState exportState() const;
  // The state a fork of this graph starts from. Every present node is added to the fork afresh,
  // `plantedAt` plus one counter tick per node in (creation stamp, id) order, so sibling ties keep
  // their order; every status seed is cleared, and `opens` says whether each node still opens its
  // tree. Tombstones and edges keep their stamps. `plantedAt` must dominate every stamp the graph holds.
  GraphState forkState(const Hlc& plantedAt, ForkOpens opens) const;
  // One entry's full CRDT state, for sparse persistence. nullopt for a never-seen key.
  std::optional<NodeStateEntry> exportNode(const NodeId& id) const;
  std::optional<EdgeStateEntry> exportEdge(const Edge& edge) const;

private:
  std::map<NodeId, NodeRecord> nodes_;
  std::map<Edge, ElementSet> edges_;
};

}
