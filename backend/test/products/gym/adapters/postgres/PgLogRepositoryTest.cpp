#include "products/gym/adapters/postgres/PgCatalogRepository.h"
#include "products/gym/adapters/postgres/PgLogRepository.h"
#include "products/gym/adapters/postgres/PgProgramRepository.h"

// The in-memory twin is included for its three EXPORT renderings alone, asserted against each other.
#include "test/products/gym/Fakes.h"
#include "test/products/gym/adapters/postgres/PgGymFixture.h"
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

// The log's store against a real server: the lifecycle, the set writes and their races, and every read.
using namespace wm::gym;
using namespace wm::gym::pgtest;

TEST(pg_gym_session_lifecycle_start_is_idempotent_and_one_open_holds) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgLogRepository repo{wm::pgTestPool()};
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
  repo.close(SessionId{"ses_pg000001"}, t1 + 1'000, ClosedBy::finish);
  repo.close(SessionId{"ses_pg000001"}, t1 + 9'000, ClosedBy::finish);
  CHECK_EQ(repo.open(wm::UserId{kUser}), std::optional<Session>());
  std::optional<Session> closed = repo.session(wm::UserId{kUser}, SessionId{"ses_pg000001"});
  CHECK_EQ(closed->finishedAtMs, std::optional<std::uint64_t>(t1 + 1'000));

  repo.insertSession(sessionAt("ses_pg000002", t1 + 5));
  CHECK_EQ(repo.open(wm::UserId{kUser}), std::optional<Session>(sessionAt("ses_pg000002", t1 + 5)));
}

TEST(pg_gym_set_write_numbers_max_plus_one_and_replay_returns_stored) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgLogRepository repo{wm::pgTestPool()};
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

// The read-back is scoped to the session, so an id already spent elsewhere resolves to NOTHING.
TEST(pg_gym_a_set_id_spent_in_another_session_resolves_to_nothing) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgLogRepository repo{wm::pgTestPool()};
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

  // The same lifter reusing one of their own spent ids in a later session: the same refusal.
  repo.close(SessionId{"ses_pg000001"}, t1 + 3'000, ClosedBy::finish);
  repo.insertSession(sessionAt("ses_pg000003", t1 + 4'000));
  SetInsertOutcome reused = repo.insertSet(
      Set{SetId{"set_pg000001"}, SessionId{"ses_pg000003"}, ExerciseId{"back-squat"}, 0, 222.5, 9,
          SetKind::working, std::nullopt, "", t1 + 5'000});

  CHECK(reused.error == SetInsertError::idTaken);
  CHECK_EQ(reused.set, std::optional<Set>());
  CHECK_EQ(repo.setsOf(SessionId{"ses_pg000003"}), std::vector<Set>{});
  CHECK_EQ(repo.setOf(wm::UserId{kUser}, SetId{"set_pg000001"}), mine.set);
}

// The catalog refusal leaves the store as a VALUE: the statement asks outright, inside the session's lock.
TEST(pg_gym_a_set_naming_a_movement_no_catalog_holds_is_refused_as_a_value) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgLogRepository repo{wm::pgTestPool()};
  const std::uint64_t t1 = 1'700'000'000'123;
  repo.insertSession(sessionAt("ses_pg000001", t1));
  SetInsertOutcome landed = repo.insertSet(benchSet("set_pg000001", 82.5, t1 + 1'000));

  SetInsertOutcome unknown = repo.insertSet(
      Set{SetId{"set_pg000002"}, SessionId{"ses_pg000001"}, ExerciseId{"pg-no-such-movement"}, 0,
          60.0, 5, SetKind::working, std::nullopt, "", t1 + 2'000});

  CHECK(unknown.error == SetInsertError::unknownExercise);
  CHECK_EQ(unknown.set, std::optional<Set>());
  CHECK_EQ(repo.setsOf(SessionId{"ses_pg000001"}), std::vector<Set>{*landed.set});

  // The rolled-back transaction is the refused write's alone: the next append lands normally.
  SetInsertOutcome after = repo.insertSet(benchSet("set_pg000003", 85.0, t1 + 3'000));
  CHECK(after.error == SetInsertError::none);
  CHECK_EQ(after.set->setNumber, 2);
  CHECK_EQ(repo.setsOf(SessionId{"ses_pg000001"}), (std::vector<Set>{*landed.set, *after.set}));
}

// A set may not NAME a movement this account cannot see: the write carries the catalog read's predicate.
TEST(pg_gym_a_set_may_not_name_another_accounts_private_movement) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgLogRepository repo{wm::pgTestPool()};
  PgCatalogRepository catalog{wm::pgTestPool()};
  const std::uint64_t t1 = 1'700'000'000'123;
  catalog.insertExercise(wm::UserId{kOther},
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

// The finish boundary is held HERE by the lock: a close landing between the service's read and this insert is caught.
TEST(pg_gym_a_set_that_never_landed_cannot_land_after_the_session_closed) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgLogRepository repo{wm::pgTestPool()};
  const std::uint64_t t1 = 1'700'000'000'123;
  repo.insertSession(sessionAt("ses_pg000001", t1));
  SetInsertOutcome landed = repo.insertSet(benchSet("set_pg000001", 82.5, t1 + 1'000));
  repo.close(SessionId{"ses_pg000001"}, t1 + 2'000, ClosedBy::finish);

  SetInsertOutcome refused = repo.insertSet(benchSet("set_pg000002", 85.0, t1 + 3'000));

  CHECK(refused.error == SetInsertError::finished);
  CHECK_EQ(refused.set, std::optional<Set>());
  CHECK_EQ(repo.setsOf(SessionId{"ses_pg000001"}), std::vector<Set>{*landed.set});
}

// A set continuing a STALE close lands and moves finished_at forward; a legacy close (closed_by NULL) reads as a finish.
TEST(pg_gym_a_late_set_continues_a_stale_close_and_never_a_finish) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgLogRepository repo{wm::pgTestPool()};
  const std::uint64_t t1 = 1'700'000'000'123;
  repo.insertSession(sessionAt("ses_pg000001", t1));
  repo.insertSet(benchSet("set_pg000001", 82.5, t1 + 1'000));
  repo.close(SessionId{"ses_pg000001"}, t1 + 1'000, ClosedBy::stale);

  SetInsertOutcome owed = repo.insertSet(benchSet("set_pg000002", 85.0, t1 + 600'000));
  SetInsertOutcome tomorrow = repo.insertSet(benchSet("set_pg000003", 60.0, t1 + 600'000 + kAutoCloseMs + 1));

  CHECK(owed.error == SetInsertError::none);
  CHECK_EQ(owed.set->setNumber, 2);
  CHECK(tomorrow.error == SetInsertError::finished);
  std::optional<Session> extended = repo.session(wm::UserId{kUser}, SessionId{"ses_pg000001"});
  CHECK_EQ(extended->finishedAtMs, std::optional<std::uint64_t>(t1 + 600'000));
  CHECK(extended->closedBy == std::optional<ClosedBy>(ClosedBy::stale));
  CHECK_EQ(repo.open(wm::UserId{kUser}), std::optional<Session>());   // extended, not reopened

  // The lifter's finish onto the stale close: inside the window it moves the end and the word, later only the word.
  repo.close(SessionId{"ses_pg000001"}, t1 + 700'000, ClosedBy::finish);
  std::optional<Session> upgraded = repo.session(wm::UserId{kUser}, SessionId{"ses_pg000001"});
  CHECK_EQ(upgraded->finishedAtMs, std::optional<std::uint64_t>(t1 + 700'000));
  CHECK(upgraded->closedBy == std::optional<ClosedBy>(ClosedBy::finish));
  repo.close(SessionId{"ses_pg000001"}, t1 + 900'000, ClosedBy::finish);            // a finish never moves again
  CHECK_EQ(repo.session(wm::UserId{kUser}, SessionId{"ses_pg000001"})->finishedAtMs,
           std::optional<std::uint64_t>(t1 + 700'000));

  repo.insertSession(sessionAt("ses_pg000002", t1 + 900'000));
  repo.insertSet(benchSet("set_pg000004", 82.5, t1 + 901'000, "ses_pg000002"));
  repo.close(SessionId{"ses_pg000002"}, t1 + 902'000, ClosedBy::finish);
  SetInsertOutcome afterFinish = repo.insertSet(benchSet("set_pg000005", 85.0, t1 + 901'500, "ses_pg000002"));
  CHECK(afterFinish.error == SetInsertError::finished);
}

// max+1 under parallel appends: each append serializes behind the session row, so six mint six numbers.
TEST(pg_gym_parallel_appends_to_one_session_mint_distinct_numbers) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgLogRepository repo{wm::pgTestPool()};
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
  PgLogRepository repo{wm::pgTestPool()};
  const std::uint64_t t1 = 1'700'000'000'123;
  const std::uint64_t t2 = t1 + 100'000;

  repo.insertSession(sessionAt("ses_pg000001", t1));
  repo.insertSet(benchSet("set_pg000001", 82.5, t1 + 1'000));
  repo.insertSet(Set{SetId{"set_pg000002"}, SessionId{"ses_pg000001"}, ExerciseId{"back-squat"},
                     0, 100.0, 5, SetKind::working, std::nullopt, "", t1 + 2'000});
  repo.close(SessionId{"ses_pg000001"}, t1 + 3'000, ClosedBy::finish);
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

// Two sessions started in the same millisecond, the tie straddling a page edge: the pair cursor walks all four.
TEST(pg_gym_log_walks_a_tied_start_instant_across_a_page_boundary) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgLogRepository repo{wm::pgTestPool()};
  const std::uint64_t t1 = 1'700'000'000'123;
  repo.insertSession(sessionAt("ses_pg000001", t1 + 3'000));
  repo.close(SessionId{"ses_pg000001"}, t1 + 9'000, ClosedBy::finish);
  repo.insertSession(sessionAt("ses_pg000002", t1 + 2'000));
  repo.close(SessionId{"ses_pg000002"}, t1 + 9'000, ClosedBy::finish);
  repo.insertSession(sessionAt("ses_pg000003", t1 + 2'000));   // the tie
  repo.close(SessionId{"ses_pg000003"}, t1 + 9'000, ClosedBy::finish);
  repo.insertSession(sessionAt("ses_pg000004", t1 + 1'000));
  repo.close(SessionId{"ses_pg000004"}, t1 + 9'000, ClosedBy::finish);

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

// topSet is a lateral over the WORKING sets; closedItself is the four-hour rule's signature — finished_at at the last set's instant, or at started_at.
TEST(pg_gym_log_carries_the_top_working_set_and_says_which_row_closed_itself) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgLogRepository repo{wm::pgTestPool()};
  const std::uint64_t t1 = 1'700'000'000'123;

  // Finished by a tap, an hour after its last set.
  repo.insertSession(sessionAt("ses_pg000001", t1));
  repo.insertSet(squatSet("set_pg000001", "ses_pg000001", 100, 5, t1 + 60'000));
  repo.insertSet(squatSet("set_pg000002", "ses_pg000001", 100, 8, t1 + 120'000));
  repo.insertSet(squatSet("set_pg000003", "ses_pg000001", 140, 1, t1 + 30'000, SetKind::warmup));
  repo.close(SessionId{"ses_pg000001"}, t1 + 3'600'000, ClosedBy::finish);
  // Left running and never touched again: the auto-close ends it AT its last set.
  repo.insertSession(sessionAt("ses_pg000002", t1 + 10'000'000));
  repo.insertSet(squatSet("set_pg000004", "ses_pg000002", 90, 5, t1 + 10'060'000));
  repo.close(SessionId{"ses_pg000002"}, t1 + 10'060'000, ClosedBy::stale);
  // Abandoned holding no set at all: the same rule ends it at its own start.
  repo.insertSession(sessionAt("ses_pg000004", t1 + 30'000'000));
  repo.close(SessionId{"ses_pg000004"}, t1 + 30'000'000, ClosedBy::stale);
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

  // A row closed before closed_by existed reads the four-hour rule's own signature.
  {
    wm::PgLease conn{*wm::pgTestPool()};
    pqxx::work txn{*conn};
    txn.exec("UPDATE gym_sessions SET closed_by = NULL WHERE id IN ('ses_pg000001', 'ses_pg000002')");
    txn.commit();
  }
  std::vector<SessionSummary> legacy = pageOf(repo, wm::UserId{kUser}, page(t1 + 40'000'000, 50));
  CHECK(legacy[2].closedItself);
  CHECK_FALSE(legacy[3].closedItself);
}

// Both counts come off ONE GROUP BY, and `greatest(weight_kg, 0)` keeps a NEGATIVE assisted load from subtracting.
TEST(pg_gym_log_counts_working_sets_apart_and_clamps_an_assisted_set_out_of_the_tonnage) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgLogRepository repo{wm::pgTestPool()};
  const std::uint64_t t1 = 1'700'000'000'123;

  repo.insertSession(sessionAt("ses_pg000001", t1));
  repo.insertSet(squatSet("set_pg000001", "ses_pg000001", 60, 10, t1 + 1'000, SetKind::warmup));
  repo.insertSet(squatSet("set_pg000002", "ses_pg000001", 100, 5, t1 + 2'000));
  repo.insertSet(squatSet("set_pg000003", "ses_pg000001", 100, 5, t1 + 3'000));
  repo.insertSet(benchSet("set_pg000004", 82.5, t1 + 4'000));                     // 82.5 × 8
  repo.insertSet(benchSet("set_pg000005", -20, t1 + 5'000));                      // assisted × 8
  repo.close(SessionId{"ses_pg000001"}, t1 + 6'000, ClosedBy::finish);
  // A whole session of chin-ups: working sets that moved no measurable load at all.
  repo.insertSession(sessionAt("ses_pg000002", t1 + 100'000));
  repo.insertSet(benchSet("set_pg000006", 0, t1 + 101'000, "ses_pg000002"));
  repo.close(SessionId{"ses_pg000002"}, t1 + 102'000, ClosedBy::finish);

  std::vector<SessionSummary> listed = pageOf(repo, wm::UserId{kUser}, page(t1 + 200'000, 50));

  REQUIRE_EQ(listed.size(), static_cast<std::size_t>(2));
  CHECK_EQ(listed[0].setCount, 1);
  CHECK_EQ(listed[0].workingSetCount, 1);
  CHECK_EQ(listed[0].tonnageKg, 0.0);
  CHECK_EQ(listed[1].setCount, 5);
  CHECK_EQ(listed[1].workingSetCount, 4);          // the ramp-up is counted, never worked
  CHECK_EQ(listed[1].tonnageKg, 100.0 * 5 + 100.0 * 5 + 82.5 * 8);   // the assisted set adds none
}

// One row per distinct WORKING load carrying the best reps at it, heaviest first; a load at or below zero rides along unfiltered.
TEST(pg_gym_log_hands_back_one_row_per_working_load_with_the_best_reps_at_it) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgLogRepository repo{wm::pgTestPool()};
  const std::uint64_t t1 = 1'700'000'000'123;

  repo.insertSession(sessionAt("ses_pg000001", t1));
  repo.insertSet(squatSet("set_pg000001", "ses_pg000001", 60, 10, t1 + 1'000, SetKind::warmup));
  repo.insertSet(squatSet("set_pg000002", "ses_pg000001", 100, 5, t1 + 2'000));
  repo.insertSet(squatSet("set_pg000003", "ses_pg000001", 95, 6, t1 + 3'000));
  repo.insertSet(squatSet("set_pg000004", "ses_pg000001", 95, 10, t1 + 4'000));
  repo.insertSet(squatSet("set_pg000005", "ses_pg000001", 95, 8, t1 + 5'000));
  repo.insertSet(squatSet("set_pg000006", "ses_pg000001", -20, 12, t1 + 6'000));
  repo.close(SessionId{"ses_pg000001"}, t1 + 7'000, ClosedBy::finish);

  std::vector<SessionSummary> listed = pageOf(repo, wm::UserId{kUser}, page(t1 + 100'000, 50));

  REQUIRE_EQ(listed.size(), static_cast<std::size_t>(1));
  // One row per (movement, load) with the best reps at it, dated by the SESSION and not by the set (domain/Review.h).
  CHECK_EQ(listed[0].workingMarks,
           (std::vector<PriorMark>{PriorMark{ExerciseId{"back-squat"}, 100.0, 5, t1},
                                   PriorMark{ExerciseId{"back-squat"}, 95.0, 10, t1},
                                   PriorMark{ExerciseId{"back-squat"}, -20.0, 12, t1}}));
  // And what the application makes of it: the session's number, not its heaviest set's.
  CHECK_EQ(topE1rmOf(listed[0].workingMarks), e1rm(95.0, 10));
  CHECK_EQ(listed[0].topSet, std::optional<TopWorkingSet>(TopWorkingSet{100.0, 5}));
}

// The movements are framed by the rows they come back in, so a name holding a separator is still ONE movement.
TEST(pg_gym_log_names_a_movement_whose_display_name_holds_a_newline_once) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgLogRepository repo{wm::pgTestPool()};
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

// The prefill read: the most recent FINISHED session wins, warmups are not history, the block is in set_number order.
TEST(pg_gym_last_time_is_the_newest_finished_session_of_that_movement) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgLogRepository repo{wm::pgTestPool()};
  const std::uint64_t t1 = 1'700'000'000'123;

  repo.insertSession(sessionAt("ses_pg000001", t1));
  repo.insertSet(benchSet("set_pg000001", 80.0, t1 + 1'000));
  repo.close(SessionId{"ses_pg000001"}, t1 + 2'000, ClosedBy::finish);

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
  repo.close(SessionId{"ses_pg000002"}, t1 + 15'000, ClosedBy::finish);

  // Today, live and heavier: an unfinished session is never a last time.
  repo.insertSession(sessionAt("ses_pg000003", t1 + 20'000));
  repo.insertSet(benchSet("set_pg000006", 100.0, t1 + 21'000, "ses_pg000003"));
  // And another account's newer, heavier bench, which this caller must never see.
  repo.insertSession(Session{SessionId{"ses_pg000004"}, wm::UserId{kOther}, t1 + 30'000});
  repo.insertSet(benchSet("set_pg000007", 142.5, t1 + 31'000, "ses_pg000004"));
  repo.close(SessionId{"ses_pg000004"}, t1 + 32'000, ClosedBy::finish);

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
  PgLogRepository repo{wm::pgTestPool()};
  const std::uint64_t t1 = 1'700'000'000'123;
  repo.insertSession(sessionAt("ses_pg000001", t1));
  repo.insertSet(Set{SetId{"set_pg000001"}, SessionId{"ses_pg000001"}, ExerciseId{"back-squat"}, 0,
                     60.0, 10, SetKind::warmup, std::nullopt, "", t1 + 1'000});
  repo.close(SessionId{"ses_pg000001"}, t1 + 2'000, ClosedBy::finish);
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
  // Owner-scoped exactly like the catalog read: another account's custom movement is unknown here.
  CHECK(anothersCustom.error == LastTimeError::unknownExercise);
  CHECK_EQ(anothersCustom.lastTime, std::optional<LastTime>());
}

// Last time is the newest SESSION, not the newest set instant: completed_at is the device's own wall clock.
TEST(pg_gym_last_time_walks_sessions_not_set_instants) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgLogRepository repo{wm::pgTestPool()};
  const std::uint64_t t1 = 1'700'000'000'123;
  const std::uint64_t day = 86'400'000;

  repo.insertSession(sessionAt("ses_pg000001", t1));                       // a week ago
  repo.insertSet(benchSet("set_pg000001", 60.0, t1 + 30 * day));           // stamped 30 days ahead
  repo.close(SessionId{"ses_pg000001"}, t1 + 1'000, ClosedBy::finish);
  repo.insertSession(sessionAt("ses_pg000002", t1 + 6 * day));             // yesterday
  SetInsertOutcome honest =
      repo.insertSet(benchSet("set_pg000002", 100.0, t1 + 6 * day + 1'000, "ses_pg000002"));
  repo.close(SessionId{"ses_pg000002"}, t1 + 6 * day + 2'000, ClosedBy::finish);

  LastTimeOutcome last = repo.lastTime(wm::UserId{kUser}, ExerciseId{"bench-press"});
  std::vector<SessionSummary> listed = pageOf(repo, wm::UserId{kUser}, page(t1 + 7 * day, 50));

  CHECK(last.error == LastTimeError::none);
  CHECK_EQ(last.lastTime->session.id, SessionId{"ses_pg000002"});
  CHECK_EQ(last.lastTime->sets, std::vector<Set>{*honest.set});
  // The two reads sort on the same key, so they can never name a different newest session.
  CHECK_EQ(listed[0].session.id, last.lastTime->session.id);
}

// The session lookup is owner-scoped here rather than transitively through the set row's owner.
TEST(pg_gym_last_time_never_answers_with_a_session_the_caller_does_not_own) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgLogRepository repo{wm::pgTestPool()};
  const std::uint64_t t1 = 1'700'000'000'123;
  repo.insertSession(Session{SessionId{"ses_pg000001"}, wm::UserId{kUser}, t1, std::nullopt,
                             std::nullopt, PlanSnapshot{"A private routine", {}}});
  repo.insertSet(benchSet("set_pg000001", 142.5, t1 + 1'000));
  repo.close(SessionId{"ses_pg000001"}, t1 + 2'000, ClosedBy::finish);
  {
    // A set row inside the owner's session carrying ANOTHER account's user_id.
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
  // The locator's probe filters exactly what the block read filters.
  CHECK(ours.error == LastTimeError::none);
  CHECK_EQ(ours.lastTime->session.id, SessionId{"ses_pg000001"});
  CHECK_EQ(ours.lastTime->routineName, std::string("A private routine"));
  REQUIRE_EQ(ours.lastTime->sets.size(), static_cast<std::size_t>(1));
  CHECK_EQ(ours.lastTime->sets[0].id, SetId{"set_pg000001"});
}

// Against real jsonb, with the blob written STRAIGHT INTO the column: only a string is a routine name.
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
    PgLogRepository repo{wm::pgTestPool()};
    repo.insertSession(sessionAt("ses_pg000001", t1));
    {
      wm::PgLease c{*wm::pgTestPool()};
      pqxx::work w{*c};
      w.exec_params("UPDATE gym_sessions SET plan = nullif($2, '')::jsonb WHERE id = $1",
                    "ses_pg000001", snapshot);
      w.commit();
    }
    SetInsertOutcome landed = repo.insertSet(benchSet("set_pg000001", 82.5, t1 + 1'000));
    repo.close(SessionId{"ses_pg000001"}, t1 + 2'000, ClosedBy::finish);

    LastTimeOutcome last = repo.lastTime(wm::UserId{kUser}, ExerciseId{"bench-press"});

    CHECK(last.error == LastTimeError::none);
    CHECK_EQ(last.lastTime->routineName, name);
    CHECK_EQ(last.lastTime->sets, std::vector<Set>{*landed.set});
  }
}

// The picker's meta against the real DISTINCT ON: the LAST set of lastTime's block, dated by that block's session.
TEST(pg_gym_last_sets_is_the_last_row_of_each_movements_last_time_block) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgLogRepository repo{wm::pgTestPool()};
  const std::uint64_t t1 = 1'700'000'000'123;

  // An older, HEAVIER bench session, so a row that reported the heaviest set would say 100 here.
  repo.insertSession(sessionAt("ses_pg000001", t1));
  repo.insertSet(benchSet("set_pg000001", 100.0, t1 + 1'000));
  repo.close(SessionId{"ses_pg000001"}, t1 + 2'000, ClosedBy::finish);

  repo.insertSession(sessionAt("ses_pg000002", t1 + 10'000));
  repo.insertSet(Set{SetId{"set_pg000002"}, SessionId{"ses_pg000002"}, ExerciseId{"bench-press"}, 0,
                     40.0, 10, SetKind::warmup, std::nullopt, "", t1 + 11'000});
  repo.insertSet(benchSet("set_pg000003", 82.5, t1 + 12'000, "ses_pg000002"));
  repo.insertSet(benchSet("set_pg000004", 80.0, t1 + 13'000, "ses_pg000002"));
  // Squatted only as a ramp-up, which is the same silence as never squatting at all.
  repo.insertSet(squatSet("set_pg000005", "ses_pg000002", 60.0, 5, t1 + 14'000, SetKind::warmup));
  repo.close(SessionId{"ses_pg000002"}, t1 + 15'000, ClosedBy::finish);

  // Today, live and far heavier.
  repo.insertSession(sessionAt("ses_pg000003", t1 + 20'000));
  repo.insertSet(benchSet("set_pg000006", 140.0, t1 + 21'000, "ses_pg000003"));

  // And another account's newer, heavier bench.
  repo.insertSession(Session{SessionId{"ses_pg000004"}, wm::UserId{kOther}, t1 + 30'000});
  repo.insertSet(benchSet("set_pg000007", 142.5, t1 + 31'000, "ses_pg000004"));
  repo.close(SessionId{"ses_pg000004"}, t1 + 32'000, ClosedBy::finish);

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

// One row per movement, keyed by movement id — the key a picker joins onto its catalog, not the draw order.
TEST(pg_gym_last_sets_carries_one_row_per_movement_ordered_by_id) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgLogRepository repo{wm::pgTestPool()};
  const std::uint64_t t1 = 1'700'000'000'123;

  CHECK(repo.lastSets(wm::UserId{kUser}).empty());

  repo.insertSession(sessionAt("ses_pg000001", t1));
  repo.insertSet(benchSet("set_pg000001", 82.5, t1 + 1'000));
  repo.insertSet(squatSet("set_pg000002", "ses_pg000001", 120.0, 5, t1 + 2'000));
  repo.close(SessionId{"ses_pg000001"}, t1 + 3'000, ClosedBy::finish);

  // A later session squats again, so the two rows are dated by two different workouts.
  repo.insertSession(sessionAt("ses_pg000002", t1 + 10'000));
  repo.insertSet(squatSet("set_pg000003", "ses_pg000002", 125.0, 5, t1 + 11'000));
  repo.close(SessionId{"ses_pg000002"}, t1 + 12'000, ClosedBy::finish);

  CHECK_EQ(repo.lastSets(wm::UserId{kUser}),
           (std::vector<LastSet>{LastSet{ExerciseId{"back-squat"}, 125.0, 5, t1 + 10'000},
                                 LastSet{ExerciseId{"bench-press"}, 82.5, 8, t1}}));
}

// The plan goes through one codec at both edges, and the name stays a plain string at the top level.
TEST(pg_gym_the_plan_snapshot_round_trips_through_jsonb) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgLogRepository repo{wm::pgTestPool()};
  PgProgramRepository program{wm::pgTestPool()};
  const std::uint64_t t1 = 1'700'000'000'123;
  const PlanSnapshot frozen{
      "Push A",
      {PlanEntry{ExerciseId{"bench-press"}, 5, 5, 82.5, 180},
       PlanEntry{ExerciseId{"back-squat"}, 3, 8, std::nullopt, std::nullopt}}};

  // routine_id is a real foreign key, and it is the snapshot beside it that the log reads its plan out of.
  inserted(program, routineAt("rt_pg000001", "Push A", {entryAt(1, "bench-press")}));
  repo.insertSession(Session{SessionId{"ses_pg000001"}, wm::UserId{kUser}, t1, std::nullopt,
                             RoutineId{"rt_pg000001"}, frozen});
  repo.insertSet(benchSet("set_pg000001", 82.5, t1 + 1'000));
  repo.close(SessionId{"ses_pg000001"}, t1 + 2'000, ClosedBy::finish);

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

// One row per (movement, load) carrying the BEST reps ever done at it, dated by the EARLIEST SESSION to hit them (domain/Review.h).
TEST(pg_gym_history_marks_the_best_reps_at_each_load_this_session_works) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgLogRepository repo{wm::pgTestPool()};
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
  repo.close(SessionId{"ses_pg000001"}, t1 - 2 * week + 3'600'000, ClosedBy::finish);
  repo.insertSession(sessionAt("ses_pg000003", t1));
  repo.insertSet(squatSet("set_pg000010", "ses_pg000003", 105, 5, t1 + 60'000));
  repo.close(SessionId{"ses_pg000003"}, t1 + 3'600'000, ClosedBy::finish);
  // Inserted last, because the one-open index allows exactly one open session at a time.
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
  PgLogRepository repo{wm::pgTestPool()};
  PgProgramRepository program{wm::pgTestPool()};
  const std::uint64_t t1 = 1'700'000'000'000;
  const std::uint64_t week = 604'800'000;
  inserted(program, routineAt("rt_pg000001", "Push A", {entryAt(1, "back-squat")}));

  repo.insertSession(Session{SessionId{"ses_pg000001"}, wm::UserId{kUser}, t1 - 2 * week,
                             std::nullopt, RoutineId{"rt_pg000001"}, pushA()});
  repo.insertSet(squatSet("set_pg000001", "ses_pg000001", 95, 5, t1 - 2 * week + 60'000));
  repo.close(SessionId{"ses_pg000001"}, t1 - 2 * week + 3'600'000, ClosedBy::finish);
  // The same movement a week later with no day of the program behind it: not what this stands against.
  repo.insertSession(sessionAt("ses_pg000002", t1 - week));
  repo.insertSet(squatSet("set_pg000002", "ses_pg000002", 100, 5, t1 - week + 60'000));
  repo.close(SessionId{"ses_pg000002"}, t1 - week + 3'600'000, ClosedBy::finish);
  repo.insertSession(Session{SessionId{"ses_pg000003"}, wm::UserId{kUser}, t1, std::nullopt,
                             RoutineId{"rt_pg000001"}, pushA()});
  repo.insertSet(squatSet("set_pg000003", "ses_pg000003", 105, 5, t1 + 60'000));
  repo.close(SessionId{"ses_pg000003"}, t1 + 3'600'000, ClosedBy::finish);

  std::optional<Session> reviewed = repo.session(wm::UserId{kUser}, SessionId{"ses_pg000003"});
  REQUIRE(reviewed.has_value());
  SessionHistory history = repo.historyFor(wm::UserId{kUser}, *reviewed);

  // The window compares the PAIR (started_at, id), so the session under review is never its own history.
  REQUIRE(history.previous.has_value());
  CHECK_EQ(history.previous->id.str(), std::string("ses_pg000001"));
  CHECK_EQ(history.previous->plan, std::optional<PlanSnapshot>(pushA()));
  REQUIRE_EQ(history.previousSets.size(), static_cast<std::size_t>(1));
  CHECK_EQ(history.previousSets[0].weightKg, 95.0);
  // Each mark dated by the session it was set in, never by the instant a set carried.
  const std::vector<PriorMark> marks{PriorMark{ExerciseId{"back-squat"}, 95, 5, t1 - 2 * week},
                                     PriorMark{ExerciseId{"back-squat"}, 100, 5, t1 - week}};
  CHECK_EQ(history.marks, marks);
}

TEST(pg_gym_discard_takes_the_session_and_every_set_with_it) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgLogRepository repo{wm::pgTestPool()};
  const std::uint64_t t1 = 1'700'000'000'123;
  repo.insertSession(sessionAt("ses_pg000001", t1));
  repo.insertSet(benchSet("set_pg000001", 82.5, t1 + 1'000));
  repo.insertSet(benchSet("set_pg000002", 82.5, t1 + 2'000));
  repo.close(SessionId{"ses_pg000001"}, t1 + 3'000, ClosedBy::finish);

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

// The row is rewritten in place and the version it replaced lands in gym_set_revisions unmarked.
TEST(pg_gym_a_correction_rewrites_the_set_in_place_and_keeps_what_it_replaced) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgLogRepository repo{wm::pgTestPool()};
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

// The lock is its OWN statement: a data-modifying CTE reads the snapshot its statement began with, taken
// before the lock is granted, so without it two corrections copy the same pre-existing row.
TEST(pg_gym_parallel_corrections_of_one_set_keep_every_version_that_ever_stood) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgLogRepository repo{wm::pgTestPool()};
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

// The scope on those statements: another account's set, and this account's in another workout, are not there.
TEST(pg_gym_a_correction_reaches_no_set_outside_the_workout_or_the_account) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgLogRepository repo{wm::pgTestPool()};
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

// The delete moves the row WHOLE and marks it, in one statement, and is silent whether or not anything was there.
// Numbers are not closed up behind it: max+1 keeps minting, so no set inherits a number another one wore.
TEST(pg_gym_a_delete_moves_the_row_into_the_revisions_and_never_reuses_its_number) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgLogRepository repo{wm::pgTestPool()};
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

// A replayed append of a deleted set asks the revisions rather than the primary key, and answers `deleted`, not `idTaken`.
TEST(pg_gym_a_deleted_sets_id_is_spent_for_good_and_a_replayed_append_cannot_bring_it_back) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgLogRepository repo{wm::pgTestPool()};
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
  // A closed workout does not change the answer, and does not get to answer FIRST.
  repo.close(SessionId{"ses_pg000001"}, t1 + 5'000, ClosedBy::finish);
  CHECK(repo.insertSet(benchSet("set_pg000002", 82.5, t1 + 2'000)).error == SetInsertError::deleted);
}

// Another account's deleted id is not a fact this caller may learn, and their own id stays spent in any workout.
TEST(pg_gym_a_deleted_id_is_spent_for_its_own_account_alone) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgLogRepository repo{wm::pgTestPool()};
  const std::uint64_t t1 = 1'700'000'000'123;
  repo.insertSession(sessionAt("ses_pg000001", t1));
  repo.insertSet(benchSet("set_pg000001", 80.0, t1 + 1'000));
  repo.deleteSet(wm::UserId{kUser}, SessionId{"ses_pg000001"}, SetId{"set_pg000001"});
  repo.close(SessionId{"ses_pg000001"}, t1 + 2'000, ClosedBy::finish);
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

// A queue re-sending a set's POST while the lifter deletes it: all three writes take the SESSION's row first,
// so either the append lands and the delete removes it, or the delete commits and the append is refused.
TEST(pg_gym_an_append_racing_a_delete_of_the_same_set_always_ends_deleted) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgLogRepository repo{wm::pgTestPool()};
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
    // Taken in the other order these two are a cycle, and Postgres breaks a cycle by aborting one of them.
    CHECK_EQ(raised.load(), 0);
    CHECK_EQ(repo.setOf(wm::UserId{kUser}, SetId{id}), std::optional<Set>());
  }
}

// One lock order: the correction and the delete both take the SESSION row first (gym_set_revisions carries an
// FK to gym_sessions), so there is no cycle to deadlock on.
TEST(pg_gym_a_correction_racing_a_delete_of_the_same_set_never_deadlocks) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgLogRepository repo{wm::pgTestPool()};
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
    // Whichever went first, the delete is the last word.
    CHECK_EQ(repo.setOf(wm::UserId{kUser}, SetId{id}), std::optional<Set>());
  }
}

// The guard is on the VALUES: a fix that changes nothing keeps no version, and one that moves a field keeps the whole row.
TEST(pg_gym_a_correction_that_moves_nothing_keeps_no_revision) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgLogRepository repo{wm::pgTestPool()};
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

// Neither write goes near gym_sessions.plan or a routine entry, and the live reads move exactly as far as the fix did.
TEST(pg_gym_fixing_and_deleting_a_set_leave_the_frozen_plan_and_the_routine_untouched) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgLogRepository repo{wm::pgTestPool()};
  PgProgramRepository program{wm::pgTestPool()};
  const std::uint64_t t1 = 1'700'000'000'123;
  inserted(program, routineAt("rt_pg000001", "Push A", {entryAt(1, "bench-press")}));
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
  std::optional<Routine> plan = program.routine(wm::UserId{kUser}, RoutineId{"rt_pg000001"});
  REQUIRE(plan.has_value());
  CHECK_EQ(plan->entries, std::vector<RoutineEntry>{entryAt(1, "bench-press")});
  CHECK_EQ(plan->name, std::string("Push A"));
  std::vector<SessionSummary> rows = pageOf(repo, wm::UserId{kUser}, page(t1 + 10'000, 10));
  REQUIRE_EQ(rows.size(), static_cast<std::size_t>(1));
  CHECK_EQ(rows[0].setCount, 1);
  CHECK_EQ(rows[0].tonnageKg, 180.0);
  CHECK_EQ(rows[0].topSet, std::optional<TopWorkingSet>(TopWorkingSet{60, 3}));
}

// The discard reaches the revisions too: session_id carries a cascading foreign key and set_id carries none.
TEST(pg_gym_discarding_a_session_takes_its_revisions_with_it) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgLogRepository repo{wm::pgTestPool()};
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
  repo.close(SessionId{"ses_pg000001"}, t1 + 3'000, ClosedBy::finish);
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

// A row written before the instant band was enforced is clamped into the band rather than failing the conversion.
TEST(pg_gym_reads_a_pre_1970_legacy_row_instead_of_failing_the_whole_log) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgLogRepository repo{wm::pgTestPool()};
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

// One point per (movement, session), one mark per (movement, load), and the weekly counts. No Epley in the SQL.
TEST(pg_gym_statistics_is_the_top_set_per_session_the_marks_and_the_weekly_counts) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgLogRepository repo{wm::pgTestPool()};
  const std::uint64_t t1 = 1'700'000'000'000;
  const std::uint64_t week = 604'800'000;

  repo.insertSession(sessionAt("ses_pg000001", t1));
  repo.insertSet(squatSet("set_pg000001", "ses_pg000001", 100, 5, t1 + 60'000));
  repo.insertSet(squatSet("set_pg000002", "ses_pg000001", 110, 2, t1 + 120'000));
  repo.insertSet(squatSet("set_pg000003", "ses_pg000001", 60, 10, t1 + 180'000, SetKind::warmup));
  repo.close(SessionId{"ses_pg000001"}, t1 + 3'600'000, ClosedBy::finish);
  repo.insertSession(sessionAt("ses_pg000002", t1 + week));
  repo.insertSet(squatSet("set_pg000004", "ses_pg000002", 105, 5, t1 + week + 60'000));
  repo.close(SessionId{"ses_pg000002"}, t1 + week + 3'600'000, ClosedBy::finish);

  TrainingLog log = repo.trainingLog(wm::UserId{kUser});

  // The heaviest working set, ties to more reps; the warmup counts toward nothing.
  CHECK_EQ(log.tops, (std::vector<MovementTop>{MovementTop{ExerciseId{"back-squat"}, t1, 110, 2},
                                               MovementTop{ExerciseId{"back-squat"}, t1 + week,
                                                           105, 5}}));
  // A mark carries the START of the session it was set in, the same instant its point above carries.
  CHECK_EQ(log.marks, (std::vector<PriorMark>{
                          PriorMark{ExerciseId{"back-squat"}, 100, 5, t1},
                          PriorMark{ExerciseId{"back-squat"}, 105, 5, t1 + week},
                          PriorMark{ExerciseId{"back-squat"}, 110, 2, t1}}));
  // Monday 00:00 UTC, truncated `AT TIME ZONE 'UTC'`: 1699833600000 is 2023-11-13.
  CHECK_EQ(log.weeks, (std::vector<TrainingWeek>{TrainingWeek{1'699'833'600'000, 1, 2},
                                                 TrainingWeek{1'699'833'600'000 + week, 1, 1}}));
}

// generate_series fills the run, so a week nobody trained is a zero and not a missing row.
TEST(pg_gym_statistics_weeks_are_contiguous_across_a_week_nobody_trained) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgLogRepository repo{wm::pgTestPool()};
  const std::uint64_t t1 = 1'700'000'000'000;
  const std::uint64_t week = 604'800'000;

  repo.insertSession(sessionAt("ses_pg000001", t1));
  repo.insertSet(squatSet("set_pg000001", "ses_pg000001", 100, 5, t1 + 60'000));
  repo.close(SessionId{"ses_pg000001"}, t1 + 3'600'000, ClosedBy::finish);
  repo.insertSession(sessionAt("ses_pg000002", t1 + 2 * week));
  repo.insertSet(squatSet("set_pg000002", "ses_pg000002", 105, 5, t1 + 2 * week + 60'000));
  repo.close(SessionId{"ses_pg000002"}, t1 + 2 * week + 3'600'000, ClosedBy::finish);

  TrainingLog log = repo.trainingLog(wm::UserId{kUser});

  CHECK_EQ(log.weeks, (std::vector<TrainingWeek>{
                          TrainingWeek{1'699'833'600'000, 1, 1},
                          TrainingWeek{1'699'833'600'000 + week, 0, 0},
                          TrainingWeek{1'699'833'600'000 + 2 * week, 1, 1}}));
}

TEST(pg_gym_statistics_leaves_the_open_session_and_another_account_out) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgLogRepository repo{wm::pgTestPool()};
  const std::uint64_t t1 = 1'700'000'000'000;

  repo.insertSession(sessionAt("ses_pg000001", t1));   // today's workout, never closed
  repo.insertSet(squatSet("set_pg000001", "ses_pg000001", 100, 5, t1 + 60'000));
  repo.insertSession(Session{SessionId{"ses_pg000003"}, wm::UserId{kOther}, t1});
  repo.insertSet(squatSet("set_pg000003", "ses_pg000003", 200, 5, t1 + 60'000));
  repo.close(SessionId{"ses_pg000003"}, t1 + 3'600'000, ClosedBy::finish);

  TrainingLog log = repo.trainingLog(wm::UserId{kUser});

  CHECK(log.tops.empty());
  CHECK(log.marks.empty());
  CHECK(log.weeks.empty());
}

// Every cell is rendered by Postgres and the exact bytes are pinned, beside the in-memory twin's.
TEST(pg_gym_export_renders_instants_as_iso_utc_and_numerics_at_their_column_scale) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgLogRepository repo{wm::pgTestPool()};
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
  PgLogRepository repo{wm::pgTestPool()};
  const std::uint64_t t1 = 1'700'000'000'000;
  repo.insertSession(Session{SessionId{"ses_pg000003"}, wm::UserId{kOther}, t1});
  repo.insertSet(squatSet("set_pg000003", "ses_pg000003", 200, 5, t1 + 60'000));

  CHECK(repo.exportedSets(wm::UserId{kUser}).empty());
  CHECK_EQ(repo.exportedSets(wm::UserId{kOther}).size(), static_cast<std::size_t>(1));
}

TEST(pg_gym_share_is_idempotent_on_the_session_and_replaces_one_that_has_ended) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgLogRepository repo{wm::pgTestPool()};
  const std::uint64_t now = 1'700'000'000'000;
  repo.insertSession(sessionAt("ses_pg000001", now));
  repo.close(SessionId{"ses_pg000001"}, now + 3'600'000, ClosedBy::finish);

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
  PgLogRepository repo{wm::pgTestPool()};
  const std::uint64_t now = 1'700'000'000'000;
  repo.insertSession(Session{SessionId{"ses_pg000003"}, wm::UserId{kOther}, now});
  repo.close(SessionId{"ses_pg000003"}, now + 3'600'000, ClosedBy::finish);

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
  PgLogRepository repo{wm::pgTestPool()};
  const std::uint64_t now = 1'700'000'000'000;
  repo.insertSession(Session{SessionId{"ses_pg000001"}, wm::UserId{kUser}, now, std::nullopt,
                             std::nullopt, pushA()});
  repo.insertSet(squatSet("set_pg000001", "ses_pg000001", 100, 5, now + 60'000));
  repo.insertSet(squatSet("set_pg000002", "ses_pg000001", 110, 2, now + 120'000));
  repo.close(SessionId{"ses_pg000001"}, now + 3'600'000, ClosedBy::finish);
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

// The share goes with the workout: `on delete cascade` leaves no live link to a session that is gone.
TEST(pg_gym_discarding_a_session_takes_its_share_with_it) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgLogRepository repo{wm::pgTestPool()};
  const std::uint64_t now = 1'700'000'000'000;
  repo.insertSession(sessionAt("ses_pg000001", now));
  repo.close(SessionId{"ses_pg000001"}, now + 3'600'000, ClosedBy::finish);
  repo.insertShare(SessionShare{SessionId{"ses_pg000001"}, wm::UserId{kUser}, "pg-tok-doomed",
                                now + kShareLifetimeMs},
                   now);
  CHECK(repo.sharedSession("pg-tok-doomed", now + 1));

  CHECK(repo.deleteSession(wm::UserId{kUser}, SessionId{"ses_pg000001"}));

  CHECK_FALSE(repo.sharedSession("pg-tok-doomed", now + 1));
}

// The marks standing BEFORE a page: every finished session older than the page's last row, narrowed to its movements.
TEST(pg_gym_log_hands_over_the_marks_standing_before_the_page) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgLogRepository repo{wm::pgTestPool()};
  const std::uint64_t t1 = 1'700'000'000'000;
  const std::uint64_t day = 86'400'000;

  repo.insertSession(sessionAt("ses_pg000001", t1));
  repo.insertSet(squatSet("set_pg000001", "ses_pg000001", 100, 5, t1 + 1'000));
  repo.insertSet(benchSet("set_pg000002", 80.0, t1 + 2'000, "ses_pg000001"));
  repo.close(SessionId{"ses_pg000001"}, t1 + 3'000, ClosedBy::finish);
  repo.insertSession(sessionAt("ses_pg000002", t1 + day));
  repo.insertSet(squatSet("set_pg000003", "ses_pg000002", 105, 5, t1 + day + 1'000));
  repo.close(SessionId{"ses_pg000002"}, t1 + day + 2'000, ClosedBy::finish);

  const LogPage newest = repo.log(wm::UserId{kUser}, page(t1 + 2 * day, 1));
  const LogPage whole = repo.log(wm::UserId{kUser}, page(t1 + 2 * day, 50));

  // The squat mark this page has to beat comes back beside it; the BENCH mark does not.
  REQUIRE_EQ(newest.sessions.size(), static_cast<std::size_t>(1));
  CHECK_EQ(newest.standing,
           (std::vector<PriorMark>{PriorMark{ExerciseId{"back-squat"}, 100.0, 5, t1}}));
  // The whole log on one page: nothing was finished before its oldest row, so nothing stands.
  REQUIRE_EQ(whole.sessions.size(), static_cast<std::size_t>(2));
  CHECK_EQ(whole.standing, std::vector<PriorMark>{});
}

// The two windows differ on purpose: a page carries the OPEN workout as a row, while the standing marks count FINISHED sessions alone.
TEST(pg_gym_log_lists_the_open_session_and_never_lets_its_marks_stand_before_a_page) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgLogRepository repo{wm::pgTestPool()};
  const std::uint64_t t1 = 1'700'000'000'000;
  const std::uint64_t day = 86'400'000;

  repo.insertSession(sessionAt("ses_pg000001", t1));
  repo.insertSet(squatSet("set_pg000001", "ses_pg000001", 100, 5, t1 + 1'000));
  repo.close(SessionId{"ses_pg000001"}, t1 + 2'000, ClosedBy::finish);
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

// One ladder per FINISHED session oldest first, the routines naming the movement once each, then the recent days.
TEST(pg_gym_movement_history_is_a_ladder_per_finished_session_the_routines_and_the_recent_days) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgLogRepository repo{wm::pgTestPool()};
  PgProgramRepository program{wm::pgTestPool()};
  const std::uint64_t t1 = 1'700'000'000'000;
  const std::uint64_t day = 86'400'000;
  // The same movement twice in one routine — heavy, then a back-off — is still ONE routine.
  inserted(program, routineAt("rt_pg000001", "Legs",
                               {entryAt(1, "back-squat"), entryAt(2, "back-squat")}));

  repo.insertSession(sessionAt("ses_pg000001", t1));
  repo.insertSet(squatSet("set_pg000001", "ses_pg000001", 60, 10, t1 + 1'000, SetKind::warmup));
  repo.insertSet(squatSet("set_pg000002", "ses_pg000001", 100, 5, t1 + 2'000));
  repo.insertSet(squatSet("set_pg000003", "ses_pg000001", 95, 10, t1 + 3'000));
  repo.close(SessionId{"ses_pg000001"}, t1 + 4'000, ClosedBy::finish);
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
  // The ladder's rows carry that same instant, so the bar, the tile and the record line cannot land on three days.
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

// A movement this account's catalog does not hold answers with nothing at all, as does another lifter's private one.
TEST(pg_gym_movement_history_of_a_movement_this_account_cannot_see_is_empty) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgLogRepository repo{wm::pgTestPool()};
  PgCatalogRepository catalog{wm::pgTestPool()};
  catalog.insertExercise(wm::UserId{kOther},
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
