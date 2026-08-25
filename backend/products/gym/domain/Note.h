#pragma once

#include "products/gym/domain/Training.h"

#include <cstddef>
#include <cstdint>
#include <string>
#include <vector>

namespace wm::gym {

struct NoteTag;
using NoteId = Id<NoteTag>;

// The three bounds a note lives under. The schema's CHECKs and `list_notes`'s description carry
// the same three numbers; a bound moved here moves there.
constexpr std::size_t kMaxNotes = 10;
constexpr std::size_t kMaxNoteTitleChars = 60;   // code points, after trim; never empty
constexpr std::size_t kMaxNoteBodyBytes = 500;   // UTF-8 bytes, after trim; may be empty

// A note is a title and a body the lifter wrote FOR Coach, stored verbatim — nothing in this product
// summarises what a lifter typed. `position` is precedence: the top note wins where two disagree.
// Position and instant are the store's facts: an incoming write carries neither (both zero) and the
// store answers with the row as it now stands.
struct Note {
  NoteId id;
  UserId user;
  std::string title;
  std::string body;
  int position = 0;
  std::uint64_t updatedAtMs = 0;

  // Trims both ends, then refuses: an empty title, a title past kMaxNoteTitleChars, a body past
  // kMaxNoteBodyBytes, text a `text` column cannot hold, a malformed id, a position off the list.
  // The three bound sentences are the wire's own 400s, forwarded verbatim by NotesApi.
  Note(NoteId id, UserId user, std::string title, std::string body, int position = 0,
       std::uint64_t updatedAtMs = 0);

  bool operator==(const Note&) const = default;
};

// Whether `order` names every note in `standing` exactly once — the rule a whole-order replace is
// refused against. Pure, so the fake and the SQL adapter decide it one way.
bool namesEveryNoteOnce(const std::vector<Note>& standing, const std::vector<NoteId>& order);

}
