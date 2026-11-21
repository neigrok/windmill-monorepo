#pragma once

#include "platform/application/sync/SyncCatalog.h"

#include <memory>
#include <string_view>

namespace wm::sync {

// Whether a deployment serves roadmap's scopes through the engine: served where ROADMAP_ENGINE_ENABLED says so, as
// production's host does (roadmap-on-the-engine.md §8.1), and withheld where it is unset.
enum class RoadmapServing { withheld, served };

std::string_view compositionText();
const Registry& productRegistry();
// The composition's every product bound to its Postgres tables, roadmap withheld unless `serving` serves it.
std::shared_ptr<SyncCatalog> productCatalog(RoadmapServing serving = RoadmapServing::withheld);

}
