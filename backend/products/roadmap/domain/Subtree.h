#pragma once

#include "products/roadmap/domain/Ids.h"

#include <optional>
#include <string>
#include <vector>

namespace wm {

// The step that owns a subtree, in the subtree's parent tree.
struct OwningStep {
  TreeId tree;
  NodeId step;
  bool operator==(const OwningStep&) const = default;
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

// A change that only a root takes, aimed at a subtree: refused `not-a-root`, naming where the subtree hangs and its root.
struct NotARoot {
  OwningStep owningStep;
  TreeId root;
  bool operator==(const NotARoot&) const = default;
};

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
