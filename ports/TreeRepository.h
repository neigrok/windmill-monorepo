#pragma once

#include "domain/GraphState.h"
#include "domain/Ids.h"
#include "domain/Legend.h"
#include "domain/Tree.h"

#include <cstdint>
#include <optional>
#include <string>
#include <vector>

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

// One row of a caller's registry: the projected present document and when the tree last
// changed structurally (epoch ms). The caller's progress is joined in a separate read.
struct OwnedTree {
  TreeData data;
  std::uint64_t updatedAt = 0;
};

struct TreeRepository {
  virtual ~TreeRepository() = default;
  virtual std::optional<StoredTree> load(const TreeId& tree) = 0;
  virtual void save(const TreeId& tree, const GraphState& state, const LegendState& legend,
                    const std::string& title, Seq head) = 0;
  // The trees a user owns, newest-touched excluded from ordering here (the domain orders).
  // Soft-deleted trees are never returned.
  virtual std::vector<OwnedTree> listOwnedBy(const UserId& owner) = 0;
  // Retire a tree by stamping deleted_at; every read filters it out afterwards.
  virtual void softDelete(const TreeId& tree) = 0;
  // Assign an owner, but only to a tree that has none — the first authenticated writer
  // claims it; a claim never overrides an existing owner.
  virtual void claim(const TreeId& tree, const UserId& owner) = 0;
  // Create `newTree` as a verbatim copy of `source`'s document (nodes, edges and legend
  // kinds), recording provenance and its owner. The copy starts a fresh op log at head 0.
  virtual void fork(const TreeId& newTree, const TreeId& source, const GraphState& state,
                    const LegendState& legend, const std::string& title, const UserId& owner) = 0;
};

}
