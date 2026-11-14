#include "products/roadmap/domain/SubtreeInventory.h"

#include "products/roadmap/domain/OpenedTrees.h"

#include <algorithm>
#include <utility>
#include <vector>

namespace wm {

SubtreeInventory::MultiOpened& SubtreeInventory::MultiOpened::operator+=(const MultiOpened& other) {
  trees += other.trees;
  sameTree += other.sameTree;
  acrossTrees += other.acrossTrees;
  maxOpeners = std::max(maxOpeners, other.maxOpeners);
  return *this;
}

void SubtreeInventory::Loops::count(std::size_t trees) {
  std::size_t& ofItsLength = trees == 1 ? one : trees == 2 ? two : trees <= 8 ? threeToEight : moreThanEight;
  ++ofItsLength;
}

SubtreeInventory::Loops& SubtreeInventory::Loops::operator+=(const Loops& other) {
  one += other.one;
  two += other.two;
  threeToEight += other.threeToEight;
  moreThanEight += other.moreThanEight;
  return *this;
}

void SubtreeInventory::Entries::count(std::size_t steps) {
  std::size_t& ofItsEntries = steps == 0 ? none : steps == 1 ? one : twoOrMore;
  ++ofItsEntries;
}

SubtreeInventory::Entries& SubtreeInventory::Entries::operator+=(const Entries& other) {
  none += other.none;
  one += other.one;
  twoOrMore += other.twoOrMore;
  return *this;
}

SubtreeInventory::Cycles& SubtreeInventory::Cycles::operator+=(const Cycles& other) {
  trees += other.trees;
  selfPointers += other.selfPointers;
  alsoMultiOpened += other.alsoMultiOpened;
  loops += other.loops;
  byEntries += other.byEntries;
  return *this;
}

SubtreeInventory::Dangling& SubtreeInventory::Dangling::operator+=(const Dangling& other) {
  missing += other.missing;
  deleted += other.deleted;
  foreign += other.foreign;
  notATreeId += other.notATreeId;
  return *this;
}

void SubtreeInventory::Depth::count(std::size_t depth, std::size_t trees) {
  deepest = std::max(deepest, depth);
  std::size_t& atThisDepth = depth == 1 ? one : depth == 2 ? two : depth == 3 ? three : moreThanThree;
  atThisDepth += trees;
}

SubtreeInventory::Depth& SubtreeInventory::Depth::operator+=(const Depth& other) {
  deepest = std::max(deepest, other.deepest);
  one += other.one;
  two += other.two;
  three += other.three;
  moreThanThree += other.moreThanThree;
  return *this;
}

SubtreeInventory::Accounts& SubtreeInventory::Accounts::operator+=(const Accounts& other) {
  withPointers += other.withPointers;
  needingChoice += other.needingChoice;
  return *this;
}

SubtreeInventory& SubtreeInventory::operator+=(const SubtreeInventory& other) {
  trees += other.trees;
  roots += other.roots;
  owned += other.owned;
  hanging += other.hanging;
  multiOpened += other.multiOpened;
  cycles += other.cycles;
  dangling += other.dangling;
  depth += other.depth;
  depthIfResolved += other.depthIfResolved;
  accounts += other.accounts;
  return *this;
}

SubtreeInventory inventory(const AccountTrees& account) {
  // The account's trees as OpenedTrees reads them, for their pointers alone: no title, no node count, no marks and no
  // place, so each is read as a root.
  std::map<TreeId, OpenedTree> standing;
  for (const auto& [tree, pointers] : account.standing) {
    OpenedTree& read = standing[tree];
    for (const auto& [target, steps] : pointers) read.pointers[target].nodes = steps;
  }
  const OpenedTrees opened(std::move(standing));

  // Each tree's group: the loop it is on, or the tree alone. The loops come first, so a group below `loops` is a loop.
  std::vector<std::set<TreeId>> groups = opened.loops();
  const std::size_t loops = groups.size();
  std::map<TreeId, std::size_t> groupOf;
  for (std::size_t group = 0; group < loops; ++group)
    for (const TreeId& tree : groups[group]) groupOf.emplace(tree, group);
  for (const auto& [tree, pointers] : account.standing)
    if (groupOf.emplace(tree, groups.size()).second) groups.push_back({tree});

  SubtreeInventory counted;
  std::set<TreeId> deletedNamed;
  std::vector<TreeId> roots;
  std::map<TreeId, std::vector<TreeId>> ownedBelow;
  std::vector<std::size_t> entries(loops, 0);
  std::vector<std::set<std::size_t>> groupsBelow(groups.size());
  std::vector<std::size_t> groupsAbove(groups.size(), 0);
  bool holdsPointer = false;
  for (const auto& [tree, pointers] : account.standing) {
    for (const auto& [target, steps] : pointers) {
      holdsPointer = true;
      if (account.standing.count(target)) continue;
      if (account.foreign.count(target)) {
        counted.dangling.foreign += steps;
      } else if (account.deleted.count(target)) {
        counted.dangling.deleted += steps;
        deletedNamed.insert(target);
      } else if (wellFormedTreeId(target.str())) {
        counted.dangling.missing += steps;
      } else {
        counted.dangling.notATreeId += steps;
      }
    }
    const std::size_t group = groupOf.at(tree);
    const auto self = pointers.find(tree);
    const int selfPointers = self == pointers.end() ? 0 : self->second;
    counted.cycles.selfPointers += selfPointers;
    const std::vector<OpeningSteps> openers = opened.openersOf(tree);
    int openingSteps = selfPointers;
    for (const OpeningSteps& opener : openers) {
      openingSteps += opener.steps;
      const std::size_t above = groupOf.at(opener.tree);
      if (above == group) continue;
      if (group < loops) entries[group] += opener.steps;
      if (groupsBelow[above].insert(group).second) ++groupsAbove[group];
    }
    // A step opening the tree it stands in puts that tree on a loop, so every tree past this test opens none of itself.
    if (group < loops) {
      ++counted.cycles.trees;
      if (openingSteps > 1) ++counted.cycles.alsoMultiOpened;
      continue;
    }
    if (openingSteps == 0) {
      ++counted.roots;
      roots.push_back(tree);
      continue;
    }
    if (openingSteps == 1) {
      ++counted.owned;
      ownedBelow[openers.front().tree].push_back(tree);
      continue;
    }
    ++counted.multiOpened.trees;
    if (std::any_of(openers.begin(), openers.end(), [](const OpeningSteps& opener) { return opener.steps > 1; }))
      ++counted.multiOpened.sameTree;
    if (openers.size() > 1) ++counted.multiOpened.acrossTrees;
    counted.multiOpened.maxOpeners = std::max(
        counted.multiOpened.maxOpeners, std::min(static_cast<std::size_t>(openingSteps), kMaxOpenersCounted));
  }
  for (std::size_t loop = 0; loop < loops; ++loop) {
    counted.cycles.loops.count(groups[loop].size());
    counted.cycles.byEntries.count(entries[loop]);
  }

  // Down from the roots through owned trees alone. An owned tree has one opener and is on no loop, so the walk is a
  // forest and reaches each tree once; an owned tree under a tree opened twice, or under a loop, is never reached.
  std::size_t reached = 0;
  std::vector<TreeId> level = std::move(roots);
  for (std::size_t depth = 1;; ++depth) {
    std::vector<TreeId> below;
    for (const TreeId& tree : level) {
      const auto owned = ownedBelow.find(tree);
      if (owned != ownedBelow.end()) below.insert(below.end(), owned->second.begin(), owned->second.end());
    }
    if (below.empty()) break;
    counted.depth.count(depth, below.size());
    reached += below.size();
    level = std::move(below);
  }
  counted.hanging = counted.owned - reached;

  // Down the groups, each placed once every group above it is: the groups lead to one another in no loop, so each is.
  // Whatever a choice keeps, a way down enters a loop once and passes each of its trees at most once, so a group of n
  // trees starts one below the deepest of the groups above it and can stack n deep from there.
  std::vector<std::size_t> top(groups.size(), 0);
  std::vector<std::size_t> placed;
  for (std::size_t group = 0; group < groups.size(); ++group)
    if (groupsAbove[group] == 0) placed.push_back(group);
  while (!placed.empty()) {
    const std::size_t group = placed.back();
    placed.pop_back();
    const std::size_t deepest = top[group] + groups[group].size() - 1;
    if (deepest > 0) counted.depthIfResolved.count(deepest, groups[group].size());
    for (const std::size_t below : groupsBelow[group]) {
      top[below] = std::max(top[below], deepest + 1);
      if (--groupsAbove[below] == 0) placed.push_back(below);
    }
  }

  counted.trees = account.standing.size() + deletedNamed.size();
  const SubtreeInventory::Dangling& dangling = counted.dangling;
  const bool danglingAny = dangling.missing + dangling.deleted + dangling.foreign + dangling.notATreeId > 0;
  counted.accounts.withPointers = holdsPointer ? 1 : 0;
  counted.accounts.needingChoice = counted.multiOpened.trees + counted.cycles.trees > 0 || danglingAny ? 1 : 0;
  return counted;
}

}
