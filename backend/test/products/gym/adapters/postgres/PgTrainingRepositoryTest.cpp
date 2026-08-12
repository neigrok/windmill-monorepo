#include "products/gym/adapters/postgres/PgTrainingRepository.h"

// The in-memory twin is included for its three EXPORT renderings alone: the fake states what
// `to_char(… AT TIME ZONE 'UTC')` and a `::text` cast off a fixed-scale numeric produce, and the
// export case below asserts both against each other so neither can drift on its own.
#include "test/products/gym/Fakes.h"
#include "test/PgTestPool.h"
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
// when WM_PG_TEST is set — otherwise every case here reports `skip`, which the run summary counts
// as skipped and never as passed (RUNNING.md §7 has the invocation). It seeds its own user
// row. This is the one test that proves the SQL half — the bare-conflict start idempotency, the
// one-open partial index, max+1 numbering computed in the INSERT, the read-back replay, and the
// 64-row seed — against a real server rather than the fake.
using namespace wm::gym;

namespace {
const char* kNeedsPostgres = "WM_PG_TEST unset — needs a live Postgres, see RUNNING.md §7";

const std::string kUser = "22222222-2222-2222-2222-222222222222";
const std::string kOther = "22222222-2222-2222-2222-222222222233";

void reset() {
  wm::PgLease c{*wm::pgTestPool()};
  pqxx::work w{*c};
  w.exec("INSERT INTO users (id, email) VALUES ('" + kUser + "', 'gym-pgtest@example.com') "
         "ON CONFLICT (id) DO NOTHING");
  w.exec("INSERT INTO users (id, email) VALUES ('" + kOther + "', 'gym-pgtest-b@example.com') "
         "ON CONFLICT (id) DO NOTHING");
  // FK order, and the routines before the exercises: an entry references a movement, so a custom
  // one cannot be removed while a plan still names it.
  w.exec("DELETE FROM gym_sets WHERE user_id IN ('" + kUser + "', '" + kOther + "')");
  w.exec("DELETE FROM gym_sessions WHERE user_id IN ('" + kUser + "', '" + kOther + "')");
  w.exec("DELETE FROM gym_routines WHERE user_id IN ('" + kUser + "', '" + kOther + "')");
  w.exec("DELETE FROM gym_exercise_names WHERE user_id IN ('" + kUser + "', '" + kOther + "')");
  w.exec("DELETE FROM gym_exercises WHERE created_by IN ('" + kUser + "', '" + kOther + "')");
  w.commit();
}

Session sessionAt(const std::string& id, std::uint64_t startedAtMs) {
  return Session{SessionId{id}, wm::UserId{kUser}, startedAtMs};
}

RoutineEntry entryAt(int position, const std::string& exercise, int targetSets = 5,
                     std::optional<int> targetReps = 5,
                     std::optional<double> targetWeightKg = 82.5,
                     std::optional<int> restSeconds = 180) {
  return RoutineEntry{position, ExerciseId{exercise}, targetSets, targetReps, targetWeightKg,
                      restSeconds};
}

Routine routineAt(const std::string& id, const std::string& name,
                  std::vector<RoutineEntry> entries) {
  return Routine{RoutineId{id}, wm::UserId{kUser}, name, 0, std::move(entries)};
}

PlanSnapshot pushA() {
  return PlanSnapshot{"Push A", {PlanEntry{ExerciseId{"bench-press"}, 5, 5, 82.5, 180}}};
}

LogCursor page(std::uint64_t beforeMs, int limit) {
  return LogCursor{beforeMs, std::nullopt, limit};
}

// The rows of a page, for the cases that are about the rows. The marks standing before the page ride
// back in the same value and have their own cases below.
std::vector<SessionSummary> pageOf(PgTrainingRepository& repo, const wm::UserId& user,
                                   const LogCursor& cursor) {
  return repo.log(user, cursor).sessions;
}

Set benchSet(const std::string& id, double weightKg, std::uint64_t completedAtMs,
             const std::string& session = "ses_pg000001") {
  return Set{SetId{id}, SessionId{session}, ExerciseId{"bench-press"}, 0, weightKg, 8,
             SetKind::working, std::nullopt, "", completedAtMs};
}

// The reps are what the marks are made of, so the finish read's fixture states them.
Set squatSet(const std::string& id, const std::string& session, double weightKg, int reps,
             std::uint64_t completedAtMs, SetKind kind = SetKind::working) {
  return Set{SetId{id}, SessionId{session}, ExerciseId{"back-squat"}, 0, weightKg, reps, kind,
             std::nullopt, "", completedAtMs};
}
}

TEST(pg_gym_catalog_serves_the_seeded_64_in_pattern_then_name_order) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgTrainingRepository repo{wm::pgTestPool()};

  std::vector<Exercise> catalog = repo.catalog(wm::UserId{kUser});

  REQUIRE_EQ(catalog.size(), static_cast<std::size_t>(64));
  CHECK_EQ(catalog.front(), Exercise(ExerciseId{"farmers-carry"}, "Farmers Carry", Pattern::carry,
                                     Equipment::dumbbell, 2.0, false));
  CHECK_EQ(catalog.back(), Exercise(ExerciseId{"walking-lunge"}, "Walking Lunge", Pattern::squat,
                                    Equipment::dumbbell, 2.0, false));
}

TEST(pg_gym_session_lifecycle_start_is_idempotent_and_one_open_holds) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgTrainingRepository repo{wm::pgTestPool()};
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
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgTrainingRepository repo{wm::pgTestPool()};
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
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgTrainingRepository repo{wm::pgTestPool()};
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

