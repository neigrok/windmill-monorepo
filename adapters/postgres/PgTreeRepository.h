#pragma once

#include "ports/TreeRepository.h"

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
  void save(const TreeId& tree, const GraphState& state, const LegendState& legend,
            const Lww<std::string>& title, Seq head) override;
  void create(const TreeId& tree, const GraphState& state, const LegendState& legend,
              const std::string& title, const UserId& owner) override;
  std::vector<OwnedTree> listOwnedBy(const UserId& owner) override;
  void softDelete(const TreeId& tree) override;
  void rename(const TreeId& tree, const Lww<std::string>& title) override;
  void claim(const TreeId& tree, const UserId& owner) override;
  void setVisibility(const TreeId& tree, Visibility visibility) override;
  void fork(const TreeId& newTree, const TreeId& source, const GraphState& state,
            const LegendState& legend, const std::string& title, const UserId& owner) override;

private:
  std::string connString_;
};

}
