#pragma once

#include "products/gym/domain/Note.h"

#include <cstdint>
#include <optional>
#include <string>
#include <vector>

namespace wm::gym {

// `full` is the tenth note already standing; `idTaken` is an id spent on a note this account cannot
// see — the primary key spans every account, so a write must refuse rather than overwrite.
enum class NoteWriteError { none, full, idTaken };

struct NoteWriteOutcome {
  std::optional<Note> note;   // the row as the store now holds it
  NoteWriteError error;
};

// `mismatch` is an order that does not name every note of the account exactly once.
enum class NotesOrderError { none, mismatch };

struct NotesOrderOutcome {
  std::vector<Note> notes;    // position ascending, empty on a refusal
  NotesOrderError error;
};

// One line of the notes export: text end to end, rendered by the store. Position ascending.
struct ExportedNote {
  std::string position;
  std::string title;
  std::string body;
  std::string updatedAt;

  bool operator==(const ExportedNote&) const = default;
};

// The notes' door to gym storage. Every read and write is owner-scoped by the UserId it carries;
// absent is byte-identical to forbidden. Positions are dense 0..n-1 on every answer.
struct NotesRepository {
  virtual ~NotesRepository() = default;

  virtual std::vector<Note> notes(const UserId& user) = 0;   // position ascending
  // Upsert by the client-minted id. A new id lands at position n (or `full`); the caller's own id
  // carrying the same text replays the stored row untouched; carrying different text it is an edit
  // stamped `nowMs`. Another account's id is `idTaken`.
  virtual NoteWriteOutcome saveNote(const Note& incoming, std::uint64_t nowMs) = 0;
  // Absent and already gone are one answer; the notes after it move up one.
  virtual void deleteNote(const UserId& user, const NoteId& id) = 0;
  // Whole-order replace: refused unless `order` names every note exactly once. Precedence is not the
  // note's text, so `updated_at` does not move.
  virtual NotesOrderOutcome reorderNotes(const UserId& user, const std::vector<NoteId>& order) = 0;
  virtual std::vector<ExportedNote> exportedNotes(const UserId& user) = 0;
};

}
