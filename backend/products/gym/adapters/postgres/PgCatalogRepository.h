#pragma once

#include "platform/adapters/postgres/PgPool.h"
#include "products/gym/ports/CatalogRepository.h"

#include <memory>
#include <string>

namespace wm::gym {

// The catalog over Postgres: the global seeds, an account's own movements, and the per-account name
// and alias rows a rename leaves on either. Owner-scoped like every gym read; insertExercise is
// idempotent by client-minted id and its read-back is scoped to the caller's own rows, so a spent id
// answers `idTaken` and says nothing about who holds it. Stateless but for the pool — each method
// borrows a connection for exactly one transaction (platform/adapters/postgres/PgPool.h).
// The column list and the join every movement row is read through live in PgGymRows.h.
class PgCatalogRepository : public CatalogRepository {
public:
  explicit PgCatalogRepository(std::shared_ptr<PgPool> pool);

  std::vector<Exercise> catalog(const UserId& user) override;
  ExerciseInsertOutcome insertExercise(const UserId& owner, const Exercise& incoming) override;
  std::optional<Exercise> renameExercise(const UserId& user, const ExerciseId& id,
                                         const std::string& name) override;

private:
  std::shared_ptr<PgPool> pool_;
};

}
