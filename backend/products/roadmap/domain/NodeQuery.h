#pragma once

#include "products/roadmap/domain/Ids.h"
#include "products/roadmap/domain/Tree.h"

#include <optional>
#include <string>
#include <vector>

namespace wm {

// A read-side filter over a tree's present nodes. Every set criterion must match (AND):
// `color` pins a hue; `kind` pins a hue too, resolved from the legend (an id absent from the
// legend selects nothing); `query` is a case-insensitive substring tested against a node's
// id, label and description. An all-empty filter selects every node.
struct NodeFilter {
  std::optional<NodeColor> color;
  std::optional<KindId> kind;
  std::string query;
};

// The nodes of `tree` the filter admits, BEST FIRST: an exact id, then an id prefix, then a label
// hit, then an id substring, then a description-only hit; ties keep the tree's own node order.
// Without a query the tree's order stands. A pure projection, which is what makes a resume cursor safe.
std::vector<NodeSpec> selectNodes(const TreeData& tree, const NodeFilter& filter);

}
