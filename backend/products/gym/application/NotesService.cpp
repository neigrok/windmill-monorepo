#include "products/gym/application/NotesService.h"

namespace wm::gym {

NotesService::NotesService(NotesRepository& notes, GymWriteDoor& door) : notes_(notes), door_(door) {}

std::vector<Note> NotesService::notes(const UserId& user) { return notes_.notes(user); }

NoteWriteOutcome NotesService::saveInsight(const Note& incoming) { return door_.saveInsight(incoming); }

std::optional<Note> NotesService::noteSave(const UserId& user, const NoteId& id) {
  return notes_.noteSave(user, id);
}

}
