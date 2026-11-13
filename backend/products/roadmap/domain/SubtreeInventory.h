#pragma once

#include "products/roadmap/domain/Ids.h"

#include <cstddef>
#include <map>
#include <set>

namespace wm {

// One account's trees as the inventory reads them: each standing tree with how many of its present steps open each tree
// id. Of the ids those steps name that are not among `standing`, `deleted` holds the account's own soft-deleted trees and
// `foreign` the trees of another account or of nobody, standing or deleted; an id in neither names no tree.
struct AccountTrees {
  std::map<TreeId, std::map<TreeId, int>> standing;
  std::set<TreeId> deleted;
  std::set<TreeId> foreign;
  bool operator==(const AccountTrees&) const = default;
};

// The most opening steps `maxOpeners` tells apart: a tree opened by more reads this many.
constexpr std::size_t kMaxOpenersCounted = 100;

// How the pointers between an account's trees meet one owned subtree per step (SPEC.md, Subtree inventory), in counts
// alone: never an id or a title. Every standing tree is counted in exactly one of `roots`, `owned`, `multiOpened` and
// `cycles`, and a tree on a loop under `cycles` whatever else is true of it.
struct SubtreeInventory {
  // Trees opened by two or more steps. `sameTree` counts those with two or more of their opening steps in one tree,
  // `acrossTrees` those whose opening steps stand in two or more trees; a tree may be both.
  struct MultiOpened {
    std::size_t trees = 0;
    std::size_t sameTree = 0;
    std::size_t acrossTrees = 0;
    std::size_t maxOpeners = 0;
    bool operator==(const MultiOpened&) const = default;
  };
  // Each set of trees that lead to one another, by how many trees it holds.
  struct Loops {
    std::size_t one = 0;
    std::size_t two = 0;
    std::size_t threeToEight = 0;
    std::size_t moreThanEight = 0;
    bool operator==(const Loops&) const = default;
  };
  // Trees on a loop; `selfPointers` counts the steps that open the tree they stand in.
  struct Cycles {
    std::size_t trees = 0;
    std::size_t selfPointers = 0;
    Loops loops;
    bool operator==(const Cycles&) const = default;
  };
  // Present steps whose pointer is not valid, by what it names.
  struct Dangling {
    std::size_t missing = 0;
    std::size_t deleted = 0;
    std::size_t foreign = 0;
    std::size_t notATreeId = 0;
    bool operator==(const Dangling&) const = default;
  };
  // The trees a root reaches through owned trees alone, by how many pointers down they sit, and the deepest of them.
  struct Depth {
    std::size_t deepest = 0;
    std::size_t one = 0;
    std::size_t two = 0;
    std::size_t three = 0;
    std::size_t moreThanThree = 0;
    bool operator==(const Depth&) const = default;
  };
  // Accounts with any pointer, and those with a tree that needs a choice: opened twice, on a loop or holding a step whose
  // pointer is not valid.
  struct Accounts {
    std::size_t withPointers = 0;
    std::size_t needingChoice = 0;
    bool operator==(const Accounts&) const = default;
  };

  // The standing trees, and the deleted trees a present step still names.
  std::size_t trees = 0;
  // Standing trees no valid pointer opens.
  std::size_t roots = 0;
  // Standing trees on no loop that exactly one step opens, in another tree: they convert with no choice.
  std::size_t owned = 0;
  MultiOpened multiOpened;
  Cycles cycles;
  Dangling dangling;
  Depth depth;
  Accounts accounts;

  // Another account's inventory folded in: the counts add, and of each greatest the greater stays.
  SubtreeInventory& operator+=(const SubtreeInventory& other);
  bool operator==(const SubtreeInventory&) const = default;
};

// One account's inventory, judged by the rule `OpenedTrees` holds: a pointer is valid when it names a standing tree of
// the same account.
SubtreeInventory inventory(const AccountTrees& account);

}
