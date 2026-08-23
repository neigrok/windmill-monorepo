#include "products/gym/adapters/postgres/PgCatalogRepository.h"

#include "platform/adapters/postgres/PgPool.h"
#include "products/gym/adapters/postgres/PgGymRows.h"

#include <pqxx/pqxx>

#include <optional>
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

ExerciseInsertOutcome PgCatalogRepository::insertExercise(const UserId& owner,
                                                           const Exercise& incoming) {
  // The read-back is scoped to the caller's own created_by rows: a seed slug and another lifter's id
  // both resolve to nothing, so the answer is "that id is taken" and never their row.
  std::optional<Exercise> stored;
  {
    PgLease conn{*pool_};
    pqxx::work txn{*conn};
    txn.exec_params(
        "INSERT INTO gym_exercises (id, name, pattern, equipment, step_kg, created_by) "
        "VALUES ($1, $2, $3, $4, $5, $6::uuid) ON CONFLICT DO NOTHING",
        incoming.id.str(), incoming.name, toString(incoming.pattern), toString(incoming.equipment),
        incoming.stepKg, owner.str());
    pqxx::result rows = txn.exec_params(
        "SELECT " + std::string(kExerciseColumns) + " FROM " + std::string(kExerciseFrom) +
            " WHERE e.id = $2 AND e.created_by = $1::uuid",
        owner.str(), incoming.id.str());
    if (!rows.empty()) stored = exerciseFrom(rows[0]);
    txn.commit();
  }
  if (!stored) return {std::nullopt, ExerciseInsertError::idTaken};
  return {stored, ExerciseInsertError::none};
}

std::optional<Exercise> PgCatalogRepository::renameExercise(const UserId& user,
                                                             const ExerciseId& id,
                                                             const std::string& name) {
  // One transaction; the read that opens it is the whole owner check.
  // `UPDATE gym_exercises SET name` runs only where `created_by = the caller`: the seeds are one
  // global row each, so renaming one in place would rename it for every lifter. A seed takes a line
  // in gym_exercise_names instead, coalesced over the seed's name by every read, and renaming a seed
  // back to its default deletes that line.
  // The renamed entity is constructed before either write: the constructor is the entire validation.
  std::optional<Exercise> stored;
  {
    PgLease conn{*pool_};
    pqxx::work txn{*conn};
    pqxx::result rows = txn.exec_params(
        "SELECT " + std::string(kExerciseColumns) + ", e.name AS seed_name FROM " +
            std::string(kExerciseFrom) +
            " WHERE e.id = $2 AND (e.created_by IS NULL OR e.created_by = $1::uuid)",
        user.str(), id.str());
    if (rows.empty()) return std::nullopt;
    const Exercise current = exerciseFrom(rows[0]);
    const Exercise renamed{current.id,         name,           current.pattern,
                           current.equipment,  current.stepKg, current.custom};

    if (renamed.custom)
      txn.exec_params("UPDATE gym_exercises SET name = $3 WHERE id = $2 AND created_by = $1::uuid",
                      user.str(), id.str(), renamed.name);
    else if (renamed.name == rows[0]["seed_name"].as<std::string>())
      txn.exec_params("DELETE FROM gym_exercise_names WHERE user_id = $1::uuid AND exercise_id = $2",
                      user.str(), id.str());
    else
      txn.exec_params("INSERT INTO gym_exercise_names (user_id, exercise_id, name) "
                      "VALUES ($1::uuid, $2, $3) "
                      "ON CONFLICT (user_id, exercise_id) DO UPDATE "
                      "  SET name = excluded.name, updated_at = now()",
                      user.str(), id.str(), renamed.name);

    // Three statements, one rule: a name is either the movement's current one or an alias, never
    // both, and only the newest few aliases are kept. The guard on the insert keeps a rename to the
    // same name from turning the current name into its own alias.
    if (renamed.name != current.name)
      txn.exec_params("INSERT INTO gym_exercise_aliases (user_id, exercise_id, name) "
                      "VALUES ($1::uuid, $2, $3) ON CONFLICT (user_id, exercise_id, name) "
                      "DO UPDATE SET created_at = now()",
                      user.str(), id.str(), current.name);
    txn.exec_params("DELETE FROM gym_exercise_aliases "
                    "WHERE user_id = $1::uuid AND exercise_id = $2 AND name = $3",
                    user.str(), id.str(), renamed.name);
    // Pruned oldest-first under the same ORDER the read uses; the two must match.
    txn.exec_params("DELETE FROM gym_exercise_aliases a "
                    "WHERE a.user_id = $1::uuid AND a.exercise_id = $2 AND a.name NOT IN "
                    "  (SELECT b.name FROM gym_exercise_aliases b "
                    "   WHERE b.user_id = $1::uuid AND b.exercise_id = $2 "
                    "   ORDER BY b.created_at DESC, b.name ASC LIMIT $3)",
                    user.str(), id.str(), static_cast<long long>(kMaxAliases));

    // The read-back carries the same predicate the read above did.
    pqxx::result named = txn.exec_params(
        "SELECT " + std::string(kExerciseColumns) + " FROM " + std::string(kExerciseFrom) +
            " WHERE e.id = $2 AND (e.created_by IS NULL OR e.created_by = $1::uuid)",
        user.str(), id.str());
    if (!named.empty()) stored = exerciseFrom(named[0]);
    txn.commit();
  }
  return stored;
}

}
