#pragma once

#include "platform/adapters/postgres/PgPool.h"
#include "products/gym/ports/NotesRepository.h"

#include <memory>

namespace wm::gym {

// Ten rows per account at most, dense on `position`. Each method borrows a connection for exactly
// one transaction. Every write opens by taking a transaction-scoped advisory lock on the account,
// so overlapping writes queue and each reads what the one before it committed: two new notes take
// n and n+1, and a second flight of one new id reads back the stored row. The deferred unique on
// (user_id, position) is what lets a reorder swap rows inside one transaction, never a backstop.
class PgNotesRepository : public NotesRepository {
public:
  explicit PgNotesRepository(std::shared_ptr<PgPool> pool);

  std::vector<Note> notes(const UserId& user) override;
  NoteWriteOutcome saveNote(const Note& incoming, std::uint64_t nowMs) override;
  void deleteNote(const UserId& user, const NoteId& id) override;
  NotesOrderOutcome reorderNotes(const UserId& user, const std::vector<NoteId>& order) override;
  std::vector<ExportedNote> exportedNotes(const UserId& user) override;

private:
  std::shared_ptr<PgPool> pool_;
};

}
