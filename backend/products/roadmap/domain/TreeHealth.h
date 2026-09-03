#pragma once

#include "products/roadmap/domain/SkillTree.h"

namespace wm {

struct Health {
  int nodeCount = 0;
  int edgeCount = 0;
  int crossBranch = 0;
  int crossBranchExempt = 0;
  int redundant = 0;
  double avgInDegree = 0;
  int score = 0;
  bool operator==(const Health&) const = default;
};

// Pure diagnostics over a valid tree: counts, cross-branch coupling, redundant (transitively
// implied) edges, and a 0..100 health score. Branches derive from colour (TrunkTree), so an edge
// between two hues is cross-branch — unless either endpoint wears a kind the legend marks
// `crossBranchExempt`: those edges are counted in `crossBranchExempt` instead and weigh nothing —
// the score's fractions are over `edgeCount - crossBranchExempt`, while `edgeCount` stays every
// live edge.
// The redundant count is reported as 0 on a tree that costs more than withinReachabilityBudget
// (domain/LooseGraph.h) allows.
struct TreeHealth {
  static Health assess(const SkillTree& tree);
};

}
