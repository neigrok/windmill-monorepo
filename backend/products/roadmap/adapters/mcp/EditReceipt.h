#pragma once

#include "products/roadmap/domain/TreeDiagnostics.h"

#include <json/json.h>

#include <vector>

namespace wm {

// `introducedDiagnostics` carries the errors the tree holds now and did not hold before this
// edit. Both keys are always written — an innocent edit answers `[]`. Only the three errors
// `clean()` counts are attributable; a smell is not.
void answerDiagnostics(const TreeDiagnostics& before, const TreeDiagnostics& after, Json::Value& receipt);

// `keptEdges` lists edges as {from, to}, the first 50 then one "and N more" string; `keptEdgeCount`
// is the whole number. Both keys are always written — an empty list answers `[]` and `0`.
void answerKeptEdges(const std::vector<Edge>& kept, Json::Value& receipt);

}
