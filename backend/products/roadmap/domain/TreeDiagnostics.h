#pragma once

#include "products/roadmap/domain/Ids.h"
#include "products/roadmap/domain/Legend.h"
#include "products/roadmap/domain/LooseGraph.h"
#include "products/roadmap/domain/Tree.h"

#include <optional>
#include <string>
#include <vector>

namespace wm {

struct Cycle {
  std::vector<NodeId> members;
};

// A warning about one node, or about the whole tree when it names none; `hue` is the hue an unclaimed-hue smell is
// about.
struct Smell {
  std::optional<NodeId> node;
  std::string kind;
  std::optional<NodeColor> hue;

  bool operator==(const Smell&) const = default;
};

// How a LooseGraph departs from a valid tree, read beside its legend. Errors (cycles, dangling,
// self-edges) block the SkillTree projection; smells are warnings. `maskedWork` is nodes deleted while
// a subtree of live children hangs off them — the delete stands, resurrecting the parent re-connects it.
struct TreeDiagnostics {
  std::vector<Cycle> cycles;
  std::vector<Edge> dangling;
  std::vector<Edge> selfEdges;
  std::vector<Smell> smells;
  std::vector<NodeId> maskedWork;  // tombstoned parents that still have present children

  bool clean() const { return cycles.empty() && dangling.empty() && selfEdges.empty(); }

  static TreeDiagnostics assess(const LooseGraph& graph, const Legend& legend);

  static constexpr std::size_t maxLabel = 256;
  static constexpr std::size_t inDegreeSmell = 4;
};

}
