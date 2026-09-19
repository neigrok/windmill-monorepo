#include "products/gym/application/NotesService.h"

namespace wm::gym {

NotesService::NotesService(NotesRepository& notes, Clock& clock) : notes_(notes), clock_(clock) {}

std::vector<Note> NotesService::notes(const UserId& user) { return notes_.notes(user); }

NoteWriteOutcome NotesService::saveNote(const Note& incoming) {
  return notes_.saveNote(incoming, clock_.nowMs());
}

NoteWriteOutcome NotesService::saveInsight(const Note& incoming) {
  return notes_.saveInsight(incoming, clock_.nowMs());
}

std::optional<Note> NotesService::noteSave(const UserId& user, const NoteId& id) {
  return notes_.noteSave(user, id);
}

void NotesService::deleteNote(const UserId& user, const NoteId& id) { notes_.deleteNote(user, id); }

NotesOrderOutcome NotesService::reorderNotes(const UserId& user, const std::vector<NoteId>& order) {
  return notes_.reorderNotes(user, order);
}

}
