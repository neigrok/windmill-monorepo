#include "products/roadmap/domain/OpenedTrees.h"

#include <algorithm>
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

std::set<TreeId> treesOpenedBy(const std::map<NodeId, TreeId>& pointers) {
  std::set<TreeId> opened;
  for (const auto& [node, tree] : pointers) opened.insert(tree);
  return opened;
}

std::map<NodeId, TreeId> pointersSetSince(const std::map<NodeId, TreeId>& before, const std::map<NodeId, TreeId>& after) {
  std::map<NodeId, TreeId> set;
  for (const auto& [node, tree] : after) {
    const auto held = before.find(node);
    if (held == before.end() || held->second != tree) set.emplace(node, tree);
  }
  return set;
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

WaysBack OpenedTrees::waysBackTo(const TreeId& tree) const {
  WaysBack back;
  std::vector<TreeId> level;
  if (standing_.count(tree)) {
    back.ways.emplace(tree, WaysBack::Way{});
    level.push_back(tree);
  }
  // A level of openers at a time, so each tree is met first at its fewest pointers, and every tree it opens that is
  // one pointer nearer is met in that same round: the smallest of them is where it steps.
  for (int distance = 1; !level.empty(); ++distance) {
    std::vector<TreeId> above;
    for (const TreeId& below : level) {
      const auto openers = openers_.find(below);
      if (openers == openers_.end()) continue;
      for (const TreeId& opener : openers->second) {
        ++back.walked;
        const auto [way, fresh] = back.ways.emplace(opener, WaysBack::Way{distance, below});
        if (fresh) above.push_back(opener);
        if (way->second.pointers == distance && below < way->second.next) way->second.next = below;
      }
    }
    level = std::move(above);
  }
  return back;
}

std::set<TreeId> OpenedTrees::leadingBackTo(const TreeId& tree) const {
  std::set<TreeId> leading;
  for (const auto& [led, way] : waysBackTo(tree).ways) leading.insert(led);
  return leading;
}

PointerDiagnostics OpenedTrees::diagnose(const TreeId& tree, const std::map<NodeId, TreeId>& pointers) const {
  const WaysBack back = waysBackTo(tree);
  PointerDiagnostics diagnostics;
  for (const auto& [node, opened] : pointers) {
    if (!standing_.count(opened)) {
      if (diagnostics.danglingPointers.size() == kMaxDanglingPointers) ++diagnostics.danglingPointersOmitted;
      else diagnostics.danglingPointers.push_back({node, opened});
      continue;
    }
    const auto way = back.ways.find(opened);
    if (way == back.ways.end()) continue;
    if (diagnostics.treeLoops.size() == kMaxTreeLoops) {
      ++diagnostics.treeLoopsOmitted;
      continue;
    }
    const std::size_t trees = static_cast<std::size_t>(way->second.pointers) + 1;
    TreeLoop loop{node, {}, trees - std::min(trees, kMaxLoopPath)};
    for (TreeId on = opened; loop.path.size() < trees - loop.pathOmitted; on = back.ways.at(on).next)
      loop.path.push_back({on, standing_.at(on).title});
    diagnostics.treeLoops.push_back(std::move(loop));
  }
  return diagnostics;
}

}
