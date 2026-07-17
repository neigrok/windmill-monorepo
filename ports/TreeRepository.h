#pragma once

#include "domain/Access.h"
#include "domain/Crdt.h"
#include "domain/GraphState.h"
#include "domain/Ids.h"
#include "domain/Legend.h"
#include "domain/Tree.h"

#include <cstdint>
#include <exception>
#include <optional>
#include <string>
#include <vector>

namespace wm {

// The id-collision refusal create() and fork() raise: a row already holds the id — possibly
// soft-deleted (a delete hides a tree from load, but its row keeps the id). The unique index
// arbitrates cross-process races; callers reload to classify what they hit.
struct DuplicateTree : std::exception {
  const char* what() const noexcept override { return "a tree with that id already exists"; }
};

// A stored tree: its full loose-graph CRDT state, its legend CRDT state, the title register
// (an unset stamp means the create-time baseline, never renamed), the seq of the last op
// folded into the snapshot, and its authorization facts — the owner (empty until claimed)
// and visibility. Private by default (fail-closed): a tree is owner-only until it is shared.
struct StoredTree {
  GraphState state;
  LegendState legend;
  Lww<std::string> title;
  Seq head = 0;
  std::optional<UserId> owner;
  Visibility visibility = Visibility::private_;
  bool operator==(const StoredTree&) const = default;
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
  // the title register and head. A sparse slice is the norm (just the entries dirtied since
  // the last save); entries absent from the slice are left untouched, and a save never
  // deletes a row — the lattice is entry-grow-only (a delete is a tombstone stamp on its
  // entry). The title is the one guarded field: it lands only under a stamp dominating the
  // stored one — LWW at the column — so a second process's stale room cache (the standalone
  // MCP binary, a dev run sharing the DB) can never revert a newer rename.
  virtual void save(const TreeId& tree, const GraphState& state, const LegendState& legend,
                    const Lww<std::string>& title, Seq head) = 0;
  // Insert a brand-new tree owned by `owner` — a fresh id, its starting document (graph +
  // legend) and title. Throws DuplicateTree on an id collision (never overwrites a tree).
  virtual void create(const TreeId& tree, const GraphState& state, const LegendState& legend,
                      const std::string& title, const UserId& owner) = 0;
  // The trees a user owns, newest-touched excluded from ordering here (the domain orders).
  // Soft-deleted trees are never returned.
  virtual std::vector<OwnedTree> listOwnedBy(const UserId& owner) = 0;
  // Retire a tree by stamping deleted_at; every read filters it out afterwards.
  virtual void softDelete(const TreeId& tree) = 0;
  // Write the title register (and touch updated_at). The closed-room seam only — a live
  // room's title reaches the column through save(); RoomRegistry::rename picks the seam.
  // Guarded like save: the write lands only under a dominating stamp, so the caller mints
  // one past the register it just loaded.
  virtual void rename(const TreeId& tree, const Lww<std::string>& title) = 0;
  // Assign an owner, but only to a tree that has none — the first authenticated writer
  // claims it; a claim never overrides an existing owner.
  virtual void claim(const TreeId& tree, const UserId& owner) = 0;
  // Set a tree's read visibility (the share seam). Guarded like claim — a soft-deleted tree
  // is left alone; the owner check is the caller's (TreeRegistry), not this write's.
  virtual void setVisibility(const TreeId& tree, Visibility visibility) = 0;
  // Create `newTree` as a verbatim copy of `source`'s document (nodes, edges and legend
  // kinds), recording provenance and its owner. The copy starts a fresh op log at head 0.
  // Throws DuplicateTree on an id collision, exactly as create does.
  virtual void fork(const TreeId& newTree, const TreeId& source, const GraphState& state,
                    const LegendState& legend, const std::string& title, const UserId& owner) = 0;
};

}
