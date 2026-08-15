#pragma once

#include "products/gym/domain/Training.h"

#include <optional>
#include <string>
#include <vector>

namespace wm::gym {

// The catalog write's one refusal. The read-back is scoped to the caller's own created_by rows, so
// a seed's slug and another lifter's custom id are both simply taken — the caller mints a new id
// and sends it again, and learns nothing about who holds the old one.
enum class ExerciseInsertError { none, idTaken };

struct ExerciseInsertOutcome {
  std::optional<Exercise> exercise;
  ExerciseInsertError error;
};

// The catalog's door to gym storage: the 64 global seeds, this account's own movements, and the
// per-account names and aliases a rename leaves on either. One of five aggregate ports over one
// Postgres database (LogRepository, ProgramRepository, AskThreadRepository, PreferencesRepository
// are the others), and the one whose rows the log and the program name: a set, a routine line and
// a proposal line each carry an ExerciseId, and the store behind those two ports checks it against
// this catalog under the same visibility predicate `catalog` reads by. Every read and write is
// owner-scoped by the UserId it carries; absent is byte-identical to forbidden. insertExercise is
// idempotent by client-minted id — a conflict answers with the row that is stored.
struct CatalogRepository {
  virtual ~CatalogRepository() = default;

  virtual std::vector<Exercise> catalog(const UserId& user) = 0;          // seeds + own customs
  // The owner rides beside the row rather than inside it: a catalog entry has no owner when it is a
  // seed, and `custom` is what the read derives from created_by.
  virtual ExerciseInsertOutcome insertExercise(const UserId& owner, const Exercise& incoming) = 0;
  // The one write in this port that changes something already stored, and the one that must not
  // leak across accounts: the 64 seeds are GLOBAL rows, so a movement this account created renames
  // on its own row while a seed takes a per-account display name instead — and renaming a seed back
  // to what it is called by default clears that name rather than storing a copy of it. Nothing
  // about identity moves either way: every set, routine entry and frozen plan snapshot still points
  // at the same id, which is the promise §4 exists to keep. Absent, and another account's private
  // movement, are the one answer every read here gives.
  //
  // IT ALSO KEEPS THE OLD NAME (§N32's *old name searchable as an alias*): the name this account
  // was calling the movement a moment ago joins its aliases, so the word in a lifter's muscle
  // memory still finds it in the picker. Per account like the display name itself, and it comes
  // back on `Exercise::aliases` beside that name rather than on a read of its own — an alias IS a
  // name, and a picker that had to fetch names from two places would search one of them a frame
  // late. Renaming BACK to a name this account already used takes that name off the alias list in
  // the same write, because a name cannot be both what a movement is called and what it used to be.
  virtual std::optional<Exercise> renameExercise(const UserId& user, const ExerciseId& id,
                                                 const std::string& name) = 0;
};

}
