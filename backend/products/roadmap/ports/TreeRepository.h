#pragma once

#include "platform/domain/Access.h"
#include "platform/domain/Crdt.h"
#include "products/roadmap/domain/GraphState.h"
#include "products/roadmap/domain/Ids.h"
#include "products/roadmap/domain/Legend.h"
#include "products/roadmap/domain/Tree.h"

#include <cstdint>
#include <exception>
#include <optional>
#include <set>
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
// folded into the snapshot, its authorization facts — the owner (set at insert; empty only on
// a legacy row, which is then nobody's to write) and visibility — and when it was planted.
// Private by default (fail-closed): a tree is owner-only until it is shared.
struct StoredTree {
  GraphState state;
  LegendState legend;
  Lww<std::string> title;
  Seq head = 0;
  std::optional<UserId> owner;
  Visibility visibility = Visibility::private_;
  std::uint64_t createdAt = 0;  // epoch ms; the planting time, fixed for the tree's whole life
  bool operator==(const StoredTree&) const = default;
};

// One row of a caller's registry: the projected present document, when the tree was planted,
// and when it last changed structurally (both epoch ms). The caller's progress is joined in a
// separate read.
struct OwnedTree {
  TreeData data;
  std::uint64_t createdAt = 0;
  std::uint64_t updatedAt = 0;
};

// One row of the public wall: the same projected document and structural timestamp, plus the
// facts a gallery card needs that a registry row doesn't — when the OWNER last marked a step (the
// other half of "last active": the structural stamp never moves for a progress mark, so a wall
// ranked on it alone cannot tell a tended tree from an abandoned one), how many trees were forked
// from it, whose journey it shows (a shared tree shows its OWNER's progress, so the wall joins the
// owner's overlay, not the reader's), and the title of the tree this one was forked from, under
// the same rule ForkLineage carries: named only while that source exists and is public. The mark
// and the lineage ride this query rather than a per-card lookup, which would be a second round
// trip per row.
struct ListedTree {
  TreeData data;
  std::uint64_t updatedAt = 0;
  std::uint64_t lastMarkedAt = 0;  // epoch ms of the owner's latest mark on this tree, 0 if none
  int forks = 0;
  UserId owner;
  std::string sourceTitle;
};

// Only the two facts an access decision needs. `load` drags every node, edge and kind row off
// disk to rebuild the CRDT state; a caller that just asks "may this reader see it?" — the unfurl
// card, most notably, which anyone may request — must not pay for the whole lattice to answer it.
struct TreeAccess {
  std::optional<UserId> owner;
  Visibility visibility = Visibility::private_;
};

// Fork provenance for the unfurl (fork-attribution): whether this tree is itself a fork, its
// SOURCE's title — named only when the source still exists and is PUBLIC, so an unlisted or
// private source is never revealed to a stranger who happens on the unfurl — and how many trees
// were forked FROM this one. The loop the shared tree came from, and the loop it invites.
struct ForkLineage {
  bool isFork = false;
  std::string sourceTitle;  // empty unless the source exists and is public
  int forkCount = 0;
};

struct TreeRepository {
  virtual ~TreeRepository() = default;
  virtual std::optional<StoredTree> load(const TreeId& tree) = 0;
  virtual std::optional<TreeAccess> loadAccess(const TreeId& tree) = 0;
  // Fork provenance for the unfurl — two small counts/lookups, never the whole lattice.
  virtual ForkLineage loadForkLineage(const TreeId& tree) = 0;
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
  // Every tree its owner listed publicly, for the gallery wall. Visibility is this query's own
  // filter — private and unlisted trees are never candidates — so the wall cannot leak a tree
  // whose owner didn't ask to be listed. Unowned and soft-deleted trees are never returned.
  virtual std::vector<ListedTree> listPublic() = 0;
  // The trees this user has forked FROM — the sources, not the copies, and only while the copy
  // still stands. One read for a whole wall: a gallery marks every entry the reader has already
  // taken, and asking per card would be a query per row.
  virtual std::set<TreeId> listForkedSources(const UserId& owner) = 0;
  // Retire a tree by stamping deleted_at; every read filters it out afterwards.
  virtual void softDelete(const TreeId& tree) = 0;
  // Write the title register (and touch updated_at). The closed-room seam only — a live
  // room's title reaches the column through save(); RoomRegistry::rename picks the seam.
  // Guarded like save: the write lands only under a dominating stamp, so the caller mints
  // one past the register it just loaded.
  virtual void rename(const TreeId& tree, const Lww<std::string>& title) = 0;
  // Set a tree's read visibility (the share seam). A soft-deleted tree is left alone; the
  // owner check is the caller's (TreeRegistry), not this write's.
  virtual void setVisibility(const TreeId& tree, Visibility visibility) = 0;
  // Create `newTree` as a verbatim copy of `source`'s document (nodes, edges and legend
  // kinds), recording provenance and its owner. The copy starts a fresh op log at head 0.
  // Throws DuplicateTree on an id collision, exactly as create does.
  virtual void fork(const TreeId& newTree, const TreeId& source, const GraphState& state,
                    const LegendState& legend, const std::string& title, const UserId& owner) = 0;
};

}
