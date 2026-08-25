#pragma once

#include "platform/ports/Clock.h"
#include "products/gym/ports/NotesRepository.h"

#include <vector>

namespace wm::gym {

// The notes a lifter writes for Coach. Reads are pass-throughs; the write is dated by the server's
// clock, since a note is not a log entry and the device's wall clock has nothing to say about it.
// There is no proposal door here: Coach reads notes over `list_notes` and never writes one.
class NotesService {
public:
  NotesService(NotesRepository& notes, Clock& clock);

  std::vector<Note> notes(const UserId& user);
  NoteWriteOutcome saveNote(const Note& incoming);
  void deleteNote(const UserId& user, const NoteId& id);
  NotesOrderOutcome reorderNotes(const UserId& user, const std::vector<NoteId>& order);
  std::vector<ExportedNote> exportedNotes(const UserId& user);

private:
  NotesRepository& notes_;
  Clock& clock_;
};

}
