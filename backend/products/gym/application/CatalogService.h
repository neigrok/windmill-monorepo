#pragma once

#include "products/gym/ports/CatalogRepository.h"

#include <optional>
#include <string>
#include <vector>

namespace wm::gym {

// A movement a lifter created, off the picker's "no movement by that name". stepKg is the one
// optional: omitted, the equipment decides it (defaultStepKg), which is how the 64 seeds were
// written. It is stored and served and nothing steps a weight by it — see Training.h.
struct ExerciseWrite {
  ExerciseId id;
  std::string name;
  Pattern pattern;
  Equipment equipment;
  std::optional<double> stepKg;
};

// The application seam over the catalog of movements — one of five services, each over the
// aggregate port of the same name (TrainingService, ProgramService, ThreadService,
// PreferencesService are the other four). The seeds plus this lifter's own, and the two writes a
// lifter has: create a movement, rename one. Every refusal it can answer is the store's own fact,
// so it hands the port's outcomes straight back rather than re-spelling them into a second enum
// that could only ever say the same words. A movement's RECORD is a read of the log and lives on
// TrainingService, even though CatalogApi mounts it under the movement's path.
class CatalogService {
public:
  explicit CatalogService(CatalogRepository& catalog);

  std::vector<Exercise> catalog(const UserId& user);
  ExerciseInsertOutcome createExercise(const UserId& user, const ExerciseWrite& incoming);
  // The rename, and the identity it exists to prove: the movement keeps its id, so every set and
  // every plan that names it is untouched and the history stays whole. The name is validated where
  // every other value in this product is — by constructing the entity — so a name the store cannot
  // hold never reaches it. Absent is the store's one fact: this account's catalog holds no such
  // movement.
  std::optional<Exercise> renameExercise(const UserId& user, const ExerciseId& id,
                                         const std::string& name);

private:
  CatalogRepository& catalog_;
};

}
