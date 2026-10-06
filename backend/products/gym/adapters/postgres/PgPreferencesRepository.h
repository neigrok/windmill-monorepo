#pragma once

#include "platform/adapters/postgres/PgPool.h"
#include "products/gym/ports/PreferencesRepository.h"

#include <memory>

namespace wm::gym {

// One row per account at most, absent until written, read in one transaction.
class PgPreferencesRepository : public PreferencesRepository {
public:
  explicit PgPreferencesRepository(std::shared_ptr<PgPool> pool);

  std::optional<GymPreferences> preferences(const UserId& user) override;

private:
  std::shared_ptr<PgPool> pool_;
};

}
