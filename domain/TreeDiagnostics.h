#pragma once

#include "domain/Ids.h"
#include "domain/LooseGraph.h"
#include "domain/Tree.h"

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
struct TreeDiagnostics {
  std::vector<Cycle> cycles;
  std::vector<Edge> dangling;
  std::vector<Edge> selfEdges;
  std::vector<Smell> smells;

  bool clean() const { return cycles.empty() && dangling.empty() && selfEdges.empty(); }

  static TreeDiagnostics assess(const LooseGraph& graph);

  static constexpr std::size_t maxLabel = 256;
  static constexpr std::size_t inDegreeSmell = 4;
};

}
