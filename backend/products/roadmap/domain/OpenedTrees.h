#pragma once

#include "products/roadmap/domain/Ids.h"
#include "products/roadmap/domain/Tree.h"

#include <cstddef>
#include <cstdint>
#include <map>
#include <optional>
#include <set>
#include <string>
#include <vector>

namespace wm {

// The latest of the reader's marks that say complete among some nodes, by stamp, with the instant it was recorded;
// unset where none of them is. A mark stored without a stamp (a row written before marks were stamped) is never it.
struct LatestMark {
  Hlc at;
  std::uint64_t markedAt = 0;

  // Keeps the later of this and `other`.
  void join(const LatestMark& other) {
    if (other.at > at) *this = other;
  }
  bool operator==(const LatestMark&) const = default;
};

// The nodes of one tree that open one target, how many of them the reader marked and the latest of those marks.
struct Pointers {
  int nodes = 0;
  int marked = 0;
  LatestMark latest;
  bool operator==(const Pointers&) const = default;
};

// One tree as completeness reads it; `marked` counts the reader's marks on nodes that hold no pointer, and `latest`
// is the latest of them.
struct OpenedTree {
  std::string title;
  int total = 0;
  int marked = 0;
  LatestMark latest;
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

// What a step that owns a subtree says of it to anyone who may read the tree (SPEC.md, Model, Subtrees): the subtree,
// and what it comes to for the owner once the owner's trees are followed, none until then.
struct OwnedSubtree {
  TreeId id;
  std::optional<Opening> opening;
  bool operator==(const OwnedSubtree&) const = default;
};

// The most one answer of pointer diagnostics lists: the nodes on a loop of trees, the trees along one way back and
// the pointers that dangle. What is past a cap is counted, never built.
constexpr std::size_t kMaxTreeLoops = 50;
constexpr std::size_t kMaxLoopPath = 8;
constexpr std::size_t kMaxDanglingPointers = 50;

// The steps of one of an owner's trees that open another of theirs: `steps` of them, in `tree`.
struct OpeningSteps {
  TreeId tree;
  int steps = 0;
  bool operator==(const OpeningSteps&) const = default;
};

// What became of the steps of the owner's other trees that opened a removed tree, per tree, each in id order. `removed`:
// the steps, deleted and saved. `unsaved`: deleted in the tree's room and sent to its open pages, and the save failed —
// gone now, kept gone by the save the registry retries, back without the owner's mark should the server restart first.
// `incomplete`: nothing deleted, the steps kept, each pointing at a tree that no longer stands.
struct Cascade {
  std::map<TreeId, std::vector<NodeId>> removed;
  std::vector<TreeId> unsaved;
  std::vector<TreeId> incomplete;
  bool operator==(const Cascade&) const = default;
};

// One tree on the way from the tree a node opens back to the node's own tree.
struct TreeOnLoop {
  TreeId tree;
  std::string title;
  bool operator==(const TreeOnLoop&) const = default;
};

// A node whose pointer leads back to its own tree, which is why that tree never completes. `path` is a shortest way
// back: the tree the node opens first, the smaller tree id taken wherever two are as short, and the node's own tree
// last. A way of more than kMaxLoopPath trees is cut to its first kMaxLoopPath, and `pathOmitted` counts the trees
// left off, the node's own tree the last of them.
struct TreeLoop {
  NodeId node;
  std::vector<TreeOnLoop> path;
  std::size_t pathOmitted = 0;
  bool operator==(const TreeLoop&) const = default;
};

// A node whose pointer is not valid, with the pointer as it is stored: such a node is an ordinary node.
struct DanglingPointer {
  NodeId node;
  TreeId tree;
  bool operator==(const DanglingPointer&) const = default;
};

// How one tree's pointers depart from the rule in SPEC.md (Model, `OpenedTrees`), each list in node id order and cut
// at its cap, with the entries past the cap counted beside it.
struct PointerDiagnostics {
  std::vector<TreeLoop> treeLoops;
  std::size_t treeLoopsOmitted = 0;
  std::vector<DanglingPointer> danglingPointers;
  std::size_t danglingPointersOmitted = 0;
  bool operator==(const PointerDiagnostics&) const = default;
};

// How the standing trees that lead to one tree get back to it. `pointers` is the fewest a tree takes, the tree itself
// at none, and `next` the tree it steps to first, the smaller id where two are as near. `walked` counts the pointers
// read to find them: each pointer between two standing trees at most once.
struct WaysBack {
  struct Way {
    int pointers = 0;
    TreeId next;
  };
  std::map<TreeId, Way> ways;
  std::size_t walked = 0;
};

// The tree each node of `tree` opens, by node; a node that opens none is left out.
std::map<NodeId, TreeId> pointersOf(const TreeData& tree);
std::set<TreeId> treesOpenedBy(const TreeData& tree);
// The same of a tree's pointers, held by node.
std::set<TreeId> treesOpenedBy(const std::map<NodeId, TreeId>& pointers);
// The pointers of `after` that `before` does not hold: the nodes an edit made open a tree, or another tree.
std::map<NodeId, TreeId> pointersSetSince(const std::map<NodeId, TreeId>& before, const std::map<NodeId, TreeId>& after);

// The code a mark on a node that holds a valid pointer is refused under; a client branches on it and it never changes.
inline constexpr char kOpensATree[] = "opens-a-tree";

// One owner's standing trees under the owner's marks, judged once by the rule in SPEC.md (Model, `OpenedTrees`).
class OpenedTrees {
public:
  // A pointer is valid when it names one of `standing`.
  explicit OpenedTrees(std::map<TreeId, OpenedTree> standing);

