#pragma once

#include "platform/adapters/json/JsonText.h"
#include "products/gym/domain/Training.h"

#include <pqxx/pqxx>

#include <cstdint>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

// What the five gym Postgres adapters share, and ONLY that: how an instant and a movement row cross
// from pqxx, and the one visibility predicate every write that names a movement checks under. It is
// one header rather than a copy per adapter so the sentences below stay true structurally — there
// is no second spelling of the movement-row join, and no second predicate a routine line could be
// written under that a set is not. Everything else a table needs stays file-local in the adapter
// that owns the table. Keep it that way: a helper two adapters want is a reason to think, not a
// reason to grow this file.
namespace wm::gym {

// Every column list in these adapters reads the same shape. Instants are pushed through epoch casts
// so no timestamptz or calendar parsing ever happens in C++ — the pqxx date/time readers differ
// between the macOS and CI Linux builds, and this keeps both off that path. weight/rpe/step cross
// as float8 so pqxx reads a plain double out of the numeric columns.
//
// Read as a signed bigint and clamped into the band the domain accepts. A row written before that
// band was enforced — a unit-confused client wrapped a huge uint64 into a pre-1970 timestamp — then
// reads as a bounded instant instead of failing the conversion, so one poisoned row can never take
// down every read of that account's log.
template <typename Field>
std::uint64_t instantFrom(const Field& field) {
  const long long stored = field.template as<long long>();
  if (stored < 1) return 1;
  if (static_cast<std::uint64_t>(stored) > kMaxInstantMs) return kMaxInstantMs;
  return static_cast<std::uint64_t>(stored);
}

// The catalog's columns, and the display name is the CALLER'S — the name and the names it used to
// have alike. The 64 seeds are global rows shared by every account on this server, so the name a
// lifter gave one lives in gym_exercise_names and is coalesced over the seed's own, while a movement
// they created carries its name on its own row and has no line to coalesce. The join is written into
// the column list on purpose: `e.`, `n.` and `al.` are all named here, so a read that selects these
// columns without joining the two per-account tables does not compile a query at all, rather than
// quietly printing the seed name to the one account that renamed it. EVERY read of a movement row
// takes kExerciseFrom with the caller's id at $1 — there is no second spelling of this join.
//
// The aliases cross as a JSON ARRAY rendered by Postgres, for the reason the log's tally is framed
// by rows: a display name may hold any character a text column can, newlines and commas included, so
// a separator packed into one string is a movement nobody named waiting to be split out of it.
// json_agg escapes; the parse is one line.
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

// Every row reader in these adapters is templated on the row type: pqxx names it row_ref on macOS
// and row on the CI's Linux build, so binding it concretely compiles on one and fails on the other.
template <typename Row>
Exercise exerciseFrom(const Row& row) {
  // The aliases as json_agg rendered them, newest first. A row whose array cannot be read is a row
  // with no aliases rather than a read that fails: this list is an aid to finding a movement, and
  // losing the whole catalog over one of them would cost the lifter the thing it decorates.
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

// A movement this account may NAME on a write: the catalog read's own predicate — a seed, or one
// this account created — applied where a set or a routine entry points at one. The foreign key only
// asks whether the row EXISTS, and another lifter's private movement exists: named, it would print
// that account's movement name in this log, this export and this coach share, and its owner could
// never delete it away. Read inside the caller's own transaction, against the owner of the row being
// written.
inline bool namesVisibleMovement(pqxx::work& txn, const std::string& owner,
                                 const ExerciseId& exercise) {
  return !txn
              .exec_params("SELECT 1 FROM gym_exercises "
                           "WHERE id = $1 AND (created_by IS NULL OR created_by = $2::uuid)",
                           exercise.str(), owner)
              .empty();
}

}
