#pragma once

#include "products/roadmap/domain/GraphState.h"
#include "products/roadmap/domain/Ids.h"

#include <map>
#include <optional>
#include <set>
#include <string>
#include <vector>

namespace wm {

// The step that owns a subtree, in the subtree's parent tree. A tree's path is the owning steps from its root down to
// it, root first: none for a root, one per level for a subtree, so its last entry is the step it hangs from. A subtree
// stands while its root stands and every owning step on its path is present (SPEC.md, Model, Subtrees).
struct OwningStep {
  TreeId tree;
  NodeId step;
  auto operator<=>(const OwningStep&) const = default;
};

// How deep a subtree may sit: a root is at 0, a subtree of it at 1.
constexpr int kMaxTreeDepth = 8;

// One tree on the way down from a root to a subtree under it: the tree, its step the way passes through, and its name.
struct PathStep {
  TreeId tree;
  NodeId step;
  std::string title;
  bool operator==(const PathStep&) const = default;
};

// A tree among trees as a read answers it (SPEC.md, Model, Subtrees). `title` is its name, set under `titleAt`: a root's
// own title, a subtree's owning step's label, read through, since a subtree has no name of its own. `path` is the way
// down from its root, root first, the tree itself left out. A root answers no parent, an empty path and depth 0.
struct Place {
  std::string title;
  Hlc titleAt;
  TreeId root;
  std::optional<OwningStep> parent;
  std::vector<PathStep> path;
  int depth = 0;
  bool operator==(const Place&) const = default;
};

// A subtree where it sits (SPEC.md, Model, Subtrees): its root, its owning step and its depth, written once when it is
// created and never changed, and `seq`, the head of its own stream.
struct Subtree {
  TreeId id;
  TreeId root;
  OwningStep parent;
  int depth = 0;
  Seq seq = 0;
  bool operator==(const Subtree&) const = default;
};

// What creating a subtree answers: whether this call made it, the subtree the step owns, and `parentSeq`, a seq of the
// parent's stream that already holds the subtree — the seq its `subtree` event took when this call made it, the
// parent's head when the step already owned it.
struct SubtreeCreation {
  bool created = false;
  Subtree subtree;
  Seq parentSeq = 0;
  bool operator==(const SubtreeCreation&) const = default;
};

// A change that only a root takes — a visibility change, a removal, a fork, a create at its id — aimed at a subtree:
// refused `not-a-root`, naming where the subtree hangs and its root.
struct NotARoot {
  OwningStep owningStep;
  TreeId root;
  bool operator==(const NotARoot&) const = default;
};
inline constexpr char kNotARoot[] = "not-a-root";

// What a tree's branch holds: the standing subtrees under it, and the present steps of the tree and of those subtrees.
struct BranchSize {
  int subtrees = 0;
  int steps = 0;
  bool operator==(const BranchSize&) const = default;
};

// An owning step a write would remove without naming its subtree among the write's `branches`, so a client that never
// saw the subtree cannot hide it: refused `branch-unconfirmed`, whatever the subtree holds.
struct UnconfirmedBranch {
  NodeId step;
  TreeId subtree;
  bool operator==(const UnconfirmedBranch&) const = default;
};
inline constexpr char kBranchUnconfirmed[] = "branch-unconfirmed";

// Of the present steps a write removes, each that owns a subtree (`owned`, by step) the write's `branches` do not name,
// in step order.
inline std::vector<UnconfirmedBranch> unconfirmedBranches(const std::vector<NodeId>& removed,
                                                          const std::map<NodeId, TreeId>& owned,
                                                          const std::set<TreeId>& branches) {
  std::map<NodeId, TreeId> unconfirmed;
  for (const NodeId& step : removed)
    if (const auto subtree = owned.find(step); subtree != owned.end() && !branches.count(subtree->second))
      unconfirmed.emplace(step, subtree->second);
  std::vector<UnconfirmedBranch> named;
  for (const auto& [step, subtree] : unconfirmed) named.push_back(UnconfirmedBranch{step, subtree});
  return named;
}

// The legacy pointer (SPEC.md, Model, Legacy pointers). A step that owns a subtree opens it whatever its pointer holds, and
// its pointer takes no write. A pointer write a caller sent such a step is refused `owns-a-subtree`, the rest of the
// write applied, unless it is an echo of the step's own subtree. A new pointer at a subtree, which leads nowhere, is
// refused `opens-a-subtree` at the door that judges pointer targets (MCP).
inline constexpr char kOwnsASubtree[] = "owns-a-subtree";
inline constexpr char kOpensASubtree[] = "opens-a-subtree";

// Of the pointers a write sent, by step, those on a step that owns a subtree (`owned`, by step, present or deleted)
// naming another tree than that subtree, an empty one included, in step order.
inline std::vector<NodeId> refusedPointers(const std::map<NodeId, TreeId>& sent, const std::map<NodeId, TreeId>& owned) {
  std::vector<NodeId> refused;
  for (const auto& [step, tree] : sent)
    if (const auto subtree = owned.find(step); subtree != owned.end() && subtree->second != tree) refused.push_back(step);
  return refused;
}

// `graph` with no pointer written on a step of `owned`, an echo of its subtree included; an entry left with nothing to
// write goes.
inline void withoutOwnedPointers(GraphState& graph, const std::map<NodeId, TreeId>& owned) {
  for (NodeStateEntry& node : graph.nodes) {
    if (!owned.count(node.id)) continue;
    node.opens = TreeId{};
    node.opensAt = Hlc{};
  }
  std::erase_if(graph.nodes, [](const NodeStateEntry& node) { return node == NodeStateEntry{.id = node.id}; });
}

// Why a subtree was not created. Each is expected: a line, never an Issue. savePending: the parent's room holds a
// write its store has not taken, and the create would move the stored head past it; it lifts when that save lands.
enum class SubtreeRefusal { noSuchTree, notWriter, stepGone, depthLimit, stepOpensATree, savePending };

inline const char* codeOf(SubtreeRefusal refusal) {
  switch (refusal) {
    case SubtreeRefusal::noSuchTree: return "no-such-tree";
    case SubtreeRefusal::notWriter: return "not-writer";
    case SubtreeRefusal::stepGone: return "step-gone";
    case SubtreeRefusal::depthLimit: return "depth-limit";
    case SubtreeRefusal::stepOpensATree: return "step-opens-a-tree";
    case SubtreeRefusal::savePending: return "save-pending";
  }
  return "no-such-tree";
}

}