  // The nodes among `pointers` whose pointer is valid: each follows its tree and takes no mark of its own.
  std::set<NodeId> following(const std::map<NodeId, TreeId>& pointers) const;
  // `marks` on a tree, with each node that holds a valid pointer following its tree; only `completed` is filled.
  Progress followed(const std::map<NodeId, TreeId>& pointers, const Progress& marks) const;
  Progress followed(const TreeData& tree, const Progress& marks) const;
  // What a pointer at `tree` comes to.
  Opening opening(const TreeId& tree) const;
  // One entry per node of `tree` that holds a pointer.
  std::map<NodeId, Opening> openings(const TreeData& tree) const;
  // The latest mark in what completed `tree`: of the reader's marks on its nodes that follow no tree and, for each
  // tree its nodes follow, of what completed that one. Unset for a tree that is not complete.
  LatestMark completedAt(const TreeId& tree) const;
  // The standing trees whose pointers lead to `tree`, itself among them when it stands.
  std::set<TreeId> leadingBackTo(const TreeId& tree) const;
  // The other standing trees whose nodes open `tree`, in id order, each with how many of its nodes do. The tree's own
  // pointers at itself go with it and are not among them.
  std::vector<OpeningSteps> openersOf(const TreeId& tree) const;
  // The way back to `tree` from every standing tree that leads to it; none when `tree` does not stand.
  WaysBack waysBackTo(const TreeId& tree) const;
  // The loops among the standing trees: each set of trees every one of which leads to every other, a tree that opens
  // itself alone a set of one. A tree on no loop is in none of them.
  std::vector<std::set<TreeId>> loops() const;
  // What is wrong with `pointers`, the tree each node of `tree` opens: the loops of trees through `tree` and the
  // pointers that are not valid. A loop among other trees that does not lead back to `tree` is theirs. It reads the
  // ways back once and steps along each listed path, so its work follows the account and the caps, not their product.
  PointerDiagnostics diagnose(const TreeId& tree, const std::map<NodeId, TreeId>& pointers) const;
  // The pointers the completeness pass walked: at most one per tree and target.
  std::size_t walked() const { return walked_; }

private:
  std::map<TreeId, OpenedTree> standing_;
  std::map<TreeId, std::vector<TreeId>> openers_;
  std::map<TreeId, int> pending_;
  std::map<TreeId, LatestMark> complete_;
  std::size_t walked_ = 0;
};

// What each step of `subtrees`, the subtree each step owns, says of it, off `opened`, the owner's trees: each with no
// opening when they were not followed, and a step whose subtree no longer stands among them left out.
std::map<NodeId, OwnedSubtree> ownedSubtrees(const std::map<NodeId, TreeId>& subtrees,
                                             const std::optional<OpenedTrees>& opened);

// An owner's stored `marks` on a tree as a caller who cannot write it is shown them: the owner's derived completion,
// and nothing of the trees its nodes open. A node whose pointer is valid has a row only while its tree is complete
// for the owner: complete, as its stored mark when that says so under a stamp, else at the later of the tree's
// `completedAt` and the stamp its pointer was set under, so its time never predates the pointer. Every other row is
// the stored one. Without `opened` — the trees were not read — no node that holds a pointer has a row.
Progress readerView(const Progress& marks, const std::map<NodeId, StampedPointer>& pointers,
                    const std::optional<OpenedTrees>& opened);

}
