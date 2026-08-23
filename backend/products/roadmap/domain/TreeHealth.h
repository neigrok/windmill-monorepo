#pragma once

#include "products/roadmap/domain/SkillTree.h"

namespace wm {

struct Health {
  int nodeCount = 0;
  int edgeCount = 0;
  int crossBranch = 0;
  int redundant = 0;
  double avgInDegree = 0;
  int score = 0;
  bool operator==(const Health&) const = default;
};

// Pure diagnostics over a valid tree: counts, cross-branch coupling, redundant (transitively
// implied) edges, and a 0..100 health score. The redundant count is reported as 0 on a tree that
// costs more than withinReachabilityBudget (domain/LooseGraph.h) allows.
struct TreeHealth {
  static Health assess(const SkillTree& tree);
};

}
