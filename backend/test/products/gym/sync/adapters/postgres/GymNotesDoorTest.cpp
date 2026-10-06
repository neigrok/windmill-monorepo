#include "test/products/gym/sync/adapters/postgres/GymDoorFixture.h"
#include "test/testing.h"

#include <cstdint>
#include <cstdlib>
#include <string>
#include <vector>

using namespace wm;
using namespace wm::gym;
using namespace wm::gym::doortest;

namespace {

Note note(const UserId& owner, const std::string& id, const std::string& title, const std::string& body = "") {
  return Note{NoteId{id}, owner, title, body};
}

// What a phone sends through /v1/sync for one note: its changed fields, or its death.
Json::Value pushed(Harness& h, const UserId& account, const std::string& id, const Json::Value& fields,
                   bool dead = false) {
  return h.admit(account, {GymDoor::delta("note", id, fields, false, dead)});
}

}

TEST(a_new_note_lands_last_and_is_dated_by_the_servers_clock) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Harness h;
  h.clock.now = 1'700'000'000'000;

  const NoteWriteOutcome first = h.door.saveInsight(note(h.user, "note_00000001", "Tone", "Blunt."));
  h.clock.now += 60'000;
  const NoteWriteOutcome second = h.door.saveInsight(note(h.user, "note_00000002", "Goal", "A 140 squat."));

  REQUIRE(first.error == NoteWriteError::none);
  REQUIRE(second.error == NoteWriteError::none);
  CHECK_EQ(*first.note, Note(NoteId{"note_00000001"}, h.user, "Tone", "Blunt.", 0, 1'700'000'000'000));
  CHECK_EQ(*second.note,
           Note(NoteId{"note_00000002"}, h.user, "Goal", "A 140 squat.", 1, 1'700'000'060'000));
  CHECK_EQ(h.repo.notes.notes(h.user), (std::vector<Note>{*first.note, *second.note}));
  CHECK_EQ(h.repo.notes.notes(h.other), std::vector<Note>{});
}

// The id is the idempotency key, so the same text replays untouched; a phone's edit keeps the position and moves the instant.
TEST(a_replayed_note_reads_back_the_stored_row_and_a_changed_one_is_an_edit_in_place) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Harness h;
  h.clock.now = 1'700'000'000'000;
  h.door.saveInsight(note(h.user, "note_00000001", "Tone", "Blunt."));
  const NoteWriteOutcome goal = h.door.saveInsight(note(h.user, "note_00000002", "Goal", "A 140 squat."));
  h.clock.now += 60'000;

  const NoteWriteOutcome replayed = h.door.saveInsight(note(h.user, "note_00000001", "Tone", "Blunt."));
  Json::Value body(Json::objectValue);
  body["body"] = "Blunt. Numbers first.";
  const Json::Value edited = pushed(h, h.user, "note_00000001", body);

  REQUIRE(replayed.error == NoteWriteError::none);
  CHECK_EQ(*replayed.note, Note(NoteId{"note_00000001"}, h.user, "Tone", "Blunt.", 0, 1'700'000'000'000));
  CHECK_EQ(GymDoor::refusal(edited), std::string());
  CHECK_EQ(h.repo.notes.notes(h.user),
           (std::vector<Note>{Note(NoteId{"note_00000001"}, h.user, "Tone", "Blunt. Numbers first.", 0,
                                   1'700'000'060'000),
                              *goal.note}));
}

TEST(the_eleventh_note_is_refused_and_an_edit_at_ten_still_lands) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Harness h;
  for (int at = 1; at <= 10; ++at)
    CHECK(h.door.saveInsight(note(h.user, "note_000000" + std::to_string(10 + at), "Note " + std::to_string(at)))
              .error == NoteWriteError::none);

  const NoteWriteOutcome eleventh = h.door.saveInsight(note(h.user, "note_00000099", "One too many"));
  Json::Value body(Json::objectValue);
  body["body"] = "still fits";
  const Json::Value edited = pushed(h, h.user, "note_00000020", body);

  CHECK(eleventh.error == NoteWriteError::full);
  CHECK_FALSE(eleventh.note.has_value());
  CHECK_EQ(GymDoor::refusal(edited), std::string());
  CHECK_EQ(h.repo.notes.notes(h.user).size(), std::size_t{10});
  CHECK_EQ(h.repo.notes.notes(h.user).back(),
           Note(NoteId{"note_00000020"}, h.user, "Note 10", "still fits", 9, h.clock.now));
}

// The primary key spans every account: an id another account holds is refused, never overwritten
// and never read back to the stranger.
TEST(an_id_another_account_holds_is_refused_and_their_note_is_untouched) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Harness h;
  const NoteWriteOutcome mine = h.door.saveInsight(note(h.user, "note_00000001", "Tone", "Blunt."));

  const NoteWriteOutcome taken = h.door.saveInsight(note(h.other, "note_00000001", "Mine now"));

  CHECK(taken.error == NoteWriteError::idTaken);
  CHECK_FALSE(taken.note.has_value());
  CHECK_EQ(h.repo.notes.notes(h.user), std::vector<Note>{*mine.note});
  CHECK_EQ(h.repo.notes.notes(h.other), std::vector<Note>{});
}

// A note a phone deletes leaves no gap, and its freed slot is the next note's, so ten stays reachable.
TEST(deleting_a_note_closes_the_gap_and_a_second_delete_is_a_no_op) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Harness h;
  const NoteWriteOutcome a = h.door.saveInsight(note(h.user, "note_00000001", "A"));
  h.door.saveInsight(note(h.user, "note_00000002", "B"));
  const NoteWriteOutcome c = h.door.saveInsight(note(h.user, "note_00000003", "C"));

  h.kill(h.user, "note", "note_00000002");
  const Json::Value again = pushed(h, h.user, "note_00000002", Json::Value(Json::objectValue), true);
  const Json::Value stranger = pushed(h, h.other, "note_00000001", Json::Value(Json::objectValue), true);

  CHECK_EQ(GymDoor::refusal(again), std::string());
  CHECK_EQ(GymDoor::refusal(stranger), std::string());   // not theirs: answered, and nothing moves
  const std::vector<Note> left = h.repo.notes.notes(h.user);
  CHECK_EQ(left, (std::vector<Note>{*a.note, Note(NoteId{"note_00000003"}, h.user, "C", "", 1, c.note->updatedAtMs)}));
  CHECK_EQ(h.door.saveInsight(note(h.user, "note_00000004", "D")).note->position, 2);
}
