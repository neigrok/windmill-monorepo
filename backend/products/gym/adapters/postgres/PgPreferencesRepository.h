#pragma once

#include "platform/adapters/postgres/PgPool.h"
#include "products/gym/ports/PreferencesRepository.h"

#include <memory>

namespace wm::gym {

// The settings row over Postgres (§I): one row per account at most, absent until written, and a
// whole-document upsert keyed on the account. Stateless but for the pool — each method borrows a
// connection for exactly one transaction (platform/adapters/postgres/PgPool.h). Nothing else in
// gym's storage reads this table.
class PgPreferencesRepository : public PreferencesRepository {
public:
  explicit PgPreferencesRepository(std::shared_ptr<PgPool> pool);

  std::optional<GymPreferences> preferences(const UserId& user) override;
  GymPreferences savePreferences(const GymPreferences& incoming) override;

private:
  std::shared_ptr<PgPool> pool_;
};

}
