#include "products/gym/adapters/postgres/PgTrainingRepository.h"

// The in-memory twin is included for its three EXPORT renderings alone: the fake states what
// `to_char(… AT TIME ZONE 'UTC')` and a `::text` cast off a fixed-scale numeric produce, and the
// export case below asserts both against each other so neither can drift on its own.
#include "test/products/gym/Fakes.h"
#include "test/PgTestPool.h"
#include "test/testing.h"

#include <pqxx/pqxx>

#include <algorithm>
#include <atomic>
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

// The instant every write that dates something is driven by. It is a value rather than a clock read
// so an assertion can name it.
constexpr std::uint64_t kNow = 1'700'000'000'000ull;

void reset() {
  wm::PgLease c{*wm::pgTestPool()};
  pqxx::work w{*c};
  w.exec("INSERT INTO users (id, email) VALUES ('" + kUser + "', 'gym-pgtest@example.com') "
         "ON CONFLICT (id) DO NOTHING");
  w.exec("INSERT INTO users (id, email) VALUES ('" + kOther + "', 'gym-pgtest-b@example.com') "
         "ON CONFLICT (id) DO NOTHING");
  // FK order, and the routines before the exercises: an entry references a movement, so a custom
  // one cannot be removed while a plan still names it.
  w.exec("DELETE FROM gym_set_revisions WHERE user_id IN ('" + kUser + "', '" + kOther + "')");
  w.exec("DELETE FROM gym_sets WHERE user_id IN ('" + kUser + "', '" + kOther + "')");
  w.exec("DELETE FROM gym_sessions WHERE user_id IN ('" + kUser + "', '" + kOther + "')");
  w.exec("DELETE FROM gym_proposal_changes WHERE user_id IN ('" + kUser + "', '" + kOther + "')");
  w.exec("DELETE FROM gym_proposals WHERE user_id IN ('" + kUser + "', '" + kOther + "')");
  w.exec("DELETE FROM gym_ask_turns WHERE user_id IN ('" + kUser + "', '" + kOther + "')");
  w.exec("DELETE FROM gym_ask_threads WHERE user_id IN ('" + kUser + "', '" + kOther + "')");
  w.exec("DELETE FROM gym_routines WHERE user_id IN ('" + kUser + "', '" + kOther + "')");
  w.exec("DELETE FROM gym_exercise_names WHERE user_id IN ('" + kUser + "', '" + kOther + "')");
  w.exec("DELETE FROM gym_exercise_aliases WHERE user_id IN ('" + kUser + "', '" + kOther + "')");
  w.exec("DELETE FROM gym_exercises WHERE created_by IN ('" + kUser + "', '" + kOther + "')");
  w.exec("DELETE FROM gym_preferences WHERE user_id IN ('" + kUser + "', '" + kOther + "')");
  w.commit();
}

Session sessionAt(const std::string& id, std::uint64_t startedAtMs) {
  return Session{SessionId{id}, wm::UserId{kUser}, startedAtMs};
}

// The instant a create is dated by where a test is not about the ledger, and the create as the
// app's own route makes one: the LIFTER's hand, so the routine's history says `created` and names
// no agent door.
constexpr std::uint64_t kBuiltAtMs = 1'700'000'000'000;

RoutineWriteOutcome inserted(PgTrainingRepository& repo, const Routine& incoming) {
  return repo.insertRoutine(incoming, std::nullopt, kBuiltAtMs);
}

