#pragma once

#include "platform/domain/Ids.h"

#include <string_view>

namespace wm {

struct TreeTag;
struct NodeTag;
struct KindTag;

using TreeId = Id<TreeTag>;
using NodeId = Id<NodeTag>;
using KindId = Id<KindTag>;

// The tree-id wire shape: "t_" plus 16 lowercase hex characters — exactly what the server
// mints. A client-supplied id (claim-create, fork) must match it byte for byte.
inline bool wellFormedTreeId(std::string_view id) {
  if (id.size() != 18 || id[0] != 't' || id[1] != '_') return false;
  for (const char c : id.substr(2)) {
    if ((c < '0' || c > '9') && (c < 'a' || c > 'f')) return false;
  }
  return true;
}

}
