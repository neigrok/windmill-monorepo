#pragma once

#include "platform/adapters/postgres/PgAuthRepository.h"
#include "platform/adapters/postgres/PgPool.h"
#include "products/roadmap/domain/SubtreeInventory.h"
#include "products/roadmap/ports/TreeRepository.h"

#include <memory>
#include <pqxx/pqxx>

#include <functional>
#include <string>
#include <string_view>

namespace wm {

// Every roadmap row an account owns that no foreign key to users cascades from: its trees with all
// they hold, everyone's progress on them included, and its own progress and tending runs anywhere.
// Only an owner writes a tree, so no op of the account's lives in a tree it does not own. The trees'
// ids come back to `committed`, which the composition points at the live rooms.
AccountErasure roadmapAccountErasure();

// The rules of a subtree (SPEC.md, Model, Subtrees) as every statement reads them, each for the row an alias names.
//
// A tree's name, for a `trees` row or a row carrying its title, parent_tree and parent_step: a root's own title, a
// subtree's owning step's label, read off that step's row through tree_nodes_pkey.
std::string treeNameColumn(std::string_view tree);
// That a `trees` row's branch stands: for a subtree alone, its root's row is not deleted and every owning step on its
// path is present, read in one walk up its parents. The row's own deleted_at is the statement's to test.
std::string branchStandsCondition(std::string_view tree);
// What a present `tree_nodes` row opens: the standing subtree its step owns, which ownedSubtreeJoin joins through
// trees_parent_step as `owned`, else the tree its pointer names.
std::string ownedSubtreeJoin(std::string_view step);
std::string stepOpensColumn(std::string_view step);

// Stores a tree's lattice as per-entry rows (tree_nodes / tree_edges / tree_kinds), so a save
// upserts only the slice it is given. Each call borrows a connection from the shared pool for
// the length of its transaction.
class PgTreeRepository : public TreeRepository {
public:
  explicit PgTreeRepository(std::shared_ptr<PgPool> pool);

  // What guidedTreesAbove runs, over (owner, tree, levels, guides kept): named so its Postgres test can ask the plan
  // what it reads.
  static std::string guidedTreesAboveStatement();
  // The statement behind loadAccess, with the tree as $1: a row per tree from the root down to it.
  static const char* accessStatement();
  // The statement behind openedFrom, with the owner as $1 and the trees it starts from as $2, a JSON array of ids.
  static std::string openedFromStatement();
  // The statement behind treesOpening, with the owner as $1 and the opened tree as $2.
  static const char* treesOpeningStatement();
  // The statement behind eachAccountsTrees: every account's standing trees, each with the trees its present steps open
  // and where each of those stands, account after account.
  static const char* accountsTreesStatement();

  // Every account's trees as the subtree inventory reads them (SPEC.md, Subtree inventory), handed to `visit` one account
  // at a time: one statement in a read-only transaction, fetched in pages, so no more than one account is held at once.
  // A tree of nobody's is no account's and is left out, and so is every step of a deleted tree.
  void eachAccountsTrees(const std::function<void(const UserId&, const AccountTrees&)>& visit);

  std::optional<StoredTree> load(const TreeId& tree) override;
  std::optional<StoredAccess> loadAccess(const TreeId& tree) override;
  std::set<OwningStep> absentStepsUnder(const TreeId& root) override;
  std::map<TreeId, BranchSize> branchSizes(const std::set<TreeId>& trees) override;
  std::optional<Place> placeOf(const TreeId& tree) override;
  std::optional<UserId> retiredOwner(const TreeId& tree) override;
  ForkLineage loadForkLineage(const TreeId& tree) override;
  bool save(const TreeId& tree, const GraphState& state, const LegendState& legend,
            const Lww<std::string>& title, const Lww<std::string>& guide, Seq head) override;
  void create(const TreeId& tree, const GraphState& state, const LegendState& legend,
              const std::string& title, const UserId& owner) override;
  std::vector<OwnedTree> listOwnedBy(const UserId& owner) override;
  std::vector<ListedTree> listPublic() override;
  std::set<TreeId> listForkedSources(const UserId& owner) override;
  std::map<TreeId, std::string> titlesOwnedBy(const UserId& owner, const std::set<TreeId>& trees) override;
  std::map<TreeId, OpenedTree> openedFrom(const UserId& owner, const std::set<TreeId>& opened,
                                          std::optional<std::chrono::milliseconds> budget = std::nullopt) override;
  std::map<TreeId, TreeAbove> guidedTreesAbove(const UserId& owner, const TreeId& tree) override;
  std::vector<TreeId> treesOpening(const UserId& owner, const TreeId& tree) override;
  void softDelete(const TreeId& tree) override;
  void rename(const TreeId& tree, const Lww<std::string>& title) override;
  void setVisibility(const TreeId& tree, Visibility visibility) override;
  void fork(const std::vector<TreeCopy>& copies, const UserId& owner) override;
  std::optional<SubtreeSite> subtreeSite(const TreeId& parent, const NodeId& step, const std::optional<TreeId>& opened,
                                         const std::optional<TreeId>& proposed) override;
  std::variant<Subtree, SubtreeConflict> createSubtree(const TreeId& child, const OwningStep& parent,
                                                       const LegendState& legend, Seq parentSeq) override;

private:
  // The projection both list queries need: each present node's id, colour and pointer, each pointer with the stamp it
  // was set under, and the document blob as the fallback for a tree whose rows were never backfilled.
  struct ProjectedDocument {
    TreeData data;
    std::map<NodeId, StampedPointer> pointers;
  };
  ProjectedDocument projectDocument(pqxx::work& txn, const TreeId& tree, const std::string& title,
                                    const std::string& documentBlob);

  std::shared_ptr<PgPool> pool_;
};

}
