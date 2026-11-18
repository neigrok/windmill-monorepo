#pragma once

#include "platform/adapters/postgres/PgPool.h"
#include "products/roadmap/ports/RoadmapRecords.h"

#include <memory>

namespace wm {

// RoadmapRecords over the roadmap_* tables the engine's binding writes (products/roadmap/sync/PgRoadmap), each read in
// one transaction: an account's roadmaps in one statement a table, whatever how many roadmaps it holds.
class PgRoadmapRecords final : public RoadmapRecords {
public:
  explicit PgRoadmapRecords(std::shared_ptr<PgPool> pool);

  std::optional<UserId> ownerOf(const TreeId& tree) override;
  AccountRoadmaps roadmapsOf(const UserId& owner) override;
  std::vector<ListedRoot> publicRoots() override;
  ForkLineage lineageOf(const TreeId& tree) override;
  std::set<TreeId> forkedSources(const UserId& viewer) override;

private:
  std::shared_ptr<PgPool> pool_;
};

}
