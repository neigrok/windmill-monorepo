#include "products/gym/application/CatalogService.h"
#include "products/gym/application/GymSwitches.h"
#include "products/gym/ports/GymWriteDoor.h"

namespace wm::gym {

CatalogService::CatalogService(CatalogRepository& catalog, GymWriteDoor* door) : door_(door), catalog_(catalog) {}

std::vector<Exercise> CatalogService::catalog(const UserId& user) {
  return catalog_.catalog(user);
}

// The one site that applies the equipment's default step. Every created movement is custom by
// construction; the seeds are the schema's.
ExerciseInsertOutcome CatalogService::createExercise(const UserId& user,
                                                     const ExerciseWrite& incoming) {
  requireGymWrite();
  if (door_ && gymEngineWrites())
    return door_->createExercise(user, Exercise{incoming.id, incoming.name, incoming.pattern, incoming.equipment,
                                              incoming.stepKg.value_or(defaultStepKg(incoming.equipment)), true});
  return catalog_.insertExercise(
      user, Exercise{incoming.id, incoming.name, incoming.pattern, incoming.equipment,
                     incoming.stepKg.value_or(defaultStepKg(incoming.equipment)), true});
}

// The entity's constructor is the whole validation and the store's answer the whole refusal. A
// rename moves the name and nothing else — not the pattern, not the step, not the id.
std::optional<Exercise> CatalogService::renameExercise(const UserId& user, const ExerciseId& id,
                                                       const std::string& name) {
  requireGymWrite();
  if (door_ && gymEngineWrites()) return door_->renameExercise(user, id, name);
  return catalog_.renameExercise(user, id, name);
}

}
