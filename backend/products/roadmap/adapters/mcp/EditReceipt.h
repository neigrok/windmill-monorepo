#pragma once

#include "products/roadmap/domain/TreeDiagnostics.h"

#include <json/json.h>

namespace wm {

// `introducedDiagnostics` carries the errors the tree holds now and did not hold before this
// edit. Both keys are always written — an innocent edit answers `[]`. Only the three errors
// `clean()` counts are attributable; a smell is not.
void answerDiagnostics(const TreeDiagnostics& before, const TreeDiagnostics& after, Json::Value& receipt);

}
