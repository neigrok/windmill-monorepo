#include "products/gym/application/NotesService.h"

#include "test/platform/Fakes.h"
#include "test/products/gym/Fakes.h"
#include "test/testing.h"

#include <cstdint>
#include <string>
#include <vector>

using namespace wm;
using namespace wm::gym;
using namespace wm::gym::fake;

namespace {

// The store's rules over the fake, which applies the same ones as the SQL: owner scope, the ten
// cap, position contiguity, the replay, the whole-order replace.
struct Harness {
  FakeGym repo;
  wm::fake::FakeClock clock;
  NotesService notes{repo.notes, clock};

  Note note(const std::string& id, const std::string& title, const std::string& body = "",
            const std::string& user = "u1") {
    return Note{NoteId{id}, UserId{user}, title, body};
  }

  std::vector<std::string> titlesOf(const std::string& user = "u1") {
    std::vector<std::string> titles;
    for (const Note& held : notes.notes(UserId{user})) titles.push_back(held.title);
    return titles;
  }
};

}  // namespace

TEST(a_new_note_lands_last_and_is_dated_by_the_servers_clock) {
  Harness h;
  h.clock.now = 1'700'000'000'000;

  const NoteWriteOutcome first = h.notes.saveNote(h.note("note_00000001", "Tone", "Blunt."));
  h.clock.now += 60'000;
  const NoteWriteOutcome second = h.notes.saveNote(h.note("note_00000002", "Goal", "A 140 squat."));

  REQUIRE(first.error == NoteWriteError::none);
  REQUIRE(second.error == NoteWriteError::none);
  CHECK_EQ(*first.note, Note(NoteId{"note_00000001"}, uid(), "Tone", "Blunt.", 0, 1'700'000'000'000));
  CHECK_EQ(*second.note,
           Note(NoteId{"note_00000002"}, uid(), "Goal", "A 140 squat.", 1, 1'700'000'060'000));
  CHECK_EQ(h.notes.notes(uid()), (std::vector<Note>{*first.note, *second.note}));
  CHECK_EQ(h.notes.notes(UserId{"u2"}), std::vector<Note>{});
}

// The id is the idempotency key: the same text replays untouched, different text is an edit in
// place that keeps its position and moves only its instant.
TEST(a_replayed_note_reads_back_the_stored_row_and_a_changed_one_is_an_edit_in_place) {
  Harness h;
  h.clock.now = 1'700'000'000'000;
  h.notes.saveNote(h.note("note_00000001", "Tone", "Blunt."));
  h.notes.saveNote(h.note("note_00000002", "Goal", "A 140 squat."));
  h.clock.now += 60'000;

  const NoteWriteOutcome replayed = h.notes.saveNote(h.note("note_00000001", "Tone", "Blunt."));
  const NoteWriteOutcome edited = h.notes.saveNote(h.note("note_00000001", "Tone", "Blunt. Numbers first."));

  REQUIRE(replayed.error == NoteWriteError::none);
  CHECK_EQ(replayed.note->updatedAtMs, 1'700'000'000'000u);
  REQUIRE(edited.error == NoteWriteError::none);
  CHECK_EQ(edited.note->position, 0);
  CHECK_EQ(edited.note->body, std::string("Blunt. Numbers first."));
  CHECK_EQ(edited.note->updatedAtMs, 1'700'000'060'000u);
  CHECK_EQ(h.notes.notes(uid()).size(), std::size_t{2});
  CHECK_EQ(h.notes.notes(uid())[0], *edited.note);
}

TEST(the_eleventh_note_is_refused_and_an_edit_at_ten_still_lands) {
  Harness h;
  for (int at = 1; at <= 10; ++at)
    CHECK(h.notes.saveNote(h.note("note_000000" + std::to_string(10 + at), "Note " + std::to_string(at)))
              .error == NoteWriteError::none);

  const NoteWriteOutcome eleventh = h.notes.saveNote(h.note("note_00000099", "One too many"));
  const NoteWriteOutcome edited = h.notes.saveNote(h.note("note_00000020", "Note 10", "still fits"));

  CHECK(eleventh.error == NoteWriteError::full);
  CHECK_FALSE(eleventh.note.has_value());
  CHECK(edited.error == NoteWriteError::none);
  CHECK_EQ(h.notes.notes(uid()).size(), std::size_t{10});
  CHECK_EQ(h.notes.notes(uid()).back().position, 9);
}

// The primary key spans every account: an id another account holds is refused, never overwritten
// and never read back to the stranger.
TEST(an_id_another_account_holds_is_refused_and_their_note_is_untouched) {
  Harness h;
  h.notes.saveNote(h.note("note_00000001", "Tone", "Blunt."));

  const NoteWriteOutcome taken = h.notes.saveNote(h.note("note_00000001", "Mine now", "", "u2"));

  CHECK(taken.error == NoteWriteError::idTaken);
  CHECK_FALSE(taken.note.has_value());
  CHECK_EQ(h.titlesOf("u1"), std::vector<std::string>{"Tone"});
  CHECK_EQ(h.titlesOf("u2"), std::vector<std::string>{});
  CHECK_EQ(h.notes.notes(uid())[0].body, std::string("Blunt."));
}

