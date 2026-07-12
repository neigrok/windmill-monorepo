#pragma once

#include "domain/GraphState.h"
#include "domain/Ids.h"
#include "domain/Legend.h"

#include <optional>
#include <string>

namespace wm {

// A stored tree: its full loose-graph CRDT state, its legend CRDT state, title, the seq of
// the last op folded into the snapshot, and its authorization facts — the owner (empty
// until claimed) and visibility (public trees are world-readable).
struct StoredTree {
  GraphState state;
  LegendState legend;
  std::string title;
  Seq head = 0;
  std::optional<UserId> owner;
  std::string visibility = "public";
};

struct TreeRepository {
  virtual ~TreeRepository() = default;
  virtual std::optional<StoredTree> load(const TreeId& tree) = 0;
  virtual void save(const TreeId& tree, const GraphState& state, const LegendState& legend,
                    const std::string& title, Seq head) = 0;
  // Assign an owner, but only to a tree that has none — the first authenticated writer
  // claims it; a claim never overrides an existing owner.
  virtual void claim(const TreeId& tree, const UserId& owner) = 0;
  // Create `newTree` as a verbatim copy of `source`'s document (nodes, edges and legend
  // kinds), recording provenance and its owner. The copy starts a fresh op log at head 0.
  virtual void fork(const TreeId& newTree, const TreeId& source, const GraphState& state,
                    const LegendState& legend, const std::string& title, const UserId& owner) = 0;
};

}
