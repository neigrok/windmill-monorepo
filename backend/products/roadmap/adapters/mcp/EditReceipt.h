#pragma once

#include "products/roadmap/domain/TreeDiagnostics.h"

#include <json/json.h>

namespace wm {

// What an edit answers about the tree it landed in. `diagnosticsClean` is a property of the
// WHOLE tree, so `introducedDiagnostics` carries what THIS edit broke: the errors the tree holds
// now and did not hold a moment before. Both keys are always written — an innocent edit answers
// `[]`. Only the three errors `clean()` counts are attributable; a smell is not.
void answerDiagnostics(const TreeDiagnostics& before, const TreeDiagnostics& after, Json::Value& receipt);

}
