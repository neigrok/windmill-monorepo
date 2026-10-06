#pragma once

#include "products/gym/domain/Note.h"

#include <cstdint>
#include <optional>
#include <string>
#include <vector>

namespace wm::gym {

// The notes as the engine stores them, read. Owner-scoped by the UserId it carries; absent is
// byte-identical to forbidden. Positions are dense 0..n-1 on every answer.
struct NotesRepository {
  virtual ~NotesRepository() = default;

  virtual std::vector<Note> notes(const UserId& user) = 0;   // position ascending
  // What one insight save stored, by the save's own id: it survives a later edit and deletion of the note.
  virtual std::optional<Note> noteSave(const UserId& user, const NoteId& id) = 0;
};

}
