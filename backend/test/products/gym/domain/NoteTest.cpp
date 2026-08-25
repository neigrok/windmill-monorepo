#include "products/gym/domain/Note.h"

#include "test/testing.h"

#include <functional>
#include <string>
#include <vector>

using namespace wm;
using namespace wm::gym;

namespace {

// The sentence the constructor refused with, or empty when it built.
std::string refusal(const std::function<void()>& build) {
  try {
    build();
    return "";
  } catch (const InvalidTraining& refused) {
    return refused.what();
  }
}

const UserId kLifter{"lifter"};

Note note(std::string title, std::string body) {
  return Note{NoteId{"note_00000001"}, kLifter, std::move(title), std::move(body)};
}

}  // namespace

TEST(a_note_trims_both_ends_and_keeps_what_the_lifter_typed) {
  const Note kept = note("  How I want to be talked to \n", "\tBlunt.\r\n\r\n");

  CHECK_EQ(kept.title, std::string("How I want to be talked to"));
  CHECK_EQ(kept.body, std::string("Blunt."));
  CHECK_EQ(kept.position, 0);
  CHECK_EQ(kept.updatedAtMs, 0u);
  // Verbatim inside: nothing summarises, nothing normalises a lifter's line breaks or emoji.
  CHECK_EQ(note("Tone", "Blunt.\n\nNo praise 💀").body, std::string("Blunt.\n\nNo praise 💀"));
}

TEST(a_note_needs_a_title_and_may_have_no_body) {
  CHECK_EQ(refusal([] { note("", "Blunt."); }), std::string("a note needs a title"));
  CHECK_EQ(refusal([] { note("   \n", "Blunt."); }), std::string("a note needs a title"));
  CHECK_EQ(refusal([] { note("Tone", ""); }), std::string(""));
  CHECK_EQ(note("Tone", "   ").body, std::string(""));
}

// Unicode's blanks are blanks: a title of no-break spaces is no title, one wrapped in them is what
// the lifter typed, and a blank INSIDE the text stays byte for byte.
TEST(a_note_trims_unicode_whitespace_at_both_ends_and_nowhere_else) {
  const std::string nbsp = "\xC2\xA0";            // U+00A0
  const std::string nel = "\xC2\x85";             // U+0085
  const std::string ogham = "\xE1\x9A\x80";        // U+1680
  const std::string enQuad = "\xE2\x80\x80";       // U+2000
  const std::string emSpace = "\xE2\x80\x83";      // U+2003
  const std::string hairSpace = "\xE2\x80\x8A";    // U+200A
  const std::string lineSep = "\xE2\x80\xA8";      // U+2028
  const std::string paraSep = "\xE2\x80\xA9";      // U+2029
  const std::string narrowNbsp = "\xE2\x80\xAF";   // U+202F
  const std::string mathSpace = "\xE2\x81\x9F";    // U+205F
  const std::string ideographic = "\xE3\x80\x80";  // U+3000
  const std::string needsTitle = "a note needs a title";

  CHECK_EQ(refusal([&] { note(nbsp, "Blunt."); }), needsTitle);
  CHECK_EQ(refusal([&] { note(emSpace + emSpace, "Blunt."); }), needsTitle);
  CHECK_EQ(refusal([&] { note(ideographic, ""); }), needsTitle);
  CHECK_EQ(refusal([&] {
             note(" " + nbsp + "\n" + nel + ogham + enQuad + hairSpace + lineSep + paraSep +
                      narrowNbsp + mathSpace + "\t",
                  "");
           }),
           needsTitle);

  const Note trimmed = note(nbsp + " Tone" + emSpace + "\n", ideographic + "Blunt." + nbsp);
  CHECK_EQ(trimmed.title, std::string("Tone"));
  CHECK_EQ(trimmed.body, std::string("Blunt."));
  CHECK_EQ(note("No" + nbsp + "praise", "Be" + emSpace + "blunt").title, "No" + nbsp + "praise");
  CHECK_EQ(note("No" + nbsp + "praise", "Be" + emSpace + "blunt").body, "Be" + emSpace + "blunt");
  // A four-byte tail that is not a blank stays, and a note of only blanks has an empty body.
  CHECK_EQ(note("Tone \xF0\x9F\x92\x80", "").title, std::string("Tone \xF0\x9F\x92\x80"));
  CHECK_EQ(note("Tone", nbsp + ideographic).body, std::string(""));
  // Trimmed before the count: sixty letters wrapped in no-break spaces is sixty letters.
  CHECK_EQ(refusal([&] { note(nbsp + std::string(60, 'a') + nbsp, ""); }), std::string(""));
  // A malformed tail is left for the storable check, never swallowed by the trim.
  CHECK_EQ(refusal([] { note("Tone\xC2", ""); }), std::string("could not read that note"));
  CHECK_EQ(refusal([] { note("Tone\xE2\x80", ""); }), std::string("could not read that note"));
}

