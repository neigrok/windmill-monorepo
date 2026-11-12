#pragma once

#include "products/roadmap/domain/OpenedTrees.h"
#include "products/roadmap/domain/TreeDiagnostics.h"

#include <json/json.h>

#include <vector>

namespace wm {

// `introducedDiagnostics` carries the errors the tree holds now and did not hold before this
// edit, then the loops of trees its pointers close now and did not close before it, which only an
// edit that set a pointer and had them followed passes. Both keys are always written — an innocent
// edit answers `[]`. The three errors `clean()` counts and a loop of trees are attributable; a smell
// is not. `diagnosticsClean` is the graph's alone: a loop of trees leaves it as it was.
void answerDiagnostics(const TreeDiagnostics& before, const TreeDiagnostics& after, Json::Value& receipt,
                       const PointerDiagnostics& pointersBefore = {}, const PointerDiagnostics& pointersAfter = {});

// `keptEdges` lists edges as {from, to}, the first 50 then one "and N more" string; `keptEdgeCount`
// is the whole number. Both keys are always written — an empty list answers `[]` and `0`.
void answerKeptEdges(const std::vector<Edge>& kept, Json::Value& receipt);

}
