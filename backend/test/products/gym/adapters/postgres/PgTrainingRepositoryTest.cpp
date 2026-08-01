#include "products/gym/adapters/postgres/PgTrainingRepository.h"

#include "test/testing.h"

#include <pqxx/pqxx>

#include <algorithm>
#include <cstdlib>
#include <optional>
#include <string>
#include <thread>
#include <utility>
#include <vector>

// Opt-in integration test: it needs a live local Postgres with the schema applied. It runs only
// when WM_PG_TEST is set (so CI, which has no database, skips it silently) and seeds its own user
// row. This is the one test that proves the SQL half — the bare-conflict start idempotency, the
// one-open partial index, max+1 numbering computed in the INSERT, the read-back replay, and the
// 64-row seed — against a real server rather than the fake.
using namespace wm::gym;

namespace {
std::string connString() {
  const char* url = std::getenv("DATABASE_URL");
  return url ? url : "postgresql://localhost/windmill";
}
const std::string kUser = "22222222-2222-2222-2222-222222222222";
const std::string kOther = "22222222-2222-2222-2222-222222222233";

void reset() {
  pqxx::connection c{connString()};
  pqxx::work w{c};
  w.exec("INSERT INTO users (id, email) VALUES ('" + kUser + "', 'gym-pgtest@example.com') "
         "ON CONFLICT (id) DO NOTHING");
  w.exec("INSERT INTO users (id, email) VALUES ('" + kOther + "', 'gym-pgtest-b@example.com') "
         "ON CONFLICT (id) DO NOTHING");
  w.exec("DELETE FROM gym_sets WHERE user_id IN ('" + kUser + "', '" + kOther + "')");
  w.exec("DELETE FROM gym_sessions WHERE user_id IN ('" + kUser + "', '" + kOther + "')");
  w.exec("DELETE FROM gym_exercises WHERE created_by IN ('" + kUser + "', '" + kOther + "')");
  w.commit();
}

Session sessionAt(const std::string& id, std::uint64_t startedAtMs) {
  return Session{SessionId{id}, wm::UserId{kUser}, startedAtMs};
}

LogCursor page(std::uint64_t beforeMs, int limit) {
  return LogCursor{beforeMs, std::nullopt, limit};
}

Set benchSet(const std::string& id, double weightKg, std::uint64_t completedAtMs,
             const std::string& session = "ses_pg000001") {
  return Set{SetId{id}, SessionId{session}, ExerciseId{"bench-press"}, 0, weightKg, 8,
             SetKind::working, std::nullopt, "", completedAtMs};
}
}

TEST(pg_gym_catalog_serves_the_seeded_64_in_pattern_then_name_order) {
  if (!std::getenv("WM_PG_TEST")) return;
  reset();
  PgTrainingRepository repo{connString()};

  std::vector<Exercise> catalog = repo.catalog(wm::UserId{kUser});

  CHECK_EQ(catalog.size(), static_cast<std::size_t>(64));
  CHECK_EQ(catalog.front(), Exercise(ExerciseId{"farmers-carry"}, "Farmers Carry", Pattern::carry,
                                     Equipment::dumbbell, 2.0, false));
  CHECK_EQ(catalog.back(), Exercise(ExerciseId{"walking-lunge"}, "Walking Lunge", Pattern::squat,
                                    Equipment::dumbbell, 2.0, false));
}

