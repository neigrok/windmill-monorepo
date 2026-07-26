#pragma once

#include "products/roadmap/domain/Ids.h"
#include "products/roadmap/domain/Tree.h"
#include "products/roadmap/domain/TrunkTree.h"

#include <map>
#include <stdexcept>
#include <string>
#include <vector>

namespace wm {

struct InvalidTree : std::runtime_error {
  using std::runtime_error::runtime_error;
};

// A validated projection of a diagnostics-clean LooseGraph: indexes the DAG once at
// construction (throwing InvalidTree on a duplicate id, dangling prerequisite, or
// cycle), then answers every graph question the platform read-models need.
class SkillTree {
public:
  explicit SkillTree(TreeData data);

  const TreeId& id() const { return data_.id; }
  const std::string& title() const { return data_.title; }
  const std::vector<NodeSpec>& nodes() const { return data_.nodes; }
  const std::vector<Edge>& edges() const { return edges_; }
  const TrunkTree& trunk() const { return trunk_; }

  const NodeSpec& nodeById(const NodeId& id) const;
  std::vector<const NodeSpec*> roots() const;
  std::vector<const NodeSpec*> parentsOf(const NodeId& id) const;
  const std::vector<const NodeSpec*>& childrenOf(const NodeId& id) const;
  const std::vector<NodeId>& topoOrder() const { return orderedIds_; }

private:
  TreeData data_;
  std::map<NodeId, const NodeSpec*> nodesById_;
  std::vector<Edge> edges_;
  std::map<NodeId, std::vector<const NodeSpec*>> childrenIndex_;
  std::vector<NodeId> orderedIds_;
  TrunkTree trunk_;
};

}
