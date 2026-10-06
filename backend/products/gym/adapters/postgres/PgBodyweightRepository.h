#pragma once

#include "platform/adapters/postgres/PgPool.h"
#include "products/gym/ports/BodyweightRepository.h"

#include <memory>

namespace wm::gym {

// One row per (account, local day), read. Each method borrows a connection for exactly one
// transaction. The day crosses as text (`::date` in, `::text` out): the pqxx date readers differ
// between the macOS and CI Linux builds.
class PgBodyweightRepository : public BodyweightRepository {
public:
  explicit PgBodyweightRepository(std::shared_ptr<PgPool> pool);

  std::vector<Bodyweight> entries(const UserId& user, const BodyweightRange& range) override;
  std::optional<Bodyweight> latest(const UserId& user) override;

private:
  std::shared_ptr<PgPool> pool_;
};

}
