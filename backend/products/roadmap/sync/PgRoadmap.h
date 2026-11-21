#pragma once

#include "platform/adapters/postgres/PgTableType.h"
#include "platform/application/sync/SyncCatalog.h"
#include "platform/domain/sync/Registry.h"
#include "products/roadmap/sync/RoadmapProduct.h"

#include <memory>
#include <vector>

namespace wm::roadmap::engine {

// Roadmap on Postgres: a PgTableType per registry type over the roadmap_* tables of db/schema.sql's "Roadmap on the
// engine" section, beside the tables of roadmap's own sync, from which the cutover adopted them
// (roadmap-on-the-engine.md §8.1), the activity's deeds in tree_ops, and the product that binds them to a catalog.
class PgRoadmap {
public:
  explicit PgRoadmap(const sync::Registry& registry);
  ~PgRoadmap();
  void bindTo(sync::SyncCatalog& catalog);

private:
  std::vector<std::unique_ptr<sync::PgTableType>> tables_;
  std::unique_ptr<Deeds> deeds_;
  RoadmapProduct product_;
};

}
