#pragma once

#include "domain/Ids.h"
#include "domain/Tree.h"

#include <optional>

namespace wm {

// A stored tree document plus the seq of the last op folded into it.
struct StoredTree {
  TreeData data;
  Seq head = 0;
};

// Loads and stores a tree's document. Phase 0 persists the projected TreeData; later
// phases store the full loose-graph CRDT state behind this same port.
struct TreeRepository {
  virtual ~TreeRepository() = default;
  virtual std::optional<StoredTree> load(const TreeId& tree) = 0;
  virtual void save(const TreeId& tree, const TreeData& data, Seq head) = 0;
};

}
