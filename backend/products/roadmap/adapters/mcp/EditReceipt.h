#pragma once

#include "products/roadmap/domain/OpenedTrees.h"
#include "products/roadmap/domain/TreeDiagnostics.h"

#include <json/json.h>

#include <vector>

namespace wm {

// `introducedDiagnostics` carries the errors the tree holds now and did not hold before this
// edit, then the loops of trees in `closed`: the ones the edit closed, which only an edit that changed
// the tree a node opens and had those pointers followed passes. The list names five in all, the
// graph's errors first, and counts the rest. A loop's sentence names the trees on its way back as
// far as the domain lists them and counts the rest. Both keys are always written — an innocent
// edit answers `[]`. The three errors `clean()` counts and a loop of trees are attributable; a smell
// is not. `diagnosticsClean` is the graph's alone: a loop of trees leaves it as it was.
void answerDiagnostics(const TreeDiagnostics& before, const TreeDiagnostics& after, Json::Value& receipt,
                       const PointerDiagnostics& closed = {});

// `keptEdges` lists edges as {from, to}, the first 50 then one "and N more" string; `keptEdgeCount`
// is the whole number. Both keys are always written — an empty list answers `[]` and `0`.
void answerKeptEdges(const std::vector<Edge>& kept, Json::Value& receipt);

}
