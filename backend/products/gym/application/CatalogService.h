#pragma once

#include "products/gym/ports/CatalogRepository.h"

#include <optional>
#include <string>
#include <vector>

namespace wm::gym {

// stepKg omitted means the equipment decides it (defaultStepKg).
struct ExerciseWrite {
  ExerciseId id;
  std::string name;
  Pattern pattern;
  Equipment equipment;
  std::optional<double> stepKg;
};

// The seeds plus this lifter's own movements, and the two writes a lifter has. Every refusal is the
// store's own fact, handed straight back. A movement's RECORD lives on TrainingService.
class CatalogService {
public:
  explicit CatalogService(CatalogRepository& catalog);

  std::vector<Exercise> catalog(const UserId& user);
  ExerciseInsertOutcome createExercise(const UserId& user, const ExerciseWrite& incoming);
  // The movement keeps its id, so every set and plan that names it is untouched. The name is
  // validated by constructing the entity. Absent means this account's catalog holds no such movement.
  std::optional<Exercise> renameExercise(const UserId& user, const ExerciseId& id,
                                         const std::string& name);

private:
  CatalogRepository& catalog_;
};

}
