#pragma once

#include "ports/TreeRepository.h"

#include <string>

namespace wm {

// Stores each tree as a single jsonb document row. A connection is opened per call —
// simple and correct for Phase 0; a pool is the obvious later optimization.
class PgTreeRepository : public TreeRepository {
public:
  explicit PgTreeRepository(std::string connString);

  std::optional<StoredTree> load(const TreeId& tree) override;
  void save(const TreeId& tree, const GraphState& state, const LegendState& legend,
            const std::string& title, Seq head) override;
  std::vector<OwnedTree> listOwnedBy(const UserId& owner) override;
  void softDelete(const TreeId& tree) override;
  void claim(const TreeId& tree, const UserId& owner) override;
  void fork(const TreeId& newTree, const TreeId& source, const GraphState& state,
            const LegendState& legend, const std::string& title, const UserId& owner) override;

private:
  std::string connString_;
};

}
