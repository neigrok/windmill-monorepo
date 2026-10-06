#include "products/gym/adapters/postgres/PgNotesRepository.h"

#include "test/products/gym/sync/adapters/postgres/GymDoorFixture.h"
#include "test/products/gym/adapters/postgres/PgGymFixture.h"
#include "test/testing.h"

#include "platform/adapters/json/JsonText.h"
#include "platform/domain/sync/FractionalIndex.h"

#include <pqxx/pqxx>

#include <cstdlib>
#include <exception>
#include <latch>
#include <optional>
#include <string>
#include <thread>
#include <vector>

// The notes rows against the real column checks, written by a phone's /v1/sync and Coach's save_note.
using namespace wm;
using namespace wm::gym;
using namespace wm::gym::pgtest;

namespace {

// The fractional keys a phone hands out when it appends: each one sorts after the one before.
std::vector<std::string> appendKeys(int count) {
  std::vector<std::string> keys;
  std::optional<std::string> last;
  for (int at = 0; at < count; ++at) keys.push_back(*(last = sync::between(last, std::nullopt)));
  return keys;
}

// A phone's note write through /v1/sync: a create carries its ord, an edit only the text.
Json::Value phoneNote(doortest::Harness& h, const UserId& owner, const std::string& id, const std::string& title,
                      const std::string& body, std::optional<std::string> ord = std::nullopt) {
  Json::Value fields(Json::objectValue);
  fields["title"] = title;
  fields["body"] = body;
  if (ord) fields["ord"] = *ord;
  return h.admit(owner, {GymDoor::delta("note", id, fields, ord.has_value())});
}

std::vector<std::string> titlesOf(NotesRepository& repo, const UserId& owner) {
  std::vector<std::string> titles;
  for (const Note& held : repo.notes(owner)) titles.push_back(held.title);
  return titles;
}

}  // namespace

TEST(pg_gym_notes_append_last_replay_untouched_and_edit_in_place) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  doortest::Harness h;
  const std::vector<std::string> keys = appendKeys(2);
  CHECK_EQ(h.repo.notes.notes(h.user), std::vector<Note>{});

  CHECK_EQ(GymDoor::refusal(phoneNote(h, h.user, "note_pg00001", "Tone", "Blunt.", keys[0])), "");
  const Note tone{NoteId{"note_pg00001"}, h.user, "Tone", "Blunt.", 0, kNow};
  CHECK_EQ(h.repo.notes.notes(h.user), std::vector<Note>{tone});
  h.clock.now = kNow + 60'000;
  CHECK_EQ(GymDoor::refusal(phoneNote(h, h.user, "note_pg00002", "Goal", "A 140 squat. 💀", keys[1])), "");
  const Note goal{NoteId{"note_pg00002"}, h.user, "Goal", "A 140 squat. 💀", 1, kNow + 60'000};   // byte for byte
  CHECK_EQ(h.repo.notes.notes(h.user), (std::vector<Note>{tone, goal}));
  // The same text again re-dates nothing.
  h.clock.now = kNow + 120'000;
  CHECK_EQ(GymDoor::refusal(phoneNote(h, h.user, "note_pg00001", "Tone", "Blunt.")), "");
  CHECK_EQ(h.repo.notes.notes(h.user), (std::vector<Note>{tone, goal}));
  h.clock.now = kNow + 180'000;
  CHECK_EQ(GymDoor::refusal(phoneNote(h, h.user, "note_pg00001", "Tone", "Blunt. Numbers first.")), "");
  CHECK_EQ(h.repo.notes.notes(h.user),
           (std::vector<Note>{Note{NoteId{"note_pg00001"}, h.user, "Tone", "Blunt. Numbers first.", 0, kNow + 180'000},
                              goal}));
}

TEST(pg_gym_notes_stop_at_ten_and_an_id_another_account_holds_is_refused) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  doortest::Harness h;
  const std::vector<std::string> keys = appendKeys(11);
  std::vector<Note> held;
  for (int at = 1; at <= 10; ++at) {
    const std::string id = "note_pg000" + std::to_string(10 + at);
    CHECK_EQ(GymDoor::refusal(phoneNote(h, h.user, id, "Note " + std::to_string(at), "", keys[at - 1])), "");
    held.push_back(Note{NoteId{id}, h.user, "Note " + std::to_string(at), "", at - 1, kNow});
  }

  const Json::Value eleventh = phoneNote(h, h.user, "note_pg00099", "One too many", "", keys[10]);
  const Json::Value taken = phoneNote(h, h.other, "note_pg00011", "Mine now", "", keys[0]);
  const Json::Value edited = phoneNote(h, h.user, "note_pg00020", "Note 10", "still fits");

  CHECK_EQ(eleventh, parse(R"({"s":"refused","code":"cap","detail":{"type":"note","cap":10}})"));
  CHECK_EQ(taken, parse(R"({"s":"refused","code":"id-taken"})"));
  CHECK_EQ(GymDoor::refusal(edited), "");
  held[9].body = "still fits";
  CHECK_EQ(h.repo.notes.notes(h.user), held);   // the stranger changed nothing
  CHECK_EQ(h.repo.notes.notes(h.other), std::vector<Note>{});
}