// The catalog is the store's own fact, and it leaves the store as a VALUE. It is not a caught
// exception any more: the statement asks the question outright, inside the transaction that already
// holds the session's lock, because an FK cannot tell an id nobody has from an id that belongs to
// somebody else — and those are one answer to the caller and two to the store. The HTTP edge says
// "no such exercise" either way, without ever including a database header.
TEST(pg_gym_a_set_naming_a_movement_no_catalog_holds_is_refused_as_a_value) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgTrainingRepository repo{wm::pgTestPool()};
  const std::uint64_t t1 = 1'700'000'000'123;
  repo.insertSession(sessionAt("ses_pg000001", t1));
  SetInsertOutcome landed = repo.insertSet(benchSet("set_pg000001", 82.5, t1 + 1'000));

  SetInsertOutcome unknown = repo.insertSet(
      Set{SetId{"set_pg000002"}, SessionId{"ses_pg000001"}, ExerciseId{"pg-no-such-movement"}, 0,
          60.0, 5, SetKind::working, std::nullopt, "", t1 + 2'000});

  CHECK(unknown.error == SetInsertError::unknownExercise);
  CHECK_EQ(unknown.set, std::optional<Set>());
  CHECK_EQ(repo.setsOf(SessionId{"ses_pg000001"}), std::vector<Set>{*landed.set});

  // The rolled-back transaction is the refused write's alone: the connection is reusable and the
  // next append lands normally, numbered as if the refusal had never happened.
  SetInsertOutcome after = repo.insertSet(benchSet("set_pg000003", 85.0, t1 + 3'000));
  CHECK(after.error == SetInsertError::none);
  CHECK_EQ(after.set->setNumber, 2);
  CHECK_EQ(repo.setsOf(SessionId{"ses_pg000001"}), (std::vector<Set>{*landed.set, *after.set}));
}

// A set may not NAME a movement this account cannot see. The foreign key alone is happy with
// another lifter's custom row — it exists — and a set pointing at it would print their movement
// name in this account's log, its CSV export and any workout it hands a coach, with no way for the
// owner to take it back. The write carries the catalog read's own predicate, resolved in the owner
// the locked session row names.
TEST(pg_gym_a_set_may_not_name_another_accounts_private_movement) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgTrainingRepository repo{wm::pgTestPool()};
  const std::uint64_t t1 = 1'700'000'000'123;
  repo.insertExercise(wm::UserId{kOther},
                      Exercise{ExerciseId{"pg-their-zercher"}, "Their Zercher Squat",
                               Pattern::squat, Equipment::barbell, 2.5, true});
  repo.insertSession(sessionAt("ses_pg000001", t1));

  SetInsertOutcome refused =
      repo.insertSet(Set{SetId{"set_pg000001"}, SessionId{"ses_pg000001"},
                         ExerciseId{"pg-their-zercher"}, 0, 60.0, 5, SetKind::working,
                         std::nullopt, "", t1 + 1'000});

  CHECK(refused.error == SetInsertError::unknownExercise);
  CHECK_EQ(refused.set, std::optional<Set>());
  CHECK_EQ(repo.setsOf(SessionId{"ses_pg000001"}), std::vector<Set>{});
  // It is a scope and never a claim the movement does not exist: its owner logs it as normal.
  repo.insertSession(Session{SessionId{"ses_pg000002"}, wm::UserId{kOther}, t1});
  CHECK(repo.insertSet(Set{SetId{"set_pg000002"}, SessionId{"ses_pg000002"},
                           ExerciseId{"pg-their-zercher"}, 0, 60.0, 5, SetKind::working,
                           std::nullopt, "", t1 + 1'000})
            .error == SetInsertError::none);
}

// The finish boundary is held HERE, by the lock, because the lock is the only reader that cannot be
// raced: the service checks the session it loaded, and a close landing between that read and this
// insert would otherwise let a set that never landed land after the workout ended — the one loss
// §3.3 says is impossible. A set that DID land still replays; this is the one that never did.
TEST(pg_gym_a_set_that_never_landed_cannot_land_after_the_session_closed) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgTrainingRepository repo{wm::pgTestPool()};
  const std::uint64_t t1 = 1'700'000'000'123;
  repo.insertSession(sessionAt("ses_pg000001", t1));
  SetInsertOutcome landed = repo.insertSet(benchSet("set_pg000001", 82.5, t1 + 1'000));
  repo.close(SessionId{"ses_pg000001"}, t1 + 2'000);

  SetInsertOutcome refused = repo.insertSet(benchSet("set_pg000002", 85.0, t1 + 3'000));

  CHECK(refused.error == SetInsertError::finished);
  CHECK_EQ(refused.set, std::optional<Set>());
  CHECK_EQ(repo.setsOf(SessionId{"ses_pg000001"}), std::vector<Set>{*landed.set});
}

// max+1 numbering under parallel appends: every append to one session serializes behind the
// session row, so six flushed at once mint six distinct numbers rather than four "set 1"s.
TEST(pg_gym_parallel_appends_to_one_session_mint_distinct_numbers) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgTrainingRepository repo{wm::pgTestPool()};
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
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgTrainingRepository repo{wm::pgTestPool()};
  const std::uint64_t t1 = 1'700'000'000'123;
  const std::uint64_t t2 = t1 + 100'000;

  repo.insertSession(sessionAt("ses_pg000001", t1));
  repo.insertSet(benchSet("set_pg000001", 82.5, t1 + 1'000));
  repo.insertSet(Set{SetId{"set_pg000002"}, SessionId{"ses_pg000001"}, ExerciseId{"back-squat"},
                     0, 100.0, 5, SetKind::working, std::nullopt, "", t1 + 2'000});
  repo.close(SessionId{"ses_pg000001"}, t1 + 3'000);
  repo.insertSession(sessionAt("ses_pg000002", t2));

  std::vector<SessionSummary> listed = pageOf(repo, wm::UserId{kUser}, page(t2 + 1, 50));

  REQUIRE_EQ(listed.size(), static_cast<std::size_t>(2));
  CHECK_EQ(listed[0].session.id.str(), std::string("ses_pg000002"));
  CHECK_EQ(listed[0].setCount, 0);
  CHECK_EQ(listed[0].exerciseNames, std::vector<std::string>{});
  CHECK_EQ(listed[1].session.id.str(), std::string("ses_pg000001"));
  CHECK_EQ(listed[1].setCount, 2);
  CHECK_EQ(listed[1].exerciseNames, (std::vector<std::string>{"Back Squat", "Bench Press"}));

  // The keyset cursor: strictly-before t2 drops the newer session from the page.
  std::vector<SessionSummary> older = pageOf(repo, wm::UserId{kUser}, page(t2, 50));
  REQUIRE_EQ(older.size(), static_cast<std::size_t>(1));
  CHECK_EQ(older[0].session.id.str(), std::string("ses_pg000001"));
}

// Two sessions started in the same millisecond, with the tie straddling a page edge: on a cursor
// of the instant alone the tie-mate is in no page, ever. The pair cursor walks all four.
TEST(pg_gym_log_walks_a_tied_start_instant_across_a_page_boundary) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgTrainingRepository repo{wm::pgTestPool()};
  const std::uint64_t t1 = 1'700'000'000'123;
  repo.insertSession(sessionAt("ses_pg000001", t1 + 3'000));
  repo.close(SessionId{"ses_pg000001"}, t1 + 9'000);
  repo.insertSession(sessionAt("ses_pg000002", t1 + 2'000));
  repo.close(SessionId{"ses_pg000002"}, t1 + 9'000);
  repo.insertSession(sessionAt("ses_pg000003", t1 + 2'000));   // the tie
  repo.close(SessionId{"ses_pg000003"}, t1 + 9'000);
  repo.insertSession(sessionAt("ses_pg000004", t1 + 1'000));
  repo.close(SessionId{"ses_pg000004"}, t1 + 9'000);

  std::vector<SessionSummary> first = pageOf(repo, wm::UserId{kUser}, page(t1 + 9'000, 2));
  std::vector<SessionSummary> second = pageOf(
      repo, wm::UserId{kUser},
      LogCursor{first.back().session.startedAtMs, first.back().session.id, 2});
  std::vector<SessionSummary> third = pageOf(
      repo, wm::UserId{kUser},
      LogCursor{second.back().session.startedAtMs, second.back().session.id, 2});

  REQUIRE_EQ(first.size(), static_cast<std::size_t>(2));
  CHECK_EQ(first[0].session.id.str(), std::string("ses_pg000001"));
  CHECK_EQ(first[1].session.id.str(), std::string("ses_pg000003"));
  REQUIRE_EQ(second.size(), static_cast<std::size_t>(2));
  CHECK_EQ(second[0].session.id.str(), std::string("ses_pg000002"));
  CHECK_EQ(second[1].session.id.str(), std::string("ses_pg000004"));
  CHECK(third.empty());
}

// The log row's two other facts, against the real statement. topSet is a lateral over the WORKING
// sets — heaviest, ties to more reps — so a heavier warmup is not what the row says the session was,
// and a session holding no working set has no top set at all. closedItself is the four-hour rule's
// own signature: finished_at at the last set's instant exactly, or at started_at for a session that
// holds none. A finish a lifter tapped lands wherever their device said, and reads as false.
TEST(pg_gym_log_carries_the_top_working_set_and_says_which_row_closed_itself) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgTrainingRepository repo{wm::pgTestPool()};
  const std::uint64_t t1 = 1'700'000'000'123;

  // Finished by a tap, an hour after its last set.
  repo.insertSession(sessionAt("ses_pg000001", t1));
  repo.insertSet(squatSet("set_pg000001", "ses_pg000001", 100, 5, t1 + 60'000));
  repo.insertSet(squatSet("set_pg000002", "ses_pg000001", 100, 8, t1 + 120'000));
  repo.insertSet(squatSet("set_pg000003", "ses_pg000001", 140, 1, t1 + 30'000, SetKind::warmup));
  repo.close(SessionId{"ses_pg000001"}, t1 + 3'600'000);
  // Left running and never touched again: the auto-close ends it AT its last set.
  repo.insertSession(sessionAt("ses_pg000002", t1 + 10'000'000));
  repo.insertSet(squatSet("set_pg000004", "ses_pg000002", 90, 5, t1 + 10'060'000));
  repo.close(SessionId{"ses_pg000002"}, t1 + 10'060'000);
  // Abandoned holding no set at all: the same rule ends it at its own start.
  repo.insertSession(sessionAt("ses_pg000004", t1 + 30'000'000));
  repo.close(SessionId{"ses_pg000004"}, t1 + 30'000'000);
  // Warmed up and still running — inserted LAST, because the one-open index allows exactly one.
  repo.insertSession(sessionAt("ses_pg000003", t1 + 20'000'000));
  repo.insertSet(squatSet("set_pg000005", "ses_pg000003", 60, 10, t1 + 20'060'000,
                          SetKind::warmup));

  std::vector<SessionSummary> listed = pageOf(repo, wm::UserId{kUser}, page(t1 + 40'000'000, 50));

  REQUIRE_EQ(listed.size(), static_cast<std::size_t>(4));
  CHECK_EQ(listed[0].session.id.str(), std::string("ses_pg000004"));
  CHECK_EQ(listed[0].topSet, std::optional<TopWorkingSet>());   // no sets at all
  CHECK(listed[0].closedItself);                                // ended when it began
  CHECK_EQ(listed[1].session.id.str(), std::string("ses_pg000003"));
  CHECK_EQ(listed[1].topSet, std::optional<TopWorkingSet>());   // a ramp-up is not a top set
  CHECK_FALSE(listed[1].closedItself);                          // still running
  CHECK_EQ(listed[2].session.id.str(), std::string("ses_pg000002"));
  CHECK_EQ(listed[2].topSet, std::optional<TopWorkingSet>(TopWorkingSet{90, 5}));
  CHECK(listed[2].closedItself);
  CHECK_EQ(listed[3].session.id.str(), std::string("ses_pg000001"));
  CHECK_EQ(listed[3].topSet, std::optional<TopWorkingSet>(TopWorkingSet{100, 8}));
  CHECK_FALSE(listed[3].closedItself);
}

// The aggregate's two counts and its tonnage, against the real statement. Both counts come off ONE
// GROUP BY so they cannot disagree about which sets a session held, and the tonnage filters to the
// same working rows the top set is picked from. `greatest(weight_kg, 0)` is the load-bearing clamp:
// gym_sets stores a NEGATIVE kg for band-assisted work (§2.3), and an unclamped sum would let an
// assisted pull-up subtract from a week somebody trained. A session whose working sets are all
// unloaded sums to zero, which is a real answer and not an absence.
TEST(pg_gym_log_counts_working_sets_apart_and_clamps_an_assisted_set_out_of_the_tonnage) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgTrainingRepository repo{wm::pgTestPool()};
  const std::uint64_t t1 = 1'700'000'000'123;

  repo.insertSession(sessionAt("ses_pg000001", t1));
  repo.insertSet(squatSet("set_pg000001", "ses_pg000001", 60, 10, t1 + 1'000, SetKind::warmup));
  repo.insertSet(squatSet("set_pg000002", "ses_pg000001", 100, 5, t1 + 2'000));
  repo.insertSet(squatSet("set_pg000003", "ses_pg000001", 100, 5, t1 + 3'000));
  repo.insertSet(benchSet("set_pg000004", 82.5, t1 + 4'000));                     // 82.5 × 8
  repo.insertSet(benchSet("set_pg000005", -20, t1 + 5'000));                      // assisted × 8
  repo.close(SessionId{"ses_pg000001"}, t1 + 6'000);
  // A whole session of chin-ups: working sets that moved no measurable load at all.
  repo.insertSession(sessionAt("ses_pg000002", t1 + 100'000));
  repo.insertSet(benchSet("set_pg000006", 0, t1 + 101'000, "ses_pg000002"));
  repo.close(SessionId{"ses_pg000002"}, t1 + 102'000);

  std::vector<SessionSummary> listed = pageOf(repo, wm::UserId{kUser}, page(t1 + 200'000, 50));

  REQUIRE_EQ(listed.size(), static_cast<std::size_t>(2));
  CHECK_EQ(listed[0].setCount, 1);
  CHECK_EQ(listed[0].workingSetCount, 1);
  CHECK_EQ(listed[0].tonnageKg, 0.0);
  CHECK_EQ(listed[1].setCount, 5);
  CHECK_EQ(listed[1].workingSetCount, 4);          // the ramp-up is counted, never worked
  CHECK_EQ(listed[1].tonnageKg, 100.0 * 5 + 100.0 * 5 + 82.5 * 8);   // the assisted set adds none
}

// The load ladder against the real statement: one row per distinct WORKING load, carrying the best
// reps done at it, heaviest first. It is what the log row's e1RM is computed from, and it has to be
// the loads rather than the top set — the heaviest set here is 100 × 5 and the session's estimate
// belongs to the 95 × 10 back-offs. The warmup is not in it, and a load at or below zero rides along
// unfiltered because which loads Epley is defined for is the domain's rule, stated in one place.
TEST(pg_gym_log_hands_back_one_row_per_working_load_with_the_best_reps_at_it) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgTrainingRepository repo{wm::pgTestPool()};
  const std::uint64_t t1 = 1'700'000'000'123;

  repo.insertSession(sessionAt("ses_pg000001", t1));
  repo.insertSet(squatSet("set_pg000001", "ses_pg000001", 60, 10, t1 + 1'000, SetKind::warmup));
  repo.insertSet(squatSet("set_pg000002", "ses_pg000001", 100, 5, t1 + 2'000));
  repo.insertSet(squatSet("set_pg000003", "ses_pg000001", 95, 6, t1 + 3'000));
  repo.insertSet(squatSet("set_pg000004", "ses_pg000001", 95, 10, t1 + 4'000));
  repo.insertSet(squatSet("set_pg000005", "ses_pg000001", 95, 8, t1 + 5'000));
  repo.insertSet(squatSet("set_pg000006", "ses_pg000001", -20, 12, t1 + 6'000));
  repo.close(SessionId{"ses_pg000001"}, t1 + 7'000);

  std::vector<SessionSummary> listed = pageOf(repo, wm::UserId{kUser}, page(t1 + 100'000, 50));

  REQUIRE_EQ(listed.size(), static_cast<std::size_t>(1));
  // One row per (movement, load) with the best reps at it, heaviest first — the projection both of
  // the row's rules read, and the one the domain's record walk is handed. Every one of them is
  // dated by the SESSION and not by the set that hit those reps: a mark belongs to the workout that
  // set it, which is the day every surface prints beside it (domain/Review.h).
  CHECK_EQ(listed[0].workingMarks,
           (std::vector<PriorMark>{PriorMark{ExerciseId{"back-squat"}, 100.0, 5, t1},
                                   PriorMark{ExerciseId{"back-squat"}, 95.0, 10, t1},
                                   PriorMark{ExerciseId{"back-squat"}, -20.0, 12, t1}}));
  // And what the application makes of it: the session's number, not its heaviest set's.
  CHECK_EQ(topE1rmOf(listed[0].workingMarks), e1rm(95.0, 10));
  CHECK_EQ(listed[0].topSet, std::optional<TopWorkingSet>(TopWorkingSet{100.0, 5}));
}

// The summary's movements are framed by the rows they come back in, so a display name holding
// whatever separator a hand-rolled aggregate would have used is still ONE movement.
TEST(pg_gym_log_names_a_movement_whose_display_name_holds_a_newline_once) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgTrainingRepository repo{wm::pgTestPool()};
  const std::uint64_t t1 = 1'700'000'000'123;
  {
    wm::PgLease c{*wm::pgTestPool()};
    pqxx::work w{*c};
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

  std::vector<SessionSummary> listed = pageOf(repo, wm::UserId{kUser}, page(t1 + 9'000, 50));

  REQUIRE_EQ(listed.size(), static_cast<std::size_t>(1));
  CHECK_EQ(listed[0].setCount, 2);
  CHECK_EQ(listed[0].exerciseNames, (std::vector<std::string>{"Bench Press", "Zercher\nSquat"}));
}

// The prefill read, against the real index. What has to hold: the most recent FINISHED session
// wins (the live one never does), warmups are not history, the block comes back in set_number
// order, the routine name is the one frozen in the session's own plan snapshot, and another
// account's identical movement is invisible.
TEST(pg_gym_last_time_is_the_newest_finished_session_of_that_movement) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgTrainingRepository repo{wm::pgTestPool()};
  const std::uint64_t t1 = 1'700'000'000'123;

  repo.insertSession(sessionAt("ses_pg000001", t1));
  repo.insertSet(benchSet("set_pg000001", 80.0, t1 + 1'000));
  repo.close(SessionId{"ses_pg000001"}, t1 + 2'000);

  repo.insertSession(Session{SessionId{"ses_pg000002"}, wm::UserId{kUser}, t1 + 10'000,
                             std::nullopt, std::nullopt,
                             PlanSnapshot{"Bench day", {}}});
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
  REQUIRE_EQ(theirs.lastTime->sets.size(), static_cast<std::size_t>(1));
  CHECK_EQ(theirs.lastTime->sets[0].weightKg, 142.5);
}

// A movement that was only ever warmed up has no last time — the same answer as one never touched.
TEST(pg_gym_last_time_of_a_first_ever_movement_is_empty_and_of_an_unknown_one_is_a_refusal) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgTrainingRepository repo{wm::pgTestPool()};
  const std::uint64_t t1 = 1'700'000'000'123;
  repo.insertSession(sessionAt("ses_pg000001", t1));
  repo.insertSet(Set{SetId{"set_pg000001"}, SessionId{"ses_pg000001"}, ExerciseId{"back-squat"}, 0,
                     60.0, 10, SetKind::warmup, std::nullopt, "", t1 + 1'000});
  repo.close(SessionId{"ses_pg000001"}, t1 + 2'000);
  {
    wm::PgLease c{*wm::pgTestPool()};
    pqxx::work w{*c};
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
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgTrainingRepository repo{wm::pgTestPool()};
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
  std::vector<SessionSummary> listed = pageOf(repo, wm::UserId{kUser}, page(t1 + 7 * day, 50));

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
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgTrainingRepository repo{wm::pgTestPool()};
  const std::uint64_t t1 = 1'700'000'000'123;
  repo.insertSession(Session{SessionId{"ses_pg000001"}, wm::UserId{kUser}, t1, std::nullopt,
                             std::nullopt, PlanSnapshot{"A private routine", {}}});
  repo.insertSet(benchSet("set_pg000001", 142.5, t1 + 1'000));
  repo.close(SessionId{"ses_pg000001"}, t1 + 2'000);
  {
    // A set row inside the owner's session carrying ANOTHER account's user_id. No API path mints
    // one today; the read must not depend on that staying true.
    wm::PgLease c{*wm::pgTestPool()};
    pqxx::work w{*c};
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
  REQUIRE_EQ(ours.lastTime->sets.size(), static_cast<std::size_t>(1));
  CHECK_EQ(ours.lastTime->sets[0].id, SetId{"set_pg000001"});
}

// Against real jsonb, with the blob written STRAIGHT INTO the column: the snapshot is a typed value
// now, so no writer in this module can produce any of these — which is exactly why the read is
// still pinned. `->>` renders an object, an array or a number as TEXT, and that text would be
// printed verbatim as the prefill card's cross-routine suffix. Only a string is a routine name, and
// a plan that is not an object is no plan at all.
TEST(pg_gym_last_time_names_the_routine_only_when_the_stored_plan_holds_a_string) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  const std::vector<std::pair<std::string, std::string>> snapshots{
      {R"({"routine":"Bench day","entries":[]})", "Bench day"},
      {R"({"routine":42})", ""},
      {R"({"routine":{"nested":1}})", ""},
      {R"({"routine":["a","b"]})", ""},
      {R"({"routine":null})", ""},
      {R"({"entries":[]})", ""},
      {R"(["a","b"])", ""},
      {R"("just a string")", ""},
      {"", ""},   // no plan at all: the ad-hoc session
  };
  const std::uint64_t t1 = 1'700'000'000'123;

  for (const auto& [snapshot, name] : snapshots) {
    reset();
    PgTrainingRepository repo{wm::pgTestPool()};
    repo.insertSession(sessionAt("ses_pg000001", t1));
    {
      wm::PgLease c{*wm::pgTestPool()};
      pqxx::work w{*c};
      w.exec_params("UPDATE gym_sessions SET plan = nullif($2, '')::jsonb WHERE id = $1",
                    "ses_pg000001", snapshot);
      w.commit();
    }
    SetInsertOutcome landed = repo.insertSet(benchSet("set_pg000001", 82.5, t1 + 1'000));
    repo.close(SessionId{"ses_pg000001"}, t1 + 2'000);

    LastTimeOutcome last = repo.lastTime(wm::UserId{kUser}, ExerciseId{"bench-press"});

    CHECK(last.error == LastTimeError::none);
    CHECK_EQ(last.lastTime->routineName, name);
    CHECK_EQ(last.lastTime->sets, std::vector<Set>{*landed.set});
  }
}

// The plan is the one shape written at BOTH edges — jsonb here, an object on the wire — and it goes
// through the same codec, so a session read back holds exactly what was frozen onto it. The name
// stays a plain string at the top level, which is what the prefill's type check looks for.
TEST(pg_gym_the_plan_snapshot_round_trips_through_jsonb) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgTrainingRepository repo{wm::pgTestPool()};
  const std::uint64_t t1 = 1'700'000'000'123;
  const PlanSnapshot frozen{
      "Push A",
      {PlanEntry{ExerciseId{"bench-press"}, 5, 5, 82.5, 180},
       PlanEntry{ExerciseId{"back-squat"}, 3, 8, std::nullopt, std::nullopt}}};

  // The routine has to exist for the session to point at it: routine_id is a real foreign key, and
  // it is the snapshot beside it — not the pointer — that the log reads its plan out of.
  repo.insertRoutine(routineAt("rt_pg000001", "Push A", {entryAt(1, "bench-press")}));
  repo.insertSession(Session{SessionId{"ses_pg000001"}, wm::UserId{kUser}, t1, std::nullopt,
                             RoutineId{"rt_pg000001"}, frozen});
  repo.insertSet(benchSet("set_pg000001", 82.5, t1 + 1'000));
  repo.close(SessionId{"ses_pg000001"}, t1 + 2'000);

  std::optional<Session> stored = repo.session(wm::UserId{kUser}, SessionId{"ses_pg000001"});
  LastTimeOutcome last = repo.lastTime(wm::UserId{kUser}, ExerciseId{"bench-press"});

  REQUIRE(stored.has_value());
  CHECK_EQ(stored->plan, std::optional<PlanSnapshot>(frozen));
  CHECK_EQ(stored->routine, std::optional<RoutineId>(RoutineId{"rt_pg000001"}));
  CHECK_EQ(last.lastTime->routineName, std::string("Push A"));
  CHECK_EQ(last.lastTime->session.plan, std::optional<PlanSnapshot>(frozen));
  // An ad-hoc session carries no plan, and no plan is an absence rather than an empty one.
  repo.insertSession(sessionAt("ses_pg000002", t1 + 10'000));
  CHECK_EQ(repo.session(wm::UserId{kUser}, SessionId{"ses_pg000002"})->plan,
           std::optional<PlanSnapshot>());
}

// ---- routines: two tables, one document, one transaction -----------------------------------

// The row and its lines land together, and the id is the idempotency key: a create replayed after a
// lost reply reads back what landed instead of appending a second copy of every line.
TEST(pg_gym_routine_create_is_idempotent_and_the_whole_document_round_trips) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgTrainingRepository repo{wm::pgTestPool()};
  // The same movement twice at two positions — bench heavy, then bench back-off — is the case the
  // (routine_id, position) key exists for, and it must survive a round trip in order.
  const Routine pushA = routineAt("rt_pg000001", "Push A",
                                  {entryAt(1, "bench-press", 5, 5, 82.5, 180),
                                   entryAt(2, "bench-press", 3, 12, 60.0, std::nullopt),
                                   entryAt(3, "back-squat", 3, 8, std::nullopt, std::nullopt)});

  RoutineWriteOutcome created = repo.insertRoutine(pushA);
  RoutineWriteOutcome replayed = repo.insertRoutine(
      routineAt("rt_pg000001", "Renamed mid-flight", {entryAt(1, "back-squat")}));

  CHECK(created.error == RoutineWriteError::none);
  CHECK_EQ(created.routine, std::optional<Routine>(pushA));
  CHECK(replayed.error == RoutineWriteError::none);
  CHECK_EQ(replayed.routine, created.routine);   // the STORED routine, untouched
  CHECK_EQ(repo.routine(wm::UserId{kUser}, RoutineId{"rt_pg000001"}),
           std::optional<Routine>(pushA));
  CHECK_EQ(repo.routine(wm::UserId{kOther}, RoutineId{"rt_pg000001"}), std::optional<Routine>());
  CHECK_EQ(repo.routines(wm::UserId{kOther}), std::vector<Routine>{});
}

// `Chin-up 3 × max` against the real column. target_reps dropped its NOT NULL for this line, so the
// write binds a null and the read hands back an absence — not a zero, and not the 8 the column used
// to default to. The CHECK still holds for every line that names a target.
TEST(pg_gym_a_routine_line_with_no_rep_target_round_trips_as_a_null) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgTrainingRepository repo{wm::pgTestPool()};
  const Routine pushA =
      routineAt("rt_pg000001", "Push A",
                {entryAt(1, "pull-up", 3, std::nullopt, std::nullopt, 180),
                 entryAt(2, "bench-press", 5, 5, 82.5, 180)});

  RoutineWriteOutcome created = repo.insertRoutine(pushA);
  std::optional<Routine> read = repo.routine(wm::UserId{kUser}, RoutineId{"rt_pg000001"});

  CHECK(created.error == RoutineWriteError::none);
  CHECK_EQ(created.routine, std::optional<Routine>(pushA));
  CHECK_EQ(read, std::optional<Routine>(pushA));
  CHECK_EQ(read->entries[0].targetReps, std::optional<int>());
  CHECK_EQ(read->entries[1].targetReps, std::optional<int>(5));
  CHECK_EQ(repo.routines(wm::UserId{kUser}), std::vector<Routine>{pushA});
  {
    wm::PgLease c{*wm::pgTestPool()};
    pqxx::work w{*c};
    CHECK_EQ(w.exec_params("SELECT count(*)::int AS n FROM gym_routine_entries "
                           "WHERE routine_id = $1 AND target_reps IS NULL",
                           "rt_pg000001")[0]["n"]
                 .as<int>(),
             1);
  }
  // A replace writes the null too — the whole document is laid down again, absences and all.
  RoutineWriteOutcome replaced = repo.replaceRoutine(
      routineAt("rt_pg000001", "Push A", {entryAt(1, "bench-press", 5, std::nullopt, 82.5, 180)}));
  CHECK(replaced.error == RoutineWriteError::none);
  CHECK_EQ(replaced.routine->entries[0].targetReps, std::optional<int>());
}

TEST(pg_gym_a_routine_id_another_account_holds_resolves_to_nothing) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgTrainingRepository repo{wm::pgTestPool()};
  repo.insertRoutine(Routine{RoutineId{"rt_pg000001"}, wm::UserId{kOther}, "Their plan", 0,
                             {entryAt(1, "bench-press")}});

  RoutineWriteOutcome taken = repo.insertRoutine(routineAt("rt_pg000001", "Mine", {entryAt(1, "back-squat")}));
  RoutineWriteOutcome replaced =
      repo.replaceRoutine(routineAt("rt_pg000001", "Mine now", {entryAt(1, "back-squat")}));

  CHECK(taken.error == RoutineWriteError::idTaken);
  CHECK_EQ(taken.routine, std::optional<Routine>());   // never the stranger's plan
  CHECK(replaced.error == RoutineWriteError::notFound);
  CHECK_FALSE(repo.deleteRoutine(wm::UserId{kUser}, RoutineId{"rt_pg000001"}));
  CHECK_EQ(repo.routine(wm::UserId{kOther}, RoutineId{"rt_pg000001"})->name,
           std::string("Their plan"));
}

// The catalog is the store's own fact and it leaves as a VALUE, exactly as a set's does — asked
// outright by the statement rather than caught off the foreign key, so "you may not see it" is
// sayable at all. The document is one transaction, so a refused line rolls back and leaves NO
// routine row behind — not even the header.
TEST(pg_gym_a_routine_entry_naming_no_movement_is_refused_and_leaves_no_row) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgTrainingRepository repo{wm::pgTestPool()};

  RoutineWriteOutcome refused = repo.insertRoutine(
      routineAt("rt_pg000001", "Push A",
                {entryAt(1, "bench-press"), entryAt(2, "pg-no-such-movement")}));

  CHECK(refused.error == RoutineWriteError::unknownExercise);
  CHECK_EQ(refused.routine, std::optional<Routine>());
  CHECK_EQ(repo.routine(wm::UserId{kUser}, RoutineId{"rt_pg000001"}), std::optional<Routine>());
  CHECK_EQ(repo.routines(wm::UserId{kUser}), std::vector<Routine>{});
  // The rolled-back transaction was the refused write's alone: the connection is reusable at once.
  RoutineWriteOutcome after = repo.insertRoutine(routineAt("rt_pg000001", "Push A", {entryAt(1, "bench-press")}));
  CHECK(after.error == RoutineWriteError::none);
  CHECK_EQ(after.routine->entries.size(), static_cast<std::size_t>(1));
}

// The same scope the set write is held to, on the other door a movement id travels through — and
// the replace half is checked beside the create, because both write the same whole document and a
// gate on only one of them is no gate at all.
TEST(pg_gym_a_routine_entry_may_not_name_another_accounts_private_movement) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgTrainingRepository repo{wm::pgTestPool()};
  repo.insertExercise(wm::UserId{kOther},
                      Exercise{ExerciseId{"pg-their-zercher"}, "Their Zercher Squat",
                               Pattern::squat, Equipment::barbell, 2.5, true});
  const Routine stored = routineAt("rt_pg000001", "Push A", {entryAt(1, "bench-press")});
  repo.insertRoutine(stored);

  RoutineWriteOutcome created =
      repo.insertRoutine(routineAt("rt_pg000002", "Push B", {entryAt(1, "pg-their-zercher")}));
  RoutineWriteOutcome replaced =
      repo.replaceRoutine(routineAt("rt_pg000001", "Push A2", {entryAt(1, "pg-their-zercher")}));

  CHECK(created.error == RoutineWriteError::unknownExercise);
  CHECK_EQ(created.routine, std::optional<Routine>());
  CHECK_EQ(repo.routine(wm::UserId{kUser}, RoutineId{"rt_pg000002"}), std::optional<Routine>());
  // A refused replace rolls back whole: the line it deleted is still there, and so is the name.
  CHECK(replaced.error == RoutineWriteError::unknownExercise);
  CHECK_EQ(replaced.routine, std::optional<Routine>());
  CHECK_EQ(repo.routine(wm::UserId{kUser}, RoutineId{"rt_pg000001"}), std::optional<Routine>(stored));
}

// A whole-document replace: a reorder, an insertion and a deletion are one write, and churning the
// lines costs no identity because a line has none — its key IS its position.
TEST(pg_gym_routine_replace_rewrites_every_line_and_a_missing_one_is_not_found) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgTrainingRepository repo{wm::pgTestPool()};
  repo.insertRoutine(routineAt("rt_pg000001", "Push A",
                               {entryAt(1, "bench-press"), entryAt(2, "back-squat")}));
  const Routine rewritten = routineAt("rt_pg000001", "Push A2",
                                      {entryAt(1, "back-squat", 4, 6, 100.0, 240)});

  RoutineWriteOutcome replaced = repo.replaceRoutine(rewritten);
  RoutineWriteOutcome missing =
      repo.replaceRoutine(routineAt("rt_pg000009", "Nowhere", {entryAt(1, "bench-press")}));
  RoutineWriteOutcome refused = repo.replaceRoutine(
      routineAt("rt_pg000001", "Push A3", {entryAt(1, "pg-no-such-movement")}));

  CHECK(replaced.error == RoutineWriteError::none);
  CHECK_EQ(replaced.routine, std::optional<Routine>(rewritten));
  CHECK_EQ(repo.routine(wm::UserId{kUser}, RoutineId{"rt_pg000001"}),
           std::optional<Routine>(rewritten));
  CHECK(missing.error == RoutineWriteError::notFound);
  // A refused replace rolls back whole: the lines it deleted are still there, and so is the name.
  CHECK(refused.error == RoutineWriteError::unknownExercise);
  CHECK_EQ(repo.routine(wm::UserId{kUser}, RoutineId{"rt_pg000001"}),
           std::optional<Routine>(rewritten));
}

TEST(pg_gym_routine_delete_cascades_its_lines_and_leaves_every_session_its_snapshot) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgTrainingRepository repo{wm::pgTestPool()};
  const std::uint64_t t1 = 1'700'000'000'123;
  repo.insertRoutine(routineAt("rt_pg000001", "Push A", {entryAt(1, "bench-press")}));
  repo.insertSession(Session{SessionId{"ses_pg000001"}, wm::UserId{kUser}, t1, std::nullopt,
                             RoutineId{"rt_pg000001"}, pushA()});
  repo.close(SessionId{"ses_pg000001"}, t1 + 1'000);

  CHECK(repo.deleteRoutine(wm::UserId{kUser}, RoutineId{"rt_pg000001"}));
  CHECK_FALSE(repo.deleteRoutine(wm::UserId{kUser}, RoutineId{"rt_pg000001"}));

  std::optional<Session> ran = repo.session(wm::UserId{kUser}, SessionId{"ses_pg000001"});
  REQUIRE(ran.has_value());
  CHECK_EQ(ran->routine, std::optional<RoutineId>());          // on delete set null
  CHECK_EQ(ran->plan, std::optional<PlanSnapshot>(pushA()));   // the copy is what survives
  CHECK_EQ(repo.routines(wm::UserId{kUser}), std::vector<Routine>{});
  {
    wm::PgLease c{*wm::pgTestPool()};
    pqxx::work w{*c};
    CHECK_EQ(w.exec_params("SELECT 1 FROM gym_routine_entries WHERE routine_id = $1",
                           "rt_pg000001")
                 .size(),
             static_cast<std::size_t>(0));
  }
}

// The routines screen's order, read off the log rather than a column: most recently trained first,
// never-trained after them, ties broken by (position, id) so the walk is deterministic.
TEST(pg_gym_routines_are_listed_most_recently_trained_first) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgTrainingRepository repo{wm::pgTestPool()};
  const std::uint64_t t1 = 1'700'000'000'123;
  repo.insertRoutine(routineAt("rt_pg000001", "Push A", {entryAt(1, "bench-press")}));
  repo.insertRoutine(routineAt("rt_pg000002", "Pull A", {entryAt(1, "back-squat")}));
  repo.insertRoutine(routineAt("rt_pg000003", "Legs", {entryAt(1, "back-squat")}));
  repo.insertSession(Session{SessionId{"ses_pg000001"}, wm::UserId{kUser}, t1, std::nullopt,
                             RoutineId{"rt_pg000002"}, PlanSnapshot{"Pull A", {}}});
  repo.close(SessionId{"ses_pg000001"}, t1 + 1'000);
  repo.insertSession(Session{SessionId{"ses_pg000002"}, wm::UserId{kUser}, t1 + 10'000,
                             std::nullopt, RoutineId{"rt_pg000001"}, pushA()});
  repo.close(SessionId{"ses_pg000002"}, t1 + 11'000);
  // Another account training its own routine cannot move this account's order.
  repo.insertRoutine(Routine{RoutineId{"rt_pg000004"}, wm::UserId{kOther}, "Theirs", 0,
                             {entryAt(1, "bench-press")}});

  std::vector<Routine> listed = repo.routines(wm::UserId{kUser});

  REQUIRE_EQ(listed.size(), static_cast<std::size_t>(3));
  CHECK_EQ(listed[0].name, std::string("Push A"));
  CHECK_EQ(listed[0].lastTrainedAtMs, std::optional<std::uint64_t>(t1 + 10'000));
  CHECK_EQ(listed[1].name, std::string("Pull A"));
  CHECK_EQ(listed[1].lastTrainedAtMs, std::optional<std::uint64_t>(t1));
  CHECK_EQ(listed[2].name, std::string("Legs"));
  CHECK_EQ(listed[2].lastTrainedAtMs, std::optional<std::uint64_t>());
  CHECK_EQ(listed[0].entries, std::vector<RoutineEntry>{entryAt(1, "bench-press")});
}

// ---- the finish read: the marks, the session it stands against, and the discard ---------------

// One row per (movement, load) carrying the BEST reps ever done at it — the projection all three
// record rules are answered from, which is what keeps Epley out of SQL. Restricted to the movements
// this session works, taken only from FINISHED sessions that started earlier, and dated by the
// EARLIEST SESSION to hit those reps — the workout, never the set's own device stamp, which is what
// puts one date under a record wherever it is read (domain/Review.h).
TEST(pg_gym_history_marks_the_best_reps_at_each_load_this_session_works) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgTrainingRepository repo{wm::pgTestPool()};
  const std::uint64_t t1 = 1'700'000'000'000;
  const std::uint64_t week = 604'800'000;

  repo.insertSession(sessionAt("ses_pg000001", t1 - 2 * week));
  repo.insertSet(squatSet("set_pg000001", "ses_pg000001", 100, 8, t1 - 2 * week + 60'000));
  repo.insertSet(squatSet("set_pg000002", "ses_pg000001", 100, 8, t1 - 2 * week + 120'000));
  repo.insertSet(squatSet("set_pg000003", "ses_pg000001", 100, 5, t1 - 2 * week + 180'000));
  repo.insertSet(squatSet("set_pg000004", "ses_pg000001", 90, 10, t1 - 2 * week + 240'000));
  // A warmup is not history, and neither is a movement this session never works.
  repo.insertSet(squatSet("set_pg000005", "ses_pg000001", 140, 3, t1 - 2 * week + 30'000,
                          SetKind::warmup));
  repo.insertSet(benchSet("set_pg000006", 80, t1 - 2 * week + 300'000, "ses_pg000001"));
  repo.close(SessionId{"ses_pg000001"}, t1 - 2 * week + 3'600'000);
  repo.insertSession(sessionAt("ses_pg000003", t1));
  repo.insertSet(squatSet("set_pg000010", "ses_pg000003", 105, 5, t1 + 60'000));
  repo.close(SessionId{"ses_pg000003"}, t1 + 3'600'000);
  // Inserted last, because the one-open index allows exactly one of these at a time: a session
  // nobody ever closed, holding the heaviest squat in the log.
  repo.insertSession(sessionAt("ses_pg000002", t1 - week));
  repo.insertSet(squatSet("set_pg000007", "ses_pg000002", 200, 5, t1 - week + 60'000));

  std::optional<Session> reviewed = repo.session(wm::UserId{kUser}, SessionId{"ses_pg000003"});
  REQUIRE(reviewed.has_value());
  SessionHistory history = repo.historyFor(wm::UserId{kUser}, *reviewed);

  const std::vector<PriorMark> marks{PriorMark{ExerciseId{"back-squat"}, 90, 10, t1 - 2 * week},
                                     PriorMark{ExerciseId{"back-squat"}, 100, 8, t1 - 2 * week}};
  CHECK_EQ(history.marks, marks);
  CHECK_EQ(history.previous, std::optional<Session>());   // no routine, nothing to stand against
  CHECK_EQ(history.previousSets, std::vector<Set>{});
  // Another account reads its own log and no part of this one.
  CHECK_EQ(repo.historyFor(wm::UserId{kOther}, *reviewed).marks, std::vector<PriorMark>{});
}

TEST(pg_gym_history_stands_against_the_last_finished_session_of_the_same_routine) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgTrainingRepository repo{wm::pgTestPool()};
  const std::uint64_t t1 = 1'700'000'000'000;
  const std::uint64_t week = 604'800'000;
  repo.insertRoutine(routineAt("rt_pg000001", "Push A", {entryAt(1, "back-squat")}));

  repo.insertSession(Session{SessionId{"ses_pg000001"}, wm::UserId{kUser}, t1 - 2 * week,
                             std::nullopt, RoutineId{"rt_pg000001"}, pushA()});
  repo.insertSet(squatSet("set_pg000001", "ses_pg000001", 95, 5, t1 - 2 * week + 60'000));
  repo.close(SessionId{"ses_pg000001"}, t1 - 2 * week + 3'600'000);
  // The same movement a week later, with no day of the program behind it: not what this stands
  // against, however recent.
  repo.insertSession(sessionAt("ses_pg000002", t1 - week));
  repo.insertSet(squatSet("set_pg000002", "ses_pg000002", 100, 5, t1 - week + 60'000));
  repo.close(SessionId{"ses_pg000002"}, t1 - week + 3'600'000);
  repo.insertSession(Session{SessionId{"ses_pg000003"}, wm::UserId{kUser}, t1, std::nullopt,
                             RoutineId{"rt_pg000001"}, pushA()});
  repo.insertSet(squatSet("set_pg000003", "ses_pg000003", 105, 5, t1 + 60'000));
  repo.close(SessionId{"ses_pg000003"}, t1 + 3'600'000);

  std::optional<Session> reviewed = repo.session(wm::UserId{kUser}, SessionId{"ses_pg000003"});
  REQUIRE(reviewed.has_value());
  SessionHistory history = repo.historyFor(wm::UserId{kUser}, *reviewed);

  // The window compares the PAIR (started_at, id), so the session under review is never its own
  // history — and without that a review read after the finish would find every set tying itself.
  REQUIRE(history.previous.has_value());
  CHECK_EQ(history.previous->id.str(), std::string("ses_pg000001"));
  CHECK_EQ(history.previous->plan, std::optional<PlanSnapshot>(pushA()));
  REQUIRE_EQ(history.previousSets.size(), static_cast<std::size_t>(1));
  CHECK_EQ(history.previousSets[0].weightKg, 95.0);
  // Each mark dated by the session it was set in — two sessions here, two dates, and neither of
  // them the instant a set carried.
  const std::vector<PriorMark> marks{PriorMark{ExerciseId{"back-squat"}, 95, 5, t1 - 2 * week},
                                     PriorMark{ExerciseId{"back-squat"}, 100, 5, t1 - week}};
  CHECK_EQ(history.marks, marks);
}

TEST(pg_gym_discard_takes_the_session_and_every_set_with_it) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgTrainingRepository repo{wm::pgTestPool()};
  const std::uint64_t t1 = 1'700'000'000'123;
  repo.insertSession(sessionAt("ses_pg000001", t1));
  repo.insertSet(benchSet("set_pg000001", 82.5, t1 + 1'000));
  repo.insertSet(benchSet("set_pg000002", 82.5, t1 + 2'000));
  repo.close(SessionId{"ses_pg000001"}, t1 + 3'000);

  CHECK_FALSE(repo.deleteSession(wm::UserId{kOther}, SessionId{"ses_pg000001"}));
  CHECK(repo.deleteSession(wm::UserId{kUser}, SessionId{"ses_pg000001"}));
  CHECK_FALSE(repo.deleteSession(wm::UserId{kUser}, SessionId{"ses_pg000001"}));

  CHECK_EQ(repo.session(wm::UserId{kUser}, SessionId{"ses_pg000001"}), std::optional<Session>());
  // `on delete cascade`: the sets go with the row rather than outliving it as orphans.
  CHECK_EQ(repo.setsOf(SessionId{"ses_pg000001"}), std::vector<Set>{});
  {
    wm::PgLease c{*wm::pgTestPool()};
    pqxx::work w{*c};
    CHECK_EQ(w.exec_params("SELECT 1 FROM gym_sets WHERE session_id = $1", "ses_pg000001").size(),
             static_cast<std::size_t>(0));
  }
}

// ---- the catalog's one write ---------------------------------------------------------------

TEST(pg_gym_create_exercise_is_the_callers_alone_and_a_spent_id_is_refused) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgTrainingRepository repo{wm::pgTestPool()};
  const Exercise mine{ExerciseId{"pg-zercher-squat"}, "Zercher Squat", Pattern::squat,
                      Equipment::machine, 5.0, true};

  ExerciseInsertOutcome created = repo.insertExercise(wm::UserId{kUser}, mine);
  ExerciseInsertOutcome replayed = repo.insertExercise(
      wm::UserId{kUser}, Exercise{ExerciseId{"pg-zercher-squat"}, "Renamed mid-flight",
                                  Pattern::squat, Equipment::machine, 5.0, true});
  ExerciseInsertOutcome theirs = repo.insertExercise(
      wm::UserId{kOther}, Exercise{ExerciseId{"pg-zercher-squat"}, "Theirs", Pattern::squat,
                                   Equipment::machine, 5.0, true});
  ExerciseInsertOutcome seedSlug = repo.insertExercise(
      wm::UserId{kUser}, Exercise{ExerciseId{"bench-press"}, "My Bench", Pattern::press,
                                  Equipment::barbell, 2.5, true});

  CHECK(created.error == ExerciseInsertError::none);
  CHECK_EQ(created.exercise, std::optional<Exercise>(mine));
  CHECK(replayed.error == ExerciseInsertError::none);
  CHECK_EQ(replayed.exercise, std::optional<Exercise>(mine));   // the stored row, name and all
  CHECK(theirs.error == ExerciseInsertError::idTaken);
  CHECK_EQ(theirs.exercise, std::optional<Exercise>());
  CHECK(seedSlug.error == ExerciseInsertError::idTaken);
  // It is theirs alone: 64 seeds plus this one for the owner, 64 flat for everybody else.
  CHECK_EQ(repo.catalog(wm::UserId{kUser}).size(), static_cast<std::size_t>(65));
  CHECK_EQ(repo.catalog(wm::UserId{kOther}).size(), static_cast<std::size_t>(64));
  // And a created movement is a movement: a set may name it, and a plan may hold it.
  repo.insertSession(sessionAt("ses_pg000001", 1'700'000'000'123));
  CHECK(repo.insertSet(Set{SetId{"set_pg000001"}, SessionId{"ses_pg000001"},
                           ExerciseId{"pg-zercher-squat"}, 0, 60.0, 8, SetKind::working,
                           std::nullopt, "", 1'700'000'001'123})
            .error == SetInsertError::none);
  CHECK(repo.insertRoutine(routineAt("rt_pg000001", "Push A", {entryAt(1, "pg-zercher-squat")}))
            .error == RoutineWriteError::none);
}

// The domain's step band is the column's band, and this is where that claim is checked rather than
// asserted: 99.99 and 0.01 store and read back unchanged, and a step outside them never reaches
// here because the Exercise constructor refuses it — which is what keeps a numeric overflow from
// leaving the repository as the house 500 the ladder documents as retryable.
TEST(pg_gym_the_step_band_the_domain_enforces_is_exactly_what_the_column_holds) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgTrainingRepository repo{wm::pgTestPool()};
  const Exercise ceiling{ExerciseId{"pg-heavy-step"}, "Heavy Step", Pattern::squat,
                         Equipment::machine, kMaxStepKg, true};
  const Exercise floorStep{ExerciseId{"pg-fine-step"}, "Fine Step", Pattern::isolation,
                           Equipment::cable, kMinStepKg, true};

  ExerciseInsertOutcome top = repo.insertExercise(wm::UserId{kUser}, ceiling);
  ExerciseInsertOutcome fine = repo.insertExercise(wm::UserId{kUser}, floorStep);

  CHECK(top.error == ExerciseInsertError::none);
  CHECK_EQ(top.exercise, std::optional<Exercise>(ceiling));
  CHECK_EQ(top.exercise->stepKg, 99.99);
  CHECK(fine.error == ExerciseInsertError::none);
  CHECK_EQ(fine.exercise->stepKg, 0.01);
  // And what the domain refuses is what the column would have raised on: proved by the statement
  // the repository would have run, so the constructor's bound is the column's and not a guess.
  {
    wm::PgLease c{*wm::pgTestPool()};
    pqxx::work w{*c};
    bool overflowed = false;
    try {
      w.exec_params("INSERT INTO gym_exercises (id, name, pattern, equipment, step_kg, created_by) "
                    "VALUES ($1, $2, 'squat', 'barbell', $3, $4::uuid)",
                    "pg-overflow-step", "Overflow Step", 100.0, kUser);
    } catch (const pqxx::data_exception&) {
      overflowed = true;
    }
    CHECK(overflowed);
  }
}

// A row written before the instant band was enforced still reads: it is clamped into the band
// rather than failing the conversion, so one poisoned row cannot take down the whole log.
TEST(pg_gym_reads_a_pre_1970_legacy_row_instead_of_failing_the_whole_log) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgTrainingRepository repo{wm::pgTestPool()};
  const std::uint64_t t1 = 1'700'000'000'123;
  repo.insertSession(sessionAt("ses_pg000001", t1));
  {
    wm::PgLease c{*wm::pgTestPool()};
    pqxx::work w{*c};
    w.exec_params("INSERT INTO gym_sessions (id, user_id, started_at, finished_at) "
                  "VALUES ('ses_pg000002', $1::uuid, to_timestamp(-1), to_timestamp(-1))", kUser);
    w.commit();
  }

  std::vector<SessionSummary> listed = pageOf(repo, wm::UserId{kUser}, page(t1 + 9'000, 50));

  REQUIRE_EQ(listed.size(), static_cast<std::size_t>(2));
  CHECK_EQ(listed[0].session.id.str(), std::string("ses_pg000001"));
  CHECK_EQ(listed[1].session.id.str(), std::string("ses_pg000002"));
  CHECK_EQ(listed[1].session.startedAtMs, static_cast<std::uint64_t>(1));
  CHECK_EQ(listed[1].session.finishedAtMs, std::optional<std::uint64_t>(1));
  CHECK_EQ(repo.session(wm::UserId{kUser}, SessionId{"ses_pg000002"})->startedAtMs,
           static_cast<std::uint64_t>(1));
}

// ---- the statistics read -------------------------------------------------------------------

// The three projections, proved against a real planner: one point per (movement, session) under
// TopSet's rule, one mark per (movement, load) under the review's, and the weekly counts. No Epley
// is computed anywhere in the SQL — the numbers below are loads and reps, and the estimate over
// them is the domain's.
TEST(pg_gym_statistics_is_the_top_set_per_session_the_marks_and_the_weekly_counts) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgTrainingRepository repo{wm::pgTestPool()};
  const std::uint64_t t1 = 1'700'000'000'000;
  const std::uint64_t week = 604'800'000;

  repo.insertSession(sessionAt("ses_pg000001", t1));
  repo.insertSet(squatSet("set_pg000001", "ses_pg000001", 100, 5, t1 + 60'000));
  repo.insertSet(squatSet("set_pg000002", "ses_pg000001", 110, 2, t1 + 120'000));
  repo.insertSet(squatSet("set_pg000003", "ses_pg000001", 60, 10, t1 + 180'000, SetKind::warmup));
  repo.close(SessionId{"ses_pg000001"}, t1 + 3'600'000);
  repo.insertSession(sessionAt("ses_pg000002", t1 + week));
  repo.insertSet(squatSet("set_pg000004", "ses_pg000002", 105, 5, t1 + week + 60'000));
  repo.close(SessionId{"ses_pg000002"}, t1 + week + 3'600'000);

  TrainingLog log = repo.trainingLog(wm::UserId{kUser});

  // The heaviest working set, ties to more reps — and the warmup counts toward nothing, here as
  // everywhere else the product aggregates.
  CHECK_EQ(log.tops, (std::vector<MovementTop>{MovementTop{ExerciseId{"back-squat"}, t1, 110, 2},
                                               MovementTop{ExerciseId{"back-squat"}, t1 + week,
                                                           105, 5}}));
  // A mark carries the START of the session it was set in, which is the instant its point above
  // carries too: the standing best and the point that IS that best cannot land on two days.
  CHECK_EQ(log.marks, (std::vector<PriorMark>{
                          PriorMark{ExerciseId{"back-squat"}, 100, 5, t1},
                          PriorMark{ExerciseId{"back-squat"}, 105, 5, t1 + week},
                          PriorMark{ExerciseId{"back-squat"}, 110, 2, t1}}));
  // Monday 00:00 UTC, truncated `AT TIME ZONE 'UTC'` so the buckets do not move with the server's
  // own zone — 1699833600000 is 2023-11-13, the Monday of the week t1 falls in.
  CHECK_EQ(log.weeks, (std::vector<TrainingWeek>{TrainingWeek{1'699'833'600'000, 1, 2},
                                                 TrainingWeek{1'699'833'600'000 + week, 1, 1}}));
}

// generate_series fills the run, so a week nobody trained is a zero and not a missing row: the gap
// is the fact, and a client filling it in would be doing calendar arithmetic in a second place.
TEST(pg_gym_statistics_weeks_are_contiguous_across_a_week_nobody_trained) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgTrainingRepository repo{wm::pgTestPool()};
  const std::uint64_t t1 = 1'700'000'000'000;
  const std::uint64_t week = 604'800'000;

  repo.insertSession(sessionAt("ses_pg000001", t1));
  repo.insertSet(squatSet("set_pg000001", "ses_pg000001", 100, 5, t1 + 60'000));
  repo.close(SessionId{"ses_pg000001"}, t1 + 3'600'000);
  repo.insertSession(sessionAt("ses_pg000002", t1 + 2 * week));
  repo.insertSet(squatSet("set_pg000002", "ses_pg000002", 105, 5, t1 + 2 * week + 60'000));
  repo.close(SessionId{"ses_pg000002"}, t1 + 2 * week + 3'600'000);

  TrainingLog log = repo.trainingLog(wm::UserId{kUser});

  CHECK_EQ(log.weeks, (std::vector<TrainingWeek>{
                          TrainingWeek{1'699'833'600'000, 1, 1},
                          TrainingWeek{1'699'833'600'000 + week, 0, 0},
                          TrainingWeek{1'699'833'600'000 + 2 * week, 1, 1}}));
}

TEST(pg_gym_statistics_leaves_the_open_session_and_another_account_out) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgTrainingRepository repo{wm::pgTestPool()};
  const std::uint64_t t1 = 1'700'000'000'000;

  repo.insertSession(sessionAt("ses_pg000001", t1));   // today's workout, never closed
  repo.insertSet(squatSet("set_pg000001", "ses_pg000001", 100, 5, t1 + 60'000));
  repo.insertSession(Session{SessionId{"ses_pg000003"}, wm::UserId{kOther}, t1});
  repo.insertSet(squatSet("set_pg000003", "ses_pg000003", 200, 5, t1 + 60'000));
  repo.close(SessionId{"ses_pg000003"}, t1 + 3'600'000);

  TrainingLog log = repo.trainingLog(wm::UserId{kUser});

  CHECK(log.tops.empty());
  CHECK(log.marks.empty());
  CHECK(log.weeks.empty());
}

// ---- the export ------------------------------------------------------------------------------

// Every cell is rendered by Postgres and the exact bytes are pinned here, because the in-memory
// fake states the same three renderings — this case is what keeps the two from drifting apart.
TEST(pg_gym_export_renders_instants_as_iso_utc_and_numerics_at_their_column_scale) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgTrainingRepository repo{wm::pgTestPool()};
  const std::uint64_t t1 = 1'700'000'000'000;

  repo.insertSession(Session{SessionId{"ses_pg000001"}, wm::UserId{kUser}, t1, std::nullopt,
                             std::nullopt, pushA()});
  repo.insertSet(Set{SetId{"set_pg000001"}, SessionId{"ses_pg000001"}, ExerciseId{"back-squat"}, 0,
                     82.5, 8, SetKind::working, 8.5, "felt heavy, said \"again\"",
                     t1 + 60'000});

  std::vector<ExportedSet> rows = repo.exportedSets(wm::UserId{kUser});

  REQUIRE_EQ(rows.size(), static_cast<std::size_t>(1));
  CHECK_EQ(rows[0],
           (ExportedSet{"ses_pg000001", "2023-11-14T22:13:20Z", "", "Push A", "set_pg000001",
                        "back-squat", "Back Squat", "1", "82.50", "8", "working", "8.5",
                        "felt heavy, said \"again\"", "2023-11-14T22:14:20Z"}));
  CHECK_EQ(rows[0].startedAt, fake::isoUtc(t1));
  CHECK_EQ(rows[0].weightKg, fake::scaled(82.5, 2));
  CHECK_EQ(rows[0].rpe, fake::scaled(8.5, 1));
}

TEST(pg_gym_export_never_reaches_another_accounts_sets) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgTrainingRepository repo{wm::pgTestPool()};
  const std::uint64_t t1 = 1'700'000'000'000;
  repo.insertSession(Session{SessionId{"ses_pg000003"}, wm::UserId{kOther}, t1});
  repo.insertSet(squatSet("set_pg000003", "ses_pg000003", 200, 5, t1 + 60'000));

  CHECK(repo.exportedSets(wm::UserId{kUser}).empty());
  CHECK_EQ(repo.exportedSets(wm::UserId{kOther}).size(), static_cast<std::size_t>(1));
}

// ---- the coach share ---------------------------------------------------------------------------

TEST(pg_gym_share_is_idempotent_on_the_session_and_replaces_one_that_has_ended) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgTrainingRepository repo{wm::pgTestPool()};
  const std::uint64_t now = 1'700'000'000'000;
  repo.insertSession(sessionAt("ses_pg000001", now));
  repo.close(SessionId{"ses_pg000001"}, now + 3'600'000);

  std::optional<SessionShare> first =
      repo.insertShare(SessionShare{SessionId{"ses_pg000001"}, wm::UserId{kUser}, "pg-tok-one",
                                    now + kShareLifetimeMs},
                       now);
  std::optional<SessionShare> again =
      repo.insertShare(SessionShare{SessionId{"ses_pg000001"}, wm::UserId{kUser}, "pg-tok-two",
                                    now + kShareLifetimeMs},
                       now);

  REQUIRE(first);
  REQUIRE(again);
  CHECK_EQ(first->token, std::string("pg-tok-one"));
  CHECK_EQ(again->token, std::string("pg-tok-one"));   // the live link, not a second capability
  CHECK_EQ(again->expiresAtMs, now + kShareLifetimeMs);

  // A month later the row has ended, and re-sharing mints a NEW capability rather than reviving it.
  const std::uint64_t later = now + kShareLifetimeMs + 1;
  std::optional<SessionShare> minted =
      repo.insertShare(SessionShare{SessionId{"ses_pg000001"}, wm::UserId{kUser}, "pg-tok-three",
                                    later + kShareLifetimeMs},
                       later);
  REQUIRE(minted);
  CHECK_EQ(minted->token, std::string("pg-tok-three"));
  CHECK_EQ(minted->expiresAtMs, later + kShareLifetimeMs);
  CHECK_FALSE(repo.sharedSession("pg-tok-one", later));
}

TEST(pg_gym_share_never_reaches_an_absent_or_another_accounts_session) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgTrainingRepository repo{wm::pgTestPool()};
  const std::uint64_t now = 1'700'000'000'000;
  repo.insertSession(Session{SessionId{"ses_pg000003"}, wm::UserId{kOther}, now});
  repo.close(SessionId{"ses_pg000003"}, now + 3'600'000);

  CHECK_FALSE(repo.insertShare(SessionShare{SessionId{"ses_pg000009"}, wm::UserId{kUser}, "pg-a",
                                            now + kShareLifetimeMs},
                               now));
  CHECK_FALSE(repo.insertShare(SessionShare{SessionId{"ses_pg000003"}, wm::UserId{kUser}, "pg-b",
                                            now + kShareLifetimeMs},
                               now));
  CHECK_FALSE(repo.revokeShare(wm::UserId{kUser}, SessionId{"ses_pg000003"}));
  CHECK_FALSE(repo.sharedSession("pg-a", now));
  CHECK_FALSE(repo.sharedSession("pg-b", now));
}

TEST(pg_gym_shared_session_answers_one_workout_and_nothing_about_the_account) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgTrainingRepository repo{wm::pgTestPool()};
  const std::uint64_t now = 1'700'000'000'000;
  repo.insertSession(Session{SessionId{"ses_pg000001"}, wm::UserId{kUser}, now, std::nullopt,
                             std::nullopt, pushA()});
  repo.insertSet(squatSet("set_pg000001", "ses_pg000001", 100, 5, now + 60'000));
  repo.insertSet(squatSet("set_pg000002", "ses_pg000001", 110, 2, now + 120'000));
  repo.close(SessionId{"ses_pg000001"}, now + 3'600'000);
  repo.insertShare(SessionShare{SessionId{"ses_pg000001"}, wm::UserId{kUser}, "pg-tok-live",
                                now + kShareLifetimeMs},
                   now);

  std::optional<SharedSession> read = repo.sharedSession("pg-tok-live", now + 1);

  REQUIRE(read);
  CHECK_EQ(read->startedAtMs, now);
  CHECK_EQ(read->finishedAtMs, std::optional<std::uint64_t>(now + 3'600'000));
  // The name off the session's OWN frozen snapshot, never off a routine as it is called today.
  CHECK_EQ(read->routineName, std::string("Push A"));
  CHECK_EQ(read->sets,
           (std::vector<SharedSet>{
               SharedSet{"Back Squat", 1, 100, 5, SetKind::working, std::nullopt, "", now + 60'000},
               SharedSet{"Back Squat", 2, 110, 2, SetKind::working, std::nullopt, "",
                         now + 120'000}}));

  // Expired, unknown and revoked are one answer, and the end is not inclusive.
  CHECK_FALSE(repo.sharedSession("pg-tok-live", now + kShareLifetimeMs));
  CHECK_FALSE(repo.sharedSession("nobody-minted-this", now + 1));
  CHECK(repo.revokeShare(wm::UserId{kUser}, SessionId{"ses_pg000001"}));
  CHECK_FALSE(repo.sharedSession("pg-tok-live", now + 1));
}

// The share goes with the workout: `on delete cascade` means a discard leaves no live link behind
// pointing at a session that is gone.
TEST(pg_gym_discarding_a_session_takes_its_share_with_it) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgTrainingRepository repo{wm::pgTestPool()};
  const std::uint64_t now = 1'700'000'000'000;
  repo.insertSession(sessionAt("ses_pg000001", now));
  repo.close(SessionId{"ses_pg000001"}, now + 3'600'000);
  repo.insertShare(SessionShare{SessionId{"ses_pg000001"}, wm::UserId{kUser}, "pg-tok-doomed",
                                now + kShareLifetimeMs},
                   now);
  CHECK(repo.sharedSession("pg-tok-doomed", now + 1));

  CHECK(repo.deleteSession(wm::UserId{kUser}, SessionId{"ses_pg000001"}));

  CHECK_FALSE(repo.sharedSession("pg-tok-doomed", now + 1));
}

// The marks standing BEFORE a page, against the real statement. A page is judged against the
// history in front of it, and page two has history page two cannot see — so the read hands over the
// same projection with the window moved to "every finished session older than this page's last row",
// narrowed to the movements the page trains. The first page stands on the older session's marks;
// paging past it leaves nothing standing at all.
TEST(pg_gym_log_hands_over_the_marks_standing_before_the_page) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgTrainingRepository repo{wm::pgTestPool()};
  const std::uint64_t t1 = 1'700'000'000'000;
  const std::uint64_t day = 86'400'000;

  repo.insertSession(sessionAt("ses_pg000001", t1));
  repo.insertSet(squatSet("set_pg000001", "ses_pg000001", 100, 5, t1 + 1'000));
  repo.insertSet(benchSet("set_pg000002", 80.0, t1 + 2'000, "ses_pg000001"));
  repo.close(SessionId{"ses_pg000001"}, t1 + 3'000);
  repo.insertSession(sessionAt("ses_pg000002", t1 + day));
  repo.insertSet(squatSet("set_pg000003", "ses_pg000002", 105, 5, t1 + day + 1'000));
  repo.close(SessionId{"ses_pg000002"}, t1 + day + 2'000);

  const LogPage newest = repo.log(wm::UserId{kUser}, page(t1 + 2 * day, 1));
  const LogPage whole = repo.log(wm::UserId{kUser}, page(t1 + 2 * day, 50));

  // One row on the page, and the squat mark it has to beat comes back beside it. The BENCH mark
  // does not: the page does not train it, so it is not history this page needs.
  REQUIRE_EQ(newest.sessions.size(), static_cast<std::size_t>(1));
  CHECK_EQ(newest.standing,
           (std::vector<PriorMark>{PriorMark{ExerciseId{"back-squat"}, 100.0, 5, t1}}));
  // The whole log on one page: nothing was finished before its oldest row, so nothing stands.
  REQUIRE_EQ(whole.sessions.size(), static_cast<std::size_t>(2));
  CHECK_EQ(whole.standing, std::vector<PriorMark>{});
}

// The two windows this read applies are DIFFERENT on purpose, and the difference is what the domain
// has to be told about: a page carries the OPEN workout as a row like any other, while the marks
// standing before it count FINISHED sessions alone. Filtering the page here instead would drop the
// open row off the log; folding its marks in the domain would judge the row above it against
// history that session's own finish screen cannot see.
TEST(pg_gym_log_lists_the_open_session_and_never_lets_its_marks_stand_before_a_page) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgTrainingRepository repo{wm::pgTestPool()};
  const std::uint64_t t1 = 1'700'000'000'000;
  const std::uint64_t day = 86'400'000;

  repo.insertSession(sessionAt("ses_pg000001", t1));
  repo.insertSet(squatSet("set_pg000001", "ses_pg000001", 100, 5, t1 + 1'000));
  repo.close(SessionId{"ses_pg000001"}, t1 + 2'000);
  repo.insertSession(sessionAt("ses_pg000002", t1 + day));   // still running, and the heavier day
  repo.insertSet(squatSet("set_pg000002", "ses_pg000002", 110, 5, t1 + day + 1'000));

  const LogPage newest = repo.log(wm::UserId{kUser}, page(t1 + 2 * day, 1));
  const LogPage whole = repo.log(wm::UserId{kUser}, page(t1 + 2 * day, 50));

  // The open workout is the newest row, and what stands before it is the finished day alone.
  REQUIRE_EQ(newest.sessions.size(), static_cast<std::size_t>(1));
  CHECK_EQ(newest.sessions[0].session.id, SessionId{"ses_pg000002"});
  CHECK_EQ(newest.sessions[0].session.finishedAtMs, std::optional<std::uint64_t>());
  CHECK_EQ(newest.standing,
           (std::vector<PriorMark>{PriorMark{ExerciseId{"back-squat"}, 100.0, 5, t1}}));
  // Both rows on one page: the open one's 110 × 5 is a mark of the PAGE and never a standing one.
  REQUIRE_EQ(whole.sessions.size(), static_cast<std::size_t>(2));
  CHECK_EQ(whole.sessions[0].workingMarks,
           (std::vector<PriorMark>{PriorMark{ExerciseId{"back-squat"}, 110.0, 5, t1 + day}}));
  CHECK_EQ(whole.standing, std::vector<PriorMark>{});
}

// THE HAZARD, against the real table: the 64 seeds are GLOBAL rows, so a rename that touched
// gym_exercises would rename Back Squat for every lifter on this server. This case is what stops
// that statement from ever being written — it asserts the OTHER account's catalog, and the row
// itself, are untouched.
TEST(pg_gym_renaming_a_seed_is_one_accounts_alone_and_leaves_the_global_row_untouched) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgTrainingRepository repo{wm::pgTestPool()};

  const std::optional<Exercise> renamed =
      repo.renameExercise(wm::UserId{kUser}, ExerciseId{"back-squat"}, "Low-bar Squat");

  REQUIRE(renamed.has_value());
  CHECK_EQ(renamed->id, ExerciseId{"back-squat"});      // the id never moves
  CHECK_EQ(renamed->name, std::string("Low-bar Squat"));
  CHECK_EQ(renamed->custom, false);
  bool mine = false;
  for (const Exercise& row : repo.catalog(wm::UserId{kUser}))
    if (row.id == ExerciseId{"back-squat"} && row.name == "Low-bar Squat") mine = true;
  bool theirs = false;
  for (const Exercise& row : repo.catalog(wm::UserId{kOther}))
    if (row.id == ExerciseId{"back-squat"} && row.name == "Back Squat") theirs = true;
  CHECK(mine);
  CHECK(theirs);
  // And the global row itself still says what the seed says.
  wm::PgLease conn{*wm::pgTestPool()};
  pqxx::work txn{*conn};
  CHECK_EQ(txn.exec_params("SELECT name FROM gym_exercises WHERE id = 'back-squat'")[0][0]
               .as<std::string>(),
           std::string("Back Squat"));
}

// A movement the caller CREATED is their own row and renames in place — no line beside it, because
// there is no global row to protect. Renaming a seed back to its own name clears the line instead
// of storing a copy of it.
TEST(pg_gym_renaming_your_own_movement_edits_its_row_and_clearing_a_seeds_name_drops_the_line) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgTrainingRepository repo{wm::pgTestPool()};
  repo.insertExercise(wm::UserId{kUser},
                      Exercise{ExerciseId{"ex_pg000001"}, "Zercher Squat", Pattern::squat,
                               Equipment::barbell, 2.5, true});

  const std::optional<Exercise> own =
      repo.renameExercise(wm::UserId{kUser}, ExerciseId{"ex_pg000001"}, "Zercher");
  repo.renameExercise(wm::UserId{kUser}, ExerciseId{"back-squat"}, "Low-bar Squat");
  // Typed back with the stray space a keyboard leaves: the entity trims before anything compares,
  // so this is the seed's own name and clears the line rather than pinning a copy that differs from
  // it by one byte.
  const std::optional<Exercise> restored =
      repo.renameExercise(wm::UserId{kUser}, ExerciseId{"back-squat"}, " Back Squat ");

  REQUIRE(own.has_value());
  CHECK_EQ(own->name, std::string("Zercher"));
  CHECK_EQ(own->custom, true);
  REQUIRE(restored.has_value());
  CHECK_EQ(restored->name, std::string("Back Squat"));
  wm::PgLease conn{*wm::pgTestPool()};
  pqxx::work txn{*conn};
  CHECK_EQ(txn.exec_params("SELECT count(*)::int FROM gym_exercise_names WHERE user_id = $1::uuid",
                           kUser)[0][0]
               .as<int>(),
           0);
  // The rename edited the caller's own row and nobody else's: another account cannot see it at all.
  CHECK_EQ(repo.renameExercise(wm::UserId{kOther}, ExerciseId{"ex_pg000001"}, "Mine"),
           std::optional<Exercise>());
  CHECK_EQ(repo.renameExercise(wm::UserId{kUser}, ExerciseId{"no-such"}, "Mine"),
           std::optional<Exercise>());
}

// Every read that prints a movement name reads the CALLER's name for it — the catalog, the log
// row's movement list, the export, and the coach share (which resolves against the OWNER of the
// workout, the one account a token's reader has). A read that missed the coalesce would print the
// seed name to the one lifter who renamed it.
TEST(pg_gym_every_read_that_names_a_movement_names_it_as_the_caller_does) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgTrainingRepository repo{wm::pgTestPool()};
  const std::uint64_t t1 = 1'700'000'000'000;

  repo.insertSession(sessionAt("ses_pg000001", t1));
  repo.insertSet(squatSet("set_pg000001", "ses_pg000001", 100, 5, t1 + 1'000));
  repo.close(SessionId{"ses_pg000001"}, t1 + 2'000);
  repo.renameExercise(wm::UserId{kUser}, ExerciseId{"back-squat"}, "Low-bar Squat");
  repo.insertShare(SessionShare{SessionId{"ses_pg000001"}, wm::UserId{kUser}, "tok_pg000001",
                                t1 + 30ull * 86'400'000},
                   t1);

  const std::vector<SessionSummary> listed = pageOf(repo, wm::UserId{kUser}, page(t1 + 9'000, 50));
  const std::vector<ExportedSet> exported = repo.exportedSets(wm::UserId{kUser});
  const std::optional<SharedSession> shared = repo.sharedSession("tok_pg000001", t1 + 1);

  REQUIRE_EQ(listed.size(), static_cast<std::size_t>(1));
  CHECK_EQ(listed[0].exerciseNames, std::vector<std::string>{"Low-bar Squat"});
  REQUIRE_EQ(exported.size(), static_cast<std::size_t>(1));
  CHECK_EQ(exported[0].exerciseName, std::string("Low-bar Squat"));
  CHECK_EQ(exported[0].exerciseId, std::string("back-squat"));   // the id in the file never moved
  REQUIRE(shared.has_value());
  REQUIRE_EQ(shared->sets.size(), static_cast<std::size_t>(1));
  CHECK_EQ(shared->sets[0].exercise, std::string("Low-bar Squat"));
}

// The record read against the real statements: one ladder per FINISHED session oldest first, the
// routines that name the movement counted once each, and the last training days with their sets in
// the order they were performed. The open session and another account's are nowhere in it.
TEST(pg_gym_movement_history_is_a_ladder_per_finished_session_the_routines_and_the_recent_days) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgTrainingRepository repo{wm::pgTestPool()};
  const std::uint64_t t1 = 1'700'000'000'000;
  const std::uint64_t day = 86'400'000;
  // The same movement twice in one routine — heavy, then a back-off — is still ONE routine.
  repo.insertRoutine(routineAt("rt_pg000001", "Legs",
                               {entryAt(1, "back-squat"), entryAt(2, "back-squat")}));

  repo.insertSession(sessionAt("ses_pg000001", t1));
  repo.insertSet(squatSet("set_pg000001", "ses_pg000001", 60, 10, t1 + 1'000, SetKind::warmup));
  repo.insertSet(squatSet("set_pg000002", "ses_pg000001", 100, 5, t1 + 2'000));
  repo.insertSet(squatSet("set_pg000003", "ses_pg000001", 95, 10, t1 + 3'000));
  repo.close(SessionId{"ses_pg000001"}, t1 + 4'000);
  repo.insertSession(sessionAt("ses_pg000002", t1 + day));   // still open: not history yet

  const MovementHistory history =
      repo.movementHistory(wm::UserId{kUser}, ExerciseId{"back-squat"});

  REQUIRE(history.exercise.has_value());
  CHECK_EQ(history.exercise->id, ExerciseId{"back-squat"});
  CHECK_EQ(history.routines, 1);
  REQUIRE_EQ(history.sessions.size(), static_cast<std::size_t>(1));
  CHECK_EQ(history.sessions[0].session, SessionId{"ses_pg000001"});
  CHECK_EQ(history.sessions[0].startedAtMs, t1);   // the SESSION's start, never a set's stamp
  // And the ladder's own rows carry that same instant, so the bar, the tile and the record line the
  // page computes off them cannot land on three days.
  CHECK_EQ(history.sessions[0].loads,
           (std::vector<PriorMark>{PriorMark{ExerciseId{"back-squat"}, 100.0, 5, t1},
                                   PriorMark{ExerciseId{"back-squat"}, 95.0, 10, t1}}));
  REQUIRE_EQ(history.recent.size(), static_cast<std::size_t>(1));
  CHECK_EQ(history.recent[0].session, SessionId{"ses_pg000001"});
  CHECK_EQ(history.recent[0].startedAtMs, t1);
  // The warmup is not a set this page prints, for the reason the prefill block excludes it.
  REQUIRE_EQ(history.recent[0].sets.size(), static_cast<std::size_t>(2));
  CHECK_EQ(history.recent[0].sets[0].weightKg, 100.0);
  CHECK_EQ(history.recent[0].sets[1].weightKg, 95.0);
}

// A movement this account's catalog does not hold answers with nothing at all, and the three reads
// behind the first never fire. Another lifter's private movement is that same one fact.
TEST(pg_gym_movement_history_of_a_movement_this_account_cannot_see_is_empty) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgTrainingRepository repo{wm::pgTestPool()};
  repo.insertExercise(wm::UserId{kOther},
                      Exercise{ExerciseId{"ex_pg000002"}, "Theirs", Pattern::squat,
                               Equipment::barbell, 2.5, true});

  CHECK_EQ(repo.movementHistory(wm::UserId{kUser}, ExerciseId{"ex_pg000002"}).exercise,
           std::optional<Exercise>());
  CHECK_EQ(repo.movementHistory(wm::UserId{kUser}, ExerciseId{"no-such"}).exercise,
           std::optional<Exercise>());
  // A movement in the catalog nobody has lifted is the OTHER answer: present, with nothing in it.
  const MovementHistory never = repo.movementHistory(wm::UserId{kUser}, ExerciseId{"back-squat"});
  REQUIRE(never.exercise.has_value());
  CHECK_EQ(never.routines, 0);
  CHECK(never.sessions.empty());
  CHECK(never.recent.empty());
}
