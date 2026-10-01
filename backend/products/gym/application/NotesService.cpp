#include "products/gym/application/NotesService.h"
#include "products/gym/application/GymSwitches.h"
#include "products/gym/ports/GymWriteDoor.h"

namespace wm::gym {

NotesService::NotesService(NotesRepository& notes, Clock& clock, GymWriteDoor* door) : door_(door), notes_(notes), clock_(clock) {}

std::vector<Note> NotesService::notes(const UserId& user) { return notes_.notes(user); }

NoteWriteOutcome NotesService::saveNote(const Note& incoming) {
  requireGymWrite();
  if (door_ && gymEngineWrites()) return door_->saveNote(incoming);
  return notes_.saveNote(incoming, clock_.nowMs());
}

NoteWriteOutcome NotesService::saveInsight(const Note& incoming) {
  requireGymWrite();
  if (door_ && gymEngineWrites()) return door_->saveInsight(incoming);
  return notes_.saveInsight(incoming, clock_.nowMs());
}

std::optional<Note> NotesService::noteSave(const UserId& user, const NoteId& id) {
  return notes_.noteSave(user, id);
}

void NotesService::deleteNote(const UserId& user, const NoteId& id) {
  requireGymWrite();
  if (door_ && gymEngineWrites()) { door_->deleteNote(user, id); return; }
  notes_.deleteNote(user, id);
}

NotesOrderOutcome NotesService::reorderNotes(const UserId& user, const std::vector<NoteId>& order) {
  requireGymWrite();
  if (door_ && gymEngineWrites()) return door_->reorderNotes(user, order);
  return notes_.reorderNotes(user, order);
}

}
