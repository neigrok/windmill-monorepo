#pragma once

#include "products/gym/ports/CatalogRepository.h"
#include "products/gym/ports/GymWriteDoor.h"

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

// The seeds plus this lifter's own movements, and the one write an agent has. Every refusal is the
// engine's own fact, handed straight back. A movement's RECORD lives on TrainingService.
class CatalogService {
public:
  CatalogService(CatalogRepository& catalog, GymWriteDoor& door);

  std::vector<Exercise> catalog(const UserId& user);
  ExerciseInsertOutcome createExercise(const UserId& user, const ExerciseWrite& incoming);

private:
  CatalogRepository& catalog_;
  GymWriteDoor& door_;
};

}
