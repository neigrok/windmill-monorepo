#pragma once

#include "products/roadmap/domain/Ids.h"
#include "products/roadmap/domain/OpenedTrees.h"
#include "products/roadmap/domain/Subtree.h"
#include "products/roadmap/domain/Tree.h"

#include <cstdint>
#include <optional>
#include <string>
#include <vector>

namespace wm {

// A pure projection of a tree + one caller's overlay.
struct TreeStats {
  int total = 0;
  int done = 0;
  std::optional<NodeColor> dominantKind;
};

TreeStats treeStats(const TreeData& tree, const Progress& progress);

// When a tree last moved forward. The trees row moves on a structural edit, a rename or a visibility
// flip; a progress mark writes only node_progress. Every ordering that means "last active" folds the
// pair here.
std::uint64_t lastActiveAt(std::uint64_t updatedAt, std::uint64_t lastMarkedAt);

// The two timestamps answer different questions — how old the tree is, and how fresh it is.
struct TreeSummary {
  TreeId id;
  std::string title;
  std::uint64_t createdAt = 0;  // epoch ms; the planting time
  std::uint64_t updatedAt = 0;  // epoch ms; lastActiveAt — a structural edit or a progress mark
  TreeStats stats;
  std::vector<OpeningSteps> openers;  // the owner's other trees whose steps open this one (OpenedTrees::openersOf)
};

// Each step of `data` opens the subtree it owns, whatever its pointer holds (SPEC.md, Model, Subtrees).
struct LoadedTree {
  TreeData data;
  std::uint64_t createdAt = 0;     // the trees-row planting timestamp (epoch ms)
  std::uint64_t updatedAt = 0;     // the trees-row structural timestamp (epoch ms)
  Progress progress;               // the caller's overlay
  std::uint64_t lastMarkedAt = 0;  // the caller's latest progress mark (epoch ms), 0 if none
  std::optional<OwningStep> parent;  // a subtree's owning step; none for a root
};

// One owner's loaded trees under their marks, judged once for the whole account.
OpenedTrees openedAmong(const std::vector<LoadedTree>& loaded);

// One row per root of `loaded`, ordered newest-forward-change first, ties broken by id: a subtree is no row, and counts
// in its parent as the one step that owns it. Each row's updatedAt is the freshest of its two timestamps. Every
// tree of `loaded` is judged, and the openers come from `loaded` alone, so every tree in them stands and is the owner's.
std::vector<TreeSummary> registrySummaries(const std::vector<LoadedTree>& loaded);

}
