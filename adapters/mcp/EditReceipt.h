#pragma once

#include "domain/TreeDiagnostics.h"

#include <json/json.h>

namespace wm {

// What an edit answers about the tree it landed in.
//
// `diagnosticsClean` is a property of the WHOLE tree, so a `false` may be dirt that was already
// there — which left every caller reading it as feedback on its own write to call get_diagnostics
// to find out whose dirt it was, the exact round trip the flag exists to save. So the receipt
// carries the answer beside it: `introducedDiagnostics` is what this edit BROKE — the errors the
// tree holds now and did not hold a moment before, each named endpoint by endpoint, in the same
// voice a refusal is written in.
//
// Both keys, always. An innocent edit answers `[]`, and an omitted list would leave a caller
// unable to tell "my edit broke nothing" from "this server does not answer that".
//
// Only the three errors `clean()` counts are attributable: a smell (an empty icon, a long label)
// is an opinion about the tree, and an edit that leaves one is not thereby a broken edit.
void answerDiagnostics(const TreeDiagnostics& before, const TreeDiagnostics& after, Json::Value& receipt);

}
