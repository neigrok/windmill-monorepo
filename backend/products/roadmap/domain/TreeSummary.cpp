#include "products/roadmap/domain/TreeSummary.h"

#include <algorithm>
#include <array>
#include <cstddef>
#include <map>
#include <utility>

namespace wm {

TreeStats treeStats(const TreeData& tree, const Progress& progress) {
  TreeStats stats;
  stats.total = static_cast<int>(tree.nodes.size());
  for (const NodeSpec& node : tree.nodes)
    if (progress.completed.count(node.id)) ++stats.done;  // clamp to nodes that still exist

  if (tree.nodes.empty()) return stats;

  std::array<int, 6> worn{};  // node colors are a fixed six (domain/Tree.h)
  for (const NodeSpec& node : tree.nodes) ++worn[static_cast<std::size_t>(node.color)];

  auto leader = std::max_element(worn.begin(), worn.end());  // the first hue at the peak count
  if (std::count(worn.begin(), worn.end(), *leader) == 1) {
    stats.dominantKind = static_cast<NodeColor>(std::distance(worn.begin(), leader));
    return stats;
  }

  // A tie for most-worn breaks to the root's color — the smallest-id node with no
  // prerequisites, else the smallest-id node (nodes arrive id-sorted from the projection).
  const NodeSpec* root = &tree.nodes.front();
  for (const NodeSpec& node : tree.nodes)
    if (node.prerequisites.empty()) { root = &node; break; }
  stats.dominantKind = root->color;
  return stats;
}

std::uint64_t lastActiveAt(std::uint64_t updatedAt, std::uint64_t lastMarkedAt) {
  return std::max(updatedAt, lastMarkedAt);
}

OpenedTrees openedAmong(const std::vector<LoadedTree>& loaded) {
  std::map<TreeId, std::map<NodeId, TreeId>> owned;  // the subtree each step owns, by the tree it is in
  for (const LoadedTree& tree : loaded)
    if (tree.parent) owned[tree.parent->tree].emplace(tree.parent->step, tree.data.id);
  std::map<TreeId, OpenedTree> standing;
  for (const LoadedTree& tree : loaded) {
    const auto steps = owned.find(tree.data.id);
    standing.emplace(tree.data.id, OpenedTree(tree.data, tree.progress,
                                              steps == owned.end() ? std::map<NodeId, TreeId>{} : steps->second,
                                              tree.parent));
  }
  return OpenedTrees(std::move(standing));
}

namespace {

// The subtrees each tree of `loaded` owns, by step.
using Owned = std::map<TreeId, std::map<NodeId, const LoadedTree*>>;

// `tree` with every subtree reached down its present owning steps: how many subtrees, and how many steps in all.
BranchSize branchOf(const LoadedTree& tree, const Owned& owned) {
  BranchSize branch{0, static_cast<int>(tree.data.nodes.size())};
  const auto steps = owned.find(tree.data.id);
  if (steps == owned.end()) return branch;
  for (const NodeSpec& node : tree.data.nodes) {
    const auto subtree = steps->second.find(node.id);
    if (subtree == steps->second.end()) continue;
    const BranchSize below = branchOf(*subtree->second, owned);
    branch.subtrees += 1 + below.subtrees;
    branch.steps += below.steps;
  }
  return branch;
}

}

std::vector<TreeSummary> registrySummaries(const std::vector<LoadedTree>& loaded) {
  const OpenedTrees opened = openedAmong(loaded);
  Owned owned;
  for (const LoadedTree& tree : loaded)
    if (tree.parent) owned[tree.parent->tree].emplace(tree.parent->step, &tree);
  std::vector<TreeSummary> summaries;
  summaries.reserve(loaded.size());
  for (const LoadedTree& tree : loaded) {
    if (tree.parent) continue;
    TreeSummary summary;
    summary.id = tree.data.id;
    summary.title = tree.data.title;
    summary.createdAt = tree.createdAt;  // a birth stamp: never folded with the freshness ones
    summary.updatedAt = lastActiveAt(tree.updatedAt, tree.lastMarkedAt);
    summary.stats = treeStats(tree.data, opened.followed(tree.data, tree.progress));
    summary.openers = opened.openersOf(tree.data.id);
    summary.branch = branchOf(tree, owned);
    summaries.push_back(std::move(summary));
  }
  std::sort(summaries.begin(), summaries.end(), [](const TreeSummary& a, const TreeSummary& b) {
    if (a.updatedAt != b.updatedAt) return a.updatedAt > b.updatedAt;
    return a.id < b.id;
  });
  return summaries;
}

}
