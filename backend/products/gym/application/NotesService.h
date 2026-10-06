#pragma once

#include "products/gym/ports/GymWriteDoor.h"
#include "products/gym/ports/NotesRepository.h"

#include <optional>
#include <vector>

namespace wm::gym {

// Notes hold the lifter's instructions, written on a phone, and the useful insights Coach and connected
// agents save. An insight save appends and never changes a note that stands.
class NotesService {
public:
  NotesService(NotesRepository& notes, GymWriteDoor& door);

  std::vector<Note> notes(const UserId& user);
  NoteWriteOutcome saveInsight(const Note& incoming);
  std::optional<Note> noteSave(const UserId& user, const NoteId& id);

private:
  NotesRepository& notes_;
  GymWriteDoor& door_;
};

}
