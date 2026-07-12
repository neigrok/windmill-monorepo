#pragma once

#include "domain/GraphState.h"
#include "domain/Ids.h"
#include "domain/Legend.h"

#include <optional>
#include <string>

namespace wm {

// A stored tree: its full loose-graph CRDT state, its legend CRDT state, title, and the
// seq of the last op folded into the snapshot.
struct StoredTree {
  GraphState state;
  LegendState legend;
  std::string title;
  Seq head = 0;
};

struct TreeRepository {
  virtual ~TreeRepository() = default;
  virtual std::optional<StoredTree> load(const TreeId& tree) = 0;
  virtual void save(const TreeId& tree, const GraphState& state, const LegendState& legend,
                    const std::string& title, Seq head) = 0;
  // Create `newTree` as a verbatim copy of `source`'s document (nodes, edges and legend
  // kinds), recording provenance. The copy starts a fresh op log at head 0.
  virtual void fork(const TreeId& newTree, const TreeId& source, const GraphState& state,
                    const LegendState& legend, const std::string& title) = 0;
};

}
