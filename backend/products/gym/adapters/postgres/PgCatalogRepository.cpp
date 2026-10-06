#include "products/gym/adapters/postgres/PgCatalogRepository.h"

#include "platform/adapters/postgres/PgPool.h"
#include "products/gym/adapters/postgres/PgGymRows.h"

#include <pqxx/pqxx>

#include <string>
#include <utility>
#include <vector>

namespace wm::gym {

PgCatalogRepository::PgCatalogRepository(std::shared_ptr<PgPool> pool)
    : pool_(std::move(pool)) {}

std::vector<Exercise> PgCatalogRepository::catalog(const UserId& user) {
  // Ordered by the name the caller sees, not by the name the seed carries.
  PgLease conn{*pool_};
  pqxx::work txn{*conn};
  pqxx::result rows = txn.exec_params(
      "SELECT " + std::string(kExerciseColumns) + " FROM " + std::string(kExerciseFrom) +
          " WHERE e.created_by IS NULL OR e.created_by = $1::uuid "
          "ORDER BY e.pattern, name",
      user.str());

  std::vector<Exercise> out;
  for (const auto& row : rows) out.push_back(exerciseFrom(row));
  return out;
}

}
