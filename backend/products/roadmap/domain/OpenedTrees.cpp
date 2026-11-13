#include "products/roadmap/domain/OpenedTrees.h"

#include <algorithm>
#include <utility>

namespace wm {

OpenedTree::OpenedTree(const TreeData& tree, const Progress& marks)
    : title(tree.title), total(static_cast<int>(tree.nodes.size())) {
  for (const NodeSpec& node : tree.nodes) {
    const bool nodeMarked = marks.completed.count(node.id) > 0;
    const auto mark = marks.marks.find(node.id);
    const bool stamped = nodeMarked && mark != marks.marks.end() && mark->second.at.isSet();
    const LatestMark latestOfNode = stamped ? LatestMark{mark->second.at, mark->second.markedAt} : LatestMark{};
    if (node.opens.empty()) {
      if (nodeMarked) ++marked;
      latest.join(latestOfNode);
      continue;
    }
    Pointers& opening = pointers[node.opens];
    ++opening.nodes;
    if (nodeMarked) ++opening.marked;
    opening.latest.join(latestOfNode);
  }
}

std::map<NodeId, TreeId> pointersOf(const TreeData& tree) {
  std::map<NodeId, TreeId> pointers;
  for (const NodeSpec& node : tree.nodes)
    if (!node.opens.empty()) pointers.emplace(node.id, node.opens);
  return pointers;
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
  // `pending_` counts a tree's nodes that are not complete; a tree is complete when it reaches zero. `latest` is the
  // latest mark among what has completed of a tree so far: its marks that count, then each tree it follows.
  std::vector<TreeId> ready;
  std::map<TreeId, LatestMark> latest;
  for (const auto& [id, tree] : standing_) {
    int pending = tree.total - tree.marked;
    LatestMark& latestOfTree = latest.emplace(id, tree.latest).first->second;
    for (const auto& [target, opening] : tree.pointers) {
      if (standing_.count(target)) {
        openers_[target].push_back(id);
        continue;
      }
      pending -= opening.marked;
      latestOfTree.join(opening.latest);
    }
    pending_[id] = pending;
    if (tree.total > 0 && pending == 0) ready.push_back(id);
  }
  // Each pointer is walked once, when its target completes: trees only ever join, so this is the least answer.
  while (!ready.empty()) {
    const TreeId finished = ready.back();
    ready.pop_back();
    const LatestMark completedAt = complete_.emplace(finished, latest.at(finished)).first->second;
    const auto openers = openers_.find(finished);
    if (openers == openers_.end()) continue;
    for (const TreeId& opener : openers->second) {
      ++walked_;
      latest.at(opener).join(completedAt);
      int& pending = pending_.at(opener);
      pending -= standing_.at(opener).pointers.at(finished).nodes;
      if (pending == 0) ready.push_back(opener);
    }
  }
}

std::set<NodeId> OpenedTrees::following(const std::map<NodeId, TreeId>& pointers) const {
  std::set<NodeId> following;
  for (const auto& [node, opened] : pointers)
    if (standing_.count(opened)) following.insert(node);
  return following;
}

Progress OpenedTrees::followed(const std::map<NodeId, TreeId>& pointers, const Progress& marks) const {
  Progress followed;
  followed.completed = marks.completed;
  for (const NodeId& node : following(pointers)) {
    followed.completed.erase(node);
    if (complete_.count(pointers.at(node))) followed.completed.insert(node);
  }
  return followed;
}

Progress OpenedTrees::followed(const TreeData& tree, const Progress& marks) const {
  return followed(pointersOf(tree), marks);
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

std::vector<std::set<TreeId>> OpenedTrees::loops() const {
  // Tarjan's walk, kept on an explicit stack so a long chain of trees cannot exhaust the call stack. It steps from a tree
  // to its openers: trees that lead to one another do so along the pointers read either way.
  struct Visit {
    TreeId tree;
    std::size_t nextOpener = 0;
  };
  const std::vector<TreeId> noOpeners;
  const auto openersOf = [&](const TreeId& tree) -> const std::vector<TreeId>& {
    const auto openers = openers_.find(tree);
    return openers == openers_.end() ? noOpeners : openers->second;
  };
  std::map<TreeId, std::size_t> reachedAt;
  std::map<TreeId, std::size_t> earliest;  // the earliest tree still unsettled that a tree's walk leads to
  std::vector<TreeId> unsettled;
  std::set<TreeId> isUnsettled;
  std::vector<std::set<TreeId>> loops;
  const auto reach = [&](const TreeId& tree, std::vector<Visit>& walk) {
    const std::size_t order = reachedAt.size();
    reachedAt[tree] = order;
    earliest[tree] = order;
    unsettled.push_back(tree);
    isUnsettled.insert(tree);
    walk.push_back({tree});
  };
  for (const auto& [start, unused] : standing_) {
    if (reachedAt.count(start)) continue;
    std::vector<Visit> walk;
    reach(start, walk);
    while (!walk.empty()) {
      const TreeId tree = walk.back().tree;
      const std::vector<TreeId>& openers = openersOf(tree);
      if (walk.back().nextOpener < openers.size()) {
        const TreeId& opener = openers[walk.back().nextOpener++];
        if (!reachedAt.count(opener)) reach(opener, walk);
        else if (isUnsettled.count(opener)) earliest[tree] = std::min(earliest[tree], reachedAt[opener]);
        continue;
      }
      walk.pop_back();
      if (!walk.empty()) earliest[walk.back().tree] = std::min(earliest[walk.back().tree], earliest[tree]);
      if (earliest[tree] != reachedAt[tree]) continue;
      // The tree is the earliest of what its walk reached and left unsettled: it and everything above it settle as one.
      std::set<TreeId> settled;
      TreeId member;
      do {
        member = unsettled.back();
        unsettled.pop_back();
        isUnsettled.erase(member);
        settled.insert(member);
      } while (member != tree);
      if (settled.size() > 1 || standing_.at(tree).pointers.count(tree)) loops.push_back(std::move(settled));
    }
  }
  return loops;
}

LatestMark OpenedTrees::completedAt(const TreeId& tree) const {
  const auto complete = complete_.find(tree);
  if (complete == complete_.end()) return {};
  return complete->second;
}

std::set<TreeId> OpenedTrees::leadingBackTo(const TreeId& tree) const {
  std::set<TreeId> leading;
  for (const auto& [led, way] : waysBackTo(tree).ways) leading.insert(led);
  return leading;
}

std::vector<OpeningSteps> OpenedTrees::openersOf(const TreeId& tree) const {
  std::vector<OpeningSteps> openers;
  const auto opened = openers_.find(tree);
  if (opened == openers_.end()) return openers;
  // `openers_` lists each opener once, in the id order `standing_` is walked in.
  for (const TreeId& opener : opened->second)
    if (opener != tree) openers.push_back({opener, standing_.at(opener).pointers.at(tree).nodes});
  return openers;
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

Progress readerView(const Progress& marks, const std::map<NodeId, StampedPointer>& pointers,
                    const std::optional<OpenedTrees>& opened) {
  std::map<NodeId, TreeId> targets;
  for (const auto& [node, pointer] : pointers) targets.emplace(node, pointer.tree);
  std::set<NodeId> following;
  if (opened) following = opened->following(targets);
  else for (const auto& [node, tree] : targets) following.insert(node);
  Progress shown;
  for (const auto& [node, mark] : marks.marks)
    if (!following.count(node)) shown.record(node, mark);
  if (!opened) return shown;
  for (const NodeId& node : opened->followed(targets, Progress{}).completed) {
    const auto stored = marks.marks.find(node);
    if (stored != marks.marks.end() && stored->second.status == ProgressStatus::complete && stored->second.at.isSet()) {
      shown.record(node, ProgressMark{ProgressStatus::complete, stored->second.at, stored->second.markedAt});
      continue;
    }
    const StampedPointer& pointer = pointers.at(node);
    LatestMark at = opened->completedAt(pointer.tree);
    at.join(LatestMark{pointer.setAt, pointer.setAt.physicalMs});
    shown.record(node, ProgressMark{ProgressStatus::complete, at.at, at.markedAt});
  }
  return shown;
}

}
