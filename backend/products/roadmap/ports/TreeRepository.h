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

// A soft-deleted row keeps its id, so it collides here too.
struct DuplicateTree : std::exception {
  const char* what() const noexcept override { return "a tree with that id already exists"; }
};

// An unset title stamp means the create-time baseline, never renamed; an empty owner means a
// legacy row nobody may write.
struct StoredTree {
  GraphState state;
  LegendState legend;
  Lww<std::string> title;
  Seq head = 0;
  std::optional<UserId> owner;
  Visibility visibility = Visibility::private_;
  std::uint64_t createdAt = 0;  // epoch ms
  bool operator==(const StoredTree&) const = default;
};

// Timestamps are epoch ms; the caller's progress is joined in a separate read.
struct OwnedTree {
  TreeData data;
  std::uint64_t createdAt = 0;
  std::uint64_t updatedAt = 0;
};

// `data` carries the OWNER's progress, not the reader's.
struct ListedTree {
  TreeData data;
  std::uint64_t updatedAt = 0;
  std::uint64_t lastMarkedAt = 0;  // epoch ms of the owner's latest mark on this tree, 0 if none
  int forks = 0;
  UserId owner;
  std::string sourceTitle;
};

// The two facts an access decision needs, without the whole-lattice cost of load().
struct TreeAccess {
  std::optional<UserId> owner;
  Visibility visibility = Visibility::private_;
};

struct ForkLineage {
  bool isFork = false;
  std::string sourceTitle;  // empty unless the source exists and is public
  int forkCount = 0;
};

struct TreeRepository {
  virtual ~TreeRepository() = default;
  virtual std::optional<StoredTree> load(const TreeId& tree) = 0;
  virtual std::optional<TreeAccess> loadAccess(const TreeId& tree) = 0;
  // Who owned a row that outlived its delete; a live row (or none) answers nullopt.
  virtual std::optional<UserId> retiredOwner(const TreeId& tree) = 0;
  virtual ForkLineage loadForkLineage(const TreeId& tree) = 0;
  // Upsert a slice: entries given replace their rows, absent ones are untouched, and a save never
  // deletes. The title lands only under a stamp dominating the stored one.
  virtual void save(const TreeId& tree, const GraphState& state, const LegendState& legend,
                    const Lww<std::string>& title, Seq head) = 0;
  // Insert a brand-new tree. Throws DuplicateTree on an id collision (never overwrites a tree).
  virtual void create(const TreeId& tree, const GraphState& state, const LegendState& legend,
                      const std::string& title, const UserId& owner) = 0;
  // Soft-deleted trees are never returned; ordering is the domain's.
  virtual std::vector<OwnedTree> listOwnedBy(const UserId& owner) = 0;
  // Public trees only, filtered by this query; unowned and soft-deleted are never returned.
  virtual std::vector<ListedTree> listPublic() = 0;
  // The sources this user forked FROM, only while the copy still stands.
  virtual std::set<TreeId> listForkedSources(const UserId& owner) = 0;
  // Retire a tree by stamping deleted_at; every read filters it out afterwards.
  virtual void softDelete(const TreeId& tree) = 0;
  // The closed-room seam only — a live room's title reaches the column through save(). Lands only
  // under a stamp dominating the stored one.
  virtual void rename(const TreeId& tree, const Lww<std::string>& title) = 0;
  // The owner check is the caller's, not this write's; a soft-deleted tree is left alone.
  virtual void setVisibility(const TreeId& tree, Visibility visibility) = 0;
  // Verbatim copy of `source`'s document; the copy starts a fresh op log at head 0. Throws
  // DuplicateTree on an id collision.
  virtual void fork(const TreeId& newTree, const TreeId& source, const GraphState& state,
                    const LegendState& legend, const std::string& title, const UserId& owner) = 0;
};

}