TEST(deleting_a_note_closes_the_gap_and_a_second_delete_is_a_no_op) {
  Harness h;
  h.notes.saveNote(h.note("note_00000001", "A"));
  h.notes.saveNote(h.note("note_00000002", "B"));
  h.notes.saveNote(h.note("note_00000003", "C"));

  h.notes.deleteNote(uid(), NoteId{"note_00000002"});
  h.notes.deleteNote(uid(), NoteId{"note_00000002"});
  h.notes.deleteNote(UserId{"u2"}, NoteId{"note_00000001"});   // not theirs: nothing moves

  const std::vector<Note> left = h.notes.notes(uid());
  REQUIRE_EQ(left.size(), std::size_t{2});
  CHECK_EQ(left[0].id, NoteId{"note_00000001"});
  CHECK_EQ(left[0].position, 0);
  CHECK_EQ(left[1].id, NoteId{"note_00000003"});
  CHECK_EQ(left[1].position, 1);
  // The freed slot is taken by the next note, so ten stays reachable.
  CHECK_EQ(h.notes.saveNote(h.note("note_00000004", "D")).note->position, 2);
}

// Order is precedence: the whole list is replaced at once, and it must name every note once.
TEST(reordering_replaces_the_whole_order_or_refuses_it) {
  Harness h;
  h.clock.now = 1'700'000'000'000;
  h.notes.saveNote(h.note("note_00000001", "A"));
  h.notes.saveNote(h.note("note_00000002", "B"));
  h.notes.saveNote(h.note("note_00000003", "C"));
  h.notes.saveNote(h.note("note_00000009", "Theirs", "", "u2"));
  h.clock.now += 60'000;

  const NotesOrderOutcome moved =
      h.notes.reorderNotes(uid(), {NoteId{"note_00000003"}, NoteId{"note_00000001"}, NoteId{"note_00000002"}});

  REQUIRE(moved.error == NotesOrderError::none);
  CHECK_EQ(h.titlesOf(), (std::vector<std::string>{"C", "A", "B"}));
  CHECK_EQ(moved.notes, h.notes.notes(uid()));
  CHECK_EQ(moved.notes[0].position, 0);
  CHECK_EQ(moved.notes[2].position, 2);
  // Precedence is not the note's text, so nothing was re-dated.
  for (const Note& held : moved.notes) CHECK_EQ(held.updatedAtMs, 1'700'000'000'000u);

  for (const std::vector<NoteId>& bad : std::vector<std::vector<NoteId>>{
           {NoteId{"note_00000001"}, NoteId{"note_00000002"}},
           {NoteId{"note_00000001"}, NoteId{"note_00000001"}, NoteId{"note_00000002"}},
           {NoteId{"note_00000001"}, NoteId{"note_00000002"}, NoteId{"note_00000009"}},
           {NoteId{"note_00000001"}, NoteId{"note_00000002"}, NoteId{"note_00000003"},
            NoteId{"note_00000004"}},
           {}}) {
    const NotesOrderOutcome refused = h.notes.reorderNotes(uid(), bad);
    CHECK(refused.error == NotesOrderError::mismatch);
    CHECK(refused.notes.empty());
  }
  CHECK_EQ(h.titlesOf(), (std::vector<std::string>{"C", "A", "B"}));   // nothing moved
  CHECK_EQ(h.titlesOf("u2"), std::vector<std::string>{"Theirs"});
  // An account with nothing reorders nothing, and that is the one empty order that is not a mismatch.
  CHECK(h.notes.reorderNotes(UserId{"u3"}, {}).error == NotesOrderError::none);
}

TEST(the_notes_export_is_text_in_precedence_order) {
  Harness h;
  h.clock.now = 1'700'000'000'000;
  h.notes.saveNote(h.note("note_00000001", "Tone", "Blunt."));
  h.notes.saveNote(h.note("note_00000002", "Goal", ""));
  h.notes.saveNote(h.note("note_00000009", "Theirs", "", "u2"));
  h.notes.reorderNotes(uid(), {NoteId{"note_00000002"}, NoteId{"note_00000001"}});

  CHECK_EQ(h.notes.exportedNotes(uid()),
           (std::vector<ExportedNote>{{"0", "Goal", "", "2023-11-14T22:13:20Z"},
                                      {"1", "Tone", "Blunt.", "2023-11-14T22:13:20Z"}}));
  CHECK_EQ(h.notes.exportedNotes(UserId{"u3"}), std::vector<ExportedNote>{});
}
