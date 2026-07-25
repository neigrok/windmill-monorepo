#pragma once

#include "domain/Ids.h"
#include "domain/Tree.h"

#include <cstdint>
#include <optional>
#include <string>
#include <vector>

namespace wm {

// The headline stats of one tree: how many nodes, how many the caller has finished, and the
// hue the tree wears most. A pure projection of a tree + one caller's overlay — the share
// card computes the same three from the same inputs.
struct TreeStats {
  int total = 0;
  int done = 0;
  std::optional<NodeColor> dominantKind;
};

TreeStats treeStats(const TreeData& tree, const Progress& progress);

// One glanceable registry row: which tree, its stats, when it was planted, and when it last
// moved forward. The two timestamps answer different questions — how old the tree is, and how
// fresh it is — so neither stands in for the other.
struct TreeSummary {
  TreeId id;
  std::string title;
  std::uint64_t createdAt = 0;  // epoch ms; the planting time, fixed for the tree's whole life
  std::uint64_t updatedAt = 0;  // epoch ms; the freshest forward change (structural edit or a progress mark)
  TreeStats stats;
};

// One owned tree's loaded facts, handed to the domain to summarize. The three timestamps have
// three provenances — the tree's planting, its last structural save, and the caller's last
// progress mark.
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
