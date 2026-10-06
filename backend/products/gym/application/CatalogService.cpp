#include "products/gym/application/CatalogService.h"

namespace wm::gym {

CatalogService::CatalogService(CatalogRepository& catalog, GymWriteDoor& door) : catalog_(catalog), door_(door) {}

std::vector<Exercise> CatalogService::catalog(const UserId& user) {
  return catalog_.catalog(user);
}

// The one site that applies the equipment's default step. Every created movement is custom by
// construction; the seeds are the schema's.
ExerciseInsertOutcome CatalogService::createExercise(const UserId& user,
                                                     const ExerciseWrite& incoming) {
  return door_.createExercise(user, Exercise{incoming.id, incoming.name, incoming.pattern, incoming.equipment,
                                             incoming.stepKg.value_or(defaultStepKg(incoming.equipment)), true});
}

}
