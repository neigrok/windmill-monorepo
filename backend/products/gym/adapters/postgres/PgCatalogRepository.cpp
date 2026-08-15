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
  // Ordered by the name the CALLER sees, not by the name the seed carries: the picker is an
  // alphabetical list, and a renamed movement that stayed sorted under its old name would be
  // findable only by someone who remembered what it used to be called.
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
  // The read-back is scoped to the caller's OWN created_by rows, which is what makes the refusal
  // safe: a seed's slug and another lifter's custom id both resolve to nothing here, so the answer
  // is "that id is taken" and never a row the caller may not read.
  std::optional<Exercise> stored;
  {
    PgLease conn{*pool_};
    pqxx::work txn{*conn};
    txn.exec_params(
        "INSERT INTO gym_exercises (id, name, pattern, equipment, step_kg, created_by) "
        "VALUES ($1, $2, $3, $4, $5, $6::uuid) ON CONFLICT DO NOTHING",
        incoming.id.str(), incoming.name, toString(incoming.pattern), toString(incoming.equipment),
        incoming.stepKg, owner.str());
    // The one join every movement read takes, with the caller at $1 like all of them: a movement
    // created a moment ago has no override and no alias, so both sides come back empty — and the
    // read-back is still scoped to the caller's own created_by rows, which is what makes the
    // refusal below safe.
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
  // Read, then decide which of two writes this is, then read back — one transaction, and the read
  // that opens it is the whole owner check: the catalog's own predicate, so a seed and this
  // account's own movement are renamable and another lifter's is simply not there.
  //
  // THE HAZARD THIS METHOD EXISTS FOR: `UPDATE gym_exercises SET name` renames a SEED for every
  // lifter on the server, because the 64 seeds are one global row each. So the statement runs only
  // where `created_by = the caller` — their own movement, their own row — and a seed takes a line
  // in gym_exercise_names instead, which every read of a movement name coalesces over the seed's.
  // Renaming a seed back to what it is called by default DELETES that line rather than storing a
  // copy of the seed's own string: an override that says nothing is not an override, and the row
  // would otherwise outlive a later change to the seed name it was pinning.
  //
  // The renamed entity is CONSTRUCTED before either write, from the row as it would be — the
  // constructor is the entire validation (as for every other write into gym's store), so a name too
  // long, empty, or holding the NUL that Postgres text stops at never reaches a column. Nothing else
  // about the movement moves: not its pattern, not its step, and least of all its id, which is what
  // keeps every set, routine entry and frozen plan snapshot pointing at the same movement.
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

    // THE OLD NAME KEPT (§N32), in three statements that are one rule: the name this account was
    // using is now something it USED to use, the name it is using now is not, and only the newest
    // few are worth carrying.
    //
    // The second statement is the one a rename BACK needs. `Back Squat → High-bar squat → Back
    // Squat` leaves two aliases if nothing takes the new name off the list, and the stale one would
    // shadow the truth in the picker — a search for `Back Squat` matching the movement twice, once
    // as what it is called and once as what it is not. A name is either the movement's or the
    // memory of it, never both. Renaming to the SAME name changes nothing and must not turn the
    // current name into its own alias, which is what the guard on the insert is for.
    if (renamed.name != current.name)
      txn.exec_params("INSERT INTO gym_exercise_aliases (user_id, exercise_id, name) "
                      "VALUES ($1::uuid, $2, $3) ON CONFLICT (user_id, exercise_id, name) "
                      "DO UPDATE SET created_at = now()",
                      user.str(), id.str(), current.name);
    txn.exec_params("DELETE FROM gym_exercise_aliases "
                    "WHERE user_id = $1::uuid AND exercise_id = $2 AND name = $3",
                    user.str(), id.str(), renamed.name);
    // The cap, pruned oldest-first under the ORDER the read uses — the two must match or the list
    // that ships is not the list that was kept.
    txn.exec_params("DELETE FROM gym_exercise_aliases a "
                    "WHERE a.user_id = $1::uuid AND a.exercise_id = $2 AND a.name NOT IN "
                    "  (SELECT b.name FROM gym_exercise_aliases b "
                    "   WHERE b.user_id = $1::uuid AND b.exercise_id = $2 "
                    "   ORDER BY b.created_at DESC, b.name ASC LIMIT $3)",
                    user.str(), id.str(), static_cast<long long>(kMaxAliases));

    // The read-back carries the SAME predicate the read above did, though nothing another account
    // owns could reach it — a query in this module that is owner-scoped only by where it happens to
    // sit is one a later hand copies somewhere it is not.
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
