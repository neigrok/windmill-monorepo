#pragma once

#include "platform/domain/Ids.h"
#include "platform/domain/sync/Registry.h"
#include "platform/domain/sync/Scope.h"
#include "platform/domain/sync/Wire.h"

#include <json/json.h>

namespace wm::sync {

// Who sends the intent: a server origin may leave stamps null for step 9 to mint, and write server fields.
struct Sender {
  UserId account;
  bool server = false;
};

struct Shaped {
  ScopeKey scope;
  Intent intent;
};

// §6.1 steps 1 and 2 for one wire intent, whatever its origin: the scope its reference names, its shape
// against the registry (§4.1, §4.4's writer rules and §2.4's whole puts included), then the skew bound. A
// time value past the bound comes back clamped to serverNow. A string holding U+0000 is invalid. Throws
// Refusal: invalid, then clock-skew.
Shaped shapeIntent(const Registry& registry, const Json::Value& wire, const Sender& sender, Ms serverNow, Ms maxSkewMs);

}
