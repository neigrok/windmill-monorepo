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
    MultiOpened& operator+=(const MultiOpened& other);
    bool operator==(const MultiOpened&) const = default;
  };
  // Each set of trees that lead to one another, by how many trees it holds.
  struct Loops {
    std::size_t one = 0;
    std::size_t two = 0;
    std::size_t threeToEight = 0;
    std::size_t moreThanEight = 0;
    void count(std::size_t trees);
    Loops& operator+=(const Loops& other);
    bool operator==(const Loops&) const = default;
  };
  // Each loop by how many present steps from outside it open one of its trees: none leaves the loop to become a root of
  // its own, one is a cut that needs no choice.
  struct Entries {
    std::size_t none = 0;
    std::size_t one = 0;
    std::size_t twoOrMore = 0;
    void count(std::size_t steps);
    Entries& operator+=(const Entries& other);
    bool operator==(const Entries&) const = default;
  };
  // Trees on a loop. `selfPointers` counts the steps that open the tree they stand in, and `alsoMultiOpened` the trees on
  // a loop that two or more steps open, their own steps and the loop's included.
  struct Cycles {
    std::size_t trees = 0;
    std::size_t selfPointers = 0;
    std::size_t alsoMultiOpened = 0;
    Loops loops;
    Entries byEntries;
    Cycles& operator+=(const Cycles& other);
    bool operator==(const Cycles&) const = default;
  };
  // Present steps whose pointer is not valid, by what it names.
  struct Dangling {
    std::size_t missing = 0;
    std::size_t deleted = 0;
    std::size_t foreign = 0;
    std::size_t notATreeId = 0;
    Dangling& operator+=(const Dangling& other);
    bool operator==(const Dangling&) const = default;
  };
  // Trees by how many pointers below a tree no pointer opens they sit, and the deepest of them.
  struct Depth {
    std::size_t deepest = 0;
    std::size_t one = 0;
    std::size_t two = 0;
    std::size_t three = 0;
    std::size_t moreThanThree = 0;
    // `trees` more trees sit `depth` pointers down, at least one.
    void count(std::size_t depth, std::size_t trees);
    Depth& operator+=(const Depth& other);
    bool operator==(const Depth&) const = default;
  };
  // Accounts with any pointer, and those with a tree that needs a choice: opened twice, on a loop or holding a step whose
  // pointer is not valid.
  struct Accounts {
    std::size_t withPointers = 0;
    std::size_t needingChoice = 0;
    Accounts& operator+=(const Accounts& other);
    bool operator==(const Accounts&) const = default;
  };

  // The standing trees, and the deleted trees a present step still names.
  std::size_t trees = 0;
  // Standing trees no valid pointer opens.
  std::size_t roots = 0;
  // Standing trees on no loop that exactly one step opens, in another tree: they convert with no choice.
  std::size_t owned = 0;
  // Owned trees no root reaches through owned trees alone: they hang under a tree opened twice or under a loop.
  std::size_t hanging = 0;
  MultiOpened multiOpened;
  Cycles cycles;
  Dangling dangling;
  // The owned trees a root reaches through owned trees alone, as they stand.
  Depth depth;
  // Every tree at the deepest any choice could nest it: the longest way down valid pointers, where a loop of n trees,
  // once a choice cuts it, can stack all n.
  Depth depthIfResolved;
  Accounts accounts;

  // Another account's inventory folded in: the counts add, and of each greatest the greater stays.
  SubtreeInventory& operator+=(const SubtreeInventory& other);
  bool operator==(const SubtreeInventory&) const = default;
};

// One account's inventory, judged by the rule `OpenedTrees` holds over the pointers alone, each standing tree read as a
// root: a pointer is valid when it names a standing tree of the same account.
SubtreeInventory inventory(const AccountTrees& account);

}
