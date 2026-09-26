#pragma once

#include "platform/domain/Ids.h"

#include <optional>
#include <stdexcept>
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

// Roadmap stores and sends a register never written as "" (schema.sql's `*_hlc` defaults, an absent
// wire field) as well as "0:0:". Any other text must be a D-1 stamp.
inline Hlc roadmapStamp(std::string_view text) {
  if (text.empty()) return Hlc{};
  if (std::optional<Hlc> stamp = parseHlc(text)) return *stamp;
  throw std::invalid_argument("a roadmap stamp is ms:counter:actor");
}

}
