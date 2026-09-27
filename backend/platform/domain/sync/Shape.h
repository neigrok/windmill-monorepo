#pragma once

#include "platform/domain/Ids.h"
#include "platform/domain/sync/Registry.h"
#include "platform/domain/sync/Scope.h"
#include "platform/domain/sync/Wire.h"

#include <json/json.h>

#include <cstddef>
#include <string_view>

namespace wm::sync {

// A text's length in a registry unit: Unicode code points, or UTF-8 bytes.
std::size_t lengthIn(Unit unit, std::string_view text);

// §2.4's structured domains, nested bounds included.
bool admits(const Domain& domain, const Json::Value& value);

// A type's id: its singleton id, its tuple of ref ids, the id of the type its key names, or its pattern.
bool isIdOf(const Registry& registry, const TypeDef& type, const Json::Value& id);

// A register's value for its field: kind, ref, domain, bounds in the field's unit, and quantum.
bool admitsValue(const Registry& registry, const FieldDef& field, const Json::Value& value);

// A command argument: an epoch ms for `time` and `instant`, an id for `ref<t>`, else its domain.
bool admitsArgument(const Registry& registry, const ArgDef& arg, const Json::Value& value);

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
// against the registry (§4.1 and §4.4's writer rules included), then the skew bound. A time value past the
// bound comes back clamped to serverNow. A string holding U+0000 is invalid. Throws Refusal: invalid, then
// clock-skew.
Shaped shapeIntent(const Registry& registry, const Json::Value& wire, const Sender& sender, Ms serverNow, Ms maxSkewMs);

}
