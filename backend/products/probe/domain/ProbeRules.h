#pragma once

#include "platform/domain/sync/Admit.h"
#include "platform/domain/sync/Record.h"

#include <vector>

// The probe's product rules (packages/api-contract/sync/corpus/README.md, "The probe product"), pure: what
// its checks and commands decide once the rows they read are loaded. The probe is a test and dev product
// only; it exercises the engine the way roadmap, gym and journal will.

namespace wm::probe {

// probe.tick ends an open run started this long ago.
inline constexpr sync::Ms kTickAfterMs = 600'000;

// A run is open while alive and its endedAt is unset or null.
bool isOpen(const sync::Row& run);

// A run is created only by probe.start: a create from any other source is invalid, a delta creating the run
// beside a probe.start of the same id included.
void requireStartedRuns(const std::vector<sync::Change>& changes);

// A run whose joined life turns dead kills every alive lap of it in the same seq, the laps the intent
// itself deletes included, at the stamp of the join's next pass (§10.3).
std::vector<sync::Delta> lapsDyingWithRuns(const std::vector<sync::Change>& changes, const std::vector<sync::Row>& laps);

// probe.copy's writes into the tree it creates (§6.1 step 14): the source's title, and every alive tag and
// link as stored, a tag born at its life stamp so that a revived tag keeps its life. Visibility never
// travels.
std::vector<sync::Delta> copyOfTree(const std::vector<sync::Row>& sourceRows);

}
