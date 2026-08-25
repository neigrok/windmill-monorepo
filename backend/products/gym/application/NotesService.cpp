#include "products/gym/application/NotesService.h"

namespace wm::gym {

NotesService::NotesService(NotesRepository& notes, Clock& clock) : notes_(notes), clock_(clock) {}

std::vector<Note> NotesService::notes(const UserId& user) { return notes_.notes(user); }

NoteWriteOutcome NotesService::saveNote(const Note& incoming) {
  return notes_.saveNote(incoming, clock_.nowMs());
}

void NotesService::deleteNote(const UserId& user, const NoteId& id) { notes_.deleteNote(user, id); }

NotesOrderOutcome NotesService::reorderNotes(const UserId& user, const std::vector<NoteId>& order) {
  return notes_.reorderNotes(user, order);
}

std::vector<ExportedNote> NotesService::exportedNotes(const UserId& user) {
  return notes_.exportedNotes(user);
}

}
