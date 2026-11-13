#pragma once

#include "platform/adapters/postgres/PgAuthRepository.h"
#include "platform/adapters/postgres/PgPool.h"
#include "products/roadmap/domain/SubtreeInventory.h"
#include "products/roadmap/ports/TreeRepository.h"

#include <memory>
#include <pqxx/pqxx>

#include <functional>
#include <string>

namespace wm {

// Every roadmap row an account owns that no foreign key to users cascades from: its trees with all
// they hold, everyone's progress on them included, and its own progress and tending runs anywhere.
// Only an owner writes a tree, so no op of the account's lives in a tree it does not own. The trees'
// ids come back to `committed`, which the composition points at the live rooms.
AccountErasure roadmapAccountErasure();

// Stores a tree's lattice as per-entry rows (tree_nodes / tree_edges / tree_kinds), so a save
// upserts only the slice it is given. Each call borrows a connection from the shared pool for
// the length of its transaction.
class PgTreeRepository : public TreeRepository {
public:
  explicit PgTreeRepository(std::shared_ptr<PgPool> pool);

  // What guidedTreesAbove runs, over (owner, tree, levels, guides kept): named so its Postgres test can ask the plan
  // what it reads.
  static const char* guidedTreesAboveStatement();
  // The statement behind openedFrom, with the owner as $1 and the trees it starts from as $2, a JSON array of ids.
  static const char* openedFromStatement();
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
  std::optional<TreeAccess> loadAccess(const TreeId& tree) override;
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
  void fork(const TreeId& newTree, const TreeId& source, const GraphState& state,
            const LegendState& legend, const Lww<std::string>& title, const Lww<std::string>& guide,
            bool guideInherited, const UserId& owner) override;

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
