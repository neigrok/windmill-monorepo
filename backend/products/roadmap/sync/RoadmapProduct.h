#pragma once

#include "platform/application/sync/SyncCatalog.h"

#include <map>
#include <memory>
#include <string>
#include <string_view>
#include <vector>

// Roadmap on the sync engine (docs/foundation/roadmap-on-the-engine.md §4, §7; engine.md Appendix A.1): its rules and
// commands over the engine's reader, so the same binding runs over Postgres (PgRoadmap) and over the test fakes.

namespace wm::roadmap::engine {

// packages/api-contract/sync/roadmap.registry.json, embedded at build time (CMakeLists.txt, wm_register_sync_product).
std::string_view registryText();
const sync::Registry& registry();

class RoadmapProduct {
public:
  RoadmapProduct();
  ~RoadmapProduct();

  // Binds every roadmap type to its store, by type name, under one rules object, and every product command to its
  // handler; the engine binds the capture and restore commands itself.
  void bindTo(sync::SyncCatalog& catalog, const std::map<std::string, sync::TypeStore*>& stores);

private:
  class Rules;
  class CreateSubtree;
  class RecolourKind;
  class UndoCreateRoadmap;
  class UndoCreateSubtree;
  class RedoCreateSubtree;

  std::unique_ptr<Rules> rules_;
  std::map<std::string, std::unique_ptr<sync::SyncCommand>> commands_;
};

}
