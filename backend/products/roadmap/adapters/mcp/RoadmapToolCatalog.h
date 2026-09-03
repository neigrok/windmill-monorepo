#pragma once

#include "platform/ports/ToolHost.h"

#include <json/json.h>

#include <cstddef>
#include <vector>

namespace wm {

// The three published vocabularies, shared by the schemas that advertise them and the checks
// that refuse against them. `kStatuses` is the mark a caller WRITES; `kNodeStates` is what the
// tree DERIVES from those marks.
inline const std::vector<const char*> kHues = {"terracotta", "olive", "gold", "brick", "sky", "plum"};
inline const std::vector<const char*> kStatuses = {"active", "complete", "none"};
inline const std::vector<const char*> kNodeStates = {"locked", "available", "active", "complete"};

// How import_subgraph meets a re-sent node's existing prerequisites, and how many ids one call may
// tombstone — published as `enum` and `maxItems` on the tool.
inline const std::vector<const char*> kPrerequisiteModes = {"merge", "replace"};
constexpr std::size_t kMaxTombstones = 500;

// Every tool, its description, the JSON Schema its arguments are pre-validated against, and the
// grant level that reaches it. Byte-pinned by the wire corpus test.
std::vector<ToolDeclaration> roadmapToolCatalog();

}