TEST(pg_gym_notes_delete_closes_the_gap_and_reorder_replaces_the_whole_order) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  doortest::Harness h;
  const std::vector<std::string> keys = appendKeys(4);
  GymDoor::requireOk(phoneNote(h, h.user, "note_pg00001", "A", "", keys[0]));
  GymDoor::requireOk(phoneNote(h, h.user, "note_pg00002", "B", "", keys[1]));
  GymDoor::requireOk(phoneNote(h, h.user, "note_pg00003", "C", "", keys[2]));
  GymDoor::requireOk(phoneNote(h, h.other, "note_pg00009", "Theirs", "", keys[0]));

  h.kill(h.user, "note", "note_pg00002");
  h.kill(h.user, "note", "note_pg00002");
  h.kill(h.user, "note", "note_pg00009");   // not theirs: nothing moves

  CHECK_EQ(h.repo.notes.notes(h.user), (std::vector<Note>{Note{NoteId{"note_pg00001"}, h.user, "A", "", 0, kNow},
                                                          Note{NoteId{"note_pg00003"}, h.user, "C", "", 1, kNow}}));
  CHECK_EQ(titlesOf(h.repo.notes, h.other), std::vector<std::string>{"Theirs"});
  GymDoor::requireOk(phoneNote(h, h.user, "note_pg00004", "D", "", keys[3]));
  CHECK_EQ(h.repo.notes.notes(h.user).at(2), (Note{NoteId{"note_pg00004"}, h.user, "D", "", 2, kNow}));

  // A swap of the first and last note: every moved note takes a new ord in one admission.
  h.clock.now = kNow + 60'000;
  const std::vector<std::string> swapped{"note_pg00004", "note_pg00003", "note_pg00001"};
  std::vector<Json::Value> moves;
  for (std::size_t at = 0; at < swapped.size(); ++at) {
    Json::Value fields(Json::objectValue);
    fields["ord"] = keys[at];
    moves.push_back(GymDoor::delta("note", swapped[at], fields));
  }
  GymDoor::requireOk(h.admit(h.user, moves));

  // Precedence re-dates nothing.
  CHECK_EQ(h.repo.notes.notes(h.user), (std::vector<Note>{Note{NoteId{"note_pg00004"}, h.user, "D", "", 0, kNow},
                                                          Note{NoteId{"note_pg00003"}, h.user, "C", "", 1, kNow},
                                                          Note{NoteId{"note_pg00001"}, h.user, "A", "", 2, kNow}}));
  CHECK_EQ(titlesOf(h.repo.notes, h.other), std::vector<std::string>{"Theirs"});
}

TEST(pg_gym_notes_cascade_with_the_account) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgNotesRepository repo{pgTestPool()};
  {
    PgLease conn{*pgTestPool()};
    pqxx::work txn{*conn};
    txn.exec("INSERT INTO gym_notes (id, user_id, position, title, body) VALUES "
             "('note_pg00001', $1::uuid, 0, 'Tone', 'Blunt.'), ('note_pg00009', $2::uuid, 0, 'Theirs', '')",
             pqxx::params{kUser, kOther});
    txn.exec("DELETE FROM users WHERE id = $1::uuid", pqxx::params{kUser});
    txn.commit();
  }
  CHECK_EQ(repo.notes(UserId{kUser}), std::vector<Note>{});
  CHECK_EQ(titlesOf(repo, UserId{kOther}), std::vector<std::string>{"Theirs"});
  reset();
}

// The columns carry the entity's three bounds, written as raw SQL because the entity can never send these.
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
      PgLease conn{*pgTestPool()};
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
    PgLease conn{*pgTestPool()};
    pqxx::work txn{*conn};
    txn.exec("INSERT INTO gym_notes (id, user_id, position, title, body) "
             "VALUES ('note_pgok0001', $1::uuid, 0, $2, $3)",
             pqxx::params{kUser, sixty, fiveHundred});
    txn.commit();
  }
  PgNotesRepository repo{pgTestPool()};
  REQUIRE_EQ(repo.notes(UserId{kUser}).size(), std::size_t{1});
  CHECK_EQ(repo.notes(UserId{kUser})[0].title, sixty);
  CHECK_EQ(repo.notes(UserId{kUser})[0].body, fiveHundred);
  reset();
}

