#include "products/gym/domain/Note.h"

#include <algorithm>
#include <utility>

namespace wm::gym {

namespace {
// Code points, not bytes: `char_length` is what the column checks, and a title of sixty accented
// letters is sixty characters. Only well-formed UTF-8 reaches here, so every non-continuation byte
// starts a point.
std::size_t codePoints(const std::string& text) {
  std::size_t points = 0;
  for (const char c : text)
    if ((static_cast<unsigned char>(c) & 0xC0) != 0x80) ++points;
  return points;
}

// Unicode's White_Space property: the ASCII blanks `trimmedName` strips, plus NEL, the no-break
// space, the ogham mark, the en/em family, the line and paragraph separators, the narrow no-break
// space, the medium mathematical space and the ideographic space — every one an invisible title.
bool isWhitespace(unsigned int point) {
  return (point >= 0x09 && point <= 0x0D) || point == 0x20 || point == 0x85 || point == 0xA0 ||
         point == 0x1680 || (point >= 0x2000 && point <= 0x200A) || point == 0x2028 ||
         point == 0x2029 || point == 0x202F || point == 0x205F || point == 0x3000;
}

// Decodes the code point starting at `at`, answering its byte width, or 0 where no well-formed
// sequence starts there — malformed bytes are left standing for `storableText` to refuse.
std::size_t decodeAt(const std::string& text, std::size_t at, unsigned int& point) {
  const unsigned char lead = static_cast<unsigned char>(text[at]);
  if (lead < 0x80) {
    point = lead;
    return 1;
  }
  if (lead < 0xC2 || lead > 0xF4) return 0;
  const std::size_t width = lead < 0xE0 ? 2 : (lead < 0xF0 ? 3 : 4);
  if (at + width > text.size()) return 0;
  point = lead & (width == 2 ? 0x1Fu : (width == 3 ? 0x0Fu : 0x07u));
  for (std::size_t step = 1; step < width; ++step) {
    const unsigned char next = static_cast<unsigned char>(text[at + step]);
    if ((next & 0xC0) != 0x80) return 0;
    point = (point << 6) | (next & 0x3Fu);
  }
  return width;
}

// The trim every display name gets, widened to Unicode blanks at both ends: a title of no-break
// spaces is the empty title it is, and a blank inside the text stays exactly as typed.
std::string trimmedText(std::string text) {
  std::size_t first = 0;
  while (first < text.size()) {
    unsigned int point = 0;
    const std::size_t width = decodeAt(text, first, point);
    if (width == 0 || !isWhitespace(point)) break;
    first += width;
  }
  std::size_t last = text.size();
  while (last > first) {
    std::size_t start = last - 1;
    while (start > first && (static_cast<unsigned char>(text[start]) & 0xC0) == 0x80 &&
           last - start < 4)
      --start;
    unsigned int point = 0;
    if (decodeAt(text, start, point) != last - start || !isWhitespace(point)) break;
    last = start;
  }
  return text.substr(first, last - first);
}
}

Note::Note(NoteId id, UserId user, std::string title, std::string body, int position,
           std::uint64_t updatedAtMs)
    : id(std::move(id)), user(std::move(user)), title(trimmedText(std::move(title))),
      body(trimmedText(std::move(body))), position(position), updatedAtMs(updatedAtMs) {
  // Unreadable before unstorable: a NUL or a bad byte is refused as a note nobody can read, with
  // the sentence the wire's other unreadable bodies get.
  if (!wellFormedId(this->id.str())) throw InvalidTraining("could not read that note");
  if (this->user.empty()) throw InvalidTraining("a note belongs to an account");
  if (!storableText(this->title) || !storableText(this->body))
    throw InvalidTraining("could not read that note");
  if (this->title.empty()) throw InvalidTraining("a note needs a title");
  if (codePoints(this->title) > kMaxNoteTitleChars)
    throw InvalidTraining("a title runs to 60 characters");
  if (this->body.size() > kMaxNoteBodyBytes) throw InvalidTraining("a note runs to 500 bytes");
  if (position < 0 || position >= static_cast<int>(kMaxNotes))
    throw InvalidTraining("a note sits at a position from 0 to 9");
  if (updatedAtMs > kMaxInstantMs) throw InvalidTraining("a note was written at an instant");
}

bool namesEveryNoteOnce(const std::vector<Note>& standing, const std::vector<NoteId>& order) {
  if (order.size() != standing.size()) return false;
  for (const Note& note : standing)
    if (std::count(order.begin(), order.end(), note.id) != 1) return false;
  return true;
}

}
