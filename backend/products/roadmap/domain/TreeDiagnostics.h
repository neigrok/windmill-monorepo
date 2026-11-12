#pragma once

#include "products/roadmap/domain/Ids.h"
#include "products/roadmap/domain/Legend.h"
#include "products/roadmap/domain/LooseGraph.h"
#include "products/roadmap/domain/Tree.h"

#include <cstddef>
#include <string>
#include <vector>

namespace wm {

struct Cycle {
  std::vector<NodeId> members;
};

// A warning about one node.
struct Smell {
  NodeId node;
  std::string kind;

  bool operator==(const Smell&) const = default;
};

// A hue present nodes wear that no kind of the legend does: how many wear it, and the first of them in the order nodes
// are reported, at most TreeDiagnostics::unclaimedNamed, so the smell stays one short line whatever the tree's size.
struct UnclaimedHue {
  NodeColor hue;
  std::size_t count = 0;
  std::vector<NodeId> nodes;

  bool operator==(const UnclaimedHue&) const = default;
};

// How a LooseGraph departs from a valid tree, read beside its legend. Errors (cycles, dangling,
// self-edges) block the SkillTree projection; smells are warnings: `smells` about one node each,
// `unclaimedHues` one per hue no kind wears, and `legendEmpty` in their place for a tree with nodes
// whose legend holds no kind, where every hue would be one. `maskedWork` is nodes deleted while a
// subtree of live children hangs off them — the delete stands, resurrecting the parent re-connects it.
struct TreeDiagnostics {
  std::vector<Cycle> cycles;
  std::vector<Edge> dangling;
  std::vector<Edge> selfEdges;
  std::vector<Smell> smells;
  std::vector<UnclaimedHue> unclaimedHues;  // in hue order
  bool legendEmpty = false;
  std::vector<NodeId> maskedWork;  // tombstoned parents that still have present children

  bool clean() const { return cycles.empty() && dangling.empty() && selfEdges.empty(); }

  static TreeDiagnostics assess(const LooseGraph& graph, const Legend& legend);

  static constexpr std::size_t maxLabel = 256;
  static constexpr std::size_t inDegreeSmell = 4;
  static constexpr std::size_t unclaimedNamed = 10;
};

}
