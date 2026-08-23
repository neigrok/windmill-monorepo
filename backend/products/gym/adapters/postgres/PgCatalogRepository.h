#pragma once

#include "platform/adapters/postgres/PgPool.h"
#include "products/gym/ports/CatalogRepository.h"

#include <memory>
#include <string>

namespace wm::gym {

// Owner-scoped. insertExercise is idempotent by client-minted id and reads back scoped to the
// caller's own rows, so a spent id answers `idTaken` and says nothing about who holds it. Each method
// borrows a connection for exactly one transaction. The movement column list and join are in
// PgGymRows.h.
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
