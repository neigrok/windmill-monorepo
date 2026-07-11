#include "domain/TrunkTree.h"

#include "domain/SkillTree.h"

namespace wm {

TrunkTree::TrunkTree(const SkillTree& tree) {
  auto roots = tree.roots();
  if (roots.size() == 1) centerNodeId_ = roots[0]->id;

  const std::vector<NodeId>& order = tree.topoOrder();
  for (const auto& id : order) trunkChildrenById_[id] = {};

  for (const auto& id : order) {
    const NodeSpec& node = tree.nodeById(id);
    std::vector<const NodeSpec*> parents = tree.parentsOf(id);
    if (parents.empty()) {
      primaryParentById_[id] = std::nullopt;
      trunkDepthById_[id] = 0;
      branchRootById_[id] = id;
      continue;
    }

    std::vector<const NodeSpec*> sameKind;
    for (const NodeSpec* parent : parents) {
      if (parent->color == node.color) sameKind.push_back(parent);
    }
    const std::vector<const NodeSpec*>& candidates = sameKind.empty() ? parents : sameKind;

    const NodeSpec* elected = candidates.front();
    for (const NodeSpec* candidate : candidates) {
      int depthGap = trunkDepthById_[candidate->id] - trunkDepthById_[elected->id];
      if (depthGap < 0) elected = candidate;
      else if (depthGap == 0 && candidate->id < elected->id) elected = candidate;
    }

    primaryParentById_[id] = elected->id;
    trunkDepthById_[id] = trunkDepthById_[elected->id] + 1;
    bool cutsBranch = (centerNodeId_ && elected->id == *centerNodeId_) || elected->color != node.color;
    branchRootById_[id] = cutsBranch ? id : branchRootById_[elected->id];
    trunkChildrenById_[elected->id].push_back(id);
  }

  for (auto it = order.rbegin(); it != order.rend(); ++it) {
    const std::vector<NodeId>& children = trunkChildrenById_[*it];
    if (children.empty()) {
      leafCountById_[*it] = 1;
      continue;
    }
    int sum = 0;
    for (const auto& childId : children) sum += leafCountById_[childId];
    leafCountById_[*it] = sum;
  }

  for (const auto& id : order) {
    if (branchRootById_[id] == id) branchRootIds_.push_back(id);
  }
}

std::optional<NodeId> TrunkTree::primaryParentOf(const NodeId& id) const {
  return primaryParentById_.at(id);
}

const std::vector<NodeId>& TrunkTree::trunkChildrenOf(const NodeId& id) const {
  return trunkChildrenById_.at(id);
}

const NodeId& TrunkTree::branchOf(const NodeId& id) const {
  return branchRootById_.at(id);
}

int TrunkTree::trunkDepthOf(const NodeId& id) const {
  return trunkDepthById_.at(id);
}

int TrunkTree::leafCountOf(const NodeId& id) const {
  return leafCountById_.at(id);
}

EdgeKind TrunkTree::edgeKind(const NodeId& from, const NodeId& to) const {
  std::optional<NodeId> primary = primaryParentOf(to);
  if (primary && *primary == from) return EdgeKind::trunk;
  if (branchOf(from) == branchOf(to)) return EdgeKind::in_branch;
  return EdgeKind::cross_branch;
}

}
