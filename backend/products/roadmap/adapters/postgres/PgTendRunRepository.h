#pragma once

#include "platform/adapters/postgres/PgPool.h"
#include "products/roadmap/ports/TendRunRepository.h"

#include <memory>
#include <string>

namespace wm {

class PgTendRunRepository : public TendRunRepository {
public:
  explicit PgTendRunRepository(std::shared_ptr<PgPool> pool);

  void save(const TendRun& run) override;
  std::optional<TendRun> find(const std::string& id) override;
  int countForUser(const UserId& user, std::uint64_t sinceMs) override;
  std::vector<TendRun> recentForUser(const UserId& user, std::uint64_t sinceMs, int limit) override;
  int failOrphanedRuns() override;

private:
  std::shared_ptr<PgPool> pool_;
};

}
