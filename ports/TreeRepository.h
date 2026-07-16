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
  // Upsert a slice of the tree's lattice: every entry given replaces its stored row (the
  // caller — the room — is the single authority, so its values are always current), plus
  // title and head. A sparse slice is the norm (just the entries dirtied since the last
  // save); entries absent from the slice are left untouched, and a save never deletes a
  // row — the lattice is entry-grow-only (a delete is a tombstone stamp on its entry).
  virtual void save(const TreeId& tree, const GraphState& state, const LegendState& legend,
                    const std::string& title, Seq head) = 0;
  // Insert a brand-new tree owned by `owner` — a fresh id, its starting document (graph +
  // legend) and title. Fails loudly on an id collision (never overwrites an existing tree).
  virtual void create(const TreeId& tree, const GraphState& state, const LegendState& legend,
                      const std::string& title, const UserId& owner) = 0;
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