RoutineEntry entryAt(int position, const std::string& exercise, std::optional<int> targetSets = 5,
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

// The picker's meta, against the real DISTINCT ON. It claims to be the read above run over every
// movement at once, so the case asserts the claim rather than trusting it: the row it hands back
// for bench is the LAST set of lastTime's own block, dated by that block's session, and every rule
// the locator keeps is kept here too. A warmup-only movement yields no row, an open session is not
// a last time however heavy it is, and another account's log is not in this answer at all.
TEST(pg_gym_last_sets_is_the_last_row_of_each_movements_last_time_block) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgTrainingRepository repo{wm::pgTestPool()};
  const std::uint64_t t1 = 1'700'000'000'123;

  // An older, HEAVIER bench session, so a row that reported the heaviest set would say 100 here.
  repo.insertSession(sessionAt("ses_pg000001", t1));
  repo.insertSet(benchSet("set_pg000001", 100.0, t1 + 1'000));
  repo.close(SessionId{"ses_pg000001"}, t1 + 2'000);

  repo.insertSession(sessionAt("ses_pg000002", t1 + 10'000));
  repo.insertSet(Set{SetId{"set_pg000002"}, SessionId{"ses_pg000002"}, ExerciseId{"bench-press"}, 0,
                     40.0, 10, SetKind::warmup, std::nullopt, "", t1 + 11'000});
  repo.insertSet(benchSet("set_pg000003", 82.5, t1 + 12'000, "ses_pg000002"));
  repo.insertSet(benchSet("set_pg000004", 80.0, t1 + 13'000, "ses_pg000002"));
  // Squatted only as a ramp-up, which is the same silence as never squatting at all.
  repo.insertSet(squatSet("set_pg000005", "ses_pg000002", 60.0, 5, t1 + 14'000, SetKind::warmup));
  repo.close(SessionId{"ses_pg000002"}, t1 + 15'000);

  // Today, live and far heavier.
  repo.insertSession(sessionAt("ses_pg000003", t1 + 20'000));
  repo.insertSet(benchSet("set_pg000006", 140.0, t1 + 21'000, "ses_pg000003"));

  // And another account's newer, heavier bench.
  repo.insertSession(Session{SessionId{"ses_pg000004"}, wm::UserId{kOther}, t1 + 30'000});
  repo.insertSet(benchSet("set_pg000007", 142.5, t1 + 31'000, "ses_pg000004"));
  repo.close(SessionId{"ses_pg000004"}, t1 + 32'000);

  std::vector<LastSet> ours = repo.lastSets(wm::UserId{kUser});
  std::vector<LastSet> theirs = repo.lastSets(wm::UserId{kOther});

  CHECK_EQ(ours, (std::vector<LastSet>{
                     LastSet{ExerciseId{"bench-press"}, 80.0, 8, t1 + 10'000}}));
  CHECK_EQ(theirs, (std::vector<LastSet>{
                       LastSet{ExerciseId{"bench-press"}, 142.5, 8, t1 + 30'000}}));

  // The claim, stated as an assertion: this IS lastTime's block, projected to its last row.
  LastTimeOutcome block = repo.lastTime(wm::UserId{kUser}, ExerciseId{"bench-press"});
  CHECK_EQ(ours[0].weightKg, block.lastTime->sets.back().weightKg);
  CHECK_EQ(ours[0].reps, block.lastTime->sets.back().reps);
  CHECK_EQ(ours[0].atMs, block.lastTime->session.startedAtMs);
}

// One row per movement, keyed by movement id — the key a picker joins these onto its catalog by, and
// not the order it draws them in. A lifter with two movements gets two rows and neither is the
// other's; a lifter with none gets nothing, which is every catalog row reading `never logged`.
TEST(pg_gym_last_sets_carries_one_row_per_movement_ordered_by_id) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgTrainingRepository repo{wm::pgTestPool()};
  const std::uint64_t t1 = 1'700'000'000'123;

  CHECK(repo.lastSets(wm::UserId{kUser}).empty());

  repo.insertSession(sessionAt("ses_pg000001", t1));
  repo.insertSet(benchSet("set_pg000001", 82.5, t1 + 1'000));
  repo.insertSet(squatSet("set_pg000002", "ses_pg000001", 120.0, 5, t1 + 2'000));
  repo.close(SessionId{"ses_pg000001"}, t1 + 3'000);

  // A later session squats again, so the two rows are dated by two different workouts.
  repo.insertSession(sessionAt("ses_pg000002", t1 + 10'000));
  repo.insertSet(squatSet("set_pg000003", "ses_pg000002", 125.0, 5, t1 + 11'000));
  repo.close(SessionId{"ses_pg000002"}, t1 + 12'000);

  CHECK_EQ(repo.lastSets(wm::UserId{kUser}),
           (std::vector<LastSet>{LastSet{ExerciseId{"back-squat"}, 125.0, 5, t1 + 10'000},
                                 LastSet{ExerciseId{"bench-press"}, 82.5, 8, t1}}));
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
  inserted(repo, routineAt("rt_pg000001", "Push A", {entryAt(1, "bench-press")}));
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

  RoutineWriteOutcome created = inserted(repo, pushA);
  RoutineWriteOutcome replayed = inserted(repo, 
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

  RoutineWriteOutcome created = inserted(repo, pushA);
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
      routineAt("rt_pg000001", "Push A", {entryAt(1, "bench-press", 5, std::nullopt, 82.5, 180)}),
      kNow);
  CHECK(replaced.error == RoutineWriteError::none);
  CHECK_EQ(replaced.routine->entries[0].targetReps, std::optional<int>());
}

// The OPEN line against the real column, and it is the same move target_reps made: target_sets
// dropped its NOT NULL and its default of 3, so a day copied out of a notebook stores the line with
// no target at all rather than the three sets nobody asked for. The CHECK still holds for every
// line that names one.
TEST(pg_gym_an_open_routine_line_round_trips_as_a_null_target_sets) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgTrainingRepository repo{wm::pgTestPool()};
  const Routine heavy = routineAt(
      "rt_pg000001", "Heavy Thursday",
      {entryAt(1, "bench-press", 5, 5, 82.5, 180),
       entryAt(2, "barbell-row", std::nullopt, std::nullopt, std::nullopt, std::nullopt)});

  RoutineWriteOutcome created = inserted(repo, heavy);
  std::optional<Routine> read = repo.routine(wm::UserId{kUser}, RoutineId{"rt_pg000001"});

  CHECK(created.error == RoutineWriteError::none);
  CHECK_EQ(created.routine, std::optional<Routine>(heavy));
  CHECK_EQ(read, std::optional<Routine>(heavy));
  CHECK_EQ(read->entries[1].targetSets, std::optional<int>());
  {
    wm::PgLease c{*wm::pgTestPool()};
    pqxx::work w{*c};
    // A NULL and not a zero: the column would take a zero and the row would then be asking for
    // nothing, which is a target rather than the absence of one.
    CHECK_EQ(w.exec_params("SELECT count(*)::int AS n FROM gym_routine_entries "
                           "WHERE routine_id = $1 AND target_sets IS NULL",
                           "rt_pg000001")[0]["n"]
                 .as<int>(),
             1);
  }
  // And the session started under it freezes the absence, so the logger asks at the rack.
  repo.insertSession(Session{SessionId{"ses_pg000001"}, wm::UserId{kUser}, kNow, std::nullopt,
                             RoutineId{"rt_pg000001"}, snapshotOf(*read)});
  CHECK_EQ(repo.session(wm::UserId{kUser}, SessionId{"ses_pg000001"})->plan->entries[1].sets,
           std::optional<int>());
}

TEST(pg_gym_a_routine_id_another_account_holds_resolves_to_nothing) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgTrainingRepository repo{wm::pgTestPool()};
  inserted(repo, Routine{RoutineId{"rt_pg000001"}, wm::UserId{kOther}, "Their plan", 0,
                             {entryAt(1, "bench-press")}});

  RoutineWriteOutcome taken = inserted(repo, routineAt("rt_pg000001", "Mine", {entryAt(1, "back-squat")}));
  RoutineWriteOutcome replaced =
      repo.replaceRoutine(routineAt("rt_pg000001", "Mine now", {entryAt(1, "back-squat")}), kNow);

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

  RoutineWriteOutcome refused = inserted(repo, 
      routineAt("rt_pg000001", "Push A",
                {entryAt(1, "bench-press"), entryAt(2, "pg-no-such-movement")}));

  CHECK(refused.error == RoutineWriteError::unknownExercise);
  CHECK_EQ(refused.routine, std::optional<Routine>());
  CHECK_EQ(repo.routine(wm::UserId{kUser}, RoutineId{"rt_pg000001"}), std::optional<Routine>());
  CHECK_EQ(repo.routines(wm::UserId{kUser}), std::vector<Routine>{});
  // The rolled-back transaction was the refused write's alone: the connection is reusable at once.
  RoutineWriteOutcome after = inserted(repo, routineAt("rt_pg000001", "Push A", {entryAt(1, "bench-press")}));
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
  inserted(repo, stored);

  RoutineWriteOutcome created =
      inserted(repo, routineAt("rt_pg000002", "Push B", {entryAt(1, "pg-their-zercher")}));
  RoutineWriteOutcome replaced =
      repo.replaceRoutine(routineAt("rt_pg000001", "Push A2", {entryAt(1, "pg-their-zercher")}),
                          kNow);

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
  inserted(repo, routineAt("rt_pg000001", "Push A",
                               {entryAt(1, "bench-press"), entryAt(2, "back-squat")}));
  // The revision moves on the lifter's own write — the token a proposal is minted against and
  // superseded by (domain/Proposal.h) — so what the store hands back stands one past what was sent.
  const Routine rewritten = routineAt("rt_pg000001", "Push A2",
                                      {entryAt(1, "back-squat", 4, 6, 100.0, 240)});
  const Routine standing = Routine{rewritten.id,      rewritten.user,
                                   rewritten.name,    rewritten.position,
                                   rewritten.entries, rewritten.lastTrainedAtMs,
                                   2};

  RoutineWriteOutcome replaced = repo.replaceRoutine(rewritten, kNow);
  RoutineWriteOutcome missing =
      repo.replaceRoutine(routineAt("rt_pg000009", "Nowhere", {entryAt(1, "bench-press")}), kNow);
  RoutineWriteOutcome refused = repo.replaceRoutine(
      routineAt("rt_pg000001", "Push A3", {entryAt(1, "pg-no-such-movement")}), kNow);

  CHECK(replaced.error == RoutineWriteError::none);
  CHECK_EQ(replaced.routine, std::optional<Routine>(standing));
  CHECK_EQ(repo.routine(wm::UserId{kUser}, RoutineId{"rt_pg000001"}),
           std::optional<Routine>(standing));
  CHECK(missing.error == RoutineWriteError::notFound);
  // A refused replace rolls back whole: the lines it deleted are still there, the name is, and so
  // is the revision — a rolled-back write moves no token.
  CHECK(refused.error == RoutineWriteError::unknownExercise);
  CHECK_EQ(repo.routine(wm::UserId{kUser}, RoutineId{"rt_pg000001"}),
           std::optional<Routine>(standing));
}

TEST(pg_gym_routine_delete_cascades_its_lines_and_leaves_every_session_its_snapshot) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgTrainingRepository repo{wm::pgTestPool()};
  const std::uint64_t t1 = 1'700'000'000'123;
  inserted(repo, routineAt("rt_pg000001", "Push A", {entryAt(1, "bench-press")}));
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
  inserted(repo, routineAt("rt_pg000001", "Push A", {entryAt(1, "bench-press")}));
  inserted(repo, routineAt("rt_pg000002", "Pull A", {entryAt(1, "back-squat")}));
  inserted(repo, routineAt("rt_pg000003", "Legs", {entryAt(1, "back-squat")}));
  repo.insertSession(Session{SessionId{"ses_pg000001"}, wm::UserId{kUser}, t1, std::nullopt,
                             RoutineId{"rt_pg000002"}, PlanSnapshot{"Pull A", {}}});
  repo.close(SessionId{"ses_pg000001"}, t1 + 1'000);
  repo.insertSession(Session{SessionId{"ses_pg000002"}, wm::UserId{kUser}, t1 + 10'000,
                             std::nullopt, RoutineId{"rt_pg000001"}, pushA()});
  repo.close(SessionId{"ses_pg000002"}, t1 + 11'000);
  // Another account training its own routine cannot move this account's order.
  inserted(repo, Routine{RoutineId{"rt_pg000004"}, wm::UserId{kOther}, "Theirs", 0,
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
  inserted(repo, routineAt("rt_pg000001", "Push A", {entryAt(1, "back-squat")}));

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

// ---- fix a set: the SQL half of "the log moves, the routine does not" ------------------------

// The correction, against a real server: the row in gym_sets is rewritten in place and the version
// it replaced lands in gym_set_revisions unmarked. Both halves are asserted off the tables rather
// than off the reply, because the reply cannot show what a second statement did.
TEST(pg_gym_a_correction_rewrites_the_set_in_place_and_keeps_what_it_replaced) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgTrainingRepository repo{wm::pgTestPool()};
  const std::uint64_t t1 = 1'700'000'000'123;
  repo.insertSession(sessionAt("ses_pg000001", t1));
  repo.insertSet(Set{SetId{"set_pg000001"}, SessionId{"ses_pg000001"}, ExerciseId{"bench-press"}, 0,
                     82.5, 8, SetKind::working, 8.5, "felt heavy", t1 + 1'000});

  SetFix fix;
  fix.weightKg = 47.5;
  fix.reps = 4;
  fix.kind = SetKind::drop;
  fix.rpeNamed = true;
  std::optional<Set> stored = repo.setOf(wm::UserId{kUser}, SetId{"set_pg000001"});
  REQUIRE(stored.has_value());
  std::optional<Set> fixed = repo.updateSet(wm::UserId{kUser}, corrected(*stored, fix));

  REQUIRE(fixed.has_value());
  CHECK_EQ(*fixed, Set(SetId{"set_pg000001"}, SessionId{"ses_pg000001"}, ExerciseId{"bench-press"},
                       1, 47.5, 4, SetKind::drop, std::nullopt, "felt heavy", t1 + 1'000));
  CHECK_EQ(repo.setsOf(SessionId{"ses_pg000001"}), std::vector<Set>{*fixed});
  {
    wm::PgLease c{*wm::pgTestPool()};
    pqxx::work w{*c};
    pqxx::result kept = w.exec_params(
        "SELECT set_id, session_id, user_id::text, exercise_id, set_number, weight_kg::float8, "
        "reps, kind, rpe::float8, note, deleted FROM gym_set_revisions WHERE set_id = $1",
        "set_pg000001");
    REQUIRE_EQ(kept.size(), static_cast<std::size_t>(1));
    CHECK_EQ(kept[0][0].as<std::string>(), std::string("set_pg000001"));
    CHECK_EQ(kept[0][1].as<std::string>(), std::string("ses_pg000001"));
    CHECK_EQ(kept[0][2].as<std::string>(), kUser);
    CHECK_EQ(kept[0][3].as<std::string>(), std::string("bench-press"));
    CHECK_EQ(kept[0][4].as<int>(), 1);
    CHECK_EQ(kept[0][5].as<double>(), 82.5);
    CHECK_EQ(kept[0][6].as<int>(), 8);
    CHECK_EQ(kept[0][7].as<std::string>(), std::string("working"));
    CHECK_EQ(kept[0][8].as<double>(), 8.5);
    CHECK_EQ(kept[0][9].as<std::string>(), std::string("felt heavy"));
    CHECK_FALSE(kept[0][10].as<bool>());
  }
}

// The reason the lock is its own statement, driven rather than argued. Six corrections land on one
// set at once; each one keeps whatever stood before it, so the versions kept plus the one still
// standing are EXACTLY the seven values that ever existed — the original and the six. Dropping the
// `FOR UPDATE` statement from `updateSet` fails this case every run (checked, before and after the
// lock moved to the session row): two corrections then copy the same pre-existing row, because a
// data-modifying CTE reads the snapshot its statement began with and that snapshot is taken before
// the lock is granted — so a value a lifter saw on screen leaves the log with nothing keeping it,
// which is the one outcome §2.7 exists to prevent.
TEST(pg_gym_parallel_corrections_of_one_set_keep_every_version_that_ever_stood) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgTrainingRepository repo{wm::pgTestPool()};
  const std::uint64_t t1 = 1'700'000'000'123;
  repo.insertSession(sessionAt("ses_pg000001", t1));
  repo.insertSet(benchSet("set_pg000001", 82.5, t1 + 1'000));

  std::vector<std::thread> corrections;
  for (int n = 0; n < 6; ++n)
    corrections.emplace_back([&repo, n, t1] {
      repo.updateSet(wm::UserId{kUser},
                     Set{SetId{"set_pg000001"}, SessionId{"ses_pg000001"},
                         ExerciseId{"bench-press"}, 1, 100.0 + n, 8, SetKind::working, std::nullopt,
                         "", t1 + 1'000});
    });
  for (std::thread& thread : corrections) thread.join();

  std::vector<double> stood;
  {
    wm::PgLease c{*wm::pgTestPool()};
    pqxx::work w{*c};
    for (const auto& row : w.exec_params(
             "SELECT weight_kg::float8 FROM gym_set_revisions WHERE user_id = $1::uuid", kUser))
      stood.push_back(row[0].as<double>());
    pqxx::result live = w.exec_params(
        "SELECT weight_kg::float8 FROM gym_sets WHERE user_id = $1::uuid", kUser);
    REQUIRE_EQ(live.size(), static_cast<std::size_t>(1));
    stood.push_back(live[0][0].as<double>());
  }
  std::sort(stood.begin(), stood.end());
  CHECK_EQ(stood, (std::vector<double>{82.5, 100.0, 101.0, 102.0, 103.0, 104.0, 105.0}));
}

// The scope, on the statements that carry it: another account's set and this account's set in a
// different workout are both simply not there, and neither leaves a revision behind.
TEST(pg_gym_a_correction_reaches_no_set_outside_the_workout_or_the_account) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgTrainingRepository repo{wm::pgTestPool()};
  const std::uint64_t t1 = 1'700'000'000'123;
  repo.insertSession(sessionAt("ses_pg000001", t1));
  repo.insertSet(benchSet("set_pg000001", 82.5, t1 + 1'000));

  std::optional<Set> stored = repo.setOf(wm::UserId{kUser}, SetId{"set_pg000001"});
  REQUIRE(stored.has_value());
  Set moved = *stored;
  moved.weightKg = 60;

  CHECK_EQ(repo.updateSet(wm::UserId{kOther}, moved), std::optional<Set>());
  Set elsewhere{SetId{"set_pg000001"}, SessionId{"ses_pg000009"}, ExerciseId{"bench-press"}, 1,
                60, 8, SetKind::working, std::nullopt, "", t1 + 1'000};
  CHECK_EQ(repo.updateSet(wm::UserId{kUser}, elsewhere), std::optional<Set>());
  CHECK_EQ(repo.setOf(wm::UserId{kUser}, SetId{"set_pg000001"})->weightKg, 82.5);
  {
    wm::PgLease c{*wm::pgTestPool()};
    pqxx::work w{*c};
    CHECK_EQ(w.exec_params("SELECT 1 FROM gym_set_revisions WHERE user_id = $1::uuid", kUser)
                 .size(),
             static_cast<std::size_t>(0));
  }
}

// The delete moves the row WHOLE and marks it, in one statement, and it is silent whether or not
// anything was there — the retry a lost reply produces keeps no second copy. Numbers are not closed
// up behind it: max+1 keeps minting, so no set ever inherits a number another one wore.
TEST(pg_gym_a_delete_moves_the_row_into_the_revisions_and_never_reuses_its_number) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgTrainingRepository repo{wm::pgTestPool()};
  const std::uint64_t t1 = 1'700'000'000'123;
  repo.insertSession(sessionAt("ses_pg000001", t1));
  repo.insertSet(benchSet("set_pg000001", 80.0, t1 + 1'000));
  repo.insertSet(benchSet("set_pg000002", 82.5, t1 + 2'000));
  repo.insertSet(benchSet("set_pg000003", 85.0, t1 + 3'000));

  repo.deleteSet(wm::UserId{kUser}, SessionId{"ses_pg000001"}, SetId{"set_pg000002"});
  repo.deleteSet(wm::UserId{kUser}, SessionId{"ses_pg000001"}, SetId{"set_pg000002"});
  repo.deleteSet(wm::UserId{kOther}, SessionId{"ses_pg000001"}, SetId{"set_pg000003"});
  SetInsertOutcome next = repo.insertSet(benchSet("set_pg000004", 87.5, t1 + 4'000));

  REQUIRE(next.set.has_value());
  CHECK_EQ(next.set->setNumber, 4);
  std::vector<int> numbers;
  for (const Set& set : repo.setsOf(SessionId{"ses_pg000001"})) numbers.push_back(set.setNumber);
  CHECK_EQ(numbers, (std::vector<int>{1, 3, 4}));
  {
    wm::PgLease c{*wm::pgTestPool()};
    pqxx::work w{*c};
    pqxx::result kept = w.exec_params(
        "SELECT set_id, set_number, weight_kg::float8, deleted FROM gym_set_revisions "
        "WHERE user_id = $1::uuid ORDER BY revision_id",
        kUser);
    REQUIRE_EQ(kept.size(), static_cast<std::size_t>(1));
    CHECK_EQ(kept[0][0].as<std::string>(), std::string("set_pg000002"));
    CHECK_EQ(kept[0][1].as<int>(), 2);
    CHECK_EQ(kept[0][2].as<double>(), 82.5);
    CHECK(kept[0][3].as<bool>());
  }
}

// THE SET A LIFTER DELETED DOES NOT COME BACK, and the append that would bring it is the ordinary
// one: a POST whose 200 was lost stays on the device's queue and is re-sent, or a claim replays the
// device's own log. The primary key cannot answer it — the row is gone from gym_sets, so the id is
// free — which is why the insert asks the revisions instead. `deleted` and not `idTaken`: every
// queue repairs a spent id by minting a fresh one, and that repair is exactly how the deletion would
// undo itself, under a number nobody chose.
TEST(pg_gym_a_deleted_sets_id_is_spent_for_good_and_a_replayed_append_cannot_bring_it_back) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgTrainingRepository repo{wm::pgTestPool()};
  const std::uint64_t t1 = 1'700'000'000'123;
  repo.insertSession(sessionAt("ses_pg000001", t1));
  repo.insertSet(benchSet("set_pg000001", 80.0, t1 + 1'000));
  repo.insertSet(benchSet("set_pg000002", 82.5, t1 + 2'000));
  repo.insertSet(benchSet("set_pg000003", 85.0, t1 + 3'000));
  repo.deleteSet(wm::UserId{kUser}, SessionId{"ses_pg000001"}, SetId{"set_pg000002"});

  // The queue's own bytes, re-sent: same id, same values, same session.
  SetInsertOutcome replayed = repo.insertSet(benchSet("set_pg000002", 82.5, t1 + 2'000));
  CHECK_EQ(replayed.set, std::optional<Set>());
  CHECK(replayed.error == SetInsertError::deleted);
  // And it is refused whatever else the caller changes about the body, because the ID is the fact.
  CHECK(repo.insertSet(benchSet("set_pg000002", 60.0, t1 + 9'000)).error ==
        SetInsertError::deleted);

  std::vector<std::string> live;
  for (const Set& set : repo.setsOf(SessionId{"ses_pg000001"})) live.push_back(set.id.str());
  CHECK_EQ(live, (std::vector<std::string>{"set_pg000001", "set_pg000003"}));
  {
    wm::PgLease c{*wm::pgTestPool()};
    pqxx::work w{*c};
    // One kept row, still the deleted one — a refused append writes nothing anywhere.
    CHECK_EQ(w.exec_params("SELECT 1 FROM gym_set_revisions WHERE user_id = $1::uuid", kUser).size(),
             static_cast<std::size_t>(1));
  }
  // A closed workout does not change the answer, and does not get to answer FIRST: `session-finished`
  // would tell a queue the set never reached the log, and this one reached it and was taken out.
  repo.close(SessionId{"ses_pg000001"}, t1 + 5'000);
  CHECK(repo.insertSet(benchSet("set_pg000002", 82.5, t1 + 2'000)).error == SetInsertError::deleted);
}

// The scope on that refusal, which is the scope every read in this store keeps: another account's
// deleted id is not a fact this caller may learn, and it is not a log a replay here could put a set
// back into. Their own id stays spent whichever workout replays it — a session is not a fresh
// namespace for an id they have already used and removed.
TEST(pg_gym_a_deleted_id_is_spent_for_its_own_account_alone) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgTrainingRepository repo{wm::pgTestPool()};
  const std::uint64_t t1 = 1'700'000'000'123;
  repo.insertSession(sessionAt("ses_pg000001", t1));
  repo.insertSet(benchSet("set_pg000001", 80.0, t1 + 1'000));
  repo.deleteSet(wm::UserId{kUser}, SessionId{"ses_pg000001"}, SetId{"set_pg000001"});
  repo.close(SessionId{"ses_pg000001"}, t1 + 2'000);
  repo.insertSession(sessionAt("ses_pg000002", t1 + 10'000));
  Session theirs{SessionId{"ses_pg000003"}, wm::UserId{kOther}, t1 + 10'000, std::nullopt,
                 std::nullopt, std::nullopt};
  repo.insertSession(theirs);

  // The same account, a different workout: still spent.
  CHECK(repo.insertSet(Set{SetId{"set_pg000001"}, SessionId{"ses_pg000002"},
                           ExerciseId{"bench-press"}, 0, 80.0, 8, SetKind::working, std::nullopt, "",
                           t1 + 11'000})
            .error == SetInsertError::deleted);
  // Another account, the same id: a fact about a log this caller cannot see, so it decides nothing.
  SetInsertOutcome landed =
      repo.insertSet(Set{SetId{"set_pg000001"}, SessionId{"ses_pg000003"},
                         ExerciseId{"bench-press"}, 0, 60.0, 5, SetKind::working, std::nullopt, "",
                         t1 + 11'000});
  REQUIRE(landed.set.has_value());
  CHECK_EQ(landed.set->weightKg, 60.0);
}

// THE RACE, driven rather than argued: a queue re-sending a set's POST while the lifter deletes it
// on another surface. Both orders are legal and both end the same way — the append lands and the
// delete removes it, or the delete commits and the append is refused — because all three writes take
// the SESSION's row first. A delete that took no lock of its own would leave a third outcome
// reachable: the append reads the revisions before the delete commits and inserts after it, and the
// set is back.
TEST(pg_gym_an_append_racing_a_delete_of_the_same_set_always_ends_deleted) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgTrainingRepository repo{wm::pgTestPool()};
  const std::uint64_t t1 = 1'700'000'000'123;
  repo.insertSession(sessionAt("ses_pg000001", t1));

  for (int trial = 0; trial < 12; ++trial) {
    const std::string id = "set_pg0001" + std::string(trial < 10 ? "0" : "") + std::to_string(trial);
    repo.insertSet(benchSet(id, 82.5, t1 + 1'000 + trial));
    std::atomic<int> raised{0};
    std::thread deleting([&repo, &id, &raised] {
      try {
        repo.deleteSet(wm::UserId{kUser}, SessionId{"ses_pg000001"}, SetId{id});
      } catch (const std::exception&) {
        raised += 1;
      }
    });
    std::thread appending([&repo, &id, &raised, t1, trial] {
      try {
        repo.insertSet(benchSet(id, 82.5, t1 + 1'000 + trial));
      } catch (const std::exception&) {
        raised += 1;
      }
    });
    deleting.join();
    appending.join();
    // Not merely a right answer — an answer at all. Taken in the other order these two are a cycle
    // (the append holds the session and wants the set row, the delete holds the set row and wants
    // the session for its copy's foreign key), and Postgres breaks a cycle by aborting one of them.
    CHECK_EQ(raised.load(), 0);
    CHECK_EQ(repo.setOf(wm::UserId{kUser}, SetId{id}), std::optional<Set>());
  }
}

// THE OTHER HALF OF THE ONE LOCK ORDER, and it is the half that would fail LOUDLY rather than
// quietly. `gym_set_revisions` carries a foreign key to `gym_sessions`, so both of these writes ask
// that session row for a KEY SHARE as they take their copy. Let the delete skip the session lock and
// the two run in opposite orders — the correction holds the session and wants the set row, the
// delete holds the set row and wants the session — which is a cycle, and Postgres breaks a cycle by
// aborting one of them: a `deadlock detected` out of a lifter's ordinary tap. Both take the session
// first, so there is no cycle to break.
TEST(pg_gym_a_correction_racing_a_delete_of_the_same_set_never_deadlocks) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgTrainingRepository repo{wm::pgTestPool()};
  const std::uint64_t t1 = 1'700'000'000'123;
  repo.insertSession(sessionAt("ses_pg000001", t1));

  for (int trial = 0; trial < 12; ++trial) {
    const std::string id = "set_pg0002" + std::string(trial < 10 ? "0" : "") + std::to_string(trial);
    repo.insertSet(benchSet(id, 82.5, t1 + 1'000 + trial));
    std::atomic<int> raised{0};
    std::thread correcting([&repo, &id, &raised, t1, trial] {
      try {
        repo.updateSet(wm::UserId{kUser},
                       Set{SetId{id}, SessionId{"ses_pg000001"}, ExerciseId{"bench-press"}, 1, 90.0,
                           8, SetKind::working, std::nullopt, "", t1 + 1'000 + trial});
      } catch (const std::exception&) {
        raised += 1;
      }
    });
    std::thread deleting([&repo, &id, &raised] {
      try {
        repo.deleteSet(wm::UserId{kUser}, SessionId{"ses_pg000001"}, SetId{id});
      } catch (const std::exception&) {
        raised += 1;
      }
    });
    correcting.join();
    deleting.join();
    CHECK_EQ(raised.load(), 0);
    // Whichever went first, the delete is the last word: a correction that ran after it finds no
    // row, and one that ran before it is the version the delete then carried into the revisions.
    CHECK_EQ(repo.setOf(wm::UserId{kUser}, SetId{id}), std::optional<Set>());
  }
}

// A CORRECTION THAT MOVED NOTHING KEPT NOTHING. `{}` is a legal fix and the reply to a lost one is
// the same bytes sent again, so an unconditional copy would grow a version of the row per retry —
// rows kept forever, in a table nothing reads, standing for a change nobody made. The guard is on
// the values, not on the request: a fix that names every field and changes none of them is the same
// no-op, and a fix that moves one field keeps the whole row it replaced.
TEST(pg_gym_a_correction_that_moves_nothing_keeps_no_revision) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgTrainingRepository repo{wm::pgTestPool()};
  const std::uint64_t t1 = 1'700'000'000'123;
  repo.insertSession(sessionAt("ses_pg000001", t1));
  repo.insertSet(Set{SetId{"set_pg000001"}, SessionId{"ses_pg000001"}, ExerciseId{"bench-press"}, 0,
                     82.5, 8, SetKind::working, 8.5, "felt heavy", t1 + 1'000});
  std::optional<Set> stored = repo.setOf(wm::UserId{kUser}, SetId{"set_pg000001"});
  REQUIRE(stored.has_value());

  for (int retry = 0; retry < 5; ++retry) CHECK_EQ(repo.updateSet(wm::UserId{kUser}, *stored), stored);
  SetFix names;
  names.weightKg = 82.5;
  names.reps = 8;
  names.kind = SetKind::working;
  names.rpeNamed = true;
  names.rpe = 8.5;
  names.note = "felt heavy";
  CHECK_EQ(repo.updateSet(wm::UserId{kUser}, corrected(*stored, names)), stored);
  {
    wm::PgLease c{*wm::pgTestPool()};
    pqxx::work w{*c};
    CHECK_EQ(w.exec_params("SELECT 1 FROM gym_set_revisions WHERE user_id = $1::uuid", kUser).size(),
             static_cast<std::size_t>(0));
  }

  SetFix moves;
  moves.reps = 9;
  std::optional<Set> fixed = repo.updateSet(wm::UserId{kUser}, corrected(*stored, moves));
  REQUIRE(fixed.has_value());
  CHECK_EQ(fixed->reps, 9);
  {
    wm::PgLease c{*wm::pgTestPool()};
    pqxx::work w{*c};
    pqxx::result kept = w.exec_params(
        "SELECT reps, weight_kg::float8, rpe::float8, note FROM gym_set_revisions "
        "WHERE user_id = $1::uuid",
        kUser);
    REQUIRE_EQ(kept.size(), static_cast<std::size_t>(1));
    CHECK_EQ(kept[0][0].as<int>(), 8);
    CHECK_EQ(kept[0][1].as<double>(), 82.5);
    CHECK_EQ(kept[0][2].as<double>(), 8.5);
    CHECK_EQ(kept[0][3].as<std::string>(), std::string("felt heavy"));
  }
}

// *Push A keeps its own numbers*, proved where it could actually be broken — against the real SQL,
// on a session started from a routine. Neither write goes near gym_sessions.plan or a routine entry,
// and the reads that stand on the live rows move exactly as far as the correction did.
TEST(pg_gym_fixing_and_deleting_a_set_leave_the_frozen_plan_and_the_routine_untouched) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgTrainingRepository repo{wm::pgTestPool()};
  const std::uint64_t t1 = 1'700'000'000'123;
  inserted(repo, routineAt("rt_pg000001", "Push A", {entryAt(1, "bench-press")}));
  repo.insertSession(Session{SessionId{"ses_pg000001"}, wm::UserId{kUser}, t1, std::nullopt,
                             RoutineId{"rt_pg000001"}, pushA()});
  repo.insertSet(benchSet("set_pg000001", 82.5, t1 + 1'000));
  repo.insertSet(benchSet("set_pg000002", 82.5, t1 + 2'000));

  std::optional<Set> stored = repo.setOf(wm::UserId{kUser}, SetId{"set_pg000001"});
  REQUIRE(stored.has_value());
  SetFix fix;
  fix.weightKg = 60;
  fix.reps = 3;
  repo.updateSet(wm::UserId{kUser}, corrected(*stored, fix));
  repo.deleteSet(wm::UserId{kUser}, SessionId{"ses_pg000001"}, SetId{"set_pg000002"});

  std::optional<Session> after = repo.session(wm::UserId{kUser}, SessionId{"ses_pg000001"});
  REQUIRE(after.has_value());
  CHECK_EQ(after->plan, std::optional<PlanSnapshot>(pushA()));
  CHECK_EQ(after->routine, std::optional<RoutineId>(RoutineId{"rt_pg000001"}));
  std::optional<Routine> plan = repo.routine(wm::UserId{kUser}, RoutineId{"rt_pg000001"});
  REQUIRE(plan.has_value());
  CHECK_EQ(plan->entries, std::vector<RoutineEntry>{entryAt(1, "bench-press")});
  CHECK_EQ(plan->name, std::string("Push A"));
  // and the live rows are what every read is computed from, so the log row moved with the fix
  std::vector<SessionSummary> rows = pageOf(repo, wm::UserId{kUser}, page(t1 + 10'000, 10));
  REQUIRE_EQ(rows.size(), static_cast<std::size_t>(1));
  CHECK_EQ(rows[0].setCount, 1);
  CHECK_EQ(rows[0].tonnageKg, 180.0);
  CHECK_EQ(rows[0].topSet, std::optional<TopWorkingSet>(TopWorkingSet{60, 3}));
}

// The discard's own promise — "permanent, and nothing keeps a copy" — reaches the revisions too,
// which is the whole reason session_id carries a cascading foreign key and set_id carries none.
TEST(pg_gym_discarding_a_session_takes_its_revisions_with_it) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgTrainingRepository repo{wm::pgTestPool()};
  const std::uint64_t t1 = 1'700'000'000'123;
  repo.insertSession(sessionAt("ses_pg000001", t1));
  repo.insertSet(benchSet("set_pg000001", 82.5, t1 + 1'000));
  repo.insertSet(benchSet("set_pg000002", 85.0, t1 + 2'000));
  std::optional<Set> stored = repo.setOf(wm::UserId{kUser}, SetId{"set_pg000001"});
  REQUIRE(stored.has_value());
  SetFix fix;
  fix.weightKg = 60;
  repo.updateSet(wm::UserId{kUser}, corrected(*stored, fix));
  repo.deleteSet(wm::UserId{kUser}, SessionId{"ses_pg000001"}, SetId{"set_pg000002"});
  repo.close(SessionId{"ses_pg000001"}, t1 + 3'000);
  {
    wm::PgLease c{*wm::pgTestPool()};
    pqxx::work w{*c};
    CHECK_EQ(w.exec_params("SELECT 1 FROM gym_set_revisions WHERE user_id = $1::uuid", kUser)
                 .size(),
             static_cast<std::size_t>(2));
  }

  CHECK(repo.deleteSession(wm::UserId{kUser}, SessionId{"ses_pg000001"}));

  wm::PgLease c{*wm::pgTestPool()};
  pqxx::work w{*c};
  CHECK_EQ(w.exec_params("SELECT 1 FROM gym_set_revisions WHERE user_id = $1::uuid", kUser).size(),
           static_cast<std::size_t>(0));
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
  CHECK(inserted(repo, routineAt("rt_pg000001", "Push A", {entryAt(1, "pg-zercher-squat")}))
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

// §N32's *old name searchable as an alias*, against the real table — seeds and a lifter's own
// movements alike, which is the whole reason it is a row and not a column beside the display name
// (a created movement has no line there to hang one off). Three rules in one write: the old name is
// kept, renaming BACK takes the name back off the list rather than leaving it to shadow the truth
// in the picker, and the list is capped so the catalog read stays the size it was.
TEST(pg_gym_a_rename_keeps_the_old_name_as_an_alias_and_renaming_back_takes_it_off) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgTrainingRepository repo{wm::pgTestPool()};
  repo.insertExercise(wm::UserId{kUser},
                      Exercise{ExerciseId{"ex_pg000001"}, "Hammer row", Pattern::pull,
                               Equipment::machine, 2.5, true});

  const std::optional<Exercise> renamed =
      repo.renameExercise(wm::UserId{kUser}, ExerciseId{"back-squat"}, "Low-bar Squat");
  const std::optional<Exercise> own =
      repo.renameExercise(wm::UserId{kUser}, ExerciseId{"ex_pg000001"}, "The slanty one");

  REQUIRE(renamed.has_value());
  CHECK_EQ(renamed->aliases, std::vector<std::string>{"Back Squat"});
  REQUIRE(own.has_value());
  CHECK_EQ(own->aliases, std::vector<std::string>{"Hammer row"});
  // It is the PICKER's read that has to carry it, because that is where the searching happens.
  for (const Exercise& row : repo.catalog(wm::UserId{kUser})) {
    if (row.id == ExerciseId{"back-squat"})
      CHECK_EQ(row.aliases, std::vector<std::string>{"Back Squat"});
    if (row.id == ExerciseId{"ex_pg000001"})
      CHECK_EQ(row.aliases, std::vector<std::string>{"Hammer row"});
  }
  // Per account, like the display name it remembers: another lifter's picker never heard of it.
  for (const Exercise& row : repo.catalog(wm::UserId{kOther}))
    if (row.id == ExerciseId{"back-squat"}) CHECK(row.aliases.empty());

  // Renamed BACK: `Back Squat` is what the movement IS again, so it is no longer a memory of one —
  // and the name it wore in between is.
  const std::optional<Exercise> back =
      repo.renameExercise(wm::UserId{kUser}, ExerciseId{"back-squat"}, "Back Squat");
  REQUIRE(back.has_value());
  CHECK_EQ(back->aliases, std::vector<std::string>{"Low-bar Squat"});

  // The cap: a lifter who tries eight names keeps the newest five, oldest dropped first.
  for (const std::string& tried : {"One", "Two", "Three", "Four", "Five", "Six", "Seven"})
    repo.renameExercise(wm::UserId{kUser}, ExerciseId{"back-squat"}, tried);
  const std::optional<Exercise> tried =
      repo.renameExercise(wm::UserId{kUser}, ExerciseId{"back-squat"}, "Eight");
  REQUIRE(tried.has_value());
  CHECK_EQ(tried->aliases,
           (std::vector<std::string>{"Seven", "Six", "Five", "Four", "Three"}));
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
// routines that name the movement NAMED once each, and the last training days with their sets in
// the order they were performed. The open session and another account's are nowhere in it.
TEST(pg_gym_movement_history_is_a_ladder_per_finished_session_the_routines_and_the_recent_days) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgTrainingRepository repo{wm::pgTestPool()};
  const std::uint64_t t1 = 1'700'000'000'000;
  const std::uint64_t day = 86'400'000;
  // The same movement twice in one routine — heavy, then a back-off — is still ONE routine.
  inserted(repo, routineAt("rt_pg000001", "Legs",
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
  // The NAMES the sheet prints, deduplicated: the same movement twice in one day is one day.
  CHECK_EQ(history.routines, std::vector<std::string>{"Legs"});
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
  CHECK(never.routines.empty());
  CHECK(never.sessions.empty());
  CHECK(never.recent.empty());
}

// ---- §I · the settings row, against the real column checks ------------------------------------

// The absence is the fact this store states: a lifter who has never opened the settings screen has
// no row, and the defaults are given a layer up rather than invented here. The upsert is the whole
// write — one row per account, last write wins — and RETURNING is what makes the answer the document
// the store now holds rather than the one the caller sent.
TEST(pg_gym_preferences_are_absent_until_written_then_upsert_in_place) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgTrainingRepository repo{wm::pgTestPool()};

  const std::optional<GymPreferences> before = repo.preferences(wm::UserId{kUser});
  const GymPreferences saved = repo.savePreferences(
      GymPreferences{wm::UserId{kUser}, Unit::lb, 15.0, {25, 20, 2.5}, 90, false, false, true});
  const GymPreferences replaced = repo.savePreferences(
      GymPreferences{wm::UserId{kUser}, Unit::kg, 20.0, {25}, std::nullopt, true, true, false});

  CHECK_EQ(before, std::optional<GymPreferences>());
  CHECK_EQ(saved, GymPreferences(wm::UserId{kUser}, Unit::lb, 15.0, {25, 20, 2.5}, 90, false, false,
                                 true));
  CHECK_EQ(replaced, GymPreferences(wm::UserId{kUser}, Unit::kg, 20.0, {25}, std::nullopt, true,
                                    true, false));
  CHECK_EQ(repo.preferences(wm::UserId{kUser}), std::optional<GymPreferences>(replaced));
  // One row per account and not a row per write: the second document replaced the first.
  wm::PgLease conn{*wm::pgTestPool()};
  pqxx::work txn{*conn};
  CHECK_EQ(txn.exec_params("SELECT count(*)::int FROM gym_preferences WHERE user_id = $1::uuid",
                           kUser)[0][0]
               .as<int>(),
           1);
}

// The plate set survives a numeric(5,2)[] round trip in the order the domain normalized it to, and
// an EMPTY set — a gym with nothing to load onto the bar — is a real stored answer rather than a
// null. Both are the cases where an array column could quietly disagree with the entity.
TEST(pg_gym_preferences_round_trip_the_plate_set_including_an_empty_one) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgTrainingRepository repo{wm::pgTestPool()};

  const GymPreferences full = repo.savePreferences(GymPreferences{
      wm::UserId{kUser}, Unit::kg, 20.0, {1.25, 25, 2.5, 20, 15, 10, 5}, 120, true, true, false});
  const GymPreferences bare = repo.savePreferences(
      GymPreferences{wm::UserId{kUser}, Unit::kg, 20.0, {}, 120, true, true, false});

  CHECK_EQ(full.platesKg, (std::vector<double>{25, 20, 15, 10, 5, 2.5, 1.25}));
  CHECK_EQ(bare.platesKg, std::vector<double>{});
  CHECK_EQ(repo.preferences(wm::UserId{kUser})->platesKg, std::vector<double>{});
}

// One lifter's settings and no other's, the scope every row in this store keeps — and the cascade
// that takes the row with the account.
TEST(pg_gym_preferences_are_owner_scoped_and_cascade_with_the_account) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgTrainingRepository repo{wm::pgTestPool()};
  repo.savePreferences(
      GymPreferences{wm::UserId{kUser}, Unit::lb, 15.0, {25}, 90, false, false, true});

  CHECK_EQ(repo.preferences(wm::UserId{kOther}), std::optional<GymPreferences>());
  CHECK_EQ(repo.preferences(wm::UserId{kUser})->units, Unit::lb);

  {
    wm::PgLease conn{*wm::pgTestPool()};
    pqxx::work txn{*conn};
    txn.exec_params("DELETE FROM users WHERE id = $1::uuid", kUser);
    txn.commit();
  }
  CHECK_EQ(repo.preferences(wm::UserId{kUser}), std::optional<GymPreferences>());
  reset();
}

// The columns carry the same bounds the entity does, so a row the domain would refuse is a row this
// database will not hold either — which is what makes the read's construction safe. Written against
// raw SQL on purpose: the entity can never send these, and the check is the only thing standing
// between a hand-edited row and a read that throws for every later request on that account.
TEST(pg_gym_preferences_columns_refuse_what_the_domain_refuses) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();

  const std::vector<std::string> refused{
      "INSERT INTO gym_preferences (user_id, units) VALUES ('" + kUser + "', 'st')",
      "INSERT INTO gym_preferences (user_id, bar_weight_kg) VALUES ('" + kUser + "', 101)",
      "INSERT INTO gym_preferences (user_id, plates_kg) VALUES ('" + kUser + "', '{0}')",
      "INSERT INTO gym_preferences (user_id, plates_kg) VALUES ('" + kUser + "', '{101}')",
      "INSERT INTO gym_preferences (user_id, plates_kg) VALUES ('" + kUser +
          "', '{1,2,3,4,5,6,7,8,9,10,11,12,13}')",
      // The two the read FLATTENS rather than refuses, and so the two a value bound cannot catch: a
      // null element vanishes through array_to_string (and `<= all` answers null, which a check
      // passes), and a second dimension slips a cap that counts rows. Either one reads back as a
      // document the lifter never wrote — a quietly missing plate, or fourteen of them.
      "INSERT INTO gym_preferences (user_id, plates_kg) VALUES ('" + kUser + "', '{25,NULL,20}')",
      "INSERT INTO gym_preferences (user_id, plates_kg) VALUES ('" + kUser + "', '{NULL}')",
      "INSERT INTO gym_preferences (user_id, plates_kg) VALUES ('" + kUser +
          "', '{{1,2,3,4,5,6,7},{8,9,10,11,12,13,14}}')",
      "INSERT INTO gym_preferences (user_id, rest_seconds) VALUES ('" + kUser + "', 14)",
      "INSERT INTO gym_preferences (user_id, rest_seconds) VALUES ('" + kUser + "', 901)"};

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
  // And the defaults on the columns are the defaults in the domain, so a row written by hand with
  // nothing but an owner reads back as the document a fresh lifter is served.
  {
    wm::PgLease conn{*wm::pgTestPool()};
    pqxx::work txn{*conn};
    txn.exec_params("INSERT INTO gym_preferences (user_id) VALUES ($1::uuid)", kUser);
    txn.commit();
  }
  PgTrainingRepository repo{wm::pgTestPool()};
  CHECK_EQ(repo.preferences(wm::UserId{kUser}),
           std::optional<GymPreferences>(GymPreferences{wm::UserId{kUser}}));
  reset();
}

// ---- the proposal ledger, against the real store ----------------------------------------------

namespace {
RoutineProposal proposalAt(const std::string& id, const std::string& routine, int baseRevision,
                           std::vector<RoutineEntry> becomes, ProposalDoor door = ProposalDoor::mcp,
                           const std::string& owner = kUser,
                           std::optional<ThreadId> thread = std::nullopt) {
  const std::vector<RoutineEntry> base{entryAt(1, "bench-press")};
  std::vector<RoutineChange> changes = changesBetween(base, becomes);
  const int counted = becomes.empty() ? static_cast<int>(changes.size())
                                      : countedChanges(base, changes, "Push A", "Push A");
  return RoutineProposal{ProposalHead{ProposalId{id}, RoutineId{routine}, wm::UserId{owner},
                                      becomes.empty() ? ProposalIntent::remove
                                                      : ProposalIntent::revise,
                                      ProposalState::pending,
                                      ProposalSource{door, "", "", thread},
                                      "Heavier triples.", counted, kNow, std::nullopt},
                         baseRevision, "Push A", "Push A", std::move(changes)};
}

RoutineEntry benchAt(double weightKg, int reps) {
  return RoutineEntry{1, ExerciseId{"bench-press"}, 5, reps, weightKg, 180};
}
}

// The day's own history, over the two tables it lives in: the proposals newest first and the
// creation row under them, with the count the day was BUILT with and the door it came through.
TEST(pg_gym_a_routines_history_is_its_proposals_and_its_creation_in_one_read) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgTrainingRepository repo{wm::pgTestPool()};
  inserted(repo, routineAt("rt_pg000001", "Push A",
                           {entryAt(1, "bench-press"), entryAt(2, "back-squat")}));
  repo.insertProposal(proposalAt("prop_pg000001", "rt_pg000001", 1, {benchAt(87.5, 3)}));
  // A second day, made by an AGENT: the door rides onto its creation row, so nothing on screen can
  // say `created by you` about a program somebody's Claude typed.
  repo.insertRoutine(routineAt("rt_pg000002", "Typed for me", {entryAt(1, "bench-press")}),
                     ProposalDoor::mcp, kNow + 1'000);

  const std::vector<RoutineEvent> history =
      repo.routineHistory(wm::UserId{kUser}, RoutineId{"rt_pg000001"});
  const std::vector<RoutineEvent> typed =
      repo.routineHistory(wm::UserId{kUser}, RoutineId{"rt_pg000002"});

  REQUIRE_EQ(history.size(), static_cast<std::size_t>(2));
  CHECK(history[0].kind == RoutineEventKind::proposal);
  CHECK_EQ(history[0].proposal->id, ProposalId{"prop_pg000001"});
  CHECK(history[1].kind == RoutineEventKind::created);
  CHECK_EQ(history[1].atMs, kBuiltAtMs);
  CHECK_EQ(history[1].movements, std::optional<int>(2));
  CHECK_EQ(history[1].door, std::optional<ProposalDoor>());   // the lifter's own hand
  REQUIRE_EQ(typed.size(), static_cast<std::size_t>(1));
  CHECK_EQ(typed[0].door, std::optional<ProposalDoor>(ProposalDoor::mcp));
  CHECK_EQ(typed[0].atMs, kNow + 1'000);
  // Another account's routine has no history at all, which is the one fact every read here gives.
  CHECK(repo.routineHistory(wm::UserId{kOther}, RoutineId{"rt_pg000001"}).empty());
}

// The whole round trip through real columns: the typed diff goes down and comes back byte for byte,
// absences included — a null rest, a null rep target, and the whole `before` side missing on a line
// the proposal adds.
TEST(pg_gym_a_proposal_round_trips_its_typed_diff_with_every_absence_intact) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgTrainingRepository repo{wm::pgTestPool()};
  inserted(repo, routineAt("rt_pg000001", "Push A", {entryAt(1, "bench-press")}));
  const RoutineProposal minted = proposalAt(
      "prop_pg00001", "rt_pg000001", 1,
      {benchAt(87.5, 3),
       RoutineEntry{2, ExerciseId{"back-squat"}, 3, std::nullopt, std::nullopt, std::nullopt}});

  ProposalMintOutcome stored = repo.insertProposal(minted);

  CHECK(stored.error == ProposalMintError::none);
  REQUIRE(stored.proposal.has_value());
  CHECK_EQ(*stored.proposal, minted);
  CHECK_EQ(repo.proposal(wm::UserId{kUser}, ProposalId{"prop_pg00001"}),
           std::optional<RoutineProposal>(minted));
  // The added line carries no `before` at all, and its three absences are absences.
  CHECK_EQ(stored.proposal->changes[1].kind, ChangeKind::added);
  CHECK_EQ(stored.proposal->changes[1].before, std::optional<EntryTargets>());
  CHECK_EQ(stored.proposal->changes[1].after,
           std::optional<EntryTargets>(EntryTargets{3, std::nullopt, std::nullopt, std::nullopt}));
}

// The partial unique index is the arbiter, not an application check: a second proposal from the
// same door settles the first as superseded and lands beside it in the history.
TEST(pg_gym_one_pending_proposal_per_routine_and_door_and_the_old_one_drops_into_history) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgTrainingRepository repo{wm::pgTestPool()};
  inserted(repo, routineAt("rt_pg000001", "Push A", {entryAt(1, "bench-press")}));
  repo.insertProposal(proposalAt("prop_pg00001", "rt_pg000001", 1, {benchAt(87.5, 3)}));

  ProposalMintOutcome second =
      repo.insertProposal(proposalAt("prop_pg00002", "rt_pg000001", 1, {benchAt(90.0, 3)}));
  // A different DOOR is a different pending slot — W7's Ask mints through this same object.
  ProposalMintOutcome ask = repo.insertProposal(
      proposalAt("prop_pg00003", "rt_pg000001", 1, {benchAt(92.5, 3)}, ProposalDoor::ask));

  CHECK(second.error == ProposalMintError::none);
  CHECK(ask.error == ProposalMintError::none);
  const std::vector<ProposalHead> all =
      repo.proposalHeads(wm::UserId{kUser}, ProposalQuery{RoutineId{"rt_pg000001"}, false});
  REQUIRE_EQ(all.size(), static_cast<std::size_t>(3));
  CHECK_EQ(repo.proposalHeads(wm::UserId{kUser}, ProposalQuery{std::nullopt, true}).size(),
           static_cast<std::size_t>(2));
  for (const ProposalHead& head : all)
    if (head.id == ProposalId{"prop_pg00001"}) {
      CHECK_EQ(head.state, ProposalState::superseded);
      CHECK_EQ(head.settledAtMs, std::optional<std::uint64_t>(kNow));
    }
}

// A replay reads back the proposal already waiting rather than superseding it with itself.
TEST(pg_gym_a_replayed_mint_reads_back_the_stored_proposal) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgTrainingRepository repo{wm::pgTestPool()};
  inserted(repo, routineAt("rt_pg000001", "Push A", {entryAt(1, "bench-press")}));
  const RoutineProposal minted = proposalAt("prop_pg00001", "rt_pg000001", 1, {benchAt(87.5, 3)});
  repo.insertProposal(minted);

  ProposalMintOutcome replayed = repo.insertProposal(minted);

  CHECK(replayed.error == ProposalMintError::none);
  CHECK_EQ(replayed.proposal, std::optional<RoutineProposal>(minted));
  CHECK_EQ(repo.proposalHeads(wm::UserId{kUser}, ProposalQuery{std::nullopt, true}).size(),
           static_cast<std::size_t>(1));
}

// Every refusal the store alone can know, and each as a VALUE: an id spent by an account this
// caller cannot see, a routine it cannot read, and a line naming a movement it may not name — the
// last refused at the MINT so a proposal a lifter cannot apply never reaches their screen.
TEST(pg_gym_a_proposal_is_refused_for_a_spent_id_an_unknown_routine_and_an_unseen_movement) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgTrainingRepository repo{wm::pgTestPool()};
  inserted(repo, routineAt("rt_pg000001", "Push A", {entryAt(1, "bench-press")}));
  inserted(repo, Routine{RoutineId{"rt_pg000009"}, wm::UserId{kOther}, "Their plan", 0,
                             {entryAt(1, "bench-press")}});
  repo.insertExercise(wm::UserId{kOther},
                      Exercise{ExerciseId{"pg-their-zercher"}, "Their Zercher Squat",
                               Pattern::squat, Equipment::barbell, 2.5, true});
  repo.insertProposal(proposalAt("prop_pg00009", "rt_pg000009", 1, {benchAt(87.5, 3)},
                                 ProposalDoor::mcp, kOther));

  ProposalMintOutcome spent =
      repo.insertProposal(proposalAt("prop_pg00009", "rt_pg000001", 1, {benchAt(87.5, 3)}));
  ProposalMintOutcome theirs =
      repo.insertProposal(proposalAt("prop_pg00002", "rt_pg000009", 1, {benchAt(87.5, 3)}));
  ProposalMintOutcome unseen = repo.insertProposal(proposalAt(
      "prop_pg00003", "rt_pg000001", 1,
      {RoutineEntry{1, ExerciseId{"pg-their-zercher"}, 3, 8, 100.0, 180}}));

  CHECK(spent.error == ProposalMintError::idTaken);
  CHECK(theirs.error == ProposalMintError::unknownRoutine);
  CHECK(unseen.error == ProposalMintError::unknownExercise);
  // The refused mint rolled back whole: no header, no lines, and the connection is reusable at once.
  CHECK_EQ(repo.proposal(wm::UserId{kUser}, ProposalId{"prop_pg00003"}),
           std::optional<RoutineProposal>());
  CHECK(repo.insertProposal(proposalAt("prop_pg00004", "rt_pg000001", 1, {benchAt(87.5, 3)}))
            .error == ProposalMintError::none);
}

// A REFUSED MINT SPENDS NOTHING OF THE LIFTER'S, and it takes real SQL to prove it: the supersede
// that clears the pending slot runs INSIDE the mint's transaction, so a refusal reached after it
// would commit the settle and roll back nothing — the card would be gone off Today with nothing
// replacing it, behind a message reading "mint a different one and send it again". Proposal ids are
// client-minted and the key is global across accounts, so a deterministic minting scheme is all it
// takes to collide with a stranger.
TEST(pg_gym_a_refused_mint_leaves_the_pending_card_it_could_not_replace) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgTrainingRepository repo{wm::pgTestPool()};
  inserted(repo, routineAt("rt_pg000001", "Push A", {entryAt(1, "bench-press")}));
  inserted(repo, Routine{RoutineId{"rt_pg000009"}, wm::UserId{kOther}, "Their plan", 0,
                             {entryAt(1, "bench-press")}});
  repo.insertProposal(proposalAt("prop_pg00009", "rt_pg000009", 1, {benchAt(87.5, 3)},
                                 ProposalDoor::mcp, kOther));
  repo.insertProposal(proposalAt("prop_pg00001", "rt_pg000001", 1, {benchAt(87.5, 3)}));

  ProposalMintOutcome stranger =
      repo.insertProposal(proposalAt("prop_pg00009", "rt_pg000001", 1, {benchAt(90.0, 3)}));
  ProposalMintOutcome reused =
      repo.insertProposal(proposalAt("prop_pg00001", "rt_pg000001", 1, {benchAt(95.0, 3)}));

  CHECK(stranger.error == ProposalMintError::idTaken);
  CHECK(reused.error == ProposalMintError::idReused);
  // Neither refusal moved anything: the card the lifter can see is still waiting, and it is still
  // the diff that was minted for it.
  const std::vector<ProposalHead> waiting =
      repo.proposalHeads(wm::UserId{kUser}, ProposalQuery{std::nullopt, true});
  REQUIRE_EQ(waiting.size(), static_cast<std::size_t>(1));
  CHECK_EQ(waiting[0].id, ProposalId{"prop_pg00001"});
  CHECK_EQ(waiting[0].state, ProposalState::pending);
  CHECK_EQ(repo.proposal(wm::UserId{kUser}, ProposalId{"prop_pg00001"})->changes[0].after,
           std::optional<EntryTargets>(EntryTargets{5, 3, 87.5, 180}));
  // And the stranger's own proposal is untouched by a refusal that named their id.
  CHECK_EQ(repo.proposalHeads(wm::UserId{kOther}, ProposalQuery{std::nullopt, true}).size(),
           static_cast<std::size_t>(1));
}

// The lifter's own hand, asked the one question that decides whether a card dies: did the document
// or the name actually move? A routine editor saving on close and a logger writing the whole
// document back to change one weight both land the bytes that already stand, and a drag up the
// routines screen moves only where the day sits — which no proposal is minted against, because an
// apply keeps the base's own position. None of the three destroyed a base, so none of them settles
// a proposal or moves the revision. A real edit still does both.
TEST(pg_gym_a_put_that_lands_the_same_document_moves_no_revision_and_settles_no_proposal) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgTrainingRepository repo{wm::pgTestPool()};
  inserted(repo, routineAt("rt_pg000001", "Push A", {entryAt(1, "bench-press")}));
  repo.insertProposal(proposalAt("prop_pg00001", "rt_pg000001", 1, {benchAt(87.5, 3)}));

  RoutineWriteOutcome identical =
      repo.replaceRoutine(routineAt("rt_pg000001", "Push A", {entryAt(1, "bench-press")}),
                          kNow + 60'000);
  RoutineWriteOutcome dragged =
      repo.replaceRoutine(Routine{RoutineId{"rt_pg000001"}, wm::UserId{kUser}, "Push A", 3,
                                  {entryAt(1, "bench-press")}},
                          kNow + 60'000);

  REQUIRE(identical.routine.has_value());
  REQUIRE(dragged.routine.has_value());
  CHECK_EQ(identical.routine->revision, 1);
  CHECK_EQ(dragged.routine->revision, 1);
  CHECK_EQ(dragged.routine->position, 3);
  CHECK_EQ(repo.proposalHeads(wm::UserId{kUser}, ProposalQuery{std::nullopt, true}).size(),
           static_cast<std::size_t>(1));

  RoutineWriteOutcome edited =
      repo.replaceRoutine(Routine{RoutineId{"rt_pg000001"}, wm::UserId{kUser}, "Push A", 3,
                                  {entryAt(1, "bench-press", 5, 5, 85.0)}},
                          kNow + 120'000);

  REQUIRE(edited.routine.has_value());
  CHECK_EQ(edited.routine->revision, 2);
  CHECK_EQ(edited.routine->entries[0].targetWeightKg, std::optional<double>(85.0));
  CHECK(repo.proposalHeads(wm::UserId{kUser}, ProposalQuery{std::nullopt, true}).empty());
  CHECK_EQ(repo.proposal(wm::UserId{kUser}, ProposalId{"prop_pg00001"})->head.state,
           ProposalState::superseded);
}

// THE TAP against real rows: one transaction, the whole document, the revision moved and the row
// dated. And the tap replayed reads back what it did rather than applying twice.
TEST(pg_gym_applying_a_proposal_writes_the_document_moves_the_revision_and_dates_the_record) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgTrainingRepository repo{wm::pgTestPool()};
  inserted(repo, routineAt("rt_pg000001", "Push A", {entryAt(1, "bench-press")}));
  repo.insertProposal(proposalAt("prop_pg00001", "rt_pg000001", 1,
                                 {benchAt(87.5, 3), entryAt(2, "back-squat", 3, 8, 100.0, 240)}));
  const Routine becomes =
      appliedTo(*repo.routine(wm::UserId{kUser}, RoutineId{"rt_pg000001"}),
                *repo.proposal(wm::UserId{kUser}, ProposalId{"prop_pg00001"}));

  ProposalSettleOutcome tapped =
      repo.applyRevision(wm::UserId{kUser}, ProposalId{"prop_pg00001"}, becomes, kNow + 60'000);
  ProposalSettleOutcome again =
      repo.applyRevision(wm::UserId{kUser}, ProposalId{"prop_pg00001"}, becomes, kNow + 120'000);

  CHECK(tapped.error == ProposalSettleError::none);
  REQUIRE(tapped.routine.has_value());
  CHECK_EQ(tapped.routine->revision, 2);
  REQUIRE_EQ(tapped.routine->entries.size(), static_cast<std::size_t>(2));
  CHECK_EQ(tapped.routine->entries[0].targetWeightKg, std::optional<double>(87.5));
  CHECK_EQ(tapped.routine->entries[1].exercise, ExerciseId{"back-squat"});
  CHECK_EQ(tapped.proposal->head.state, ProposalState::applied);
  CHECK_EQ(tapped.proposal->head.settledAtMs, std::optional<std::uint64_t>(kNow + 60'000));
  // The replayed tap is not a second write: the revision did not move again.
  CHECK(again.error == ProposalSettleError::none);
  CHECK_EQ(again.routine->revision, 2);
}

// The lifter's own PUT moves the revision and supersedes what was pending, in the SAME transaction —
// and the store refuses the apply under its own lock even when it is asked anyway.
TEST(pg_gym_the_lifters_own_write_supersedes_a_pending_proposal_and_the_tap_refuses) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgTrainingRepository repo{wm::pgTestPool()};
  inserted(repo, routineAt("rt_pg000001", "Push A", {entryAt(1, "bench-press")}));
  repo.insertProposal(proposalAt("prop_pg00001", "rt_pg000001", 1, {benchAt(87.5, 3)}));
  const Routine stale = appliedTo(*repo.routine(wm::UserId{kUser}, RoutineId{"rt_pg000001"}),
                                  *repo.proposal(wm::UserId{kUser}, ProposalId{"prop_pg00001"}));

  RoutineWriteOutcome rewritten = repo.replaceRoutine(
      routineAt("rt_pg000001", "Push A", {entryAt(1, "bench-press", 5, 5, 85.0, 180)}),
      kNow + 60'000);
  ProposalSettleOutcome refused =
      repo.applyRevision(wm::UserId{kUser}, ProposalId{"prop_pg00001"}, stale, kNow + 120'000);

  CHECK(rewritten.error == RoutineWriteError::none);
  CHECK_EQ(rewritten.routine->revision, 2);
  CHECK(refused.error == ProposalSettleError::superseded);
  CHECK_EQ(refused.routine, std::optional<Routine>());
  // The lifter's own numbers stand, and the proposal is a dated record rather than a row that went.
  CHECK_EQ(repo.routine(wm::UserId{kUser}, RoutineId{"rt_pg000001"})->entries[0].targetWeightKg,
           std::optional<double>(85.0));
  const std::vector<ProposalHead> history =
      repo.proposalHeads(wm::UserId{kUser}, ProposalQuery{RoutineId{"rt_pg000001"}, false});
  REQUIRE_EQ(history.size(), static_cast<std::size_t>(1));
  CHECK_EQ(history[0].state, ProposalState::superseded);
  CHECK_EQ(history[0].settledAtMs, std::optional<std::uint64_t>(kNow + 60'000));
}

// Dismissing changes nothing about the program and keeps the card; asking for the other decision is
// refused, and asking again for the same one replays.
TEST(pg_gym_dismissing_keeps_the_card_and_refuses_the_other_decision) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgTrainingRepository repo{wm::pgTestPool()};
  inserted(repo, routineAt("rt_pg000001", "Push A", {entryAt(1, "bench-press")}));
  repo.insertProposal(proposalAt("prop_pg00001", "rt_pg000001", 1, {benchAt(87.5, 3)}));
  const Routine becomes = appliedTo(*repo.routine(wm::UserId{kUser}, RoutineId{"rt_pg000001"}),
                                    *repo.proposal(wm::UserId{kUser}, ProposalId{"prop_pg00001"}));

  ProposalSettleOutcome dismissed =
      repo.dismissProposal(wm::UserId{kUser}, ProposalId{"prop_pg00001"}, kNow + 60'000);
  ProposalSettleOutcome again =
      repo.dismissProposal(wm::UserId{kUser}, ProposalId{"prop_pg00001"}, kNow + 120'000);
  ProposalSettleOutcome tapped =
      repo.applyRevision(wm::UserId{kUser}, ProposalId{"prop_pg00001"}, becomes, kNow + 180'000);

  CHECK(dismissed.error == ProposalSettleError::none);
  CHECK_EQ(dismissed.proposal->head.state, ProposalState::dismissed);
  CHECK_EQ(dismissed.proposal->head.settledAtMs, std::optional<std::uint64_t>(kNow + 60'000));
  CHECK(again.error == ProposalSettleError::none);
  CHECK_EQ(again.proposal->head.settledAtMs, std::optional<std::uint64_t>(kNow + 60'000));
  CHECK(tapped.error == ProposalSettleError::settled);
  CHECK_EQ(repo.routine(wm::UserId{kUser}, RoutineId{"rt_pg000001"})->revision, 1);
}

// §D14's *41 logged sets kept*, counted at READ time against the live log — the sentence that makes
// a removal safe to read has to be true when a lifter reads it.
TEST(pg_gym_a_removed_line_counts_the_sets_it_keeps_at_read_time) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgTrainingRepository repo{wm::pgTestPool()};
  inserted(repo, routineAt("rt_pg000001", "Push A", {entryAt(1, "bench-press")}));
  repo.insertSession(sessionAt("ses_pg000001", 1'700'000'000'000));
  repo.insertSet(benchSet("set_pg000001", 82.5, 1'700'000'060'000));
  repo.insertSet(benchSet("set_pg000002", 82.5, 1'700'000'120'000));
  repo.insertProposal(proposalAt("prop_pg00001", "rt_pg000001", 1, {}));

  std::optional<RoutineProposal> read =
      repo.proposal(wm::UserId{kUser}, ProposalId{"prop_pg00001"});

  REQUIRE(read.has_value());
  CHECK_EQ(read->head.intent, ProposalIntent::remove);
  REQUIRE_EQ(read->changes.size(), static_cast<std::size_t>(1));
  CHECK_EQ(read->changes[0].kind, ChangeKind::removed);
  CHECK_EQ(read->changes[0].loggedSets, 2);
}

// Applying a removal takes the day out of the program, and its proposals go with it — a day that
// has left has no editor to draw a History section in. The log keeps its frozen copy either way.
TEST(pg_gym_applying_a_removal_takes_the_routine_and_its_ledger_with_it) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgTrainingRepository repo{wm::pgTestPool()};
  inserted(repo, routineAt("rt_pg000001", "Push A", {entryAt(1, "bench-press")}));
  repo.insertProposal(proposalAt("prop_pg00001", "rt_pg000001", 1, {}));

  ProposalSettleOutcome tapped =
      repo.applyRemoval(wm::UserId{kUser}, ProposalId{"prop_pg00001"}, kNow + 60'000);

  CHECK(tapped.error == ProposalSettleError::none);
  REQUIRE(tapped.proposal.has_value());
  CHECK_EQ(tapped.proposal->head.state, ProposalState::applied);
  CHECK_EQ(tapped.proposal->head.settledAtMs, std::optional<std::uint64_t>(kNow + 60'000));
  CHECK_EQ(tapped.routine, std::optional<Routine>());
  CHECK_EQ(repo.routine(wm::UserId{kUser}, RoutineId{"rt_pg000001"}), std::optional<Routine>());
  CHECK(repo.proposalHeads(wm::UserId{kUser}, ProposalQuery{std::nullopt, false}).empty());
}

// Absent, another account's and never-existed are ONE answer on every proposal door, so a caller
// can never learn that an id exists by the shape of its refusal.
TEST(pg_gym_a_proposal_another_account_holds_resolves_to_nothing_on_every_door) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgTrainingRepository repo{wm::pgTestPool()};
  inserted(repo, Routine{RoutineId{"rt_pg000009"}, wm::UserId{kOther}, "Their plan", 0,
                             {entryAt(1, "bench-press")}});
  repo.insertProposal(proposalAt("prop_pg00009", "rt_pg000009", 1, {benchAt(87.5, 3)},
                                 ProposalDoor::mcp, kOther));
  const Routine theirs = *repo.routine(wm::UserId{kOther}, RoutineId{"rt_pg000009"});

  CHECK_EQ(repo.proposal(wm::UserId{kUser}, ProposalId{"prop_pg00009"}),
           std::optional<RoutineProposal>());
  CHECK(repo.proposalHeads(wm::UserId{kUser}, ProposalQuery{std::nullopt, false}).empty());
  CHECK(repo.applyRevision(wm::UserId{kUser}, ProposalId{"prop_pg00009"}, theirs, kNow).error ==
        ProposalSettleError::notFound);
  CHECK(repo.dismissProposal(wm::UserId{kUser}, ProposalId{"prop_pg00009"}, kNow).error ==
        ProposalSettleError::notFound);
  CHECK(repo.applyRemoval(wm::UserId{kUser}, ProposalId{"prop_pg00009"}, kNow).error ==
        ProposalSettleError::notFound);
  // Their plan is exactly where it was.
  CHECK_EQ(repo.routine(wm::UserId{kOther}, RoutineId{"rt_pg000009"}),
           std::optional<Routine>(theirs));
}

// Deleting a routine by the lifter's own hand takes its ledger with it, the cascade the schema
// declares — so nothing is left pointing at a day of the program that is gone.
TEST(pg_gym_deleting_a_routine_takes_its_proposals_with_it) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgTrainingRepository repo{wm::pgTestPool()};
  inserted(repo, routineAt("rt_pg000001", "Push A", {entryAt(1, "bench-press")}));
  repo.insertProposal(proposalAt("prop_pg00001", "rt_pg000001", 1, {benchAt(87.5, 3)}));

  CHECK(repo.deleteRoutine(wm::UserId{kUser}, RoutineId{"rt_pg000001"}));

  CHECK(repo.proposalHeads(wm::UserId{kUser}, ProposalQuery{std::nullopt, false}).empty());
  CHECK_EQ(repo.proposal(wm::UserId{kUser}, ProposalId{"prop_pg00001"}),
           std::optional<RoutineProposal>());
}

// ---- Ask's threads (§O), against the real store ------------------------------------------------

namespace {
// The two writes an ask makes, in the order it makes them: the thread lands before the model runs,
// the turns only once an answer has.
AskThread openedAt(PgTrainingRepository& repo, const std::string& id, const std::string& title,
                   std::uint64_t atMs = kNow) {
  const ThreadOpenOutcome opened = repo.openThread(wm::UserId{kUser}, ThreadId{id}, title, atMs);
  return opened.thread.value();
}

void said(PgTrainingRepository& repo, const std::string& id, const std::string& question,
          const std::string& answer, std::uint64_t atMs = kNow) {
  repo.appendTurns(wm::UserId{kUser}, ThreadId{id},
                   {ThreadTurn{true, question, atMs}, ThreadTurn{false, answer, atMs}});
}
}

// The title is the first message VERBATIM, the turns are stored as sent, and a second ask into the
// same conversation does not rename it.
TEST(pg_gym_a_thread_is_titled_by_its_first_message_and_keeps_every_turn_as_sent) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgTrainingRepository repo{wm::pgTestPool()};
  const std::string typed = "Bench \xE2\x80\x9Cstuck\xE2\x80\x9D at 82.5 \xE2\x80\x94 3 weeks, why?";

  openedAt(repo, "thr_pg000001", typed);
  said(repo, "thr_pg000001", typed, "Your top set has not moved.");
  // A second ask into the same conversation: the title is passed and ignored, because a thread is
  // named by how it opened.
  openedAt(repo, "thr_pg000001", "something else entirely", kNow + 1'000);
  said(repo, "thr_pg000001", "and the squat?", "That one is moving.", kNow + 1'000);

  const std::optional<AskThread> held = repo.thread(wm::UserId{kUser}, ThreadId{"thr_pg000001"});
  REQUIRE(held.has_value());
  CHECK_EQ(held->title, typed);
  CHECK_EQ(held->createdAtMs, kNow);
  CHECK_EQ(held->askedAtMs, kNow + 1'000);
  REQUIRE_EQ(held->turns.size(), 4u);
  CHECK_EQ(held->turns[0], (ThreadTurn{true, typed, kNow}));
  CHECK_EQ(held->turns[1], (ThreadTurn{false, "Your top set has not moved.", kNow}));
  CHECK_EQ(held->turns[2], (ThreadTurn{true, "and the squat?", kNow + 1'000}));
  CHECK_EQ(held->turns[3], (ThreadTurn{false, "That one is moving.", kNow + 1'000}));
}

// The id is a primary key across every account: one somebody else holds is refused, never appended
// to — and the refusal is the ONE place the two absences are told apart, because a write cannot
// quietly land in a stranger's conversation.
TEST(pg_gym_a_thread_id_another_account_holds_is_refused_and_their_words_stay_theirs) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgTrainingRepository repo{wm::pgTestPool()};
  openedAt(repo, "thr_pg000001", "mine");
  said(repo, "thr_pg000001", "mine", "answered");

  const ThreadOpenOutcome theirs =
      repo.openThread(wm::UserId{kOther}, ThreadId{"thr_pg000001"}, "yours", kNow);
  CHECK(theirs.error == ThreadOpenError::idTaken);
  CHECK_FALSE(theirs.thread.has_value());
  // …and the read gives them the same nothing an absent id would.
  CHECK_EQ(repo.thread(wm::UserId{kOther}, ThreadId{"thr_pg000001"}), std::optional<AskThread>());
  CHECK(repo.threads(wm::UserId{kOther}).empty());
  CHECK_EQ(repo.thread(wm::UserId{kUser}, ThreadId{"thr_pg000001"})->turns.size(), 2u);
}

// A thread whose run never answered is taken back whole — but only while it holds no turns, so a
// failed follow-up cannot delete a conversation that already happened.
TEST(pg_gym_an_empty_thread_is_discarded_and_one_with_turns_is_not) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgTrainingRepository repo{wm::pgTestPool()};
  openedAt(repo, "thr_pg000001", "never answered");
  openedAt(repo, "thr_pg000002", "answered once");
  said(repo, "thr_pg000002", "answered once", "here you go");

  repo.discardEmptyThread(wm::UserId{kUser}, ThreadId{"thr_pg000001"});
  repo.discardEmptyThread(wm::UserId{kUser}, ThreadId{"thr_pg000002"});

  CHECK_EQ(repo.thread(wm::UserId{kUser}, ThreadId{"thr_pg000001"}), std::optional<AskThread>());
  REQUIRE(repo.thread(wm::UserId{kUser}, ThreadId{"thr_pg000002"}).has_value());
}

// THE LIST: newest asked first, each row carrying the proposals its outcome is derived from — and
// the routine's name AS IT NOW STANDS, because the row points at a day a lifter can open.
TEST(pg_gym_the_thread_list_is_newest_first_and_carries_what_each_one_proposed) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgTrainingRepository repo{wm::pgTestPool()};
  inserted(repo, routineAt("rt_pg000001", "Push A", {entryAt(1, "bench-press")}));
  openedAt(repo, "thr_pg000001", "older");
  said(repo, "thr_pg000001", "older", "answered");
  openedAt(repo, "thr_pg000002", "newer", kNow + 1'000);
  said(repo, "thr_pg000002", "newer", "answered", kNow + 1'000);
  repo.insertProposal(proposalAt("prop_pg00001", "rt_pg000001", 1, {benchAt(87.5, 3)},
                                 ProposalDoor::ask, kUser, ThreadId{"thr_pg000002"}));

  const std::vector<AskThread> listed = repo.threads(wm::UserId{kUser});
  REQUIRE_EQ(listed.size(), 2u);
  CHECK_EQ(listed[0].id, ThreadId{"thr_pg000002"});
  CHECK_EQ(listed[1].id, ThreadId{"thr_pg000001"});
  // The list carries no turns — the titles and the outcomes are what a list prints.
  CHECK(listed[0].turns.empty());
  REQUIRE_EQ(listed[0].minted.size(), 1u);
  CHECK_EQ(listed[0].minted[0].id, ProposalId{"prop_pg00001"});
  CHECK_EQ(listed[0].minted[0].routineName, std::string("Push A"));
  CHECK(outcomeOf(listed[0]).kind == ThreadOutcomeKind::proposed);
  CHECK(listed[1].minted.empty());
  CHECK(outcomeOf(listed[1]).kind == ThreadOutcomeKind::readOnly);
}

// ── DELETE DELETES THE CONVERSATION, NOT THE CONSEQUENCE (§O) ────────────────────────────────
//
// The proof the wave turns on: apply a proposal minted in a conversation, delete the conversation,
// and read the routine's history. The change is still there, still says it came from Ask, and simply
// no longer opens a conversation that exists — because an applied change is a fact about somebody's
// program rather than a message.
TEST(pg_gym_deleting_a_thread_leaves_the_change_it_applied_in_the_routines_history) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgTrainingRepository repo{wm::pgTestPool()};
  inserted(repo, routineAt("rt_pg000001", "Push A", {entryAt(1, "bench-press")}));
  openedAt(repo, "thr_pg000001", "Bench has been stuck at 82.5 for three weeks. What do you see?");
  said(repo, "thr_pg000001", "Bench has been stuck at 82.5 for three weeks. What do you see?",
       "Try heavier triples.");
  repo.insertProposal(proposalAt("prop_pg00001", "rt_pg000001", 1, {benchAt(87.5, 3)},
                                 ProposalDoor::ask, kUser, ThreadId{"thr_pg000001"}));
  const Routine becomes = routineAt("rt_pg000001", "Push A", {benchAt(87.5, 3)});
  REQUIRE(repo.applyRevision(wm::UserId{kUser}, ProposalId{"prop_pg00001"}, becomes, kNow).error ==
          ProposalSettleError::none);

  CHECK(repo.deleteThread(wm::UserId{kUser}, ThreadId{"thr_pg000001"}));

  // The conversation is gone, turns and all.
  CHECK_EQ(repo.thread(wm::UserId{kUser}, ThreadId{"thr_pg000001"}), std::optional<AskThread>());
  CHECK(repo.threads(wm::UserId{kUser}).empty());
  // The consequence is not. The routine's history still carries the change…
  const std::vector<RoutineEvent> history =
      repo.routineHistory(wm::UserId{kUser}, RoutineId{"rt_pg000001"});
  REQUIRE_EQ(history.size(), 2u);
  CHECK(history[0].kind == RoutineEventKind::proposal);
  REQUIRE(history[0].proposal.has_value());
  CHECK(history[0].proposal->state == ProposalState::applied);
  CHECK_EQ(history[0].proposal->changes, 1);
  // …still says it came from Ask…
  CHECK(history[0].proposal->source.door == ProposalDoor::ask);
  // …and simply no longer opens a conversation that exists.
  CHECK_FALSE(history[0].proposal->source.thread.has_value());
  // And the program itself is exactly what the apply made it.
  const std::optional<Routine> standing = repo.routine(wm::UserId{kUser}, RoutineId{"rt_pg000001"});
  REQUIRE(standing.has_value());
  CHECK_EQ(standing->entries, std::vector<RoutineEntry>{benchAt(87.5, 3)});
  // Deleting it twice is not a second deletion, and another account's is nobody's.
  CHECK_FALSE(repo.deleteThread(wm::UserId{kUser}, ThreadId{"thr_pg000001"}));
}

// The export: one row per turn, the thread's facts beside each, everything text and every rendering
// Postgres's — asserted against the in-memory twin so neither can drift on its own. The outcome
// columns come back EMPTY on both sides, because that ladder is the domain's and LogService stamps
// it on.
TEST(pg_gym_the_thread_export_is_one_row_per_turn_and_matches_the_in_memory_twin) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgTrainingRepository repo{wm::pgTestPool()};
  openedAt(repo, "thr_pg000001", "why is my bench, uh, \"stuck\"?");
  said(repo, "thr_pg000001", "why is my bench, uh, \"stuck\"?", "Your top set has not moved.");
  openedAt(repo, "thr_pg000002", "and the squat?", kNow + 1'000);
  said(repo, "thr_pg000002", "and the squat?", "That one is moving.", kNow + 1'000);

  fake::FakeTrainingRepository twin;
  twin.threadRows.push_back(
      AskThread{ThreadId{"thr_pg000001"}, wm::UserId{kUser}, "why is my bench, uh, \"stuck\"?",
                kNow, kNow,
                {ThreadTurn{true, "why is my bench, uh, \"stuck\"?", kNow},
                 ThreadTurn{false, "Your top set has not moved.", kNow}},
                {}});
  twin.threadRows.push_back(AskThread{ThreadId{"thr_pg000002"}, wm::UserId{kUser}, "and the squat?",
                                      kNow + 1'000, kNow + 1'000,
                                      {ThreadTurn{true, "and the squat?", kNow + 1'000},
                                       ThreadTurn{false, "That one is moving.", kNow + 1'000}},
                                      {}});

  const std::vector<ExportedThreadTurn> exported = repo.exportedThreadTurns(wm::UserId{kUser});
  CHECK_EQ(exported, twin.exportedThreadTurns(wm::UserId{kUser}));
  REQUIRE_EQ(exported.size(), 4u);
  CHECK_EQ(exported[0].threadId, std::string("thr_pg000001"));
  CHECK_EQ(exported[0].turnNumber, std::string("1"));
  CHECK_EQ(exported[0].from, std::string("lifter"));
  // The turn as sent, quotes and all — nothing on the way through edits what a lifter typed.
  CHECK_EQ(exported[0].text, std::string("why is my bench, uh, \"stuck\"?"));
  CHECK_EQ(exported[1].from, std::string("ask"));
  CHECK_EQ(exported[2].threadId, std::string("thr_pg000002"));
  // The outcome is not the store's to render.
  CHECK_EQ(exported[0].outcome, std::string(""));
  CHECK_EQ(exported[0].changes, std::string(""));
}

// A THREAD WITH NO TURNS IS IN THE FILE, WITH THE TURN COLUMNS EMPTY. `openThread` commits before
// the model runs, so such a row exists for the whole of every in-flight ask and stays if the process
// died before the answer came back. An INNER JOIN made the export quietly smaller than the list a
// lifter is looking at, under a route that promises nothing omitted — so the join is a LEFT one, and
// the in-memory twin says the same.
TEST(pg_gym_a_thread_whose_run_never_answered_is_still_in_the_export) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgTrainingRepository repo{wm::pgTestPool()};
  openedAt(repo, "thr_pg000001", "a question whose run never came back");
  openedAt(repo, "thr_pg000002", "answered once", kNow + 1'000);
  said(repo, "thr_pg000002", "answered once", "here you go", kNow + 1'000);

  fake::FakeTrainingRepository twin;
  twin.threadRows.push_back(AskThread{ThreadId{"thr_pg000001"}, wm::UserId{kUser},
                                      "a question whose run never came back", kNow, kNow, {}, {}});
  twin.threadRows.push_back(AskThread{ThreadId{"thr_pg000002"}, wm::UserId{kUser}, "answered once",
                                      kNow + 1'000, kNow + 1'000,
                                      {ThreadTurn{true, "answered once", kNow + 1'000},
                                       ThreadTurn{false, "here you go", kNow + 1'000}},
                                      {}});

  const std::vector<ExportedThreadTurn> exported = repo.exportedThreadTurns(wm::UserId{kUser});
  CHECK_EQ(exported, twin.exportedThreadTurns(wm::UserId{kUser}));
  REQUIRE_EQ(exported.size(), 3u);
  CHECK_EQ(exported[0].threadId, std::string("thr_pg000001"));
  CHECK_EQ(exported[0].title, std::string("a question whose run never came back"));
  CHECK_EQ(exported[0].turnNumber, std::string(""));
  CHECK_EQ(exported[0].from, std::string(""));
  CHECK_EQ(exported[0].text, std::string(""));
  CHECK_EQ(exported[0].saidAt, std::string(""));
  CHECK_EQ(exported[1].threadId, std::string("thr_pg000002"));
  CHECK_EQ(exported[1].turnNumber, std::string("1"));
  // And it is in the list too, which is the whole complaint: the two doors show one account.
  CHECK_EQ(repo.threads(wm::UserId{kUser}).size(), 2u);
}

// `allThreads` IS THE ARCHIVE'S READ AND HAS NO CEILING — the list stops at kThreadList because that
// is a screen, and the export's outcomes are stamped from this one because an archive that dropped a
// conversation's outcome would be the route's own promise made false. Oldest first, like the turns
// beside it, and carrying what each one minted just as the list does.
TEST(pg_gym_every_thread_is_read_for_the_archive_past_the_lists_own_ceiling) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgTrainingRepository repo{wm::pgTestPool()};
  inserted(repo, routineAt("rt_pg000001", "Push A", {entryAt(1, "bench-press")}));
  for (int number = 0; number <= kThreadList; ++number) {
    const std::string id = "thr_pg" + std::string(6 - std::to_string(number).size(), '0') +
                           std::to_string(number);
    openedAt(repo, id, "question " + id, kNow + static_cast<std::uint64_t>(number));
  }
  repo.insertProposal(proposalAt("prop_pg00001", "rt_pg000001", 1, {benchAt(87.5, 3)},
                                 ProposalDoor::ask, kUser, ThreadId{"thr_pg000000"}));

  const std::vector<AskThread> every = repo.allThreads(wm::UserId{kUser});

  CHECK_EQ(repo.threads(wm::UserId{kUser}).size(), static_cast<std::size_t>(kThreadList));
  CHECK_EQ(every.size(), static_cast<std::size_t>(kThreadList) + 1);
  // Oldest first — and the oldest is exactly the one the newest-first list read drops.
  CHECK_EQ(every[0].id, ThreadId{"thr_pg000000"});
  REQUIRE_EQ(every[0].minted.size(), 1u);
  CHECK_EQ(every[0].minted[0].routineName, std::string("Push A"));
  CHECK(outcomeOf(every[0]).kind == ThreadOutcomeKind::proposed);
}