TEST(pg_gym_session_lifecycle_start_is_idempotent_and_one_open_holds) {
  if (!std::getenv("WM_PG_TEST")) return;
  reset();
  PgTrainingRepository repo{connString()};
  const std::uint64_t t1 = 1'700'000'000'123;

  repo.insertSession(sessionAt("ses_pg000001", t1));
  std::optional<Session> open = repo.open(wm::UserId{kUser});
  CHECK_EQ(open, std::optional<Session>(sessionAt("ses_pg000001", t1)));

  // The PK replay and the one-open second id are BOTH silent no-ops (bare ON CONFLICT).
  repo.insertSession(sessionAt("ses_pg000001", t1));
  repo.insertSession(sessionAt("ses_pg000002", t1 + 5));
  CHECK_EQ(repo.open(wm::UserId{kUser}), std::optional<Session>(sessionAt("ses_pg000001", t1)));
  CHECK_EQ(repo.session(wm::UserId{kUser}, SessionId{"ses_pg000002"}), std::optional<Session>());

  // close is idempotent and first-writer-wins; once closed, a new session may open.
  repo.close(SessionId{"ses_pg000001"}, t1 + 1'000);
  repo.close(SessionId{"ses_pg000001"}, t1 + 9'000);
  CHECK_EQ(repo.open(wm::UserId{kUser}), std::optional<Session>());
  std::optional<Session> closed = repo.session(wm::UserId{kUser}, SessionId{"ses_pg000001"});
  CHECK_EQ(closed->finishedAtMs, std::optional<std::uint64_t>(t1 + 1'000));

  repo.insertSession(sessionAt("ses_pg000002", t1 + 5));
  CHECK_EQ(repo.open(wm::UserId{kUser}), std::optional<Session>(sessionAt("ses_pg000002", t1 + 5)));
}

TEST(pg_gym_set_write_numbers_max_plus_one_and_replay_returns_stored) {
  if (!std::getenv("WM_PG_TEST")) return;
  reset();
  PgTrainingRepository repo{connString()};
  const std::uint64_t t1 = 1'700'000'000'123;
  repo.insertSession(sessionAt("ses_pg000001", t1));

  SetInsertOutcome bench1 = repo.insertSet(benchSet("set_pg000001", 82.5, t1 + 1'000));
  SetInsertOutcome squat1 = repo.insertSet(Set{SetId{"set_pg000002"}, SessionId{"ses_pg000001"},
                                               ExerciseId{"back-squat"}, 0, 100.0, 5,
                                               SetKind::working, std::optional<double>(8.5),
                                               "felt heavy", t1 + 2'000});
  SetInsertOutcome bench2 = repo.insertSet(benchSet("set_pg000003", 85.0, t1 + 3'000));

  CHECK(bench1.error == SetInsertError::none);
  CHECK(squat1.error == SetInsertError::none);
  CHECK(bench2.error == SetInsertError::none);
  CHECK_EQ(bench1.set->setNumber, 1);
  CHECK_EQ(squat1.set->setNumber, 1);   // its own count, not the session's
  CHECK_EQ(bench2.set->setNumber, 2);
  CHECK_EQ(squat1.set->rpe, std::optional<double>(8.5));
  CHECK_EQ(squat1.set->note, std::string("felt heavy"));
  CHECK_EQ(squat1.set->completedAtMs, t1 + 2'000);

  // A replay with a drifted weight is handed the ORIGINAL stored row, byte-for-byte.
  SetInsertOutcome replayed = repo.insertSet(benchSet("set_pg000001", 90.0, t1 + 99'000));
  CHECK(replayed.error == SetInsertError::none);
  CHECK_EQ(replayed.set, bench1.set);

  CHECK_EQ(repo.setsOf(SessionId{"ses_pg000001"}),
           (std::vector<Set>{*bench1.set, *squat1.set, *bench2.set}));
  CHECK_EQ(repo.setOf(wm::UserId{kUser}, SetId{"set_pg000001"}), bench1.set);
  CHECK_EQ(repo.setOf(wm::UserId{kOther}, SetId{"set_pg000001"}), std::optional<Set>());
  CHECK_EQ(repo.setOf(wm::UserId{kUser}, SetId{"set_pg000009"}), std::optional<Set>());
  CHECK_EQ(repo.lastActivity(SessionId{"ses_pg000001"}),
           std::optional<std::uint64_t>(t1 + 3'000));
  CHECK_EQ(repo.lastActivity(SessionId{"ses_pg000009"}), std::optional<std::uint64_t>());
}

// The read-back is scoped to the session, so a set id already spent elsewhere resolves to NOTHING
// — never to the other row. Whether that row belongs to a stranger or to the caller's own earlier
// session, the answer is byte-identical: the id is taken.
TEST(pg_gym_a_set_id_spent_in_another_session_resolves_to_nothing) {
  if (!std::getenv("WM_PG_TEST")) return;
  reset();
  PgTrainingRepository repo{connString()};
  const std::uint64_t t1 = 1'700'000'000'123;
  repo.insertSession(sessionAt("ses_pg000001", t1));
  repo.insertSession(Session{SessionId{"ses_pg000002"}, wm::UserId{kOther}, t1});
  SetInsertOutcome mine = repo.insertSet(
      Set{SetId{"set_pg000001"}, SessionId{"ses_pg000001"}, ExerciseId{"bench-press"}, 0, 142.5, 3,
          SetKind::working, std::optional<double>(9.5), "knee felt off, deload next week",
          t1 + 1'000});

  // Another account mints the same id into ITS own session.
  SetInsertOutcome theirs = repo.insertSet(
      Set{SetId{"set_pg000001"}, SessionId{"ses_pg000002"}, ExerciseId{"lateral-raise"}, 0, 7.5, 15,
          SetKind::working, std::nullopt, "", t1 + 2'000});

  CHECK(theirs.error == SetInsertError::idTaken);
  CHECK_EQ(theirs.set, std::optional<Set>());
  CHECK_EQ(repo.setsOf(SessionId{"ses_pg000002"}), std::vector<Set>{});
  CHECK_EQ(repo.setsOf(SessionId{"ses_pg000001"}), std::vector<Set>{*mine.set});

  // The same lifter reusing one of their own spent ids in a later session: the same refusal, and
  // the first row is untouched — no silent move, no silent drop reported as a success.
  repo.close(SessionId{"ses_pg000001"}, t1 + 3'000);
  repo.insertSession(sessionAt("ses_pg000003", t1 + 4'000));
  SetInsertOutcome reused = repo.insertSet(
      Set{SetId{"set_pg000001"}, SessionId{"ses_pg000003"}, ExerciseId{"back-squat"}, 0, 222.5, 9,
          SetKind::working, std::nullopt, "", t1 + 5'000});

  CHECK(reused.error == SetInsertError::idTaken);
  CHECK_EQ(reused.set, std::optional<Set>());
  CHECK_EQ(repo.setsOf(SessionId{"ses_pg000003"}), std::vector<Set>{});
  CHECK_EQ(repo.setOf(wm::UserId{kUser}, SetId{"set_pg000001"}), mine.set);
}

// The exercise FK is the store's own refusal, and it leaves the store as a VALUE — the pqxx
// exception is translated here, beside every other statement that knows what Postgres is, and the
// HTTP edge answers "no such exercise" without ever including a database header.
TEST(pg_gym_a_set_naming_a_movement_no_catalog_holds_is_refused_as_a_value) {
  if (!std::getenv("WM_PG_TEST")) return;
  reset();
  PgTrainingRepository repo{connString()};
  const std::uint64_t t1 = 1'700'000'000'123;
  repo.insertSession(sessionAt("ses_pg000001", t1));
  SetInsertOutcome landed = repo.insertSet(benchSet("set_pg000001", 82.5, t1 + 1'000));

  SetInsertOutcome unknown = repo.insertSet(
      Set{SetId{"set_pg000002"}, SessionId{"ses_pg000001"}, ExerciseId{"pg-no-such-movement"}, 0,
          60.0, 5, SetKind::working, std::nullopt, "", t1 + 2'000});

  CHECK(unknown.error == SetInsertError::unknownExercise);
  CHECK_EQ(unknown.set, std::optional<Set>());
  CHECK_EQ(repo.setsOf(SessionId{"ses_pg000001"}), std::vector<Set>{*landed.set});

  // The aborted transaction is the refused write's alone: the connection is reusable and the next
  // append lands normally, numbered as if the refusal had never happened.
  SetInsertOutcome after = repo.insertSet(benchSet("set_pg000003", 85.0, t1 + 3'000));
  CHECK(after.error == SetInsertError::none);
  CHECK_EQ(after.set->setNumber, 2);
  CHECK_EQ(repo.setsOf(SessionId{"ses_pg000001"}), (std::vector<Set>{*landed.set, *after.set}));
}

// max+1 numbering under parallel appends: every append to one session serializes behind the
// session row, so six flushed at once mint six distinct numbers rather than four "set 1"s.
TEST(pg_gym_parallel_appends_to_one_session_mint_distinct_numbers) {
  if (!std::getenv("WM_PG_TEST")) return;
  reset();
  PgTrainingRepository repo{connString()};
  const std::uint64_t t1 = 1'700'000'000'123;
  repo.insertSession(sessionAt("ses_pg000001", t1));

  std::vector<std::thread> flush;
  for (int n = 0; n < 6; ++n)
    flush.emplace_back([&repo, n, t1] {
      repo.insertSet(Set{SetId{"set_pg00001" + std::to_string(n)}, SessionId{"ses_pg000001"},
                         ExerciseId{"deadlift"}, 0, 100.0, 5, SetKind::working, std::nullopt, "",
                         t1 + 1'000 + n});
    });
  for (std::thread& thread : flush) thread.join();

  std::vector<int> numbers;
  for (const Set& set : repo.setsOf(SessionId{"ses_pg000001"})) numbers.push_back(set.setNumber);
  std::sort(numbers.begin(), numbers.end());
  CHECK_EQ(numbers, (std::vector<int>{1, 2, 3, 4, 5, 6}));
}

TEST(pg_gym_log_pages_newest_first_with_counts_and_names) {
  if (!std::getenv("WM_PG_TEST")) return;
  reset();
  PgTrainingRepository repo{connString()};
  const std::uint64_t t1 = 1'700'000'000'123;
  const std::uint64_t t2 = t1 + 100'000;

  repo.insertSession(sessionAt("ses_pg000001", t1));
  repo.insertSet(benchSet("set_pg000001", 82.5, t1 + 1'000));
  repo.insertSet(Set{SetId{"set_pg000002"}, SessionId{"ses_pg000001"}, ExerciseId{"back-squat"},
                     0, 100.0, 5, SetKind::working, std::nullopt, "", t1 + 2'000});
  repo.close(SessionId{"ses_pg000001"}, t1 + 3'000);
  repo.insertSession(sessionAt("ses_pg000002", t2));

  std::vector<SessionSummary> listed = repo.log(wm::UserId{kUser}, page(t2 + 1, 50));

  CHECK_EQ(listed.size(), static_cast<std::size_t>(2));
  CHECK_EQ(listed[0].session.id.str(), std::string("ses_pg000002"));
  CHECK_EQ(listed[0].setCount, 0);
  CHECK_EQ(listed[0].exerciseNames, std::vector<std::string>{});
  CHECK_EQ(listed[1].session.id.str(), std::string("ses_pg000001"));
  CHECK_EQ(listed[1].setCount, 2);
  CHECK_EQ(listed[1].exerciseNames, (std::vector<std::string>{"Back Squat", "Bench Press"}));

  // The keyset cursor: strictly-before t2 drops the newer session from the page.
  std::vector<SessionSummary> older = repo.log(wm::UserId{kUser}, page(t2, 50));
  CHECK_EQ(older.size(), static_cast<std::size_t>(1));
  CHECK_EQ(older[0].session.id.str(), std::string("ses_pg000001"));
}

// Two sessions started in the same millisecond, with the tie straddling a page edge: on a cursor
// of the instant alone the tie-mate is in no page, ever. The pair cursor walks all four.
TEST(pg_gym_log_walks_a_tied_start_instant_across_a_page_boundary) {
  if (!std::getenv("WM_PG_TEST")) return;
  reset();
  PgTrainingRepository repo{connString()};
  const std::uint64_t t1 = 1'700'000'000'123;
  repo.insertSession(sessionAt("ses_pg000001", t1 + 3'000));
  repo.close(SessionId{"ses_pg000001"}, t1 + 9'000);
  repo.insertSession(sessionAt("ses_pg000002", t1 + 2'000));
  repo.close(SessionId{"ses_pg000002"}, t1 + 9'000);
  repo.insertSession(sessionAt("ses_pg000003", t1 + 2'000));   // the tie
  repo.close(SessionId{"ses_pg000003"}, t1 + 9'000);
  repo.insertSession(sessionAt("ses_pg000004", t1 + 1'000));
  repo.close(SessionId{"ses_pg000004"}, t1 + 9'000);

  std::vector<SessionSummary> first = repo.log(wm::UserId{kUser}, page(t1 + 9'000, 2));
  std::vector<SessionSummary> second = repo.log(
      wm::UserId{kUser}, LogCursor{first.back().session.startedAtMs, first.back().session.id, 2});
  std::vector<SessionSummary> third = repo.log(
      wm::UserId{kUser}, LogCursor{second.back().session.startedAtMs, second.back().session.id, 2});

  CHECK_EQ(first.size(), static_cast<std::size_t>(2));
  CHECK_EQ(first[0].session.id.str(), std::string("ses_pg000001"));
  CHECK_EQ(first[1].session.id.str(), std::string("ses_pg000003"));
  CHECK_EQ(second.size(), static_cast<std::size_t>(2));
  CHECK_EQ(second[0].session.id.str(), std::string("ses_pg000002"));
  CHECK_EQ(second[1].session.id.str(), std::string("ses_pg000004"));
  CHECK(third.empty());
}

// The summary's movements are framed by the rows they come back in, so a display name holding
// whatever separator a hand-rolled aggregate would have used is still ONE movement.
TEST(pg_gym_log_names_a_movement_whose_display_name_holds_a_newline_once) {
  if (!std::getenv("WM_PG_TEST")) return;
  reset();
  PgTrainingRepository repo{connString()};
  const std::uint64_t t1 = 1'700'000'000'123;
  {
    pqxx::connection c{connString()};
    pqxx::work w{c};
    w.exec_params("INSERT INTO gym_exercises (id, name, pattern, equipment, created_by) "
                  "VALUES ($1, $2, 'squat', 'barbell', $3::uuid)",
                  "pg-zercher-squat", "Zercher\nSquat", kUser);
    w.commit();
  }
  repo.insertSession(sessionAt("ses_pg000001", t1));
  repo.insertSet(benchSet("set_pg000001", 82.5, t1 + 1'000));
  repo.insertSet(Set{SetId{"set_pg000002"}, SessionId{"ses_pg000001"},
                     ExerciseId{"pg-zercher-squat"}, 0, 60.0, 5, SetKind::working, std::nullopt,
                     "", t1 + 2'000});

  std::vector<SessionSummary> listed = repo.log(wm::UserId{kUser}, page(t1 + 9'000, 50));

  CHECK_EQ(listed.size(), static_cast<std::size_t>(1));
  CHECK_EQ(listed[0].setCount, 2);
  CHECK_EQ(listed[0].exerciseNames, (std::vector<std::string>{"Bench Press", "Zercher\nSquat"}));
}

// The prefill read, against the real index. What has to hold: the most recent FINISHED session
// wins (the live one never does), warmups are not history, the block comes back in set_number
// order, the routine name is the one frozen in the session's own plan snapshot, and another
// account's identical movement is invisible.
TEST(pg_gym_last_time_is_the_newest_finished_session_of_that_movement) {
  if (!std::getenv("WM_PG_TEST")) return;
  reset();
  PgTrainingRepository repo{connString()};
  const std::uint64_t t1 = 1'700'000'000'123;

  repo.insertSession(sessionAt("ses_pg000001", t1));
  repo.insertSet(benchSet("set_pg000001", 80.0, t1 + 1'000));
  repo.close(SessionId{"ses_pg000001"}, t1 + 2'000);

  repo.insertSession(Session{SessionId{"ses_pg000002"}, wm::UserId{kUser}, t1 + 10'000,
                             std::nullopt, std::nullopt,
                             R"({"routine":"Bench day","entries":[]})"});
  repo.insertSet(Set{SetId{"set_pg000002"}, SessionId{"ses_pg000002"}, ExerciseId{"bench-press"}, 0,
                     40.0, 10, SetKind::warmup, std::nullopt, "", t1 + 11'000});
  SetInsertOutcome top = repo.insertSet(benchSet("set_pg000003", 82.5, t1 + 12'000, "ses_pg000002"));
  SetInsertOutcome backOff =
      repo.insertSet(benchSet("set_pg000004", 80.0, t1 + 13'000, "ses_pg000002"));
  repo.insertSet(Set{SetId{"set_pg000005"}, SessionId{"ses_pg000002"}, ExerciseId{"back-squat"}, 0,
                     100.0, 5, SetKind::working, std::nullopt, "", t1 + 14'000});
  repo.close(SessionId{"ses_pg000002"}, t1 + 15'000);

  // Today, live and heavier: an unfinished session is never a last time.
  repo.insertSession(sessionAt("ses_pg000003", t1 + 20'000));
  repo.insertSet(benchSet("set_pg000006", 100.0, t1 + 21'000, "ses_pg000003"));
  // And another account's newer, heavier bench, which this caller must never see.
  repo.insertSession(Session{SessionId{"ses_pg000004"}, wm::UserId{kOther}, t1 + 30'000});
  repo.insertSet(benchSet("set_pg000007", 142.5, t1 + 31'000, "ses_pg000004"));
  repo.close(SessionId{"ses_pg000004"}, t1 + 32'000);

  LastTimeOutcome last = repo.lastTime(wm::UserId{kUser}, ExerciseId{"bench-press"});

  CHECK(last.error == LastTimeError::none);
  CHECK_EQ(last.lastTime->session.id, SessionId{"ses_pg000002"});
  CHECK_EQ(last.lastTime->session.finishedAtMs, std::optional<std::uint64_t>(t1 + 15'000));
  CHECK_EQ(last.lastTime->routineName, std::string("Bench day"));
  CHECK_EQ(last.lastTime->sets, (std::vector<Set>{*top.set, *backOff.set}));
  // The warmup is set 1 of that movement, so the block starts at 2: a filter, not a renumbering.
  CHECK_EQ(last.lastTime->sets[0].setNumber, 2);

  // The other account reads its own log, and only that.
  LastTimeOutcome theirs = repo.lastTime(wm::UserId{kOther}, ExerciseId{"bench-press"});
  CHECK(theirs.error == LastTimeError::none);
  CHECK_EQ(theirs.lastTime->session.id, SessionId{"ses_pg000004"});
  CHECK_EQ(theirs.lastTime->routineName, std::string(""));
  CHECK_EQ(theirs.lastTime->sets.size(), static_cast<std::size_t>(1));
  CHECK_EQ(theirs.lastTime->sets[0].weightKg, 142.5);
}

// A movement that was only ever warmed up has no last time — the same answer as one never touched.
TEST(pg_gym_last_time_of_a_first_ever_movement_is_empty_and_of_an_unknown_one_is_a_refusal) {
  if (!std::getenv("WM_PG_TEST")) return;
  reset();
  PgTrainingRepository repo{connString()};
  const std::uint64_t t1 = 1'700'000'000'123;
  repo.insertSession(sessionAt("ses_pg000001", t1));
  repo.insertSet(Set{SetId{"set_pg000001"}, SessionId{"ses_pg000001"}, ExerciseId{"back-squat"}, 0,
                     60.0, 10, SetKind::warmup, std::nullopt, "", t1 + 1'000});
  repo.close(SessionId{"ses_pg000001"}, t1 + 2'000);
  {
    pqxx::connection c{connString()};
    pqxx::work w{c};
    w.exec_params("INSERT INTO gym_exercises (id, name, pattern, equipment, created_by) "
                  "VALUES ($1, $2, 'squat', 'barbell', $3::uuid)",
                  "pg-zercher-squat", "Zercher Squat", kOther);
    w.commit();
  }

  LastTimeOutcome neverLogged = repo.lastTime(wm::UserId{kUser}, ExerciseId{"deadlift"});
  LastTimeOutcome onlyWarmed = repo.lastTime(wm::UserId{kUser}, ExerciseId{"back-squat"});
  LastTimeOutcome unknown = repo.lastTime(wm::UserId{kUser}, ExerciseId{"pg-no-such-movement"});
  LastTimeOutcome anothersCustom = repo.lastTime(wm::UserId{kUser}, ExerciseId{"pg-zercher-squat"});

  CHECK(neverLogged.error == LastTimeError::none);
  CHECK_EQ(neverLogged.lastTime, std::optional<LastTime>());
  CHECK(onlyWarmed.error == LastTimeError::none);
  CHECK_EQ(onlyWarmed.lastTime, std::optional<LastTime>());
  CHECK(unknown.error == LastTimeError::unknownExercise);
  CHECK_EQ(unknown.lastTime, std::optional<LastTime>());
  // Owner-scoped exactly like the catalog read: another account's custom movement is unknown here,
  // never merely unlogged, so absent stays byte-identical to forbidden.
  CHECK(anothersCustom.error == LastTimeError::unknownExercise);
  CHECK_EQ(anothersCustom.lastTime, std::optional<LastTime>());
}

// Last time is the newest SESSION, not the newest set instant. completed_at is the device's wall
// clock (§2.2) and nothing ties it to the session holding it, so a single future-stamped set would
// otherwise pin the prefill to a week-old session while the log listed a fresher one above it —
// and with no cutoff on how far last time reaches, it would answer for the next thirty days.
TEST(pg_gym_last_time_walks_sessions_not_set_instants) {
  if (!std::getenv("WM_PG_TEST")) return;
  reset();
  PgTrainingRepository repo{connString()};
  const std::uint64_t t1 = 1'700'000'000'123;
  const std::uint64_t day = 86'400'000;

  repo.insertSession(sessionAt("ses_pg000001", t1));                       // a week ago
  repo.insertSet(benchSet("set_pg000001", 60.0, t1 + 30 * day));           // stamped 30 days ahead
  repo.close(SessionId{"ses_pg000001"}, t1 + 1'000);
  repo.insertSession(sessionAt("ses_pg000002", t1 + 6 * day));             // yesterday
  SetInsertOutcome honest =
      repo.insertSet(benchSet("set_pg000002", 100.0, t1 + 6 * day + 1'000, "ses_pg000002"));
  repo.close(SessionId{"ses_pg000002"}, t1 + 6 * day + 2'000);

  LastTimeOutcome last = repo.lastTime(wm::UserId{kUser}, ExerciseId{"bench-press"});
  std::vector<SessionSummary> listed = repo.log(wm::UserId{kUser}, page(t1 + 7 * day, 50));

  CHECK(last.error == LastTimeError::none);
  CHECK_EQ(last.lastTime->session.id, SessionId{"ses_pg000002"});
  CHECK_EQ(last.lastTime->sets, std::vector<Set>{*honest.set});
  // The two reads sort on the same key, so they can never name a different newest session.
  CHECK_EQ(listed[0].session.id, last.lastTime->session.id);
}

// The one read whose session lookup used to be scoped only transitively — through the invariant
// that insertSet copies its session's owner. One mis-owned set row is all it took to hand back a
// stranger's session and the whole frozen plan inside it, while every sibling read refused.
TEST(pg_gym_last_time_never_answers_with_a_session_the_caller_does_not_own) {
  if (!std::getenv("WM_PG_TEST")) return;
  reset();
  PgTrainingRepository repo{connString()};
  const std::uint64_t t1 = 1'700'000'000'123;
  repo.insertSession(Session{SessionId{"ses_pg000001"}, wm::UserId{kUser}, t1, std::nullopt,
                             std::nullopt, R"({"routine":"A private routine","entries":[]})"});
  repo.insertSet(benchSet("set_pg000001", 142.5, t1 + 1'000));
  repo.close(SessionId{"ses_pg000001"}, t1 + 2'000);
  {
    // A set row inside the owner's session carrying ANOTHER account's user_id. No API path mints
    // one today; the read must not depend on that staying true.
    pqxx::connection c{connString()};
    pqxx::work w{c};
    w.exec_params("INSERT INTO gym_sets (id, session_id, user_id, exercise_id, set_number, "
                  "weight_kg, reps, kind, completed_at) "
                  "VALUES ($1, 'ses_pg000001', $2::uuid, 'bench-press', 9, 60, 5, 'working', "
                  "        to_timestamp($3::bigint / 1000.0))",
                  "set_pg000009", kOther, static_cast<long long>(t1 + 3'000));
    w.commit();
  }

  LastTimeOutcome theirs = repo.lastTime(wm::UserId{kOther}, ExerciseId{"bench-press"});
  LastTimeOutcome ours = repo.lastTime(wm::UserId{kUser}, ExerciseId{"bench-press"});

  CHECK(theirs.error == LastTimeError::none);
  CHECK_EQ(theirs.lastTime, std::optional<LastTime>());
  CHECK_EQ(repo.session(wm::UserId{kOther}, SessionId{"ses_pg000001"}), std::optional<Session>());
  // And the owner's own answer holds only the rows that are theirs — a located session always has
  // a block, so the locator's probe filters exactly what the block read filters.
  CHECK(ours.error == LastTimeError::none);
  CHECK_EQ(ours.lastTime->session.id, SessionId{"ses_pg000001"});
  CHECK_EQ(ours.lastTime->routineName, std::string("A private routine"));
  CHECK_EQ(ours.lastTime->sets.size(), static_cast<std::size_t>(1));
  CHECK_EQ(ours.lastTime->sets[0].id, SetId{"set_pg000001"});
}

// The same table the fake is pinned to (LogServiceTest), against real jsonb: `->>` renders an
// object, an array or a number as TEXT, and that text would be printed verbatim as the prefill
// card's cross-routine suffix. Only a string is a routine name.
TEST(pg_gym_last_time_names_the_routine_only_when_the_snapshot_holds_a_string) {
  if (!std::getenv("WM_PG_TEST")) return;
  const std::vector<std::pair<std::string, std::string>> snapshots{
      {R"({"routine":"Bench day","entries":[]})", "Bench day"},
      {R"({"routine":42})", ""},
      {R"({"routine":{"nested":1}})", ""},
      {R"({"routine":["a","b"]})", ""},
      {R"({"routine":null})", ""},
      {R"({"entries":[]})", ""},
      {R"(["a","b"])", ""},
      {R"("just a string")", ""},
      {"", ""},
  };
  const std::uint64_t t1 = 1'700'000'000'123;

  for (const auto& [snapshot, name] : snapshots) {
    reset();
    PgTrainingRepository repo{connString()};
    repo.insertSession(Session{SessionId{"ses_pg000001"}, wm::UserId{kUser}, t1, std::nullopt,
                               std::nullopt, snapshot});
    SetInsertOutcome landed = repo.insertSet(benchSet("set_pg000001", 82.5, t1 + 1'000));
    repo.close(SessionId{"ses_pg000001"}, t1 + 2'000);

    LastTimeOutcome last = repo.lastTime(wm::UserId{kUser}, ExerciseId{"bench-press"});

    CHECK(last.error == LastTimeError::none);
    CHECK_EQ(last.lastTime->routineName, name);
    CHECK_EQ(last.lastTime->sets, std::vector<Set>{*landed.set});
  }
}

// A row written before the instant band was enforced still reads: it is clamped into the band
// rather than failing the conversion, so one poisoned row cannot take down the whole log.
TEST(pg_gym_reads_a_pre_1970_legacy_row_instead_of_failing_the_whole_log) {
  if (!std::getenv("WM_PG_TEST")) return;
  reset();
  PgTrainingRepository repo{connString()};
  const std::uint64_t t1 = 1'700'000'000'123;
  repo.insertSession(sessionAt("ses_pg000001", t1));
  {
    pqxx::connection c{connString()};
    pqxx::work w{c};
    w.exec_params("INSERT INTO gym_sessions (id, user_id, started_at, finished_at) "
                  "VALUES ('ses_pg000002', $1::uuid, to_timestamp(-1), to_timestamp(-1))", kUser);
    w.commit();
  }

  std::vector<SessionSummary> listed = repo.log(wm::UserId{kUser}, page(t1 + 9'000, 50));

  CHECK_EQ(listed.size(), static_cast<std::size_t>(2));
  CHECK_EQ(listed[0].session.id.str(), std::string("ses_pg000001"));
  CHECK_EQ(listed[1].session.id.str(), std::string("ses_pg000002"));
  CHECK_EQ(listed[1].session.startedAtMs, static_cast<std::uint64_t>(1));
  CHECK_EQ(listed[1].session.finishedAtMs, std::optional<std::uint64_t>(1));
  CHECK_EQ(repo.session(wm::UserId{kUser}, SessionId{"ses_pg000002"})->startedAtMs,
           static_cast<std::uint64_t>(1));
}
