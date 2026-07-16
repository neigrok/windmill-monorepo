#pragma once

#include "domain/Ids.h"
#include "domain/Tree.h"

#include <optional>
#include <string>
#include <vector>

namespace wm {

// A read-side filter over a tree's present nodes. Every set criterion must match (AND):
// `color` pins a hue; `kind` pins a hue too, resolved from the legend (an id absent from the
// legend selects nothing); `query` is a case-insensitive substring tested against a node's
// label and description. An all-empty filter selects every node.
struct NodeFilter {
  std::optional<NodeColor> color;
  std::optional<KindId> kind;
  std::string query;
};

// The nodes of `tree` the filter admits, in the tree's own node order. A pure projection —
// the same inputs always yield the same selection.
std::vector<NodeSpec> selectNodes(const TreeData& tree, const NodeFilter& filter);

}
