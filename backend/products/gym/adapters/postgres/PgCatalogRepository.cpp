#include "products/gym/adapters/postgres/PgCatalogRepository.h"

#include "platform/adapters/postgres/PgPool.h"
#include "products/gym/adapters/postgres/PgGymRows.h"
#include "products/gym/adapters/json/GymJson.h"

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

std::vector<Exercise> PgCatalogRepository::seedCatalog() {
  PgLease conn{*pool_};
  pqxx::work txn{*conn};
  const pqxx::result rows = txn.exec(
      "SELECT id, name, pattern, equipment, step_kg::float8 AS step_kg, created_by, "
      "'[]' AS aliases,coalesce(load_count,0) AS load_count FROM gym_exercises WHERE created_by IS NULL ORDER BY pattern, name");
  std::vector<Exercise> out;
  for (const auto& row : rows) out.push_back(exerciseFrom(row));
  return out;
}

std::optional<Exercise> PgCatalogRepository::exerciseUpdate(const UserId& user, const std::string& requestId) {
  PgLease conn{*pool_};
  pqxx::work txn{*conn};
  const auto rows = txn.exec_params("SELECT exercise::text FROM gym_exercise_updates WHERE user_id=$1::uuid AND request_id=$2",
                                    user.str(), requestId);
  if (rows.empty()) return std::nullopt;
  return exerciseFromJson(parse(rows[0][0].as<std::string>()));
}

}
