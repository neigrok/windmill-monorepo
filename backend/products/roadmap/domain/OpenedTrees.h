#pragma once

#include "products/roadmap/domain/Ids.h"
#include "products/roadmap/domain/Tree.h"

#include <cstddef>
#include <map>
#include <set>
#include <string>
#include <vector>

namespace wm {

// The nodes of one tree that open one target, and how many of them the reader marked.
struct Pointers {
  int nodes = 0;
  int marked = 0;
  bool operator==(const Pointers&) const = default;
};

// One tree as completeness reads it; `marked` counts the reader's marks on nodes that hold no pointer.
struct OpenedTree {
  std::string title;
  int total = 0;
  int marked = 0;
  std::map<TreeId, Pointers> pointers;

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
  bool operator==(const Opening&) const = default;
};

// One tree on the way from the tree a node opens back to the node's own tree.
struct TreeOnLoop {
  TreeId tree;
  std::string title;
  bool operator==(const TreeOnLoop&) const = default;
};

// A node whose pointer leads back to its own tree, which is why that tree never completes. `path` is a shortest way
// back: the tree the node opens first, the node's own tree last, the smaller tree id taken wherever two are as short.
struct TreeLoop {
  NodeId node;
  std::vector<TreeOnLoop> path;
  bool operator==(const TreeLoop&) const = default;
};

// A node whose pointer is not valid, with the pointer as it is stored: such a node is an ordinary node.
struct DanglingPointer {
  NodeId node;
  TreeId tree;
  bool operator==(const DanglingPointer&) const = default;
};

// How one tree's pointers depart from the rule in SPEC.md (Model, `OpenedTrees`), each list in node id order.
struct PointerDiagnostics {
  std::vector<TreeLoop> treeLoops;
  std::vector<DanglingPointer> danglingPointers;
  bool operator==(const PointerDiagnostics&) const = default;
};

std::set<TreeId> treesOpenedBy(const TreeData& tree);

// One owner's standing trees under the owner's marks, judged once by the rule in SPEC.md (Model, `OpenedTrees`).
class OpenedTrees {
public:
  // A pointer is valid when it names one of `standing`.
  explicit OpenedTrees(std::map<TreeId, OpenedTree> standing);

  // `marks` on `tree`, with each node that holds a valid pointer following its tree; only `completed` is filled.
  Progress followed(const TreeData& tree, const Progress& marks) const;
  // One entry per node of `tree` that holds a pointer.
  std::map<NodeId, Opening> openings(const TreeData& tree) const;
  // The standing trees whose pointers lead to `tree`, itself among them when it stands.
  std::set<TreeId> leadingBackTo(const TreeId& tree) const;
  // The loops of trees through `tree` and the pointers of `tree` that are not valid. A loop among other trees that
  // does not lead back to `tree` is theirs.
  PointerDiagnostics diagnose(const TreeData& tree) const;
  // The pointers the completeness pass walked: at most one per tree and target.
  std::size_t walked() const { return walked_; }

private:
  std::map<TreeId, OpenedTree> standing_;
  std::map<TreeId, std::vector<TreeId>> openers_;
  std::map<TreeId, int> pending_;
  std::set<TreeId> complete_;
  std::size_t walked_ = 0;
};

}
