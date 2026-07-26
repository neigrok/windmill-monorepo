#pragma once

#include "products/roadmap/domain/Ids.h"
#include "products/roadmap/domain/LooseGraph.h"
#include "products/roadmap/domain/Tree.h"

#include <string>
#include <vector>

namespace wm {

struct Cycle {
  std::vector<NodeId> members;
};

struct Smell {
  NodeId node;
  std::string kind;
};

// A description of how a LooseGraph currently departs from a valid tree. Errors
// (cycles, dangling, self-edges) block the SkillTree projection; smells are warnings.
// `maskedWork` is the "keep more, lose less" repair signal: nodes deleted while a subtree of
// live children hangs off them (a delete that raced a concurrent build). The delete stands,
// but the work is only masked — resurrecting the parent re-connects it.
struct TreeDiagnostics {
  std::vector<Cycle> cycles;
  std::vector<Edge> dangling;
  std::vector<Edge> selfEdges;
  std::vector<Smell> smells;
  std::vector<NodeId> maskedWork;  // tombstoned parents that still have present children

  bool clean() const { return cycles.empty() && dangling.empty() && selfEdges.empty(); }

  static TreeDiagnostics assess(const LooseGraph& graph);

  static constexpr std::size_t maxLabel = 256;
  static constexpr std::size_t inDegreeSmell = 4;
};

}
