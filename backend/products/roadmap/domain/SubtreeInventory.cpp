#include "products/roadmap/domain/SubtreeInventory.h"

#include "products/roadmap/domain/OpenedTrees.h"

#include <algorithm>
#include <utility>
#include <vector>

namespace wm {

SubtreeInventory& SubtreeInventory::operator+=(const SubtreeInventory& other) {
  trees += other.trees;
  roots += other.roots;
  owned += other.owned;
  multiOpened.trees += other.multiOpened.trees;
  multiOpened.sameTree += other.multiOpened.sameTree;
  multiOpened.acrossTrees += other.multiOpened.acrossTrees;
  multiOpened.maxOpeners = std::max(multiOpened.maxOpeners, other.multiOpened.maxOpeners);
  cycles.trees += other.cycles.trees;
  cycles.selfPointers += other.cycles.selfPointers;
  cycles.loops.one += other.cycles.loops.one;
  cycles.loops.two += other.cycles.loops.two;
  cycles.loops.threeToEight += other.cycles.loops.threeToEight;
  cycles.loops.moreThanEight += other.cycles.loops.moreThanEight;
  dangling.missing += other.dangling.missing;
  dangling.deleted += other.dangling.deleted;
  dangling.foreign += other.dangling.foreign;
  dangling.notATreeId += other.dangling.notATreeId;
  depth.deepest = std::max(depth.deepest, other.depth.deepest);
  depth.one += other.depth.one;
  depth.two += other.depth.two;
  depth.three += other.depth.three;
  depth.moreThanThree += other.depth.moreThanThree;
  accounts.withPointers += other.accounts.withPointers;
  accounts.needingChoice += other.accounts.needingChoice;
  return *this;
}

SubtreeInventory inventory(const AccountTrees& account) {
  // The account's trees as OpenedTrees reads them, for their pointers alone: no title, no node count and no marks.
  std::map<TreeId, OpenedTree> standing;
  for (const auto& [tree, pointers] : account.standing) {
    OpenedTree& read = standing[tree];
    for (const auto& [target, steps] : pointers) read.pointers[target].nodes = steps;
  }
  const OpenedTrees opened(std::move(standing));

  SubtreeInventory counted;
  std::set<TreeId> onLoop;
  for (const std::set<TreeId>& loop : opened.loops()) {
    onLoop.insert(loop.begin(), loop.end());
    std::size_t& ofItsLength = loop.size() == 1   ? counted.cycles.loops.one
                               : loop.size() == 2 ? counted.cycles.loops.two
                               : loop.size() <= 8 ? counted.cycles.loops.threeToEight
                                                  : counted.cycles.loops.moreThanEight;
    ++ofItsLength;
  }

  std::set<TreeId> deletedNamed;
  std::vector<TreeId> roots;
  std::map<TreeId, std::vector<TreeId>> ownedBelow;
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
    // A step opening the tree it stands in puts that tree on a loop, so every tree past this test opens none of itself.
    const auto self = pointers.find(tree);
    const int selfPointers = self == pointers.end() ? 0 : self->second;
    counted.cycles.selfPointers += selfPointers;
    if (onLoop.count(tree)) {
      ++counted.cycles.trees;
      continue;
    }
    const std::vector<OpeningSteps> openers = opened.openersOf(tree);
    int openingSteps = 0;
    for (const OpeningSteps& opener : openers) openingSteps += opener.steps;
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

  // Down from the roots through owned trees alone. An owned tree has one opener and is on no loop, so the walk is a
  // forest and reaches each tree once; an owned tree under a tree opened twice, or under a loop, is never reached.
  std::vector<TreeId> level = std::move(roots);
  for (std::size_t depth = 1;; ++depth) {
    std::vector<TreeId> below;
    for (const TreeId& tree : level) {
      const auto owned = ownedBelow.find(tree);
      if (owned != ownedBelow.end()) below.insert(below.end(), owned->second.begin(), owned->second.end());
    }
    if (below.empty()) break;
    counted.depth.deepest = depth;
    std::size_t& atThisDepth = depth == 1   ? counted.depth.one
                               : depth == 2 ? counted.depth.two
                               : depth == 3 ? counted.depth.three
                                            : counted.depth.moreThanThree;
    atThisDepth += below.size();
    level = std::move(below);
  }

  counted.trees = account.standing.size() + deletedNamed.size();
  const SubtreeInventory::Dangling& dangling = counted.dangling;
  const bool danglingAny = dangling.missing + dangling.deleted + dangling.foreign + dangling.notATreeId > 0;
  counted.accounts.withPointers = holdsPointer ? 1 : 0;
  counted.accounts.needingChoice = counted.multiOpened.trees + counted.cycles.trees > 0 || danglingAny ? 1 : 0;
  return counted;
}

}
