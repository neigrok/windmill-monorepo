#include "products/roadmap/domain/OpenedTrees.h"

#include <utility>

namespace wm {

OpenedTree::OpenedTree(const TreeData& tree, const Progress& marks)
    : title(tree.title), total(static_cast<int>(tree.nodes.size())) {
  for (const NodeSpec& node : tree.nodes) {
    const bool nodeMarked = marks.completed.count(node.id) > 0;
    if (node.opens.empty()) {
      if (nodeMarked) ++marked;
      continue;
    }
    Pointers& opening = pointers[node.opens];
    ++opening.nodes;
    if (nodeMarked) ++opening.marked;
  }
}

std::set<TreeId> treesOpenedBy(const TreeData& tree) {
  std::set<TreeId> opened;
  for (const NodeSpec& node : tree.nodes)
    if (!node.opens.empty()) opened.insert(node.opens);
  return opened;
}

OpenedTrees::OpenedTrees(std::map<TreeId, OpenedTree> standing) : standing_(std::move(standing)) {
  // `pending_` counts a tree's nodes that are not complete; a tree is complete when it reaches zero.
  std::vector<TreeId> ready;
  for (const auto& [id, tree] : standing_) {
    int pending = tree.total - tree.marked;
    for (const auto& [target, opening] : tree.pointers) {
      if (standing_.count(target)) {
        openers_[target].push_back(id);
        continue;
      }
      pending -= opening.marked;
    }
    pending_[id] = pending;
    if (tree.total > 0 && pending == 0) ready.push_back(id);
  }
  // Each pointer is walked once, when its target completes: trees only ever join, so this is the least answer.
  while (!ready.empty()) {
    const TreeId finished = ready.back();
    ready.pop_back();
    complete_.insert(finished);
    const auto openers = openers_.find(finished);
    if (openers == openers_.end()) continue;
    for (const TreeId& opener : openers->second) {
      ++walked_;
      int& pending = pending_.at(opener);
      pending -= standing_.at(opener).pointers.at(finished).nodes;
      if (pending == 0) ready.push_back(opener);
    }
  }
}

Progress OpenedTrees::followed(const TreeData& tree, const Progress& marks) const {
  Progress followed;
  followed.completed = marks.completed;
  for (const NodeSpec& node : tree.nodes) {
    if (node.opens.empty() || !standing_.count(node.opens)) continue;
    followed.completed.erase(node.id);
    if (complete_.count(node.opens)) followed.completed.insert(node.id);
  }
  return followed;
}

std::map<NodeId, Opening> OpenedTrees::openings(const TreeData& tree) const {
  std::map<NodeId, Opening> openings;
  for (const NodeSpec& node : tree.nodes) {
    if (node.opens.empty()) continue;
    const auto opened = standing_.find(node.opens);
    if (opened == standing_.end()) {
      openings.emplace(node.id, Opening{node.opens, true});
      continue;
    }
    const int total = opened->second.total;
    openings.emplace(node.id, Opening{node.opens, false, opened->second.title, complete_.count(node.opens) > 0,
                                      total - pending_.at(node.opens), total});
  }
  return openings;
}

std::set<TreeId> OpenedTrees::leadingBackTo(const TreeId& tree) const {
  std::set<TreeId> leading;
  if (!standing_.count(tree)) return leading;
  std::vector<TreeId> reached{tree};
  while (!reached.empty()) {
    const TreeId led = reached.back();
    reached.pop_back();
    if (!leading.insert(led).second) continue;
    const auto openers = openers_.find(led);
    if (openers == openers_.end()) continue;
    reached.insert(reached.end(), openers->second.begin(), openers->second.end());
  }
  return leading;
}

PointerDiagnostics OpenedTrees::diagnose(const TreeData& tree) const {
  // The fewest pointers from each standing tree back to `tree`, counted a level of openers at a time.
  std::map<TreeId, int> pointersBack;
  std::vector<TreeId> level;
  if (standing_.count(tree.id)) level.push_back(tree.id);
  for (int distance = 0; !level.empty(); ++distance) {
    std::vector<TreeId> above;
    for (const TreeId& below : level) {
      if (!pointersBack.emplace(below, distance).second) continue;
      const auto openers = openers_.find(below);
      if (openers != openers_.end()) above.insert(above.end(), openers->second.begin(), openers->second.end());
    }
    level = std::move(above);
  }

  std::map<NodeId, TreeId> pointers;
  for (const NodeSpec& node : tree.nodes)
    if (!node.opens.empty()) pointers.emplace(node.id, node.opens);

  PointerDiagnostics diagnostics;
  for (const auto& [node, opened] : pointers) {
    if (!standing_.count(opened)) {
      diagnostics.danglingPointers.push_back({node, opened});
      continue;
    }
    const auto back = pointersBack.find(opened);
    if (back == pointersBack.end()) continue;
    TreeLoop loop{node, {}};
    TreeId onTheWay = opened;
    for (int left = back->second; left > 0; --left) {
      loop.path.push_back({onTheWay, standing_.at(onTheWay).title});
      // A tree's pointers are held by target id, so the first one a pointer nearer is the smallest.
      for (const auto& [target, held] : standing_.at(onTheWay).pointers) {
        const auto nearer = pointersBack.find(target);
        if (nearer == pointersBack.end() || nearer->second != left - 1) continue;
        onTheWay = target;
        break;
      }
    }
    loop.path.push_back({tree.id, standing_.at(tree.id).title});
    diagnostics.treeLoops.push_back(std::move(loop));
  }
  return diagnostics;
}

}
