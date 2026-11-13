#pragma once

#include "products/roadmap/domain/Ids.h"

namespace wm {

// The step that owns a subtree, in the subtree's parent tree.
struct OwningStep {
  TreeId tree;
  NodeId step;
  bool operator==(const OwningStep&) const = default;
};

// How deep a subtree may sit: a root is at 0, a subtree of it at 1.
constexpr int kMaxTreeDepth = 8;

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

// Why a subtree was not created. Each is expected: a line, never an Issue.
enum class SubtreeRefusal { noSuchTree, notWriter, stepGone, depthLimit, stepOpensATree };

inline const char* codeOf(SubtreeRefusal refusal) {
  switch (refusal) {
    case SubtreeRefusal::noSuchTree: return "no-such-tree";
    case SubtreeRefusal::notWriter: return "not-writer";
    case SubtreeRefusal::stepGone: return "step-gone";
    case SubtreeRefusal::depthLimit: return "depth-limit";
    case SubtreeRefusal::stepOpensATree: return "step-opens-a-tree";
  }
  return "no-such-tree";
}

}
