#pragma once

#include "domain/Ids.h"
#include "domain/Tree.h"

#include <map>
#include <optional>
#include <string>
#include <vector>

namespace wm {

// A last-writer-wins register: the value carried by the highest HLC stamp wins.
template <typename T>
struct Lww {
  T value{};
  Hlc stamp{};

  void merge(T incoming, const Hlc& at) {
    if (at > stamp) {
      value = std::move(incoming);
      stamp = at;
    }
  }
};

// A single element of an add-biased LWW-element-set: present iff it was added and no
// strictly-later remove has cancelled it (a tie between add and remove favours add).
struct ElementSet {
  Hlc addedAt{};
  Hlc removedAt{};

  void add(const Hlc& at) { if (at > addedAt) addedAt = at; }
  void remove(const Hlc& at) { if (at > removedAt) removedAt = at; }
  bool present() const { return addedAt.isSet() && !(removedAt > addedAt); }
};

struct NodeRecord {
  ElementSet life;
  Lww<std::string> label;
  Lww<std::string> icon;
  Lww<NodeColor> color;
  Lww<std::optional<Vec2>> position;
};

// The authoritative, possibly-invalid state of one tree. Every command merges into it;
// nothing is ever rejected. Validity is a separate read model (TreeDiagnostics).
class LooseGraph {
public:
  LooseGraph() = default;
  LooseGraph(const TreeData& seed, const Hlc& at);

  void createNode(const NodeId& id, const std::string& label, const std::string& icon,
                  NodeColor color, const std::optional<Vec2>& position, const Hlc& at);
  void deleteNode(const NodeId& id, const Hlc& at);
  void setLabel(const NodeId& id, const std::string& label, const Hlc& at);
  void setColor(const NodeId& id, NodeColor color, const Hlc& at);
  void setPosition(const NodeId& id, const Vec2& position, const Hlc& at);
  void addEdge(const NodeId& from, const NodeId& to, const Hlc& at);
  void removeEdge(const NodeId& from, const NodeId& to, const Hlc& at);

  bool hasNode(const NodeId& id) const;
  bool edgePresent(const NodeId& from, const NodeId& to) const;
  std::optional<NodeSpec> nodeView(const NodeId& id) const;

  std::vector<NodeId> presentNodeIds() const;
  std::vector<Edge> presentEdges() const;
  std::vector<Edge> liveEdges() const;
  std::vector<Edge> redundantEdges() const;

  TreeData toTreeData(const TreeId& id, const std::string& title) const;

private:
  std::map<NodeId, NodeRecord> nodes_;
  std::map<Edge, ElementSet> edges_;
};

}
