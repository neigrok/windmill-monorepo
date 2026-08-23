#pragma once

#include "products/gym/domain/Training.h"

#include <optional>
#include <string>
#include <vector>

namespace wm::gym {

// The catalog write's one refusal: a seed's slug and another lifter's custom id are both simply
// taken, and the caller learns nothing about who holds the id.
enum class ExerciseInsertError { none, idTaken };

struct ExerciseInsertOutcome {
  std::optional<Exercise> exercise;
  ExerciseInsertError error;
};

// The catalog's door to gym storage: the global seeds, this account's own movements, and the
// per-account names and aliases a rename leaves on either. Sets, routine lines and proposal lines
// carry an ExerciseId checked against this catalog under the same visibility predicate `catalog`
// reads by. Every read and write is owner-scoped by the UserId it carries; absent is byte-identical
// to forbidden. insertExercise is idempotent by client-minted id — a conflict answers with the row
// that is stored.
struct CatalogRepository {
  virtual ~CatalogRepository() = default;

  virtual std::vector<Exercise> catalog(const UserId& user) = 0;          // seeds + own customs
  // The owner rides beside the row: a seed has none, and `custom` is derived from created_by.
  virtual ExerciseInsertOutcome insertExercise(const UserId& owner, const Exercise& incoming) = 0;
  // Seeds are global rows: a movement this account created renames on its own row, a seed takes a
  // per-account display name, and renaming a seed back to its default clears that name. No id moves.
  // The name being replaced joins the movement's per-account aliases, returned on `Exercise::aliases`;
  // renaming back to a name already used takes it off that list in the same write.
  virtual std::optional<Exercise> renameExercise(const UserId& user, const ExerciseId& id,
                                                 const std::string& name) = 0;
};

}
