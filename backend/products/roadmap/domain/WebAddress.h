#pragma once

#include "products/roadmap/domain/Ids.h"

#include <string>

namespace wm {

// Who opens an address: the tree's owner, in the app, or anyone else who may read it, on its share page.
enum class Opener { owner, reader };

// A tree on the web as its opener sees it. `origin` is the app's public origin; a '/' it ends with is dropped.
struct WebTree {
  std::string origin;
  TreeId tree;
  Opener opener;
};

// The forms packages/api-contract/roadmap-addresses.json holds. A tree id is always t_ plus 16 hex (wellFormedTreeId),
// so it is written as it is; a step id is encoded as the web's encodeURIComponent does, which its router decodes.
std::string treeAddress(const WebTree& web);
std::string stepAddress(const WebTree& web, const NodeId& step);

}
