#include "domain/TreeSummary.h"

#include <algorithm>
#include <array>
#include <cstddef>

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

std::vector<TreeSummary> registrySummaries(const std::vector<LoadedTree>& loaded) {
  std::vector<TreeSummary> summaries;
  summaries.reserve(loaded.size());
  for (const LoadedTree& tree : loaded) {
    TreeSummary summary;
    summary.id = tree.data.id;
    summary.title = tree.data.title;
    summary.createdAt = tree.createdAt;  // a birth stamp: never folded with the freshness ones
    summary.updatedAt = lastActiveAt(tree.updatedAt, tree.lastMarkedAt);
    summary.stats = treeStats(tree.data, tree.progress);
    summaries.push_back(std::move(summary));
  }
  std::sort(summaries.begin(), summaries.end(), [](const TreeSummary& a, const TreeSummary& b) {
    if (a.updatedAt != b.updatedAt) return a.updatedAt > b.updatedAt;
    return a.id < b.id;
  });
  return summaries;
}

}
