#pragma once

#include "products/roadmap/domain/Access.h"
#include "products/roadmap/domain/Crdt.h"
#include "products/roadmap/domain/GraphState.h"
#include "products/roadmap/domain/Guides.h"
#include "products/roadmap/domain/Ids.h"
#include "products/roadmap/domain/Legend.h"
#include "products/roadmap/domain/OpenedTrees.h"
#include "products/roadmap/domain/Subtree.h"
#include "products/roadmap/domain/Tree.h"

#include <chrono>
#include <cstdint>
#include <exception>
#include <map>
#include <optional>
#include <set>
#include <string>
#include <variant>
#include <vector>

namespace wm {

// A soft-deleted row keeps its id, so it collides here too.
struct DuplicateTree : std::exception {
  const char* what() const noexcept override { return "a tree with that id already exists"; }
};

// A read that was given a budget ran past it.
struct FollowTimedOut : std::exception {
  const char* what() const noexcept override { return "the trees a tree opens were not read within the budget"; }
};

// An unset title or guide stamp means the create-time baseline, never written since; an empty
// owner means a legacy row nobody may write. `guideInherited` marks a guide a fork copied from someone
// else's tree: its author's words, until a guide of the owner's lands over it. A subtree's `owner` and
// `visibility` are its root's, and `path` its owning steps from the root down, empty for a root. `subtrees` names the
// subtree each step owns, by step, whether or not the step is present.
struct StoredTree {
  GraphState state;
  LegendState legend;
  Lww<std::string> title;
  Seq head = 0;
  std::optional<UserId> owner;
  Visibility visibility = Visibility::private_;
  std::uint64_t createdAt = 0;  // epoch ms
  Lww<std::string> guide;
  bool guideInherited = false;
  TreeId root;
  std::vector<OwningStep> path;
  std::map<NodeId, TreeId> subtrees;
  bool operator==(const StoredTree&) const = default;
};

// Timestamps are epoch ms; the caller's progress is joined in a separate read. Each step of `data` opens the subtree it
// owns, whatever its pointer holds, and `parent` is set on a subtree alone.
struct OwnedTree {
  TreeData data;
  std::uint64_t createdAt = 0;
  std::uint64_t updatedAt = 0;
  std::optional<OwningStep> parent;
};

// `data` carries the OWNER's progress, not the reader's. A step that owns a subtree opens it, its pointer set under no
// stamp.
struct ListedTree {
  TreeData data;
  std::map<NodeId, StampedPointer> pointers;  // the tree each step opens, as `data` holds it, with when it was set
  std::uint64_t updatedAt = 0;
  int forks = 0;
  UserId owner;
  std::string sourceTitle;
};

// The two facts an access decision needs, without the whole-lattice cost of load(): the root's, for a tree of any depth,
// and the root they were read from, with the tree's path of owning steps, empty for a root.
struct TreeAccess {
  std::optional<UserId> owner;
  Visibility visibility = Visibility::private_;
  TreeId root;
  std::vector<OwningStep> path;
  // The step the tree hangs from, none for a root.
  std::optional<OwningStep> parent() const {
    if (path.empty()) return std::nullopt;
    return path.back();
  }
  bool operator==(const TreeAccess&) const = default;
};

// A tree's access as its stored rows hold it, and whether they say its branch stands: every owning step on its path
// present. Only a tree whose own row and root's row stand has one.
struct StoredAccess {
  TreeAccess access;
  bool stands = true;
  bool operator==(const StoredAccess&) const = default;
};

// One tree of a fork as it is copied: the copy's id, the tree it copies, the copied tree it hangs from with the same step
// (none for the root), and the state, legend, title and guide it is born with.
struct TreeCopy {
  TreeId id;
  TreeId source;
  std::optional<OwningStep> parent;
  GraphState state;
  LegendState legend;
  Lww<std::string> title;
  Lww<std::string> guide;
  bool guideInherited = false;
};

// What creating a subtree under one step of a standing tree reads off the stored rows: that tree's root, depth and head,
// the subtree the step already owns, standing or deleted, whether the tree the step's pointer names stands and is the
// same owner's, and whether a proposed id names any row, anyone's, standing or deleted.
struct SubtreeSite {
  TreeId root;
  int depth = 0;
  Seq head = 0;
  std::optional<Subtree> owned;
  bool opensATree = false;
  bool proposedTaken = false;
};

// Why storing a subtree stored nothing: its parent no longer stands or its account is gone, the step owns a subtree
// another writer stored meanwhile, or the id names a row.
enum class SubtreeConflict { parentGone, stepOwned, idTaken };

struct ForkLineage {
  bool isFork = false;
  std::string sourceTitle;  // empty unless the source exists and is public
  int forkCount = 0;
};

struct TreeRepository {
  virtual ~TreeRepository() = default;
  // The tree's content, whether or not its branch stands: who may read it is RoomRegistry::accessOf's to answer. A
  // subtree whose root's row is deleted answers nullopt, as a tree whose own row is does.
  virtual std::optional<StoredTree> load(const TreeId& tree) = 0;
  // The tree's access off the stored rows, with whether its branch stands there; nullopt when its own row or its root's
  // is deleted.
  virtual std::optional<StoredAccess> loadAccess(const TreeId& tree) = 0;
  // Every owning step under `root`, at any depth, whose step is not present in its tree's stored rows: what the live
  // access of the root's trees starts from.
  virtual std::set<OwningStep> absentStepsUnder(const TreeId& root) = 0;
  // Of each tree among `trees` whose row stands, its branch off the stored rows (BranchSize): the subtrees reached down
  // present owning steps, and the present steps of the tree and of each of them.
  virtual std::map<TreeId, BranchSize> branchSizes(const std::set<TreeId>& trees) = 0;
  // Where `tree` sits as a read answers it (Place), off the stored rows: one walk up its parents, each subtree named by
  // its owning step's label. nullopt when its branch does not stand.
  virtual std::optional<Place> placeOf(const TreeId& tree) = 0;
  // Who owned a row that outlived its delete; a live row (or none) answers nullopt.
  virtual std::optional<UserId> retiredOwner(const TreeId& tree) = 0;
  virtual ForkLineage loadForkLineage(const TreeId& tree) = 0;
  // Upsert a slice onto a tree whose row stands: entries given replace their rows, absent ones are
  // untouched, and a save never deletes. A tree with no row, or a soft-deleted one, is left as it is,
  // and answers false. The title and the guide each land only under a stamp dominating the stored one;
  // a guide that lands is the owner's own, so it clears `guideInherited`.
  virtual bool save(const TreeId& tree, const GraphState& state, const LegendState& legend,
                    const Lww<std::string>& title, const Lww<std::string>& guide, Seq head) = 0;
  // Insert a brand-new tree. Throws DuplicateTree on an id collision (never overwrites a tree).
  virtual void create(const TreeId& tree, const GraphState& state, const LegendState& legend,
                      const std::string& title, const UserId& owner) = 0;
  // Every standing tree of `owner`'s, subtrees included while their branch stands; ordering is the domain's.
  virtual std::vector<OwnedTree> listOwnedBy(const UserId& owner) = 0;
  // Public roots only, filtered by this query; unowned, soft-deleted and subtrees are never returned.
  virtual std::vector<ListedTree> listPublic() = 0;
  // The sources this user forked FROM, only while the copy still stands.
  virtual std::set<TreeId> listForkedSources(const UserId& owner) = 0;
  // The title of each tree among `trees` that stands and is `owner`'s, by id. A soft-deleted tree,
  // someone else's, nobody's and an id no row holds are left out alike.
  virtual std::map<TreeId, std::string> titlesOwnedBy(const UserId& owner, const std::set<TreeId>& trees) = 0;
  // Each of `opened` that stands and is `owner`'s, and every such tree their steps open, under `owner`'s marks: a step
  // opens the subtree it owns, else the tree its pointer names, and a subtree is named by its owning step's label. With
  // a `budget` the read is given that long and no longer: past it the read is abandoned, holding nothing, and throws
  // FollowTimedOut.
  virtual std::map<TreeId, OpenedTree> openedFrom(const UserId& owner, const std::set<TreeId>& opened,
                                                  std::optional<std::chrono::milliseconds> budget = std::nullopt) = 0;
  // The kMaxGuides nearest trees above `tree` that carry a guide (SPEC.md, Model, `guides`; nearestGuided cuts them):
  // above are `owner`'s standing trees that lead down to it within kMaxLevelsAbove, a subtree's parent directly above
  // it and a root under each tree whose present steps point at it, never `tree` itself. Nothing when `tree` does not
  // stand or is not `owner`'s.
  virtual std::map<TreeId, TreeAbove> guidedTreesAbove(const UserId& owner, const TreeId& tree) = 0;
  // `owner`'s standing trees other than `tree` that hold a present node whose pointer names `tree`, in id order, ids
  // compared as bytes; nothing when `tree` is not `owner`'s. Whether `tree` stands does not matter: a removal asks once
  // its tree is gone. The read is keyed on the owner's own trees, so it does not grow with the pointers other accounts
  // plant at `tree`.
  virtual std::vector<TreeId> treesOpening(const UserId& owner, const TreeId& tree) = 0;
  // Retire a root by stamping deleted_at; every read filters it, and every tree under it, out afterwards. A subtree's
  // row is never retired: it goes and comes back with its owning step.
  virtual void softDelete(const TreeId& tree) = 0;
  // The closed-room seam only — a live room's title reaches the column through save(). Lands only
  // under a stamp dominating the stored one.
  virtual void rename(const TreeId& tree, const Lww<std::string>& title) = 0;
  // The owner check is the caller's, not this write's. A root's alone: a subtree's is its root's and is never set, and a
  // soft-deleted root is left alone.
  virtual void setVisibility(const TreeId& tree, Visibility visibility) = 0;
  // A fork's copies, the root first and each subtree after the copy it hangs from, stored in one transaction that holds
  // `owner`'s account: each a fresh tree at head 0 under its title and guide as given, a subtree's place taken from its
  // copied parent. The root copy alone records the tree it was forked from. Throws DuplicateTree on an id collision,
  // storing nothing.
  virtual void fork(const std::vector<TreeCopy>& copies, const UserId& owner) = 0;
  // Where a subtree under `step` of `parent` would sit (SubtreeSite), `opened` the tree the step's pointer names and
  // `proposed` the id the caller asks for. nullopt when `parent` does not stand.
  virtual std::optional<SubtreeSite> subtreeSite(const TreeId& parent, const NodeId& step,
                                                 const std::optional<TreeId>& opened,
                                                 const std::optional<TreeId>& proposed) = 0;
  // `child` stored as the subtree `parent` owns, holding `legend`, and the parent tree's head moved to `parentSeq`, in one
  // transaction that holds the owner's account against its erasure. The child takes its root, depth and owner from the
  // parent's row, with an empty title, at seq 0. A conflict writes nothing.
  virtual std::variant<Subtree, SubtreeConflict> createSubtree(const TreeId& child, const OwningStep& parent,
                                                               const LegendState& legend, Seq parentSeq) = 0;
};

}
