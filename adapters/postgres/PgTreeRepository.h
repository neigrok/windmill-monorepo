#pragma once

#include "ports/TreeRepository.h"

#include <pqxx/pqxx>

#include <string>

namespace wm {

// Stores a tree's lattice as per-entry rows (tree_nodes / tree_edges / tree_kinds), so a
// save upserts only the slice it is given — never the whole tree through MVCC. Legacy
// document-blob trees are backfilled into rows on first load. A connection is opened per
// call — simple and correct for Phase 0; a pool is the obvious later optimization.
class PgTreeRepository : public TreeRepository {
public:
  explicit PgTreeRepository(std::string connString);

  std::optional<StoredTree> load(const TreeId& tree) override;
  std::optional<TreeAccess> loadAccess(const TreeId& tree) override;
  ForkLineage loadForkLineage(const TreeId& tree) override;
  void save(const TreeId& tree, const GraphState& state, const LegendState& legend,
            const Lww<std::string>& title, Seq head) override;
  void create(const TreeId& tree, const GraphState& state, const LegendState& legend,
              const std::string& title, const UserId& owner) override;
  std::vector<OwnedTree> listOwnedBy(const UserId& owner) override;
  std::vector<ListedTree> listPublic() override;
  void softDelete(const TreeId& tree) override;
  void rename(const TreeId& tree, const Lww<std::string>& title) override;
  void claim(const TreeId& tree, const UserId& owner) override;
  void setVisibility(const TreeId& tree, Visibility visibility) override;
  void fork(const TreeId& newTree, const TreeId& source, const GraphState& state,
            const LegendState& legend, const std::string& title, const UserId& owner) override;

private:
  // The read-model projection both list queries need: each present node's id and colour — one
  // narrow indexed read, never the whole lattice — with the legacy document blob as the fallback
  // for a tree whose rows were never backfilled. It lives here rather than twice inline because
  // that fallback is the subtle half: a copy of it that fell behind would silently project those
  // trees as empty, which reads as "a tree with no steps" rather than as a bug.
  TreeData projectDocument(pqxx::work& txn, const TreeId& tree, const std::string& title,
                           const std::string& documentBlob);

  std::string connString_;
};

}