// Sixty CHARACTERS, the column's char_length: an accented title of sixty letters builds.
TEST(a_title_runs_to_sixty_characters_counted_as_code_points) {
  const std::string sixtyAscii(60, 'a');
  std::string sixtyAccented;
  for (int at = 0; at < 60; ++at) sixtyAccented += "é";   // two bytes each: 120 bytes, 60 chars
  std::string sixtyEmoji;
  for (int at = 0; at < 60; ++at) sixtyEmoji += "💀";      // four bytes each

  CHECK_EQ(refusal([&] { note(sixtyAscii, ""); }), std::string(""));
  CHECK_EQ(refusal([&] { note(sixtyAccented, ""); }), std::string(""));
  CHECK_EQ(refusal([&] { note(sixtyEmoji, ""); }), std::string(""));
  CHECK_EQ(refusal([&] { note(sixtyAscii + "a", ""); }),
           std::string("a title runs to 60 characters"));
  CHECK_EQ(refusal([&] { note(sixtyAccented + "é", ""); }),
           std::string("a title runs to 60 characters"));
  // Trimmed first: sixty letters wrapped in blanks is sixty letters.
  CHECK_EQ(refusal([&] { note("  " + sixtyAscii + "  ", ""); }), std::string(""));
}

// Five hundred BYTES, the column's octet_length: a body of accented letters fills it twice as fast.
TEST(a_body_runs_to_five_hundred_bytes_counted_as_bytes) {
  const std::string fiveHundred(500, 'b');
  std::string accented;
  for (int at = 0; at < 250; ++at) accented += "é";   // 500 bytes, 250 characters

  CHECK_EQ(refusal([&] { note("Tone", fiveHundred); }), std::string(""));
  CHECK_EQ(refusal([&] { note("Tone", accented); }), std::string(""));
  CHECK_EQ(refusal([&] { note("Tone", fiveHundred + "b"); }), std::string("a note runs to 500 bytes"));
  CHECK_EQ(refusal([&] { note("Tone", accented + "é"); }), std::string("a note runs to 500 bytes"));
  CHECK_EQ(refusal([&] { note("Tone", "  " + fiveHundred + "  "); }), std::string(""));
}

// The id shape every client-minted id shares, and text a `text` column can hold — both refused as
// a note nobody can read, the sentence the wire's other unreadable bodies get.
TEST(a_note_with_a_bad_id_or_unstorable_text_is_unreadable) {
  CHECK_EQ(refusal([] { Note{NoteId{""}, kLifter, "Tone", ""}; }),
           std::string("could not read that note"));
  CHECK_EQ(refusal([] { Note{NoteId{"note_1"}, kLifter, "Tone", ""}; }),
           std::string("could not read that note"));
  CHECK_EQ(refusal([] { Note{NoteId{"note_0000001; drop"}, kLifter, "Tone", ""}; }),
           std::string("could not read that note"));
  CHECK_EQ(refusal([] { note(std::string("To\0ne", 5), ""); }),
           std::string("could not read that note"));
  CHECK_EQ(refusal([] { note("Tone", "bench \xED\xA0\x80 stuck"); }),
           std::string("could not read that note"));
  CHECK_EQ(refusal([] { Note{NoteId{"note_00000001"}, UserId{}, "Tone", ""}; }),
           std::string("a note belongs to an account"));
}

TEST(a_note_sits_at_one_of_ten_positions) {
  CHECK_EQ(refusal([] { Note{NoteId{"note_00000001"}, kLifter, "Tone", "", 9}; }), std::string(""));
  CHECK_EQ(refusal([] { Note{NoteId{"note_00000001"}, kLifter, "Tone", "", 10}; }),
           std::string("a note sits at a position from 0 to 9"));
  CHECK_EQ(refusal([] { Note{NoteId{"note_00000001"}, kLifter, "Tone", "", -1}; }),
           std::string("a note sits at a position from 0 to 9"));
  CHECK_EQ(kMaxNotes, std::size_t{10});
  CHECK_EQ(kMaxNoteTitleChars, std::size_t{60});
  CHECK_EQ(kMaxNoteBodyBytes, std::size_t{500});
}

// The whole-order rule, decided one way for the fake and the SQL.
TEST(an_order_names_every_note_exactly_once) {
  const std::vector<Note> standing{Note{NoteId{"note_00000001"}, kLifter, "A", "", 0},
                                   Note{NoteId{"note_00000002"}, kLifter, "B", "", 1}};

  CHECK(namesEveryNoteOnce(standing, {NoteId{"note_00000002"}, NoteId{"note_00000001"}}));
  CHECK(namesEveryNoteOnce({}, {}));
  CHECK_FALSE(namesEveryNoteOnce(standing, {NoteId{"note_00000001"}}));
  CHECK_FALSE(namesEveryNoteOnce(standing, {NoteId{"note_00000001"}, NoteId{"note_00000001"}}));
  CHECK_FALSE(namesEveryNoteOnce(standing, {NoteId{"note_00000001"}, NoteId{"note_00000009"}}));
  CHECK_FALSE(namesEveryNoteOnce(
      standing, {NoteId{"note_00000001"}, NoteId{"note_00000002"}, NoteId{"note_00000003"}}));
}
