#pragma once

#include "platform/ports/ToolHost.h"

#include <json/json.h>

#include <vector>

namespace wm {

// The three published vocabularies, shared by the schemas that advertise them and the checks
// that refuse against them. `kStatuses` is the mark a caller WRITES; `kNodeStates` is what the
// tree DERIVES from those marks.
inline const std::vector<const char*> kHues = {"terracotta", "olive", "gold", "brick", "sky", "plum"};
inline const std::vector<const char*> kStatuses = {"active", "complete", "none"};
inline const std::vector<const char*> kNodeStates = {"locked", "available", "active", "complete"};

// What this product advertises to an agent: every tool, its description, the JSON Schema its
// arguments are pre-validated against, and the grant level that reaches it. Byte-pinned by the
// wire corpus test.
std::vector<ToolDeclaration> roadmapToolCatalog();

}
