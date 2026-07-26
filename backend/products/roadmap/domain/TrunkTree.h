#pragma once

#include "products/roadmap/domain/Ids.h"
#include "products/roadmap/domain/Tree.h"

#include <map>
#include <optional>
#include <vector>

namespace wm {

class SkillTree;

// Elects one trunk (primary) parent per node — a spanning arborescence over the DAG —
// and derives each node's sector: branch root, trunk depth, leaf weight. Same-kind
// parents win; ties go to the shallowest, then the smallest id.
class TrunkTree {
public:
  TrunkTree() = default;
  explicit TrunkTree(const SkillTree& tree);

  std::optional<NodeId> centerId() const { return centerNodeId_; }
  const std::vector<NodeId>& branchRoots() const { return branchRootIds_; }

  std::optional<NodeId> primaryParentOf(const NodeId& id) const;
  const std::vector<NodeId>& trunkChildrenOf(const NodeId& id) const;
  const NodeId& branchOf(const NodeId& id) const;
  int trunkDepthOf(const NodeId& id) const;
  int leafCountOf(const NodeId& id) const;
  EdgeKind edgeKind(const NodeId& from, const NodeId& to) const;

private:
  std::optional<NodeId> centerNodeId_;
  std::map<NodeId, std::optional<NodeId>> primaryParentById_;
  std::map<NodeId, int> trunkDepthById_;
  std::map<NodeId, NodeId> branchRootById_;
  std::map<NodeId, std::vector<NodeId>> trunkChildrenById_;
  std::map<NodeId, int> leafCountById_;
  std::vector<NodeId> branchRootIds_;
};

}
