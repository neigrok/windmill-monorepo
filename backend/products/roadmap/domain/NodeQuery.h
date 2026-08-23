#pragma once

#include "products/roadmap/domain/Ids.h"
#include "products/roadmap/domain/Tree.h"

#include <optional>
#include <string>
#include <vector>

namespace wm {

// A read-side filter over a tree's present nodes; every set criterion must match (AND). `kind` is
// resolved from the legend — an id absent from the legend selects nothing. `query` is a
// case-insensitive substring over a node's id, label and description. An all-empty filter selects all.
struct NodeFilter {
  std::optional<NodeColor> color;
  std::optional<KindId> kind;
  std::string query;
};

// The nodes of `tree` the filter admits, BEST FIRST: an exact id, then an id prefix, then a label
// hit, then an id substring, then a description-only hit; ties keep the tree's own node order.
// Without a query the tree's order stands. A pure projection.
std::vector<NodeSpec> selectNodes(const TreeData& tree, const NodeFilter& filter);

}
