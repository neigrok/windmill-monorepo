#pragma once

#include "domain/GraphState.h"
#include "domain/Ids.h"

#include <optional>
#include <string>

namespace wm {

// A stored tree: its full loose-graph CRDT state, title, and the seq of the last op
// folded into the snapshot.
struct StoredTree {
  GraphState state;
  std::string title;
  Seq head = 0;
};

struct TreeRepository {
  virtual ~TreeRepository() = default;
  virtual std::optional<StoredTree> load(const TreeId& tree) = 0;
  virtual void save(const TreeId& tree, const GraphState& state, const std::string& title, Seq head) = 0;
};

}
