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

// The nodes a smell covers: every one counted, the first `cap` named in the order nodes are reported, so a smell stays
// one short line whatever the tree's size.
struct CountedNodes {
  static constexpr std::size_t cap = 10;

  std::size_t count = 0;
  std::vector<NodeId> named;

  void add(const NodeId& node) {
    if (named.size() < cap) named.push_back(node);
    ++count;
  }

  bool operator==(const CountedNodes&) const = default;
};

// One kind of per-node warning — `label-too-long`, `empty-icon`, `high-in-degree` — and the nodes it covers.
struct Smell {
  std::string kind;
  CountedNodes nodes;

  bool operator==(const Smell&) const = default;
};

// A hue present nodes wear that no kind of the legend does, and the nodes wearing it.
struct UnclaimedHue {
  NodeColor hue;
  CountedNodes nodes;

  bool operator==(const UnclaimedHue&) const = default;
};

// How a LooseGraph departs from a valid tree, read beside its legend. Errors (cycles, dangling,
// self-edges) block the SkillTree projection; smells are warnings, one line each however many nodes
// they cover: `smells` one per kind some node has, in the order above, `unclaimedHues` one per hue no
// kind wears, and `legendEmpty` in their place for a tree with nodes whose legend holds no kind, where
// every hue would be one. `maskedWork` is nodes deleted while a subtree of live children hangs off
// them — the delete stands, resurrecting the parent re-connects it.
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
};

}
