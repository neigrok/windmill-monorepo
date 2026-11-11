#pragma once

#include "products/roadmap/domain/Ids.h"
#include "products/roadmap/domain/Tree.h"

#include <map>
#include <set>
#include <string>
#include <vector>

namespace wm {

// The pointers a tree may sit from the tree being read, by the shortest way, and still be judged.
inline constexpr int kOpenedTreeReach = 8;

// A node that holds a pointer, with the reader's mark on it.
struct Opener {
  NodeId node;
  TreeId opens;
  bool marked = false;
  bool operator==(const Opener&) const = default;
};

// One tree as completeness reads it; `marked` counts the reader's marks on nodes that hold no pointer.
struct OpenedTree {
  std::string title;
  int total = 0;
  int marked = 0;
  std::vector<Opener> openers;

  OpenedTree() = default;
  OpenedTree(const TreeData& tree, const Progress& marks);
  bool operator==(const OpenedTree&) const = default;
};

// What one node's pointer comes to; a `missing` one names a tree that is not valid and says nothing more.
struct Opening {
  TreeId tree;
  bool missing = false;
  std::string title;
  bool complete = false;
  int done = 0;
  int total = 0;
  bool loop = false;
  bool operator==(const Opening&) const = default;
};

std::set<TreeId> treesOpenedBy(const TreeData& tree);

// One tree's pointers followed for its owner, by the rule in SPEC.md (Model, `opens`).
struct OpenedTrees {
  // `standing` holds the owner's standing trees with the owner's marks: a pointer is valid when it names one.
  OpenedTrees(const TreeData& tree, const std::map<TreeId, OpenedTree>& standing);

  // One entry per node that holds a pointer.
  std::map<NodeId, Opening> openings;

  // `marks` with each node that opens a tree following that tree; only `completed` is filled.
  Progress followed(const Progress& marks) const;
};

}
