#include "products/gym/adapters/postgres/PgNotesRepository.h"

#include "test/products/gym/Fakes.h"
#include "test/products/gym/adapters/postgres/PgGymFixture.h"
#include "test/testing.h"

#include <pqxx/pqxx>

#include <cstdlib>
#include <exception>
#include <latch>
#include <string>
#include <thread>
#include <vector>

// The notes rows, against the real column checks and the deferred unique on (user_id, position).
// Every case drives the fake beside the store and asserts the two answer alike.
using namespace wm::gym;
using namespace wm::gym::pgtest;

namespace {

Note noteAt(const std::string& id, const std::string& title, const std::string& body = "",
            const std::string& owner = kUser) {
  return Note{NoteId{id}, wm::UserId{owner}, title, body};
}

std::vector<std::string> titlesOf(NotesRepository& repo, const std::string& owner = kUser) {
  std::vector<std::string> titles;
  for (const Note& held : repo.notes(wm::UserId{owner})) titles.push_back(held.title);
  return titles;
}

}  // namespace

TEST(pg_gym_notes_append_last_replay_untouched_and_edit_in_place) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgNotesRepository repo{wm::pgTestPool()};
  fake::FakeGym twin;

  CHECK_EQ(repo.notes(wm::UserId{kUser}), std::vector<Note>{});
  const NoteWriteOutcome first = repo.saveNote(noteAt("note_pg00001", "Tone", "Blunt."), kNow);
  const NoteWriteOutcome second =
      repo.saveNote(noteAt("note_pg00002", "Goal", "A 140 squat. 💀"), kNow + 60'000);
  const NoteWriteOutcome replayed = repo.saveNote(noteAt("note_pg00001", "Tone", "Blunt."), kNow + 120'000);
  const NoteWriteOutcome edited =
      repo.saveNote(noteAt("note_pg00001", "Tone", "Blunt. Numbers first."), kNow + 180'000);
  twin.notes.saveNote(noteAt("note_pg00001", "Tone", "Blunt."), kNow);
  twin.notes.saveNote(noteAt("note_pg00002", "Goal", "A 140 squat. 💀"), kNow + 60'000);
  twin.notes.saveNote(noteAt("note_pg00001", "Tone", "Blunt."), kNow + 120'000);
  twin.notes.saveNote(noteAt("note_pg00001", "Tone", "Blunt. Numbers first."), kNow + 180'000);

  REQUIRE(first.error == NoteWriteError::none);
  CHECK_EQ(*first.note, Note(NoteId{"note_pg00001"}, wm::UserId{kUser}, "Tone", "Blunt.", 0, kNow));
  REQUIRE(second.error == NoteWriteError::none);
  CHECK_EQ(second.note->position, 1);
  CHECK_EQ(second.note->body, std::string("A 140 squat. 💀"));   // byte for byte
  REQUIRE(replayed.error == NoteWriteError::none);
  CHECK_EQ(replayed.note->updatedAtMs, kNow);   // untouched: nothing was re-dated
  REQUIRE(edited.error == NoteWriteError::none);
  CHECK_EQ(edited.note->position, 0);
  CHECK_EQ(edited.note->updatedAtMs, kNow + 180'000);
  CHECK_EQ(repo.notes(wm::UserId{kUser}), twin.notes.notes(wm::UserId{kUser}));
  CHECK_EQ(repo.exportedNotes(wm::UserId{kUser}), twin.notes.exportedNotes(wm::UserId{kUser}));
  CHECK_EQ(repo.exportedNotes(wm::UserId{kUser})[0].updatedAt, std::string("2023-11-14T22:16:20Z"));
  reset();
}

TEST(pg_gym_notes_stop_at_ten_and_an_id_another_account_holds_is_refused) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgNotesRepository repo{wm::pgTestPool()};
  fake::FakeGym twin;
  for (int at = 1; at <= 10; ++at) {
    const std::string id = "note_pg000" + std::to_string(10 + at);
    CHECK(repo.saveNote(noteAt(id, "Note " + std::to_string(at)), kNow).error == NoteWriteError::none);
    twin.notes.saveNote(noteAt(id, "Note " + std::to_string(at)), kNow);
  }

  const NoteWriteOutcome eleventh = repo.saveNote(noteAt("note_pg00099", "One too many"), kNow);
  const NoteWriteOutcome taken = repo.saveNote(noteAt("note_pg00011", "Mine now", "", kOther), kNow);
  const NoteWriteOutcome edited = repo.saveNote(noteAt("note_pg00020", "Note 10", "still fits"), kNow);

  CHECK(eleventh.error == NoteWriteError::full);
  CHECK(twin.notes.saveNote(noteAt("note_pg00099", "One too many"), kNow).error == NoteWriteError::full);
  CHECK(taken.error == NoteWriteError::idTaken);
  CHECK(twin.notes.saveNote(noteAt("note_pg00011", "Mine now", "", kOther), kNow).error ==
        NoteWriteError::idTaken);
  CHECK(edited.error == NoteWriteError::none);
  CHECK_EQ(repo.notes(wm::UserId{kUser}).size(), std::size_t{10});
  CHECK_EQ(repo.notes(wm::UserId{kUser})[0].title, std::string("Note 1"));   // the stranger changed nothing
  CHECK_EQ(repo.notes(wm::UserId{kOther}), std::vector<Note>{});
  reset();
}

TEST(pg_gym_notes_delete_closes_the_gap_and_reorder_replaces_the_whole_order) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgNotesRepository repo{wm::pgTestPool()};
  fake::FakeGym twin;
  for (NotesRepository* store : {static_cast<NotesRepository*>(&repo),
                                 static_cast<NotesRepository*>(&twin.notes)}) {
    store->saveNote(noteAt("note_pg00001", "A"), kNow);
    store->saveNote(noteAt("note_pg00002", "B"), kNow);
    store->saveNote(noteAt("note_pg00003", "C"), kNow);
    store->saveNote(noteAt("note_pg00009", "Theirs", "", kOther), kNow);
  }

  repo.deleteNote(wm::UserId{kUser}, NoteId{"note_pg00002"});
  repo.deleteNote(wm::UserId{kUser}, NoteId{"note_pg00002"});
  repo.deleteNote(wm::UserId{kUser}, NoteId{"note_pg00009"});   // not theirs: nothing moves
  twin.notes.deleteNote(wm::UserId{kUser}, NoteId{"note_pg00002"});
  twin.notes.deleteNote(wm::UserId{kUser}, NoteId{"note_pg00009"});

  CHECK_EQ(repo.notes(wm::UserId{kUser}), twin.notes.notes(wm::UserId{kUser}));
  CHECK_EQ(titlesOf(repo), (std::vector<std::string>{"A", "C"}));
  CHECK_EQ(repo.notes(wm::UserId{kUser})[1].position, 1);
  CHECK_EQ(titlesOf(repo, kOther), std::vector<std::string>{"Theirs"});
  CHECK_EQ(repo.saveNote(noteAt("note_pg00004", "D"), kNow).note->position, 2);
  twin.notes.saveNote(noteAt("note_pg00004", "D"), kNow);

  // A swap of the first and last row: the deferred unique lets both move in one transaction.
  const std::vector<NoteId> swapped{NoteId{"note_pg00004"}, NoteId{"note_pg00003"}, NoteId{"note_pg00001"}};
  const NotesOrderOutcome moved = repo.reorderNotes(wm::UserId{kUser}, swapped);
  twin.notes.reorderNotes(wm::UserId{kUser}, swapped);

  REQUIRE(moved.error == NotesOrderError::none);
  CHECK_EQ(moved.notes, twin.notes.notes(wm::UserId{kUser}));
  CHECK_EQ(titlesOf(repo), (std::vector<std::string>{"D", "C", "A"}));
  for (const Note& held : moved.notes) CHECK_EQ(held.updatedAtMs, kNow);   // precedence re-dates nothing

  for (const std::vector<NoteId>& bad : std::vector<std::vector<NoteId>>{
           {NoteId{"note_pg00001"}, NoteId{"note_pg00003"}},
           {NoteId{"note_pg00001"}, NoteId{"note_pg00001"}, NoteId{"note_pg00003"}},
           {NoteId{"note_pg00001"}, NoteId{"note_pg00003"}, NoteId{"note_pg00009"}},
           {}}) {
    CHECK(repo.reorderNotes(wm::UserId{kUser}, bad).error == NotesOrderError::mismatch);
    CHECK(twin.notes.reorderNotes(wm::UserId{kUser}, bad).error == NotesOrderError::mismatch);
  }
  CHECK_EQ(titlesOf(repo), (std::vector<std::string>{"D", "C", "A"}));
  CHECK_EQ(titlesOf(repo, kOther), std::vector<std::string>{"Theirs"});
  reset();
}

// Saves that overlap in flight, each on its own pooled connection: every distinct id lands at its
// own position, and a twin of a NEW id whose first flight has not answered yet reads back the
// stored row. Neither is a 500 — no client can tell a lost reply from a lost race.
TEST(pg_gym_notes_overlapping_saves_queue_and_an_in_flight_twin_replays) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgNotesRepository repo{wm::pgTestPool()};
  constexpr int kDistinct = 6;
  constexpr int kTwins = 4;
  std::vector<NoteWriteOutcome> answers(kDistinct + kTwins);
  std::vector<std::string> thrown(kDistinct + kTwins);
  std::latch together{kDistinct + kTwins};
  std::vector<std::thread> racers;
  for (int at = 0; at < kDistinct + kTwins; ++at)
    racers.emplace_back([&, at] {
      const Note note = at < kDistinct
                            ? noteAt("note_pgrace0" + std::to_string(at), "Race " + std::to_string(at))
                            : noteAt("note_pgtwin01", "Twin", "the same text, four times over");
      together.arrive_and_wait();
      try {
        answers[at] = repo.saveNote(note, kNow);
      } catch (const std::exception& failed) {
        thrown[at] = failed.what();
      }
    });
  for (std::thread& racer : racers) racer.join();

  for (int at = 0; at < kDistinct + kTwins; ++at) {
    CHECK_EQ(thrown[at], std::string(""));
    CHECK(answers[at].error == NoteWriteError::none);
    REQUIRE(answers[at].note.has_value());
  }
  for (int at = kDistinct; at < kDistinct + kTwins; ++at)
    CHECK_EQ(*answers[at].note, *answers[kDistinct].note);   // one row, read back by all four
  const std::vector<Note> held = repo.notes(wm::UserId{kUser});
  REQUIRE_EQ(held.size(), static_cast<std::size_t>(kDistinct + 1));
  for (int at = 0; at <= kDistinct; ++at) CHECK_EQ(held[at].position, at);
  reset();
}

TEST(pg_gym_notes_cascade_with_the_account) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgNotesRepository repo{wm::pgTestPool()};
  repo.saveNote(noteAt("note_pg00001", "Tone", "Blunt."), kNow);
  repo.saveNote(noteAt("note_pg00009", "Theirs", "", kOther), kNow);

  {
    wm::PgLease conn{*wm::pgTestPool()};
    pqxx::work txn{*conn};
    txn.exec_params("DELETE FROM users WHERE id = $1::uuid", kUser);
    txn.commit();
  }
  CHECK_EQ(repo.notes(wm::UserId{kUser}), std::vector<Note>{});
  CHECK_EQ(titlesOf(repo, kOther), std::vector<std::string>{"Theirs"});
  reset();
}

// The columns carry the same three bounds the entity does, written against raw SQL because the
// entity can never send these.
TEST(pg_gym_notes_columns_refuse_what_the_domain_refuses) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  const std::string row = "INSERT INTO gym_notes (id, user_id, position, title, body) VALUES ";
  const std::vector<std::string> refused{
      row + "('note_pgbad01', '" + kUser + "', 0, '', '')",
      row + "('note_pgbad02', '" + kUser + "', 0, '" + std::string(61, 'a') + "', '')",
      row + "('note_pgbad03', '" + kUser + "', 0, 'Tone', '" + std::string(501, 'b') + "')",
      row + "('note_pgbad04', '" + kUser + "', 10, 'Tone', '')",
      row + "('note_pgbad05', '" + kUser + "', -1, 'Tone', '')",
      row + "('note_pgbad06', '" + kUser + "', 0, 'Tone', ''), "
            "('note_pgbad07', '" + kUser + "', 0, 'Tone', '')"};   // two at one position
  for (const std::string& statement : refused) {
    bool stopped = false;
    try {
      wm::PgLease conn{*wm::pgTestPool()};
      pqxx::work txn{*conn};
      txn.exec(statement);
      txn.commit();
    } catch (const std::exception&) {
      stopped = true;
    }
    CHECK(stopped);
  }
  // Sixty accented characters are sixty characters, and 250 of them are 500 bytes.
  std::string sixty;
  for (int at = 0; at < 60; ++at) sixty += "é";
  std::string fiveHundred;
  for (int at = 0; at < 250; ++at) fiveHundred += "é";
  {
    wm::PgLease conn{*wm::pgTestPool()};
    pqxx::work txn{*conn};
    txn.exec_params("INSERT INTO gym_notes (id, user_id, position, title, body) "
                    "VALUES ('note_pgok0001', $1::uuid, 0, $2, $3)",
                    kUser, sixty, fiveHundred);
    txn.commit();
  }
  PgNotesRepository repo{wm::pgTestPool()};
  REQUIRE_EQ(repo.notes(wm::UserId{kUser}).size(), std::size_t{1});
  CHECK_EQ(repo.notes(wm::UserId{kUser})[0].title, sixty);
  CHECK_EQ(repo.notes(wm::UserId{kUser})[0].body, fiveHundred);
  reset();
}
