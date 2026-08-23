#pragma once

#include "platform/adapters/json/JsonText.h"
#include "products/gym/domain/Training.h"

#include <pqxx/pqxx>

#include <cstdint>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

namespace wm::gym {

// Instants cross through epoch casts so no timestamptz or calendar parsing happens in C++: the pqxx
// date/time readers differ between the macOS and CI Linux builds. weight/rpe/step cross as float8.
// Read as a signed bigint and clamped into the band the domain accepts.
template <typename Field>
std::uint64_t instantFrom(const Field& field) {
  const long long stored = field.template as<long long>();
  if (stored < 1) return 1;
  if (static_cast<std::uint64_t>(stored) > kMaxInstantMs) return kMaxInstantMs;
  return static_cast<std::uint64_t>(stored);
}

// The display name is the caller's: their own name for a global seed lives in gym_exercise_names and
// is coalesced over the seed's. Every read of a movement row takes kExerciseFrom with the caller's
// id at $1. Aliases cross as a JSON array, since a display name may hold any character a text column
// can.
constexpr std::string_view kExerciseColumns =
    "e.id, coalesce(n.name, e.name) AS name, e.pattern, e.equipment, "
    "e.step_kg::float8 AS step_kg, e.created_by, al.aliases";

constexpr std::string_view kExerciseFrom =
    "gym_exercises e LEFT JOIN gym_exercise_names n "
    "  ON n.exercise_id = e.id AND n.user_id = $1::uuid "
    "LEFT JOIN LATERAL ("
    "  SELECT coalesce(json_agg(a.name ORDER BY a.created_at DESC, a.name ASC)::text, '[]') "
    "         AS aliases "
    "  FROM gym_exercise_aliases a "
    "  WHERE a.user_id = $1::uuid AND a.exercise_id = e.id) al ON true";

// Templated on the row type: pqxx names it row_ref on macOS and row on the CI Linux build, so
// binding it concretely compiles on one and fails on the other.
template <typename Row>
Exercise exerciseFrom(const Row& row) {
  // A row whose array cannot be read has no aliases, not a failed read.
  std::vector<std::string> aliases;
  const Json::Value stored = parse(row["aliases"].template as<std::string>());
  for (const Json::Value& alias : stored)
    if (alias.isString()) aliases.push_back(alias.asString());
  return Exercise{ExerciseId{row["id"].template as<std::string>()},
                  row["name"].template as<std::string>(),
                  patternFromStored(row["pattern"].template as<std::string>()),
                  equipmentFromStored(row["equipment"].template as<std::string>()),
                  row["step_kg"].template as<double>(),
                  !row["created_by"].is_null(),
                  std::move(aliases)};
}

// A movement this account may name on a write: a seed, or one it created. The foreign key only asks
// whether the row exists, and another lifter's private movement exists. Read inside the caller's own
// transaction, against the owner of the row being written.
inline bool namesVisibleMovement(pqxx::work& txn, const std::string& owner,
                                 const ExerciseId& exercise) {
  return !txn
              .exec_params("SELECT 1 FROM gym_exercises "
                           "WHERE id = $1 AND (created_by IS NULL OR created_by = $2::uuid)",
                           exercise.str(), owner)
              .empty();
}

}
