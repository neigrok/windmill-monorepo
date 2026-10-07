#pragma once

#include "platform/adapters/postgres/PgPool.h"
#include "products/gym/ports/NotesRepository.h"

#include <memory>

namespace wm::gym {

// Ten rows per account at most, dense on `position`, read. Each method borrows a connection for exactly
// one transaction.
class PgNotesRepository : public NotesRepository {
public:
  explicit PgNotesRepository(std::shared_ptr<PgPool> pool);

  std::vector<Note> notes(const UserId& user) override;
  std::optional<Note> noteSave(const UserId& user, const NoteId& id) override;

private:
  std::shared_ptr<PgPool> pool_;
};

}
