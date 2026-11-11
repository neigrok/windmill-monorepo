#include "products/roadmap/domain/OpenedTrees.h"

#include <algorithm>
#include <utility>

namespace wm {

OpenedTree::OpenedTree(const TreeData& tree, const Progress& marks)
    : title(tree.title), total(static_cast<int>(tree.nodes.size())) {
  for (const NodeSpec& node : tree.nodes) {
    const bool nodeMarked = marks.completed.count(node.id) > 0;
    if (!node.opens.empty()) {
      openers.push_back({node.id, node.opens, nodeMarked});
      continue;
    }
    if (nodeMarked) ++marked;
  }
}

std::set<TreeId> treesOpenedBy(const TreeData& tree) {
  std::set<TreeId> opened;
  for (const NodeSpec& node : tree.nodes)
    if (!node.opens.empty()) opened.insert(node.opens);
  return opened;
}

OpenedTrees::OpenedTrees(const TreeData& tree, const std::map<TreeId, OpenedTree>& standing) {
  // Breadth first, so each tree is met at its shortest distance: the step counts the pointers.
  std::set<TreeId> within{tree.id};
  std::set<TreeId> frontier;
  for (const TreeId& opened : treesOpenedBy(tree))
    if (standing.count(opened)) frontier.insert(opened);
  for (int step = 1; step <= kOpenedTreeReach && !frontier.empty(); ++step) {
    std::set<TreeId> next;
    for (const TreeId& reached : frontier) {
      if (!within.insert(reached).second) continue;
      for (const Opener& opener : standing.at(reached).openers)
        if (standing.count(opener.opens) && !within.count(opener.opens)) next.insert(opener.opens);
    }
    frontier = std::move(next);
  }

  std::set<TreeId> complete;
  const auto doneIn = [&](const OpenedTree& opened) {
    int done = opened.marked;
    for (const Opener& opener : opened.openers) {
      const bool valid = standing.count(opener.opens) > 0;
      if (valid ? complete.count(opener.opens) > 0 : opener.marked) ++done;
    }
    return done;
  };
  // Trees only ever join `complete`, so the passes end at the least answer, whatever order they run in.
  for (bool grew = true; grew;) {
    grew = false;
    for (const TreeId& reached : within) {
      // The tree being read is on every loop that leads back to it, so nothing it opens finds it complete.
      if (reached == tree.id || complete.count(reached)) continue;
      const OpenedTree& opened = standing.at(reached);
      if (opened.total == 0 || doneIn(opened) != opened.total) continue;
      complete.insert(reached);
      grew = true;
    }
  }

  std::set<TreeId> leadingBack{tree.id};
  for (bool grew = true; grew;) {
    grew = false;
    for (const TreeId& reached : within) {
      if (leadingBack.count(reached)) continue;
      const std::vector<Opener>& openers = standing.at(reached).openers;
      const bool leadsBack = std::any_of(openers.begin(), openers.end(), [&](const Opener& opener) {
        return standing.count(opener.opens) && leadingBack.count(opener.opens);
      });
      if (!leadsBack) continue;
      leadingBack.insert(reached);
      grew = true;
    }
  }

  for (const NodeSpec& node : tree.nodes) {
    if (node.opens.empty()) continue;
    const auto opened = standing.find(node.opens);
    if (opened == standing.end()) {
      openings.emplace(node.id, Opening{node.opens, true});
      continue;
    }
    openings.emplace(node.id, Opening{node.opens, false, opened->second.title, complete.count(node.opens) > 0,
                                      doneIn(opened->second), opened->second.total,
                                      leadingBack.count(node.opens) > 0});
  }
}

Progress OpenedTrees::followed(const Progress& marks) const {
  Progress followed;
  followed.completed = marks.completed;
  for (const auto& [node, opening] : openings) {
    if (opening.missing) continue;
    followed.completed.erase(node);
    if (opening.complete) followed.completed.insert(node);
  }
  return followed;
}

}
