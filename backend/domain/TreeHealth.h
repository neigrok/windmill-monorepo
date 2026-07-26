#pragma once

#include "domain/SkillTree.h"

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

// Pure diagnostics over a valid tree: counts, cross-branch coupling, redundant
// (transitively implied) edges, and a single 0..100 health score.
struct TreeHealth {
  static Health assess(const SkillTree& tree);

  static constexpr int redundancyNodeLimit = 1500;
};

}
