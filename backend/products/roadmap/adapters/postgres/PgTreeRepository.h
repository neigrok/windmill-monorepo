#pragma once

#include "platform/adapters/postgres/PgPool.h"
#include "products/roadmap/ports/TreeRepository.h"

#include <memory>
#include <pqxx/pqxx>

#include <string>

namespace wm {

// Stores a tree's lattice as per-entry rows (tree_nodes / tree_edges / tree_kinds), so a
// save upserts only the slice it is given — never the whole tree through MVCC. Legacy
// document-blob trees are backfilled into rows on first load. Each call borrows a connection
// from the shared pool for the length of its transaction (PgPool.h).
class PgTreeRepository : public TreeRepository {
public:
  explicit PgTreeRepository(std::shared_ptr<PgPool> pool);

  std::optional<StoredTree> load(const TreeId& tree) override;
  std::optional<TreeAccess> loadAccess(const TreeId& tree) override;
  std::optional<UserId> retiredOwner(const TreeId& tree) override;
  ForkLineage loadForkLineage(const TreeId& tree) override;
  void save(const TreeId& tree, const GraphState& state, const LegendState& legend,
            const Lww<std::string>& title, Seq head) override;
  void create(const TreeId& tree, const GraphState& state, const LegendState& legend,
              const std::string& title, const UserId& owner) override;
  std::vector<OwnedTree> listOwnedBy(const UserId& owner) override;
  std::vector<ListedTree> listPublic() override;
  std::set<TreeId> listForkedSources(const UserId& owner) override;
  void softDelete(const TreeId& tree) override;
  void rename(const TreeId& tree, const Lww<std::string>& title) override;
  void setVisibility(const TreeId& tree, Visibility visibility) override;
  void fork(const TreeId& newTree, const TreeId& source, const GraphState& state,
            const LegendState& legend, const std::string& title, const UserId& owner) override;

private:
  // The projection both list queries need: each present node's id and colour, one narrow indexed
  // read, with the legacy document blob as the fallback for a tree whose rows were never
  // backfilled.
  TreeData projectDocument(pqxx::work& txn, const TreeId& tree, const std::string& title,
                           const std::string& documentBlob);

  std::shared_ptr<PgPool> pool_;
};

}
