#pragma once

#include "platform/adapters/postgres/PgPool.h"
#include "products/gym/ports/CatalogRepository.h"

#include <memory>

namespace wm::gym {

// Owner-scoped, one transaction per read. The movement column list and join are in PgGymRows.h.
class PgCatalogRepository : public CatalogRepository {
public:
  explicit PgCatalogRepository(std::shared_ptr<PgPool> pool);

  std::vector<Exercise> catalog(const UserId& user) override;
  std::vector<Exercise> seedCatalog() override;
  std::optional<Exercise> exerciseUpdate(const UserId&, const std::string& requestId) override;

private:
  std::shared_ptr<PgPool> pool_;
};

}
