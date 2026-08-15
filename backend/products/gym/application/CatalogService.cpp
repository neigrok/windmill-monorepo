#include "products/gym/application/CatalogService.h"

namespace wm::gym {

CatalogService::CatalogService(CatalogRepository& catalog) : catalog_(catalog) {}

std::vector<Exercise> CatalogService::catalog(const UserId& user) {
  return catalog_.catalog(user);
}

// The one site that applies the equipment's default step, so a movement created without one climbs
// like the seed row it sits beside and no client has to carry the table. Every created movement is
// custom by construction — the seeds are the schema's, and nothing on the wire can mint one.
ExerciseInsertOutcome CatalogService::createExercise(const UserId& user,
                                                     const ExerciseWrite& incoming) {
  return catalog_.insertExercise(
      user, Exercise{incoming.id, incoming.name, incoming.pattern, incoming.equipment,
                     incoming.stepKg.value_or(defaultStepKg(incoming.equipment)), true});
}

// A pass-through like every other write here, and for the same reason: the entity's constructor is
// the whole validation and the store's answer is the whole refusal. The construction happens where
// the stored row and the new name are both in hand — inside the store, before it writes — because
// what a rename changes is what a movement is CALLED and nothing else about it moves: not its
// pattern, not its step, and least of all its id, which is the promise the record page exists to
// demonstrate.
std::optional<Exercise> CatalogService::renameExercise(const UserId& user, const ExerciseId& id,
                                                       const std::string& name) {
  return catalog_.renameExercise(user, id, name);
}

}
