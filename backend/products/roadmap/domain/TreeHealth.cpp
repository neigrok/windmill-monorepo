#include "products/roadmap/domain/TreeHealth.h"

#include "products/roadmap/domain/LooseGraph.h"

#include <algorithm>
#include <cmath>
#include <map>
#include <set>

namespace wm {

namespace {
int countRedundantEdges(const SkillTree& tree) {
  std::map<NodeId, std::set<NodeId>> descendantsById;
  const std::vector<NodeId>& order = tree.topoOrder();
  for (auto it = order.rbegin(); it != order.rend(); ++it) {
    std::set<NodeId> descendants;
    for (const NodeSpec* child : tree.childrenOf(*it)) {
      descendants.insert(child->id);
      for (const NodeId& deep : descendantsById[child->id]) descendants.insert(deep);
    }
    descendantsById[*it] = std::move(descendants);
  }

  int redundant = 0;
  for (const Edge& edge : tree.edges()) {
    for (const NodeSpec* sibling : tree.childrenOf(edge.from)) {
      if (sibling->id != edge.to && descendantsById[sibling->id].count(edge.to)) {
        ++redundant;
        break;
      }
    }
  }
  return redundant;
}
}

Health TreeHealth::assess(const SkillTree& tree) {
  Health health;
  health.nodeCount = static_cast<int>(tree.nodes().size());
  health.edgeCount = static_cast<int>(tree.edges().size());

  std::set<NodeColor> exemptHues;
  for (const Kind& kind : tree.kinds())
    if (kind.crossBranchExempt) exemptHues.insert(kind.hue);
  for (const Edge& edge : tree.edges()) {
    if (tree.trunk().edgeKind(edge.from, edge.to) != EdgeKind::cross_branch) continue;
    const bool exempt = exemptHues.count(tree.nodeById(edge.from).color) ||
                        exemptHues.count(tree.nodeById(edge.to).color);
    if (exempt) ++health.crossBranchExempt;
    else ++health.crossBranch;
  }
  // Bounded by the work, never by nodes alone: the pass that fills this in is a transitive
  // closure, and a tree wide in edges is the expensive one (domain/LooseGraph.h).
  health.redundant =
      withinReachabilityBudget(tree.nodes().size(), tree.edges().size()) ? countRedundantEdges(tree) : 0;
  health.avgInDegree = std::round((static_cast<double>(health.edgeCount) / std::max(1, health.nodeCount)) * 100) / 100;

  double crossFrac = health.edgeCount ? static_cast<double>(health.crossBranch) / health.edgeCount : 0;
  double redFrac = health.edgeCount ? static_cast<double>(health.redundant) / health.edgeCount : 0;
  double raw = 100 * (1 - 0.6 * crossFrac - 0.4 * redFrac);
  health.score = static_cast<int>(std::round(std::max(0.0, std::min(100.0, raw))));

  return health;
}

}
