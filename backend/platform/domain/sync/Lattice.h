#pragma once

#include "platform/domain/sync/Record.h"
#include "platform/domain/sync/Registry.h"

#include <cstdint>
#include <map>
#include <optional>
#include <string>

namespace wm::sync {

// §3.2. Each join answers the maximum of a total order in which the absent register (nullopt) is the
// bottom, so every join is idempotent, commutative and associative (§3.3). Values tie-break by the
// UTF-8 bytes of their JCS.

// The greater stamp, then the greater value.
std::optional<Reg> joinLww(const std::optional<Reg>& a, const std::optional<Reg>& b);

// The higher rank, then as lww: a value never falls back to a lower rank, whatever the stamps.
std::optional<Reg> joinRanked(const std::optional<Reg>& a, const std::optional<Reg>& b,
                              const std::map<std::string, std::int64_t>& rank);

// The smaller stamp, then the smaller value. `const` and `time` fields join so too.
std::optional<Reg> joinFww(const std::optional<Reg>& a, const std::optional<Reg>& b);

// The greater stamp, then alive.
std::optional<Life> joinLife(const std::optional<Life>& a, const std::optional<Life>& b);

// The smaller stamp.
std::optional<Stamp> joinBorn(const std::optional<Stamp>& a, const std::optional<Stamp>& b);

// joinRecord: life and born, and each register by its field's kind in `type`. A register of a field
// `type` does not know is kept from the one side that holds it; two of them cannot be joined.
LatticeRecord joinRecord(const TypeDef& type, const LatticeRecord& a, const LatticeRecord& b);

}