TEST(pg_gym_insight_save_survives_lost_ack_user_edit_and_delete_without_overwrite_or_restore) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  doortest::Harness h;
  GymDoor::requireOk(phoneNote(h, h.user, "note_hand001", "Priority", "Keep this first.", appendKeys(1)[0]));
  const Note hand{NoteId{"note_hand001"}, h.user, "Priority", "Keep this first.", 0, kNow};
  const Note input{NoteId{"note_coach01"}, h.user, "Schedule", "I train on Monday and Thursday."};

  h.clock.now = kNow + 1;
  const NoteWriteOutcome first = h.notes.saveInsight(input);
  REQUIRE(first.note.has_value());
  CHECK_EQ(*first.note, (Note{input.id, h.user, input.title, input.body, 1, kNow + 1}));
  h.clock.now = kNow + 2;
  CHECK_EQ(h.notes.saveInsight(input).note, first.note);
  CHECK_EQ(h.repo.notes.notes(h.user), (std::vector<Note>{hand, *first.note}));
  CHECK_FALSE(h.notes.noteSave(h.other, input.id).has_value());
  h.clock.now = kNow + 3;
  CHECK(h.notes.saveInsight(Note{input.id, h.other, input.title, input.body}).error == NoteWriteError::idTaken);
  h.clock.now = kNow + 4;
  GymDoor::requireOk(phoneNote(h, h.user, input.id.str(), "Schedule", "I now train on Tuesday."));
  h.clock.now = kNow + 5;
  CHECK_EQ(h.notes.saveInsight(input).note, first.note);
  CHECK_EQ(h.repo.notes.notes(h.user),
           (std::vector<Note>{hand, Note{input.id, h.user, "Schedule", "I now train on Tuesday.", 1, kNow + 4}}));
  h.kill(h.user, "note", input.id.str());
  h.clock.now = kNow + 6;
  CHECK_EQ(h.notes.saveInsight(input).note, first.note);
  CHECK_EQ(h.notes.noteSave(h.user, input.id), first.note);
  CHECK_EQ(h.repo.notes.notes(h.user), std::vector<Note>{hand});
  h.clock.now = kNow + 7;
  CHECK(h.notes.saveInsight(Note{NoteId{"note_hand001"}, h.user, "Changed", "Not allowed"}).error ==
        NoteWriteError::idTaken);
  CHECK_EQ(h.repo.notes.notes(h.user), std::vector<Note>{hand});
}

TEST(pg_gym_insight_exact_text_deduplicates_at_capacity_and_concurrent_saves_append_once) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  doortest::Harness h;
  const Note input{NoteId{"note_race001"}, h.user, "Schedule", "I train on Monday."};
  std::latch ready{2};
  std::latch start{1};
  NoteWriteOutcome a{std::nullopt, NoteWriteError::none}, b{std::nullopt, NoteWriteError::none};
  std::exception_ptr firstError, secondError;
  std::thread first([&] {
    ready.count_down(); start.wait();
    try { a = h.notes.saveInsight(input); } catch (...) { firstError = std::current_exception(); }
  });
  std::thread second([&] {
    ready.count_down(); start.wait();
    try { b = h.notes.saveInsight(input); } catch (...) { secondError = std::current_exception(); }
  });
  ready.wait(); start.count_down(); first.join(); second.join();
  REQUIRE(!firstError);
  REQUIRE(!secondError);
  REQUIRE(a.note.has_value());
  CHECK_EQ(*a.note, (Note{input.id, h.user, input.title, input.body, 0, kNow}));
  CHECK_EQ(a.note, b.note);
  CHECK_EQ(h.repo.notes.notes(h.user), std::vector<Note>{*a.note});
  for (int at = 1; at < 10; ++at)
    REQUIRE(h.notes.saveInsight(Note{NoteId{"note_full00" + std::to_string(at)}, h.user, "Title " + std::to_string(at), ""})
                .note.has_value());
  const NoteWriteOutcome duplicate = h.notes.saveInsight(Note{NoteId{"note_dupe001"}, h.user, input.title, input.body});
  CHECK_EQ(duplicate.note, a.note);
  CHECK_EQ(h.repo.notes.notes(h.user).size(), 10u);
  CHECK(h.notes.saveInsight(Note{NoteId{"note_new0001"}, h.user, "New insight", "Different."}).error ==
        NoteWriteError::full);
  CHECK_FALSE(h.notes.noteSave(h.user, NoteId{"note_new0001"}).has_value());
  CHECK(h.notes.saveInsight(Note{input.id, h.user, "Different", "Changed payload."}).error == NoteWriteError::idTaken);
}
