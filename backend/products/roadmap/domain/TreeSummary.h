#pragma once

#include "products/roadmap/domain/Ids.h"
#include "products/roadmap/domain/Tree.h"

#include <cstdint>
#include <optional>
#include <string>
#include <vector>

namespace wm {

// The headline stats of one tree: how many nodes, how many the caller has finished, and the hue the
// tree wears most. A pure projection of a tree + one caller's overlay.
struct TreeStats {
  int total = 0;
  int done = 0;
  std::optional<NodeColor> dominantKind;
};

TreeStats treeStats(const TreeData& tree, const Progress& progress);

// When a tree last moved forward. Its freshness lives in two places and neither stands for the
// other: the trees row moves on a structural edit (and on a rename or a visibility flip), while a
// progress mark writes only node_progress. Every ordering that means "last active" folds the pair
// here, so the registry and the public wall can never drift into two answers.
std::uint64_t lastActiveAt(std::uint64_t updatedAt, std::uint64_t lastMarkedAt);

// One glanceable registry row. The two timestamps answer different questions — how old the tree is,
// and how fresh it is — so neither stands in for the other.
struct TreeSummary {
  TreeId id;
  std::string title;
  std::uint64_t createdAt = 0;  // epoch ms; the planting time
  std::uint64_t updatedAt = 0;  // epoch ms; lastActiveAt — a structural edit or a progress mark
  TreeStats stats;
};

// One owned tree's loaded facts, handed to the domain to summarize.
struct LoadedTree {
  TreeData data;
  std::uint64_t createdAt = 0;     // the trees-row planting timestamp (epoch ms)
  std::uint64_t updatedAt = 0;     // the trees-row structural timestamp (epoch ms)
  Progress progress;               // the caller's overlay
  std::uint64_t lastMarkedAt = 0;  // the caller's latest progress mark (epoch ms), 0 if none
};

// The caller's registry, ordered the way the switcher reads it: newest forward change first,
// ties broken by id. Each row's updatedAt is the freshest of its two timestamps.
std::vector<TreeSummary> registrySummaries(const std::vector<LoadedTree>& loaded);

}
