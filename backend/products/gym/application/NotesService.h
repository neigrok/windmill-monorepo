#pragma once

#include "platform/ports/Clock.h"
#include "products/gym/ports/NotesRepository.h"

#include <vector>

namespace wm::gym {

// Notes hold the lifter's instructions and useful user-provided insights saved by Coach.
class NotesService {
public:
  NotesService(NotesRepository& notes, Clock& clock);

  std::vector<Note> notes(const UserId& user);
  NoteWriteOutcome saveNote(const Note& incoming);
  NoteWriteOutcome saveInsight(const Note& incoming);
  std::optional<Note> noteSave(const UserId& user, const NoteId& id);
  void deleteNote(const UserId& user, const NoteId& id);
  NotesOrderOutcome reorderNotes(const UserId& user, const std::vector<NoteId>& order);

private:
  NotesRepository& notes_;
  Clock& clock_;
};

}
