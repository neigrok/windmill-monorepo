#include "platform/domain/sync/Jcs.h"
#include "test/products/gym/sync/GymDoorFixture.h"
#include "test/testing.h"

#include <pqxx/pqxx>

#include <algorithm>
#include <atomic>
#include <cstdlib>
#include <latch>
#include <mutex>
#include <optional>
#include <stdexcept>
#include <string>
#include <thread>
#include <utility>
#include <vector>

// The log's reads against a real server, over a log written as the live doors write it: services for MCP and import, deltas for a phone.
using namespace wm;
using namespace wm::gym;
using namespace wm::gym::doortest;

namespace {

SetWrite lift(const std::string& id, const std::string& exercise, double weightKg, int reps,
              std::uint64_t completedAtMs, SetKind kind = SetKind::working) {
  return SetWrite{SetId{id}, ExerciseId{exercise}, weightKg, reps, kind, std::nullopt, "", completedAtMs};
}

SetWrite bench(const std::string& id, double weightKg, std::uint64_t completedAtMs) {
  return lift(id, "bench-press", weightKg, 8, completedAtMs);
}

// The reps are what the marks are made of, so a squat states them.
SetWrite squat(const std::string& id, double weightKg, int reps, std::uint64_t completedAtMs,
               SetKind kind = SetKind::working) {
  return lift(id, "back-squat", weightKg, reps, completedAtMs, kind);
}

// A start the lifter makes at `atMs`: the clock stands there, so the door holds no start ahead of it.
Session started(Harness& h, const UserId& user, const std::string& id, std::uint64_t atMs,
                std::optional<RoutineId> routine = std::nullopt) {
  h.clock.now = std::max(h.clock.now, atMs);
  const StartOutcome outcome = h.door.start(user, SessionStart{SessionId{id}, atMs, false, routine});
  if (!outcome.session) throw std::runtime_error("the door started no " + id);
  return *outcome.session;
}

Set logged(Harness& h, const UserId& user, const std::string& session, const SetWrite& set) {
  const AppendOutcome outcome = h.door.append(user, SessionId{session}, set);
  if (!outcome.set) throw std::runtime_error("the door logged no " + set.id.str());
  return *outcome.set;
}

// A finish the lifter makes at `atMs`: the clock stands there too, as the door lands a later finish at its own now.
Session finished(Harness& h, const UserId& user, const std::string& session, std::uint64_t atMs) {
  h.clock.now = std::max(h.clock.now, atMs);
  const FinishOutcome outcome = h.door.finish(user, SessionId{session}, atMs);
  if (!outcome.session) throw std::runtime_error("the door finished no " + session);
  return *outcome.session;
}

// A phone's fix of a set it holds: the fields it names, admitted as one delta.
void fixed(Harness& h, const std::string& set, const Json::Value& fields) {
  GymDoor::requireOk(h.admit(h.user, {GymDoor::delta("set", set, fields)}));
}

RoutineEntry entryAt(int position, const std::string& exercise) {
  return RoutineEntry{position, ExerciseId{exercise}, gym::fake::straight(5, 5, 82.5), 180};
}

// The lifter's own routine, which a start freezes as its plan.
Routine planned(Harness& h, const std::string& id, const std::string& name, std::vector<RoutineEntry> entries) {
  const RoutineWriteOutcome outcome =
      h.door.createRoutine(h.user, RoutineWrite{RoutineId{id}, name, 0, std::move(entries)}, std::nullopt);
  if (!outcome.routine) throw std::runtime_error("the door planned no " + id);
  return *outcome.routine;
}

void movement(Harness& h, const UserId& user, const std::string& id, const std::string& name) {
  const ExerciseInsertOutcome outcome =
      h.door.createExercise(user, ExerciseWrite{ExerciseId{id}, name, Pattern::squat, Equipment::barbell, 2.5});
  if (!outcome.exercise) throw std::runtime_error("the door created no " + id);
}

PlanSnapshot pushA() {
  return PlanSnapshot{"Push A", {PlanEntry{ExerciseId{"bench-press"}, gym::fake::straight(5, 5, 82.5), 180}}};
}

LogCursor page(std::uint64_t beforeMs, int limit) {
  return LogCursor{beforeMs, std::nullopt, limit};
}

// The rows of a page, for the cases that are about the rows.
std::vector<SessionSummary> pageOf(Harness& h, const LogCursor& cursor) {
  return h.repo.log.log(h.user, cursor).sessions;
}

pqxx::result sql(const std::string& query, const pqxx::params& params = {}) {
  PgLease lease{*pool()};
  pqxx::work txn{*lease};
  pqxx::result rows = txn.exec(query, params);
  txn.commit();
  return rows;
}

std::vector<int> numbersOf(Harness& h, const std::string& session) {
  std::vector<int> numbers;
  for (const Set& set : h.repo.log.setsOf(SessionId{session})) numbers.push_back(set.setNumber);
  std::sort(numbers.begin(), numbers.end());
  return numbers;
}

}

TEST(pg_gym_session_lifecycle_start_is_idempotent_and_one_open_holds) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Harness h;
  const std::uint64_t t1 = 1'700'000'000'123;
  const Session open{SessionId{"ses_pg000001"}, h.user, t1};

  CHECK_EQ(started(h, h.user, "ses_pg000001", t1), open);
  CHECK_EQ(h.repo.log.open(h.user), std::optional<Session>(open));

  // The replay answers with the session it started; a second id is refused while one is open, and lands nowhere.
  CHECK_EQ(h.door.start(h.user, SessionStart{SessionId{"ses_pg000001"}, t1, false}).session, std::optional<Session>(open));
  CHECK_EQ(h.door.start(h.user, SessionStart{SessionId{"ses_pg000002"}, t1 + 5, false}).error, StartError::alreadyOpen);
  CHECK_EQ(h.repo.log.open(h.user), std::optional<Session>(open));
  CHECK_EQ(h.repo.log.session(h.user, SessionId{"ses_pg000002"}), std::optional<Session>());

  // The first finish is the lifter's word and a second moves nothing; once closed, a new session may open.
  finished(h, h.user, "ses_pg000001", t1 + 1'000);
  finished(h, h.user, "ses_pg000001", t1 + 9'000);
  CHECK_EQ(h.repo.log.open(h.user), std::optional<Session>());
  CHECK_EQ(h.repo.log.session(h.user, SessionId{"ses_pg000001"}),
           std::optional<Session>(Session{SessionId{"ses_pg000001"}, h.user, t1, t1 + 1'000, std::nullopt,
                                          std::nullopt, ClosedBy::finish}));

  started(h, h.user, "ses_pg000002", t1 + 5);
  CHECK_EQ(h.repo.log.open(h.user), std::optional<Session>(Session{SessionId{"ses_pg000002"}, h.user, t1 + 5}));
}

TEST(pg_gym_progress_reads_raw_finished_working_sets_with_owner_and_effort_intact) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Harness h;
  const std::uint64_t began = 1'700'000'000'123;
  started(h, h.user, "ses_pg000001", began);
  const std::vector<SetWrite> sets{
      {SetId{"set_pg000001"}, ExerciseId{"bench-press"}, 100, 1, SetKind::working, std::nullopt, "private note", began + 1'000},
      {SetId{"set_pg000002"}, ExerciseId{"bench-press"}, 90, 10, SetKind::working, 6.5, "", began + 2'000},
      {SetId{"set_pg000003"}, ExerciseId{"bench-press"}, 90, 8, SetKind::working, 7, "", began + 3'000},
      {SetId{"set_pg000004"}, ExerciseId{"chin-up"}, -10, 8, SetKind::working, 8.5, "", began + 4'000},
      {SetId{"set_pg000005"}, ExerciseId{"pull-up"}, 0, 8, SetKind::working, std::nullopt, "", began + 5'000},
      {SetId{"set_pg000006"}, ExerciseId{"bench-press"}, 200, 8, SetKind::warmup, 8, "", began + 6'000},
      {SetId{"set_pg000007"}, ExerciseId{"bench-press"}, 200, 8, SetKind::drop, 8, "", began + 7'000},
      {SetId{"set_pg000008"}, ExerciseId{"bench-press"}, 200, 8, SetKind::failure, 8, "", began + 8'000}};
  for (const SetWrite& set : sets) logged(h, h.user, "ses_pg000001", set);
  finished(h, h.user, "ses_pg000001", began + 10'000);

  started(h, h.user, "ses_pg000002", began + 20'000);
  finished(h, h.user, "ses_pg000002", began + 30'000);
  started(h, h.user, "ses_pg000003", began + 40'000);
  logged(h, h.user, "ses_pg000003", lift("set_pg000009", "bench-press", 200, 8, began + 41'000, SetKind::warmup));
  finished(h, h.user, "ses_pg000003", began + 50'000);
  started(h, h.user, "ses_pg000004", began + 60'000);
  logged(h, h.user, "ses_pg000004", bench("set_pg000010", 200, began + 61'000));
  started(h, h.other, "ses_pg000005", began);
  logged(h, h.other, "ses_pg000005", bench("set_pg000011", 300, began + 1'000));
  finished(h, h.other, "ses_pg000005", began + 10'000);

  std::vector<ProgressSet> expected;
  for (int index = 0; index < 5; ++index)
    expected.push_back(ProgressSet{SessionId{"ses_pg000001"}, began, sets[index].exercise,
        PerformedFact{sets[index].id, sets[index].weightKg, sets[index].reps, sets[index].rpe}});
  const std::vector<ProgressSet> history = h.repo.log.progressHistory(h.user);
  CHECK_EQ(history, expected);
  CHECK_EQ(h.repo.log.progressHistory(h.other), (std::vector<ProgressSet>{
      {SessionId{"ses_pg000005"}, began, ExerciseId{"bench-press"},
          {SetId{"set_pg000011"}, 300, 8, std::nullopt}}}));
  CHECK_EQ(statsProgress(history, began + 70'000), (StatsProgress{began + 70'000, {
      {SessionId{"ses_pg000001"}, began, {
          {ExerciseId{"bench-press"}, 3, expected[0].performed, EstimatedFact{expected[2].performed, 114}},
          {ExerciseId{"chin-up"}, 1, expected[3].performed, std::nullopt},
          {ExerciseId{"pull-up"}, 1, expected[4].performed, std::nullopt, expected[4].performed}}}}}));
}

TEST(pg_gym_progress_preserves_tied_session_identity_and_current_corrections_and_deletions) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Harness h;
  const std::uint64_t began = 1'700'000'000'123;
  started(h, h.user, "ses_pg000002", began);
  logged(h, h.user, "ses_pg000002", bench("set_pg000002", 90, began + 2'000));
  finished(h, h.user, "ses_pg000002", began + 10'000);
  started(h, h.user, "ses_pg000001", began);
  logged(h, h.user, "ses_pg000001", bench("set_pg000001", 90, began + 1'000));
  finished(h, h.user, "ses_pg000001", began + 10'000);
  std::vector<ProgressSet> expected{
      {SessionId{"ses_pg000001"}, began, ExerciseId{"bench-press"},
          {SetId{"set_pg000001"}, 90, 8, std::nullopt}},
      {SessionId{"ses_pg000002"}, began, ExerciseId{"bench-press"},
          {SetId{"set_pg000002"}, 90, 8, std::nullopt}}};
  CHECK_EQ(h.repo.log.progressHistory(h.user), expected);

  fixed(h, "set_pg000001", sync::parseJson(R"({"weightKg":100,"reps":1,"rpe":6.5})"));
  expected[0].performed = PerformedFact{SetId{"set_pg000001"}, 100, 1, 6.5};
  CHECK_EQ(h.repo.log.progressHistory(h.user), expected);

  h.kill(h.user, "set", "set_pg000001");
  expected.erase(expected.begin());
  CHECK_EQ(h.repo.log.progressHistory(h.user), expected);
  REQUIRE_EQ(h.door.discard(h.user, SessionId{"ses_pg000002"}), DiscardOutcome::done);
  CHECK_EQ(h.repo.log.progressHistory(h.user), std::vector<ProgressSet>{});
}

TEST(pg_gym_progress_has_no_session_or_age_cap_and_keeps_each_raw_set) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Harness h;
  const std::uint64_t began = 1'500'000'000'000;
  h.clock.now = began + 130 * 86'400'000ull;
  std::vector<ProgressSet> expected;
  for (int day = 0; day < 130; ++day) {
    const std::string session = "ses_pg" + std::to_string(10'000'000 + day);
    const std::uint64_t start = began + day * 86'400'000ull;
    std::vector<SetWrite> sets;
    for (int index = 0; index < 2; ++index) {
      const std::string set = "set_pg" + std::to_string(10'000'000 + day * 2 + index);
      const double weightKg = day == 0 ? 150 : 100;
      sets.push_back(lift(set, "bench-press", weightKg, 1, start + 1'000));
      expected.push_back(ProgressSet{SessionId{session}, start, ExerciseId{"bench-press"},
          PerformedFact{SetId{set}, weightKg, 1, std::nullopt}});
    }
    REQUIRE_EQ(h.door.importSession(h.user, SessionImport{SessionId{session}, start, start + 60'000, std::nullopt, sets}).error,
               BatchLogError::none);
  }

  CHECK_EQ(h.repo.log.progressHistory(h.user), expected);
}

TEST(pg_gym_set_write_numbers_max_plus_one_and_replay_returns_stored) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Harness h;
  const std::uint64_t t1 = 1'700'000'000'123;
  started(h, h.user, "ses_pg000001", t1);

  const Set bench1 = logged(h, h.user, "ses_pg000001", bench("set_pg000001", 82.5, t1 + 1'000));
  const Set squat1 = logged(h, h.user, "ses_pg000001", SetWrite{SetId{"set_pg000002"}, ExerciseId{"back-squat"},
                                                                100.0, 5, SetKind::working, 8.5, "felt heavy", t1 + 2'000});
  const Set bench2 = logged(h, h.user, "ses_pg000001", bench("set_pg000003", 85.0, t1 + 3'000));

  CHECK_EQ(bench1, Set(SetId{"set_pg000001"}, SessionId{"ses_pg000001"}, ExerciseId{"bench-press"}, 1, 82.5, 8,
                       SetKind::working, std::nullopt, "", t1 + 1'000));
  // Its own count, not the session's.
  CHECK_EQ(squat1, Set(SetId{"set_pg000002"}, SessionId{"ses_pg000001"}, ExerciseId{"back-squat"}, 1, 100.0, 5,
                       SetKind::working, 8.5, "felt heavy", t1 + 2'000));
  CHECK_EQ(bench2, Set(SetId{"set_pg000003"}, SessionId{"ses_pg000001"}, ExerciseId{"bench-press"}, 2, 85.0, 8,
                       SetKind::working, std::nullopt, "", t1 + 3'000));

  // A replay with a drifted weight is handed the ORIGINAL stored row, byte-for-byte.
  const AppendOutcome replayed = h.door.append(h.user, SessionId{"ses_pg000001"}, bench("set_pg000001", 90.0, t1 + 99'000));
  CHECK(replayed.error == AppendError::none);
  CHECK_EQ(replayed.set, std::optional<Set>(bench1));

  CHECK_EQ(h.repo.log.setsOf(SessionId{"ses_pg000001"}), (std::vector<Set>{bench1, squat1, bench2}));
  CHECK_EQ(h.repo.log.setOf(h.user, SetId{"set_pg000001"}), std::optional<Set>(bench1));
  CHECK_EQ(h.repo.log.setOf(h.other, SetId{"set_pg000001"}), std::optional<Set>());
  CHECK_EQ(h.repo.log.setOf(h.user, SetId{"set_pg000009"}), std::optional<Set>());
}

// The read-back is scoped to the session, so an id already spent elsewhere resolves to NOTHING.
TEST(pg_gym_a_set_id_spent_in_another_session_resolves_to_nothing) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Harness h;
  const std::uint64_t t1 = 1'700'000'000'123;
  started(h, h.user, "ses_pg000001", t1);
  started(h, h.other, "ses_pg000002", t1);
  const Set mine = logged(h, h.user, "ses_pg000001",
      SetWrite{SetId{"set_pg000001"}, ExerciseId{"bench-press"}, 142.5, 3, SetKind::working, 9.5,
               "knee felt off, deload next week", t1 + 1'000});

  // Another account mints the same id into ITS own session.
  const AppendOutcome theirs = h.door.append(h.other, SessionId{"ses_pg000002"},
      lift("set_pg000001", "lateral-raise", 7.5, 15, t1 + 2'000));

  CHECK(theirs.error == AppendError::idTaken);
  CHECK_EQ(theirs.set, std::optional<Set>());
  CHECK_EQ(h.repo.log.setsOf(SessionId{"ses_pg000002"}), std::vector<Set>{});
  CHECK_EQ(h.repo.log.setsOf(SessionId{"ses_pg000001"}), std::vector<Set>{mine});

  // The same lifter reusing one of their own spent ids in a later session: the same refusal.
  finished(h, h.user, "ses_pg000001", t1 + 3'000);
  started(h, h.user, "ses_pg000003", t1 + 4'000);
  const AppendOutcome reused = h.door.append(h.user, SessionId{"ses_pg000003"},
      lift("set_pg000001", "back-squat", 222.5, 9, t1 + 5'000));

  CHECK(reused.error == AppendError::idTaken);
  CHECK_EQ(reused.set, std::optional<Set>());
  CHECK_EQ(h.repo.log.setsOf(SessionId{"ses_pg000003"}), std::vector<Set>{});
  CHECK_EQ(h.repo.log.setOf(h.user, SetId{"set_pg000001"}), std::optional<Set>(mine));
}

// The catalog refusal leaves the log as it stood, and the next set numbers on from what landed.
TEST(pg_gym_a_set_naming_a_movement_no_catalog_holds_is_refused_as_a_value) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Harness h;
  const std::uint64_t t1 = 1'700'000'000'123;
  started(h, h.user, "ses_pg000001", t1);
  const Set landed = logged(h, h.user, "ses_pg000001", bench("set_pg000001", 82.5, t1 + 1'000));

  const AppendOutcome unknown = h.door.append(h.user, SessionId{"ses_pg000001"},
      lift("set_pg000002", "pg-no-such-movement", 60.0, 5, t1 + 2'000));

  CHECK(unknown.error == AppendError::unknownExercise);
  CHECK_EQ(unknown.set, std::optional<Set>());
  CHECK_EQ(h.repo.log.setsOf(SessionId{"ses_pg000001"}), std::vector<Set>{landed});

  const Set after = logged(h, h.user, "ses_pg000001", bench("set_pg000003", 85.0, t1 + 3'000));
  CHECK_EQ(after.setNumber, 2);
  CHECK_EQ(h.repo.log.setsOf(SessionId{"ses_pg000001"}), (std::vector<Set>{landed, after}));
}

// A set may not NAME a movement this account cannot see: the write carries the catalog read's predicate.
TEST(pg_gym_a_set_may_not_name_another_accounts_private_movement) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Harness h;
  const std::uint64_t t1 = 1'700'000'000'123;
  movement(h, h.other, "pg-their-zercher", "Their Zercher Squat");
  started(h, h.user, "ses_pg000001", t1);

  const AppendOutcome refused = h.door.append(h.user, SessionId{"ses_pg000001"},
      lift("set_pg000001", "pg-their-zercher", 60.0, 5, t1 + 1'000));

  CHECK(refused.error == AppendError::unknownExercise);
  CHECK_EQ(refused.set, std::optional<Set>());
  CHECK_EQ(h.repo.log.setsOf(SessionId{"ses_pg000001"}), std::vector<Set>{});
  // It is a scope and never a claim the movement does not exist: its owner logs it as normal.
  started(h, h.other, "ses_pg000002", t1);
  CHECK(h.door.append(h.other, SessionId{"ses_pg000002"},
                          lift("set_pg000002", "pg-their-zercher", 60.0, 5, t1 + 1'000)).error == AppendError::none);
}

// A set continuing a STALE close lands and moves finished_at forward; a finish is never continued.
TEST(pg_gym_a_late_set_continues_a_stale_close_and_never_a_finish) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Harness h;
  const std::uint64_t t1 = 1'700'000'000'123;
  started(h, h.user, "ses_pg000001", t1);
  logged(h, h.user, "ses_pg000001", bench("set_pg000001", 82.5, t1 + 1'000));
  h.clock.now = t1 + 1'000 + kAutoCloseMs;
  CHECK_EQ(h.training.openSession(h.user), std::optional<Session>());
  CHECK_EQ(h.repo.log.session(h.user, SessionId{"ses_pg000001"}),
           std::optional<Session>(Session{SessionId{"ses_pg000001"}, h.user, t1, t1 + 1'000, std::nullopt,
                                          std::nullopt, ClosedBy::stale}));

  const AppendOutcome owed = h.door.append(h.user, SessionId{"ses_pg000001"}, bench("set_pg000002", 85.0, t1 + 600'000));
  const AppendOutcome tomorrow = h.door.append(h.user, SessionId{"ses_pg000001"},
      bench("set_pg000003", 60.0, t1 + 600'000 + kAutoCloseMs + 1));

  CHECK(owed.error == AppendError::none);
  REQUIRE(owed.set.has_value());
  CHECK_EQ(owed.set->setNumber, 2);
  CHECK(tomorrow.error == AppendError::finished);
  // Extended, not reopened.
  CHECK_EQ(h.repo.log.session(h.user, SessionId{"ses_pg000001"}),
           std::optional<Session>(Session{SessionId{"ses_pg000001"}, h.user, t1, t1 + 600'000, std::nullopt,
                                          std::nullopt, ClosedBy::stale}));
  CHECK_EQ(h.repo.log.open(h.user), std::optional<Session>());

  // The lifter's finish onto the stale close inside the window moves the end and the word.
  finished(h, h.user, "ses_pg000001", t1 + 700'000);
  CHECK_EQ(h.repo.log.session(h.user, SessionId{"ses_pg000001"}),
           std::optional<Session>(Session{SessionId{"ses_pg000001"}, h.user, t1, t1 + 700'000, std::nullopt,
                                          std::nullopt, ClosedBy::finish}));
  // A finish never moves again.
  finished(h, h.user, "ses_pg000001", t1 + 900'000);
  CHECK_EQ(h.repo.log.session(h.user, SessionId{"ses_pg000001"}).value().finishedAtMs,
           std::optional<std::uint64_t>(t1 + 700'000));

  started(h, h.user, "ses_pg000002", t1 + 900'000);
  logged(h, h.user, "ses_pg000002", bench("set_pg000004", 82.5, t1 + 901'000));
  finished(h, h.user, "ses_pg000002", t1 + 902'000);
  const AppendOutcome afterFinish = h.door.append(h.user, SessionId{"ses_pg000002"},
      bench("set_pg000005", 85.0, t1 + 901'500));
  CHECK(afterFinish.error == AppendError::finished);
}

// Appends in flight at once each take a number of their own.
TEST(pg_gym_parallel_appends_to_one_session_mint_distinct_numbers) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Harness h;
  const std::uint64_t t1 = 1'700'000'000'123;
  started(h, h.user, "ses_pg000001", t1);

  std::mutex failed;
  std::vector<std::string> thrown;
  std::vector<std::thread> flush;
  for (int n = 0; n < 6; ++n)
    flush.emplace_back([&h, &failed, &thrown, n, t1] {
      try {
        h.door.append(h.user, SessionId{"ses_pg000001"},
                          lift("set_pg00001" + std::to_string(n), "deadlift", 100.0, 5, t1 + 1'000 + n));
      } catch (const std::exception& error) {
        std::lock_guard<std::mutex> hold(failed);
        thrown.push_back(error.what());
      }
    });
  for (std::thread& thread : flush) thread.join();

  CHECK_EQ(thrown, std::vector<std::string>{});
  CHECK_EQ(numbersOf(h, "ses_pg000001"), (std::vector<int>{1, 2, 3, 4, 5, 6}));
}

TEST(pg_gym_log_pages_newest_first_with_counts_and_names) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Harness h;
  const std::uint64_t t1 = 1'700'000'000'123;
  const std::uint64_t t2 = t1 + 100'000;

  started(h, h.user, "ses_pg000001", t1);
  logged(h, h.user, "ses_pg000001", bench("set_pg000001", 82.5, t1 + 1'000));
  logged(h, h.user, "ses_pg000001", squat("set_pg000002", 100.0, 5, t1 + 2'000));
  finished(h, h.user, "ses_pg000001", t1 + 3'000);
  started(h, h.user, "ses_pg000002", t2);

  std::vector<SessionSummary> listed = pageOf(h, page(t2 + 1, 50));

  REQUIRE_EQ(listed.size(), static_cast<std::size_t>(2));
  CHECK_EQ(listed[0].session.id.str(), std::string("ses_pg000002"));
  CHECK_EQ(listed[0].setCount, 0);
  CHECK_EQ(listed[0].exerciseNames, std::vector<std::string>{});
  CHECK_EQ(listed[1].session.id.str(), std::string("ses_pg000001"));
  CHECK_EQ(listed[1].setCount, 2);
  CHECK_EQ(listed[1].exerciseNames, (std::vector<std::string>{"Back Squat", "Bench Press"}));

  // The keyset cursor: strictly-before t2 drops the newer session from the page.
  std::vector<SessionSummary> older = pageOf(h, page(t2, 50));
  REQUIRE_EQ(older.size(), static_cast<std::size_t>(1));
  CHECK_EQ(older[0].session.id.str(), std::string("ses_pg000001"));
}

// Two sessions started in the same millisecond, the tie straddling a page edge: the pair cursor walks all four.
TEST(pg_gym_log_walks_a_tied_start_instant_across_a_page_boundary) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Harness h;
  const std::uint64_t t1 = 1'700'000'000'123;
  started(h, h.user, "ses_pg000001", t1 + 3'000);
  finished(h, h.user, "ses_pg000001", t1 + 9'000);
  started(h, h.user, "ses_pg000002", t1 + 2'000);
  finished(h, h.user, "ses_pg000002", t1 + 9'000);
  started(h, h.user, "ses_pg000003", t1 + 2'000);   // the tie
  finished(h, h.user, "ses_pg000003", t1 + 9'000);
  started(h, h.user, "ses_pg000004", t1 + 1'000);
  finished(h, h.user, "ses_pg000004", t1 + 9'000);

  std::vector<SessionSummary> first = pageOf(h, page(t1 + 9'000, 2));
  REQUIRE_EQ(first.size(), static_cast<std::size_t>(2));
  std::vector<SessionSummary> second = pageOf(h, LogCursor{first.back().session.startedAtMs, first.back().session.id, 2});
  REQUIRE_EQ(second.size(), static_cast<std::size_t>(2));
  std::vector<SessionSummary> third = pageOf(h, LogCursor{second.back().session.startedAtMs, second.back().session.id, 2});

  CHECK_EQ(first[0].session.id.str(), std::string("ses_pg000001"));
  CHECK_EQ(first[1].session.id.str(), std::string("ses_pg000003"));
  CHECK_EQ(second[0].session.id.str(), std::string("ses_pg000002"));
  CHECK_EQ(second[1].session.id.str(), std::string("ses_pg000004"));
  CHECK(third.empty());
}

// topSet is a lateral over the WORKING sets; closedItself is the four-hour rule's signature — finished_at at the last set's instant, or at started_at.
TEST(pg_gym_log_carries_the_top_working_set_and_says_which_row_closed_itself) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Harness h;
  const std::uint64_t t1 = 1'700'000'000'123;

  // Finished by a tap, an hour after its last set.
  started(h, h.user, "ses_pg000001", t1);
  logged(h, h.user, "ses_pg000001", squat("set_pg000001", 100, 5, t1 + 60'000));
  logged(h, h.user, "ses_pg000001", squat("set_pg000002", 100, 8, t1 + 120'000));
  logged(h, h.user, "ses_pg000001", squat("set_pg000003", 140, 1, t1 + 30'000, SetKind::warmup));
  finished(h, h.user, "ses_pg000001", t1 + 3'600'000);
  // Left running and never touched again: the auto-close ends it AT its last set.
  started(h, h.user, "ses_pg000002", t1 + 10'000'000);
  logged(h, h.user, "ses_pg000002", squat("set_pg000004", 90, 5, t1 + 10'060'000));
  h.clock.now = t1 + 10'060'000 + kAutoCloseMs;
  REQUIRE(!h.training.openSession(h.user));
  // Abandoned holding no set at all: the same rule ends it at its own start.
  started(h, h.user, "ses_pg000004", t1 + 30'000'000);
  h.clock.now = t1 + 30'000'000 + kAutoCloseMs;
  REQUIRE(!h.training.openSession(h.user));
  // Warmed up and still running — started LAST, because only one session is ever open.
  started(h, h.user, "ses_pg000003", t1 + 20'000'000);
  logged(h, h.user, "ses_pg000003", squat("set_pg000005", 60, 10, t1 + 20'060'000, SetKind::warmup));

  std::vector<SessionSummary> listed = pageOf(h, page(t1 + 40'000'000, 50));

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
  sql("UPDATE gym_sessions SET closed_by = NULL WHERE id IN ('ses_pg000001', 'ses_pg000002')");
  std::vector<SessionSummary> legacy = pageOf(h, page(t1 + 40'000'000, 50));
  REQUIRE_EQ(legacy.size(), static_cast<std::size_t>(4));
  CHECK(legacy[2].closedItself);
  CHECK_FALSE(legacy[3].closedItself);
}

// Both counts come off ONE GROUP BY, and `greatest(weight_kg, 0)` keeps a NEGATIVE assisted load from subtracting.
TEST(pg_gym_log_counts_working_sets_apart_and_clamps_an_assisted_set_out_of_the_tonnage) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Harness h;
  const std::uint64_t t1 = 1'700'000'000'123;

  started(h, h.user, "ses_pg000001", t1);
  logged(h, h.user, "ses_pg000001", squat("set_pg000001", 60, 10, t1 + 1'000, SetKind::warmup));
  logged(h, h.user, "ses_pg000001", squat("set_pg000002", 100, 5, t1 + 2'000));
  logged(h, h.user, "ses_pg000001", squat("set_pg000003", 100, 5, t1 + 3'000));
  logged(h, h.user, "ses_pg000001", bench("set_pg000004", 82.5, t1 + 4'000));                     // 82.5 × 8
  logged(h, h.user, "ses_pg000001", bench("set_pg000005", -20, t1 + 5'000));                      // assisted × 8
  finished(h, h.user, "ses_pg000001", t1 + 6'000);
  // A whole session of chin-ups: working sets that moved no measurable load at all.
  started(h, h.user, "ses_pg000002", t1 + 100'000);
  logged(h, h.user, "ses_pg000002", bench("set_pg000006", 0, t1 + 101'000));
  finished(h, h.user, "ses_pg000002", t1 + 102'000);

  std::vector<SessionSummary> listed = pageOf(h, page(t1 + 200'000, 50));

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
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Harness h;
  const std::uint64_t t1 = 1'700'000'000'123;

  started(h, h.user, "ses_pg000001", t1);
  logged(h, h.user, "ses_pg000001", squat("set_pg000001", 60, 10, t1 + 1'000, SetKind::warmup));
  logged(h, h.user, "ses_pg000001", squat("set_pg000002", 100, 5, t1 + 2'000));
  logged(h, h.user, "ses_pg000001", squat("set_pg000003", 95, 6, t1 + 3'000));
  logged(h, h.user, "ses_pg000001", squat("set_pg000004", 95, 10, t1 + 4'000));
  logged(h, h.user, "ses_pg000001", squat("set_pg000005", 95, 8, t1 + 5'000));
  logged(h, h.user, "ses_pg000001", squat("set_pg000006", -20, 12, t1 + 6'000));
  finished(h, h.user, "ses_pg000001", t1 + 7'000);

  std::vector<SessionSummary> listed = pageOf(h, page(t1 + 100'000, 50));

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
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Harness h;
  const std::uint64_t t1 = 1'700'000'000'123;
  movement(h, h.user, "pg-zercher-squat", "Zercher\nSquat");
  started(h, h.user, "ses_pg000001", t1);
  logged(h, h.user, "ses_pg000001", bench("set_pg000001", 82.5, t1 + 1'000));
  logged(h, h.user, "ses_pg000001", lift("set_pg000002", "pg-zercher-squat", 60.0, 5, t1 + 2'000));

  std::vector<SessionSummary> listed = pageOf(h, page(t1 + 9'000, 50));

  REQUIRE_EQ(listed.size(), static_cast<std::size_t>(1));
  CHECK_EQ(listed[0].setCount, 2);
  CHECK_EQ(listed[0].exerciseNames, (std::vector<std::string>{"Bench Press", "Zercher\nSquat"}));
}

// The prefill read: the most recent FINISHED session wins, warmups are not history, the block is in set_number order.
TEST(pg_gym_last_time_is_the_newest_finished_session_of_that_movement) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Harness h;
  const std::uint64_t t1 = 1'700'000'000'123;
  const Routine day = planned(h, "rt_pg000001", "Bench day", {entryAt(1, "bench-press")});

  started(h, h.user, "ses_pg000001", t1);
  logged(h, h.user, "ses_pg000001", bench("set_pg000001", 80.0, t1 + 1'000));
  finished(h, h.user, "ses_pg000001", t1 + 2'000);

  started(h, h.user, "ses_pg000002", t1 + 10'000, day.id);
  logged(h, h.user, "ses_pg000002", lift("set_pg000002", "bench-press", 40.0, 10, t1 + 11'000, SetKind::warmup));
  const Set top = logged(h, h.user, "ses_pg000002", bench("set_pg000003", 82.5, t1 + 12'000));
  const Set backOff = logged(h, h.user, "ses_pg000002", bench("set_pg000004", 80.0, t1 + 13'000));
  logged(h, h.user, "ses_pg000002", squat("set_pg000005", 100.0, 5, t1 + 14'000));
  finished(h, h.user, "ses_pg000002", t1 + 15'000);

  // Today, live and heavier: an unfinished session is never a last time.
  started(h, h.user, "ses_pg000003", t1 + 20'000);
  logged(h, h.user, "ses_pg000003", bench("set_pg000006", 100.0, t1 + 21'000));
  // And another account's newer, heavier bench, which this caller must never see.
  started(h, h.other, "ses_pg000004", t1 + 30'000);
  logged(h, h.other, "ses_pg000004", bench("set_pg000007", 142.5, t1 + 31'000));
  finished(h, h.other, "ses_pg000004", t1 + 32'000);

  LastTimeOutcome last = h.repo.log.lastTime(h.user, ExerciseId{"bench-press"});

  CHECK(last.error == LastTimeError::none);
  REQUIRE(last.lastTime.has_value());
  CHECK_EQ(last.lastTime->session.id, SessionId{"ses_pg000002"});
  CHECK_EQ(last.lastTime->session.finishedAtMs, std::optional<std::uint64_t>(t1 + 15'000));
  CHECK_EQ(last.lastTime->routineName, std::string("Bench day"));
  REQUIRE_EQ(last.lastTime->sets, (std::vector<Set>{top, backOff}));
  // The warmup is set 1 of that movement, so the block starts at 2: a filter, not a renumbering.
  CHECK_EQ(last.lastTime->sets[0].setNumber, 2);

  // The other account reads its own log, and only that.
  LastTimeOutcome theirs = h.repo.log.lastTime(h.other, ExerciseId{"bench-press"});
  CHECK(theirs.error == LastTimeError::none);
  REQUIRE(theirs.lastTime.has_value());
  CHECK_EQ(theirs.lastTime->session.id, SessionId{"ses_pg000004"});
  CHECK_EQ(theirs.lastTime->routineName, std::string(""));
  REQUIRE_EQ(theirs.lastTime->sets.size(), static_cast<std::size_t>(1));
  CHECK_EQ(theirs.lastTime->sets[0].weightKg, 142.5);
}

// A movement that was only ever warmed up has no last time — the same answer as one never touched.
TEST(pg_gym_last_time_of_a_first_ever_movement_is_empty_and_of_an_unknown_one_is_a_refusal) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Harness h;
  const std::uint64_t t1 = 1'700'000'000'123;
  started(h, h.user, "ses_pg000001", t1);
  logged(h, h.user, "ses_pg000001", squat("set_pg000001", 60.0, 10, t1 + 1'000, SetKind::warmup));
  finished(h, h.user, "ses_pg000001", t1 + 2'000);
  movement(h, h.other, "pg-zercher-squat", "Zercher Squat");

  LastTimeOutcome neverLogged = h.repo.log.lastTime(h.user, ExerciseId{"deadlift"});
  LastTimeOutcome onlyWarmed = h.repo.log.lastTime(h.user, ExerciseId{"back-squat"});
  LastTimeOutcome unknown = h.repo.log.lastTime(h.user, ExerciseId{"pg-no-such-movement"});
  LastTimeOutcome anothersCustom = h.repo.log.lastTime(h.user, ExerciseId{"pg-zercher-squat"});

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
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Harness h;
  const std::uint64_t t1 = 1'700'000'000'123;
  const std::uint64_t day = 86'400'000;

  started(h, h.user, "ses_pg000001", t1);                                                   // a week ago
  logged(h, h.user, "ses_pg000001", bench("set_pg000001", 60.0, t1 + 30 * day));           // stamped 30 days ahead
  finished(h, h.user, "ses_pg000001", t1 + 1'000);
  started(h, h.user, "ses_pg000002", t1 + 6 * day);                                         // yesterday
  const Set honest = logged(h, h.user, "ses_pg000002", bench("set_pg000002", 100.0, t1 + 6 * day + 1'000));
  finished(h, h.user, "ses_pg000002", t1 + 6 * day + 2'000);

  LastTimeOutcome last = h.repo.log.lastTime(h.user, ExerciseId{"bench-press"});
  std::vector<SessionSummary> listed = pageOf(h, page(t1 + 7 * day, 50));

  CHECK(last.error == LastTimeError::none);
  REQUIRE(last.lastTime.has_value());
  CHECK_EQ(last.lastTime->session.id, SessionId{"ses_pg000002"});
  CHECK_EQ(last.lastTime->sets, std::vector<Set>{honest});
  // The two reads sort on the same key, so they can never name a different newest session.
  REQUIRE_EQ(listed.size(), static_cast<std::size_t>(2));
  CHECK_EQ(listed[0].session.id, last.lastTime->session.id);
}

// The session lookup is owner-scoped here rather than transitively through the set row's owner.
TEST(pg_gym_last_time_never_answers_with_a_session_the_caller_does_not_own) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Harness h;
  const std::uint64_t t1 = 1'700'000'000'123;
  const Routine routine = planned(h, "rt_pg000001", "A private routine", {entryAt(1, "bench-press")});
  started(h, h.user, "ses_pg000001", t1, routine.id);
  logged(h, h.user, "ses_pg000001", bench("set_pg000001", 142.5, t1 + 1'000));
  finished(h, h.user, "ses_pg000001", t1 + 2'000);
  // A set row inside the owner's session carrying ANOTHER account's user_id.
  sql("INSERT INTO gym_sets (id, session_id, user_id, exercise_id, set_number, weight_kg, reps, kind, completed_at) "
      "VALUES ($1, 'ses_pg000001', $2::uuid, 'bench-press', 9, 60, 5, 'working', to_timestamp($3::bigint / 1000.0))",
      pqxx::params{"set_pg000009", h.other.str(), static_cast<long long>(t1 + 3'000)});

  LastTimeOutcome theirs = h.repo.log.lastTime(h.other, ExerciseId{"bench-press"});
  LastTimeOutcome ours = h.repo.log.lastTime(h.user, ExerciseId{"bench-press"});

  CHECK(theirs.error == LastTimeError::none);
  CHECK_EQ(theirs.lastTime, std::optional<LastTime>());
  CHECK_EQ(h.repo.log.session(h.other, SessionId{"ses_pg000001"}), std::optional<Session>());
  // The locator's probe filters exactly what the block read filters.
  CHECK(ours.error == LastTimeError::none);
  REQUIRE(ours.lastTime.has_value());
  CHECK_EQ(ours.lastTime->session.id, SessionId{"ses_pg000001"});
  CHECK_EQ(ours.lastTime->routineName, std::string("A private routine"));
  REQUIRE_EQ(ours.lastTime->sets.size(), static_cast<std::size_t>(1));
  CHECK_EQ(ours.lastTime->sets[0].id, SetId{"set_pg000001"});
}

// Against real jsonb, with the blob written STRAIGHT INTO the column: only a string is a routine name.
TEST(pg_gym_last_time_names_the_routine_only_when_the_stored_plan_holds_a_string) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
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
    Harness h;
    started(h, h.user, "ses_pg000001", t1);
    const Set landed = logged(h, h.user, "ses_pg000001", bench("set_pg000001", 82.5, t1 + 1'000));
    finished(h, h.user, "ses_pg000001", t1 + 2'000);
    sql("UPDATE gym_sessions SET plan = nullif($2, '')::jsonb WHERE id = $1", pqxx::params{"ses_pg000001", snapshot});

    LastTimeOutcome last = h.repo.log.lastTime(h.user, ExerciseId{"bench-press"});

    CHECK(last.error == LastTimeError::none);
    REQUIRE(last.lastTime.has_value());
    CHECK_EQ(last.lastTime->routineName, name);
    CHECK_EQ(last.lastTime->sets, std::vector<Set>{landed});
  }
}

// Against real jsonb again: an unreadable set opens ITS line rather than shifting the ladder, and only a non-array `sets` drops a line.
TEST(pg_gym_a_stored_plan_set_that_cannot_be_read_opens_its_line_and_never_shifts_the_ladder) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Harness h;
  const std::uint64_t t1 = 1'700'000'000'123;
  started(h, h.user, "ses_pg000001", t1);
  sql("UPDATE gym_sessions SET plan = $2::jsonb WHERE id = $1",
      pqxx::params{"ses_pg000001",
                   R"({"routine":"Lower A","entries":[)"
                   R"({"exerciseId":"back-squat","sets":[{"reps":5,"weightKg":60},"garbage",{"reps":1,"weightKg":100}],"restSeconds":180},)"
                   R"({"exerciseId":"bench-press","sets":[{"reps":5,"weightKg":60},{"reps":5,"weightKg":900}]},)"
                   R"({"exerciseId":"chin-up","sets":[{"reps":"eight"},{"reps":8}]},)"
                   R"({"exerciseId":"face-pull","sets":3},)"
                   R"({"exerciseId":"barbell-row","sets":[{"reps":8,"weightKg":60},{"reps":8,"weightKg":60}]}]})"});

  std::optional<Session> stored = h.repo.log.session(h.user, SessionId{"ses_pg000001"});

  REQUIRE(stored.has_value());
  CHECK_EQ(stored->plan, std::optional<PlanSnapshot>(PlanSnapshot{
                             "Lower A",
                             {PlanEntry{ExerciseId{"back-squat"}, {}, 180},
                              PlanEntry{ExerciseId{"bench-press"}, {}, std::nullopt},
                              PlanEntry{ExerciseId{"chin-up"}, {}, std::nullopt},
                              PlanEntry{ExerciseId{"barbell-row"}, gym::fake::straight(2, 8, 60.0),
                                        std::nullopt}}}));
}

// The picker's meta against the real DISTINCT ON: the LAST set of lastTime's block, dated by that block's session.
TEST(pg_gym_last_sets_is_the_last_row_of_each_movements_last_time_block) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Harness h;
  const std::uint64_t t1 = 1'700'000'000'123;

  // An older, HEAVIER bench session, so a row that reported the heaviest set would say 100 here.
  started(h, h.user, "ses_pg000001", t1);
  logged(h, h.user, "ses_pg000001", bench("set_pg000001", 100.0, t1 + 1'000));
  finished(h, h.user, "ses_pg000001", t1 + 2'000);

  started(h, h.user, "ses_pg000002", t1 + 10'000);
  logged(h, h.user, "ses_pg000002", lift("set_pg000002", "bench-press", 40.0, 10, t1 + 11'000, SetKind::warmup));
  logged(h, h.user, "ses_pg000002", bench("set_pg000003", 82.5, t1 + 12'000));
  logged(h, h.user, "ses_pg000002", bench("set_pg000004", 80.0, t1 + 13'000));
  // Squatted only as a ramp-up, which is the same silence as never squatting at all.
  logged(h, h.user, "ses_pg000002", squat("set_pg000005", 60.0, 5, t1 + 14'000, SetKind::warmup));
  finished(h, h.user, "ses_pg000002", t1 + 15'000);

  // Today, live and far heavier.
  started(h, h.user, "ses_pg000003", t1 + 20'000);
  logged(h, h.user, "ses_pg000003", bench("set_pg000006", 140.0, t1 + 21'000));

  // And another account's newer, heavier bench.
  started(h, h.other, "ses_pg000004", t1 + 30'000);
  logged(h, h.other, "ses_pg000004", bench("set_pg000007", 142.5, t1 + 31'000));
  finished(h, h.other, "ses_pg000004", t1 + 32'000);

  std::vector<LastSet> ours = h.repo.log.lastSets(h.user);
  std::vector<LastSet> theirs = h.repo.log.lastSets(h.other);

  CHECK_EQ(ours, (std::vector<LastSet>{
                     LastSet{ExerciseId{"bench-press"}, 80.0, 8, t1 + 10'000}}));
  CHECK_EQ(theirs, (std::vector<LastSet>{
                       LastSet{ExerciseId{"bench-press"}, 142.5, 8, t1 + 30'000}}));

  // The claim, stated as an assertion: this IS lastTime's block, projected to its last row.
  LastTimeOutcome block = h.repo.log.lastTime(h.user, ExerciseId{"bench-press"});
  REQUIRE_EQ(ours.size(), static_cast<std::size_t>(1));
  REQUIRE(block.lastTime.has_value());
  REQUIRE(!block.lastTime->sets.empty());
  CHECK_EQ(ours[0].weightKg, block.lastTime->sets.back().weightKg);
  CHECK_EQ(ours[0].reps, block.lastTime->sets.back().reps);
  CHECK_EQ(ours[0].atMs, block.lastTime->session.startedAtMs);
}

// One row per movement, keyed by movement id — the key a picker joins onto its catalog, not the draw order.
TEST(pg_gym_last_sets_carries_one_row_per_movement_ordered_by_id) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Harness h;
  const std::uint64_t t1 = 1'700'000'000'123;

  CHECK(h.repo.log.lastSets(h.user).empty());

  started(h, h.user, "ses_pg000001", t1);
  logged(h, h.user, "ses_pg000001", bench("set_pg000001", 82.5, t1 + 1'000));
  logged(h, h.user, "ses_pg000001", squat("set_pg000002", 120.0, 5, t1 + 2'000));
  finished(h, h.user, "ses_pg000001", t1 + 3'000);

  // A later session squats again, so the two rows are dated by two different workouts.
  started(h, h.user, "ses_pg000002", t1 + 10'000);
  logged(h, h.user, "ses_pg000002", squat("set_pg000003", 125.0, 5, t1 + 11'000));
  finished(h, h.user, "ses_pg000002", t1 + 12'000);

  CHECK_EQ(h.repo.log.lastSets(h.user),
           (std::vector<LastSet>{LastSet{ExerciseId{"back-squat"}, 125.0, 5, t1 + 10'000},
                                 LastSet{ExerciseId{"bench-press"}, 82.5, 8, t1}}));
}

// The plan is the routine frozen at the start, through one codec at both edges, and the name stays a plain string at the top level.
TEST(pg_gym_the_plan_snapshot_round_trips_through_jsonb) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Harness h;
  const std::uint64_t t1 = 1'700'000'000'123;
  const PlanSnapshot frozen{
      "Push A",
      {PlanEntry{ExerciseId{"bench-press"}, gym::fake::straight(5, 5, 82.5), 180},
       PlanEntry{ExerciseId{"back-squat"}, gym::fake::straight(3, 8, std::nullopt), std::nullopt}}};
  const Routine routine = planned(h, "rt_pg000001", "Push A",
      {RoutineEntry{1, ExerciseId{"bench-press"}, gym::fake::straight(5, 5, 82.5), 180},
       RoutineEntry{2, ExerciseId{"back-squat"}, gym::fake::straight(3, 8, std::nullopt), std::nullopt}});

  started(h, h.user, "ses_pg000001", t1, routine.id);
  logged(h, h.user, "ses_pg000001", bench("set_pg000001", 82.5, t1 + 1'000));
  finished(h, h.user, "ses_pg000001", t1 + 2'000);

  std::optional<Session> stored = h.repo.log.session(h.user, SessionId{"ses_pg000001"});
  LastTimeOutcome last = h.repo.log.lastTime(h.user, ExerciseId{"bench-press"});

  REQUIRE(stored.has_value());
  CHECK_EQ(stored->plan, std::optional<PlanSnapshot>(frozen));
  CHECK_EQ(stored->routine, std::optional<RoutineId>(RoutineId{"rt_pg000001"}));
  REQUIRE(last.lastTime.has_value());
  CHECK_EQ(last.lastTime->routineName, std::string("Push A"));
  CHECK_EQ(last.lastTime->session.plan, std::optional<PlanSnapshot>(frozen));
  // An ad-hoc session carries no plan, and no plan is an absence rather than an empty one.
  started(h, h.user, "ses_pg000002", t1 + 10'000);
  CHECK_EQ(h.repo.log.session(h.user, SessionId{"ses_pg000002"}).value().plan, std::optional<PlanSnapshot>());
}

// One row per (movement, load) carrying the BEST reps ever done at it, dated by the EARLIEST SESSION to hit them (domain/Review.h).
TEST(pg_gym_history_marks_the_best_reps_at_each_load_this_session_works) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Harness h;
  const std::uint64_t t1 = 1'700'000'000'000;
  const std::uint64_t week = 604'800'000;

  started(h, h.user, "ses_pg000001", t1 - 2 * week);
  logged(h, h.user, "ses_pg000001", squat("set_pg000001", 100, 8, t1 - 2 * week + 60'000));
  logged(h, h.user, "ses_pg000001", squat("set_pg000002", 100, 8, t1 - 2 * week + 120'000));
  logged(h, h.user, "ses_pg000001", squat("set_pg000003", 100, 5, t1 - 2 * week + 180'000));
  logged(h, h.user, "ses_pg000001", squat("set_pg000004", 90, 10, t1 - 2 * week + 240'000));
  // A warmup is not history, and neither is a movement this session never works.
  logged(h, h.user, "ses_pg000001", squat("set_pg000005", 140, 3, t1 - 2 * week + 30'000, SetKind::warmup));
  logged(h, h.user, "ses_pg000001", bench("set_pg000006", 80, t1 - 2 * week + 300'000));
  finished(h, h.user, "ses_pg000001", t1 - 2 * week + 3'600'000);
  started(h, h.user, "ses_pg000003", t1);
  logged(h, h.user, "ses_pg000003", squat("set_pg000010", 105, 5, t1 + 60'000));
  finished(h, h.user, "ses_pg000003", t1 + 3'600'000);
  // Started last, because only one session is ever open.
  started(h, h.user, "ses_pg000002", t1 - week);
  logged(h, h.user, "ses_pg000002", squat("set_pg000007", 200, 5, t1 - week + 60'000));

  std::optional<Session> reviewed = h.repo.log.session(h.user, SessionId{"ses_pg000003"});
  REQUIRE(reviewed.has_value());
  SessionHistory history = h.repo.log.historyFor(h.user, *reviewed);

  const std::vector<PriorMark> marks{PriorMark{ExerciseId{"back-squat"}, 90, 10, t1 - 2 * week},
                                     PriorMark{ExerciseId{"back-squat"}, 100, 8, t1 - 2 * week}};
  CHECK_EQ(history.marks, marks);
  CHECK_EQ(history.previous, std::optional<Session>());   // no routine, nothing to stand against
  CHECK_EQ(history.previousSets, std::vector<Set>{});
  // Another account reads its own log and no part of this one.
  CHECK_EQ(h.repo.log.historyFor(h.other, *reviewed).marks, std::vector<PriorMark>{});
}

TEST(pg_gym_history_stands_against_the_last_finished_session_of_the_same_routine) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Harness h;
  const std::uint64_t t1 = 1'700'000'000'000;
  const std::uint64_t week = 604'800'000;
  const Routine routine = planned(h, "rt_pg000001", "Push A", {entryAt(1, "bench-press")});

  started(h, h.user, "ses_pg000001", t1 - 2 * week, routine.id);
  logged(h, h.user, "ses_pg000001", squat("set_pg000001", 95, 5, t1 - 2 * week + 60'000));
  finished(h, h.user, "ses_pg000001", t1 - 2 * week + 3'600'000);
  // The same movement a week later with no day of the program behind it: not what this stands against.
  started(h, h.user, "ses_pg000002", t1 - week);
  logged(h, h.user, "ses_pg000002", squat("set_pg000002", 100, 5, t1 - week + 60'000));
  finished(h, h.user, "ses_pg000002", t1 - week + 3'600'000);
  started(h, h.user, "ses_pg000003", t1, routine.id);
  logged(h, h.user, "ses_pg000003", squat("set_pg000003", 105, 5, t1 + 60'000));
  finished(h, h.user, "ses_pg000003", t1 + 3'600'000);

  std::optional<Session> reviewed = h.repo.log.session(h.user, SessionId{"ses_pg000003"});
  REQUIRE(reviewed.has_value());
  SessionHistory history = h.repo.log.historyFor(h.user, *reviewed);

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
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Harness h;
  const std::uint64_t t1 = 1'700'000'000'123;
  started(h, h.user, "ses_pg000001", t1);
  logged(h, h.user, "ses_pg000001", bench("set_pg000001", 82.5, t1 + 1'000));
  logged(h, h.user, "ses_pg000001", bench("set_pg000002", 82.5, t1 + 2'000));
  finished(h, h.user, "ses_pg000001", t1 + 3'000);

  CHECK_EQ(h.door.discard(h.other, SessionId{"ses_pg000001"}), DiscardOutcome::notFound);
  CHECK_EQ(h.door.discard(h.user, SessionId{"ses_pg000001"}), DiscardOutcome::done);
  CHECK_EQ(h.door.discard(h.user, SessionId{"ses_pg000001"}), DiscardOutcome::notFound);

  CHECK_EQ(h.repo.log.session(h.user, SessionId{"ses_pg000001"}), std::optional<Session>());
  CHECK_EQ(h.repo.log.setsOf(SessionId{"ses_pg000001"}), std::vector<Set>{});
  CHECK_EQ(sql("SELECT 1 FROM gym_sets WHERE session_id = $1", pqxx::params{"ses_pg000001"}).size(),
           static_cast<std::size_t>(0));
}

// The fix rewrites the set in place and the version it replaced lands in gym_set_revisions unmarked.
TEST(pg_gym_a_correction_rewrites_the_set_in_place_and_keeps_what_it_replaced) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Harness h;
  const std::uint64_t t1 = 1'700'000'000'123;
  started(h, h.user, "ses_pg000001", t1);
  logged(h, h.user, "ses_pg000001", SetWrite{SetId{"set_pg000001"}, ExerciseId{"bench-press"}, 82.5, 8,
                                             SetKind::working, 8.5, "felt heavy", t1 + 1'000});

  fixed(h, "set_pg000001", sync::parseJson(R"({"weightKg":47.5,"reps":4,"kind":"drop","rpe":null})"));

  const Set rewritten{SetId{"set_pg000001"}, SessionId{"ses_pg000001"}, ExerciseId{"bench-press"}, 1, 47.5, 4,
                      SetKind::drop, std::nullopt, "felt heavy", t1 + 1'000};
  CHECK_EQ(h.repo.log.setOf(h.user, SetId{"set_pg000001"}), std::optional<Set>(rewritten));
  CHECK_EQ(h.repo.log.setsOf(SessionId{"ses_pg000001"}), std::vector<Set>{rewritten});
  const pqxx::result kept = sql(
      "SELECT set_id, session_id, user_id::text, exercise_id, set_number, weight_kg::float8, "
      "reps, kind, rpe::float8, note, deleted FROM gym_set_revisions WHERE set_id = $1",
      pqxx::params{"set_pg000001"});
  REQUIRE_EQ(kept.size(), static_cast<std::size_t>(1));
  CHECK_EQ(kept[0][0].as<std::string>(), std::string("set_pg000001"));
  CHECK_EQ(kept[0][1].as<std::string>(), std::string("ses_pg000001"));
  CHECK_EQ(kept[0][2].as<std::string>(), h.user.str());
  CHECK_EQ(kept[0][3].as<std::string>(), std::string("bench-press"));
  CHECK_EQ(kept[0][4].as<int>(), 1);
  CHECK_EQ(kept[0][5].as<double>(), 82.5);
  CHECK_EQ(kept[0][6].as<int>(), 8);
  CHECK_EQ(kept[0][7].as<std::string>(), std::string("working"));
  CHECK_EQ(kept[0][8].as<double>(), 8.5);
  CHECK_EQ(kept[0][9].as<std::string>(), std::string("felt heavy"));
  CHECK_FALSE(kept[0][10].as<bool>());
}

// A fix that never names the note leaves the lifter's word standing, and an empty note is the CLEAR — stored as '', never null.
TEST(pg_gym_a_correction_leaves_a_note_it_does_not_name_and_stores_an_empty_one_as_the_clear) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Harness h;
  const std::uint64_t t1 = 1'700'000'000'123;
  started(h, h.user, "ses_pg000001", t1);
  logged(h, h.user, "ses_pg000001", SetWrite{SetId{"set_pg000001"}, ExerciseId{"bench-press"}, 82.5, 8,
                                             SetKind::working, 8.5, "felt heavy", t1 + 1'000});

  fixed(h, "set_pg000001", sync::parseJson(R"({"rpe":7.5})"));
  CHECK_EQ(h.repo.log.setOf(h.user, SetId{"set_pg000001"}),
           std::optional<Set>(Set{SetId{"set_pg000001"}, SessionId{"ses_pg000001"}, ExerciseId{"bench-press"}, 1, 82.5,
                                  8, SetKind::working, 7.5, "felt heavy", t1 + 1'000}));

  fixed(h, "set_pg000001", sync::parseJson(R"({"note":""})"));
  // The clear named the note alone.
  CHECK_EQ(h.repo.log.setOf(h.user, SetId{"set_pg000001"}),
           std::optional<Set>(Set{SetId{"set_pg000001"}, SessionId{"ses_pg000001"}, ExerciseId{"bench-press"}, 1, 82.5,
                                  8, SetKind::working, 7.5, "", t1 + 1'000}));
  const pqxx::result row = sql("SELECT note, note IS NULL, rpe::float8 FROM gym_sets WHERE id = $1", pqxx::params{"set_pg000001"});
  REQUIRE_EQ(row.size(), static_cast<std::size_t>(1));
  CHECK_EQ(row[0][0].as<std::string>(), std::string(""));
  CHECK_FALSE(row[0][1].as<bool>());
  CHECK_EQ(row[0][2].as<double>(), 7.5);
}

// The ceiling is 4000 BYTES and the column hands back whole what the engine admitted (this note is 3999 characters).
TEST(pg_gym_a_four_thousand_byte_note_survives_the_column_whole) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Harness h;
  const std::uint64_t t1 = 1'700'000'000'123;
  started(h, h.user, "ses_pg000001", t1);
  logged(h, h.user, "ses_pg000001", bench("set_pg000001", 82.5, t1 + 1'000));

  const std::string atTheBound = std::string(kMaxSetNoteBytes - 2, 'x') + "\xC3\xA9";
  Json::Value note(Json::objectValue);
  note["note"] = atTheBound;
  fixed(h, "set_pg000001", note);

  CHECK_EQ(h.repo.log.setOf(h.user, SetId{"set_pg000001"}),
           std::optional<Set>(Set{SetId{"set_pg000001"}, SessionId{"ses_pg000001"}, ExerciseId{"bench-press"}, 1, 82.5,
                                  8, SetKind::working, std::nullopt, atTheBound, t1 + 1'000}));
  CHECK_EQ(atTheBound.size(), static_cast<std::size_t>(4000));
  const pqxx::result row = sql("SELECT octet_length(note), char_length(note) FROM gym_sets WHERE id = $1",
                               pqxx::params{"set_pg000001"});
  REQUIRE_EQ(row.size(), static_cast<std::size_t>(1));
  CHECK_EQ(row[0][0].as<int>(), 4000);
  CHECK_EQ(row[0][1].as<int>(), 3999);
}

// ONE decimal: a phone's half steps cross unchanged and a finer one is refused; an agent's finer one is rounded at the door.
TEST(pg_gym_the_rpe_column_keeps_one_decimal_and_the_reply_carries_what_it_kept) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Harness h;
  const std::uint64_t t1 = 1'700'000'000'123;
  started(h, h.user, "ses_pg000001", t1);
  logged(h, h.user, "ses_pg000001", bench("set_pg000001", 82.5, t1 + 1'000));

  for (double rated : {6.0, 6.5, 7.0, 7.5, 8.0, 8.5, 9.0, 9.5, 10.0}) {
    Json::Value fix(Json::objectValue);
    fix["rpe"] = rated;
    fixed(h, "set_pg000001", fix);
    CHECK_EQ(h.repo.log.setOf(h.user, SetId{"set_pg000001"}).value().rpe, std::optional<double>(rated));
  }

  CHECK_EQ(GymDoor::refusal(h.admit(h.user, {GymDoor::delta("set", "set_pg000001", sync::parseJson(R"({"rpe":8.25})"))})),
           "invalid");
  CHECK_EQ(h.repo.log.setOf(h.user, SetId{"set_pg000001"}).value().rpe, std::optional<double>(10.0));
  SetWrite finer = bench("set_pg000002", 82.5, t1 + 2'000);
  finer.rpe = 8.25;
  CHECK_EQ(logged(h, h.user, "ses_pg000001", finer).rpe, std::optional<double>(8.3));

  fixed(h, "set_pg000001", sync::parseJson(R"({"rpe":null})"));
  CHECK_EQ(h.repo.log.setOf(h.user, SetId{"set_pg000001"}).value().rpe, std::optional<double>());
  const pqxx::result row = sql("SELECT rpe IS NULL FROM gym_sets WHERE id = $1", pqxx::params{"set_pg000001"});
  REQUIRE_EQ(row.size(), static_cast<std::size_t>(1));
  CHECK(row[0][0].as<bool>());
}

// Another account's fix of this set is refused whole: the id is not theirs, and nothing is written.
TEST(pg_gym_a_correction_reaches_no_set_of_another_account) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Harness h;
  const std::uint64_t t1 = 1'700'000'000'123;
  started(h, h.user, "ses_pg000001", t1);
  const Set stored = logged(h, h.user, "ses_pg000001", bench("set_pg000001", 82.5, t1 + 1'000));

  CHECK_EQ(GymDoor::refusal(h.admit(h.other, {GymDoor::delta("set", "set_pg000001", sync::parseJson(R"({"weightKg":60})"))})),
           "unknown-record");
  CHECK_EQ(h.repo.log.setOf(h.user, SetId{"set_pg000001"}), std::optional<Set>(stored));
  CHECK_EQ(sql("SELECT 1 FROM gym_set_revisions WHERE user_id = $1::uuid", pqxx::params{h.user.str()}).size(),
           static_cast<std::size_t>(0));
}

// The delete moves the row WHOLE into the revisions, silent however often and by whom; the next set numbers on from the highest standing.
TEST(pg_gym_a_delete_moves_the_row_into_the_revisions_and_never_reuses_its_number) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Harness h;
  const std::uint64_t t1 = 1'700'000'000'123;
  started(h, h.user, "ses_pg000001", t1);
  logged(h, h.user, "ses_pg000001", bench("set_pg000001", 80.0, t1 + 1'000));
  logged(h, h.user, "ses_pg000001", bench("set_pg000002", 82.5, t1 + 2'000));
  logged(h, h.user, "ses_pg000001", bench("set_pg000003", 85.0, t1 + 3'000));

  h.kill(h.user, "set", "set_pg000002");
  h.kill(h.user, "set", "set_pg000002");
  h.kill(h.other, "set", "set_pg000003");
  const Set next = logged(h, h.user, "ses_pg000001", bench("set_pg000004", 87.5, t1 + 4'000));

  CHECK_EQ(next.setNumber, 4);
  CHECK_EQ(numbersOf(h, "ses_pg000001"), (std::vector<int>{1, 3, 4}));
  const pqxx::result kept = sql("SELECT set_id, set_number, weight_kg::float8, deleted FROM gym_set_revisions "
                                "WHERE user_id = $1::uuid ORDER BY revision_id",
                                pqxx::params{h.user.str()});
  REQUIRE_EQ(kept.size(), static_cast<std::size_t>(1));
  CHECK_EQ(kept[0][0].as<std::string>(), std::string("set_pg000002"));
  CHECK_EQ(kept[0][1].as<int>(), 2);
  CHECK_EQ(kept[0][2].as<double>(), 82.5);
  CHECK(kept[0][3].as<bool>());
}

// A replayed append of a deleted set answers `deleted`, not `idTaken`, whatever its body and however the workout ended.
TEST(pg_gym_a_deleted_sets_id_is_spent_for_good_and_a_replayed_append_cannot_bring_it_back) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Harness h;
  const std::uint64_t t1 = 1'700'000'000'123;
  started(h, h.user, "ses_pg000001", t1);
  logged(h, h.user, "ses_pg000001", bench("set_pg000001", 80.0, t1 + 1'000));
  logged(h, h.user, "ses_pg000001", bench("set_pg000002", 82.5, t1 + 2'000));
  logged(h, h.user, "ses_pg000001", bench("set_pg000003", 85.0, t1 + 3'000));
  h.kill(h.user, "set", "set_pg000002");

  // The queue's own bytes, re-sent: same id, same values, same session.
  const AppendOutcome replayed = h.door.append(h.user, SessionId{"ses_pg000001"}, bench("set_pg000002", 82.5, t1 + 2'000));
  CHECK_EQ(replayed.set, std::optional<Set>());
  CHECK(replayed.error == AppendError::deleted);
  // And it is refused whatever else the caller changes about the body, because the ID is the fact.
  CHECK(h.door.append(h.user, SessionId{"ses_pg000001"}, bench("set_pg000002", 60.0, t1 + 9'000)).error ==
        AppendError::deleted);

  std::vector<std::string> live;
  for (const Set& set : h.repo.log.setsOf(SessionId{"ses_pg000001"})) live.push_back(set.id.str());
  CHECK_EQ(live, (std::vector<std::string>{"set_pg000001", "set_pg000003"}));
  // One kept row, still the deleted one — a refused append writes nothing anywhere.
  CHECK_EQ(sql("SELECT 1 FROM gym_set_revisions WHERE user_id = $1::uuid", pqxx::params{h.user.str()}).size(),
           static_cast<std::size_t>(1));
  // A closed workout does not change the answer, and does not get to answer FIRST.
  finished(h, h.user, "ses_pg000001", t1 + 5'000);
  CHECK(h.door.append(h.user, SessionId{"ses_pg000001"}, bench("set_pg000002", 82.5, t1 + 2'000)).error ==
        AppendError::deleted);
}

// A deleted id stays spent globally without exposing another account's deletion.
TEST(pg_gym_a_deleted_id_is_spent_globally_with_owner_scoped_refusals) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Harness h;
  const std::uint64_t t1 = 1'700'000'000'123;
  started(h, h.user, "ses_pg000001", t1);
  logged(h, h.user, "ses_pg000001", bench("set_pg000001", 80.0, t1 + 1'000));
  h.kill(h.user, "set", "set_pg000001");
  finished(h, h.user, "ses_pg000001", t1 + 2'000);
  started(h, h.user, "ses_pg000002", t1 + 10'000);
  started(h, h.other, "ses_pg000003", t1 + 10'000);

  // The same account, a different workout: still spent.
  CHECK(h.door.append(h.user, SessionId{"ses_pg000002"}, bench("set_pg000001", 80.0, t1 + 11'000)).error ==
        AppendError::deleted);
  // Another account receives the generic collision refusal, never the deletion detail.
  const AppendOutcome landed = h.door.append(h.other, SessionId{"ses_pg000003"},
      lift("set_pg000001", "bench-press", 60.0, 5, t1 + 11'000));
  CHECK_FALSE(landed.set.has_value());
  CHECK(landed.error == AppendError::idTaken);
}

// Neither a fix nor a delete goes near the session's plan or a routine entry, and the live reads move exactly as far as the fix did.
TEST(pg_gym_fixing_and_deleting_a_set_leave_the_frozen_plan_and_the_routine_untouched) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Harness h;
  const std::uint64_t t1 = 1'700'000'000'123;
  const Routine routine = planned(h, "rt_pg000001", "Push A", {entryAt(1, "bench-press")});
  started(h, h.user, "ses_pg000001", t1, routine.id);
  logged(h, h.user, "ses_pg000001", bench("set_pg000001", 82.5, t1 + 1'000));
  logged(h, h.user, "ses_pg000001", bench("set_pg000002", 82.5, t1 + 2'000));

  fixed(h, "set_pg000001", sync::parseJson(R"({"weightKg":60,"reps":3})"));
  h.kill(h.user, "set", "set_pg000002");

  std::optional<Session> after = h.repo.log.session(h.user, SessionId{"ses_pg000001"});
  REQUIRE(after.has_value());
  CHECK_EQ(after->plan, std::optional<PlanSnapshot>(pushA()));
  CHECK_EQ(after->routine, std::optional<RoutineId>(RoutineId{"rt_pg000001"}));
  std::optional<Routine> plan = h.repo.program.routine(h.user, RoutineId{"rt_pg000001"});
  REQUIRE(plan.has_value());
  CHECK_EQ(plan->entries, std::vector<RoutineEntry>{entryAt(1, "bench-press")});
  CHECK_EQ(plan->name, std::string("Push A"));
  std::vector<SessionSummary> rows = pageOf(h, page(t1 + 10'000, 10));
  REQUIRE_EQ(rows.size(), static_cast<std::size_t>(1));
  CHECK_EQ(rows[0].setCount, 1);
  CHECK_EQ(rows[0].tonnageKg, 180.0);
  CHECK_EQ(rows[0].topSet, std::optional<TopWorkingSet>(TopWorkingSet{60, 3}));
}

// The discard reaches the revisions too: session_id carries a cascading foreign key and set_id carries none.
TEST(pg_gym_discarding_a_session_takes_its_revisions_with_it) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Harness h;
  const std::uint64_t t1 = 1'700'000'000'123;
  started(h, h.user, "ses_pg000001", t1);
  logged(h, h.user, "ses_pg000001", bench("set_pg000001", 82.5, t1 + 1'000));
  logged(h, h.user, "ses_pg000001", bench("set_pg000002", 85.0, t1 + 2'000));
  fixed(h, "set_pg000001", sync::parseJson(R"({"weightKg":60})"));
  h.kill(h.user, "set", "set_pg000002");
  finished(h, h.user, "ses_pg000001", t1 + 3'000);
  const pqxx::result kept = sql("SELECT set_id, weight_kg::float8, deleted FROM gym_set_revisions "
                                "WHERE user_id = $1::uuid ORDER BY revision_id",
                                pqxx::params{h.user.str()});
  REQUIRE_EQ(kept.size(), static_cast<std::size_t>(2));
  CHECK_EQ(kept[0][0].as<std::string>(), std::string("set_pg000001"));
  CHECK_EQ(kept[0][1].as<double>(), 82.5);
  CHECK_FALSE(kept[0][2].as<bool>());
  CHECK_EQ(kept[1][0].as<std::string>(), std::string("set_pg000002"));
  CHECK_EQ(kept[1][1].as<double>(), 85.0);
  CHECK(kept[1][2].as<bool>());

  REQUIRE_EQ(h.door.discard(h.user, SessionId{"ses_pg000001"}), DiscardOutcome::done);

  CHECK_EQ(sql("SELECT 1 FROM gym_set_revisions WHERE user_id = $1::uuid", pqxx::params{h.user.str()}).size(),
           static_cast<std::size_t>(0));
}

// A row written before the instant band was enforced is clamped into the band rather than failing the conversion.
TEST(pg_gym_reads_a_pre_1970_legacy_row_instead_of_failing_the_whole_log) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Harness h;
  const std::uint64_t t1 = 1'700'000'000'123;
  started(h, h.user, "ses_pg000001", t1);
  sql("INSERT INTO gym_sessions (id, user_id, started_at, finished_at) "
      "VALUES ('ses_pg000002', $1::uuid, to_timestamp(-1), to_timestamp(-1))",
      pqxx::params{h.user.str()});

  std::vector<SessionSummary> listed = pageOf(h, page(t1 + 9'000, 50));

  REQUIRE_EQ(listed.size(), static_cast<std::size_t>(2));
  CHECK_EQ(listed[0].session.id.str(), std::string("ses_pg000001"));
  CHECK_EQ(listed[1].session.id.str(), std::string("ses_pg000002"));
  CHECK_EQ(listed[1].session.startedAtMs, static_cast<std::uint64_t>(1));
  CHECK_EQ(listed[1].session.finishedAtMs, std::optional<std::uint64_t>(1));
  CHECK_EQ(h.repo.log.session(h.user, SessionId{"ses_pg000002"}).value().startedAtMs, static_cast<std::uint64_t>(1));
}

// One point per (movement, session), one mark per (movement, load), and the weekly counts. No Epley in the SQL.
TEST(pg_gym_statistics_is_the_top_set_per_session_the_marks_and_the_weekly_counts) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Harness h;
  const std::uint64_t t1 = 1'700'000'000'000;
  const std::uint64_t week = 604'800'000;

  started(h, h.user, "ses_pg000001", t1);
  logged(h, h.user, "ses_pg000001", squat("set_pg000001", 100, 5, t1 + 60'000));
  logged(h, h.user, "ses_pg000001", squat("set_pg000002", 110, 2, t1 + 120'000));
  logged(h, h.user, "ses_pg000001", squat("set_pg000003", 60, 10, t1 + 180'000, SetKind::warmup));
  finished(h, h.user, "ses_pg000001", t1 + 3'600'000);
  started(h, h.user, "ses_pg000002", t1 + week);
  logged(h, h.user, "ses_pg000002", squat("set_pg000004", 105, 5, t1 + week + 60'000));
  finished(h, h.user, "ses_pg000002", t1 + week + 3'600'000);

  TrainingLog log = h.repo.log.trainingLog(h.user);

  // The heaviest working set, ties to more reps; the warmup counts toward nothing.
  CHECK_EQ(log.tops, (std::vector<MovementTop>{MovementTop{ExerciseId{"back-squat"}, t1, 110, 2},
                                               MovementTop{ExerciseId{"back-squat"}, t1 + week, 105, 5}}));
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
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Harness h;
  const std::uint64_t t1 = 1'700'000'000'000;
  const std::uint64_t week = 604'800'000;

  started(h, h.user, "ses_pg000001", t1);
  logged(h, h.user, "ses_pg000001", squat("set_pg000001", 100, 5, t1 + 60'000));
  finished(h, h.user, "ses_pg000001", t1 + 3'600'000);
  started(h, h.user, "ses_pg000002", t1 + 2 * week);
  logged(h, h.user, "ses_pg000002", squat("set_pg000002", 105, 5, t1 + 2 * week + 60'000));
  finished(h, h.user, "ses_pg000002", t1 + 2 * week + 3'600'000);

  TrainingLog log = h.repo.log.trainingLog(h.user);

  CHECK_EQ(log.weeks, (std::vector<TrainingWeek>{
                          TrainingWeek{1'699'833'600'000, 1, 1},
                          TrainingWeek{1'699'833'600'000 + week, 0, 0},
                          TrainingWeek{1'699'833'600'000 + 2 * week, 1, 1}}));
}

TEST(pg_gym_statistics_leaves_the_open_session_and_another_account_out) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Harness h;
  const std::uint64_t t1 = 1'700'000'000'000;

  started(h, h.user, "ses_pg000001", t1);   // today's workout, never closed
  logged(h, h.user, "ses_pg000001", squat("set_pg000001", 100, 5, t1 + 60'000));
  started(h, h.other, "ses_pg000003", t1);
  logged(h, h.other, "ses_pg000003", squat("set_pg000003", 200, 5, t1 + 60'000));
  finished(h, h.other, "ses_pg000003", t1 + 3'600'000);

  TrainingLog log = h.repo.log.trainingLog(h.user);

  CHECK(log.tops.empty());
  CHECK(log.marks.empty());
  CHECK(log.weeks.empty());
}

TEST(pg_gym_share_is_idempotent_on_the_session_and_replaces_one_that_has_ended) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Harness h;
  const std::uint64_t now = 1'700'000'000'000;
  started(h, h.user, "ses_pg000001", now);
  finished(h, h.user, "ses_pg000001", now + 3'600'000);

  std::optional<SessionShare> first = h.repo.log.insertShare(
      SessionShare{SessionId{"ses_pg000001"}, h.user, "pg-tok-one", now + kShareLifetimeMs}, now);
  std::optional<SessionShare> again = h.repo.log.insertShare(
      SessionShare{SessionId{"ses_pg000001"}, h.user, "pg-tok-two", now + kShareLifetimeMs}, now);

  REQUIRE(first);
  REQUIRE(again);
  CHECK_EQ(first->token, std::string("pg-tok-one"));
  CHECK_EQ(again->token, std::string("pg-tok-one"));   // the live link, not a second capability
  CHECK_EQ(again->expiresAtMs, now + kShareLifetimeMs);

  // A month later the row has ended, and re-sharing mints a NEW capability rather than reviving it.
  const std::uint64_t later = now + kShareLifetimeMs + 1;
  std::optional<SessionShare> minted = h.repo.log.insertShare(
      SessionShare{SessionId{"ses_pg000001"}, h.user, "pg-tok-three", later + kShareLifetimeMs}, later);
  REQUIRE(minted);
  CHECK_EQ(minted->token, std::string("pg-tok-three"));
  CHECK_EQ(minted->expiresAtMs, later + kShareLifetimeMs);
  CHECK_FALSE(h.repo.log.sharedSession("pg-tok-one", later));
}

TEST(pg_gym_share_never_reaches_an_absent_or_another_accounts_session) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Harness h;
  const std::uint64_t now = 1'700'000'000'000;
  started(h, h.other, "ses_pg000003", now);
  finished(h, h.other, "ses_pg000003", now + 3'600'000);

  CHECK_FALSE(h.repo.log.insertShare(SessionShare{SessionId{"ses_pg000009"}, h.user, "pg-a", now + kShareLifetimeMs}, now));
  CHECK_FALSE(h.repo.log.insertShare(SessionShare{SessionId{"ses_pg000003"}, h.user, "pg-b", now + kShareLifetimeMs}, now));
  CHECK_FALSE(h.repo.log.revokeShare(h.user, SessionId{"ses_pg000003"}));
  CHECK_FALSE(h.repo.log.sharedSession("pg-a", now));
  CHECK_FALSE(h.repo.log.sharedSession("pg-b", now));
}

TEST(pg_gym_shared_session_answers_one_workout_and_nothing_about_the_account) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Harness h;
  const std::uint64_t now = 1'700'000'000'000;
  const Routine routine = planned(h, "rt_pg000001", "Push A", {entryAt(1, "bench-press")});
  started(h, h.user, "ses_pg000001", now, routine.id);
  logged(h, h.user, "ses_pg000001", squat("set_pg000001", 100, 5, now + 60'000));
  logged(h, h.user, "ses_pg000001", squat("set_pg000002", 110, 2, now + 120'000));
  finished(h, h.user, "ses_pg000001", now + 3'600'000);
  h.repo.log.insertShare(SessionShare{SessionId{"ses_pg000001"}, h.user, "pg-tok-live", now + kShareLifetimeMs}, now);

  std::optional<SharedSession> read = h.repo.log.sharedSession("pg-tok-live", now + 1);

  REQUIRE(read);
  CHECK_EQ(read->startedAtMs, now);
  CHECK_EQ(read->finishedAtMs, std::optional<std::uint64_t>(now + 3'600'000));
  // The name off the session's OWN frozen snapshot, never off a routine as it is called today.
  CHECK_EQ(read->routineName, std::string("Push A"));
  CHECK_EQ(read->sets,
           (std::vector<SharedSet>{
               SharedSet{"Back Squat", 1, 100, 5, SetKind::working, std::nullopt, "", now + 60'000},
               SharedSet{"Back Squat", 2, 110, 2, SetKind::working, std::nullopt, "", now + 120'000}}));

  // Expired, unknown and revoked are one answer, and the end is not inclusive.
  CHECK_FALSE(h.repo.log.sharedSession("pg-tok-live", now + kShareLifetimeMs));
  CHECK_FALSE(h.repo.log.sharedSession("nobody-minted-this", now + 1));
  CHECK(h.repo.log.revokeShare(h.user, SessionId{"ses_pg000001"}));
  CHECK_FALSE(h.repo.log.sharedSession("pg-tok-live", now + 1));
}

// The share goes with the workout: `on delete cascade` leaves no live link to a session that is gone.
TEST(pg_gym_discarding_a_session_takes_its_share_with_it) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Harness h;
  const std::uint64_t now = 1'700'000'000'000;
  started(h, h.user, "ses_pg000001", now);
  finished(h, h.user, "ses_pg000001", now + 3'600'000);
  h.repo.log.insertShare(SessionShare{SessionId{"ses_pg000001"}, h.user, "pg-tok-doomed", now + kShareLifetimeMs}, now);
  CHECK(h.repo.log.sharedSession("pg-tok-doomed", now + 1));

  CHECK_EQ(h.door.discard(h.user, SessionId{"ses_pg000001"}), DiscardOutcome::done);

  CHECK_FALSE(h.repo.log.sharedSession("pg-tok-doomed", now + 1));
}

// The marks standing BEFORE a page: every finished session older than the page's last row, narrowed to its movements.
TEST(pg_gym_log_hands_over_the_marks_standing_before_the_page) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Harness h;
  const std::uint64_t t1 = 1'700'000'000'000;
  const std::uint64_t day = 86'400'000;

  started(h, h.user, "ses_pg000001", t1);
  logged(h, h.user, "ses_pg000001", squat("set_pg000001", 100, 5, t1 + 1'000));
  logged(h, h.user, "ses_pg000001", bench("set_pg000002", 80.0, t1 + 2'000));
  finished(h, h.user, "ses_pg000001", t1 + 3'000);
  started(h, h.user, "ses_pg000002", t1 + day);
  logged(h, h.user, "ses_pg000002", squat("set_pg000003", 105, 5, t1 + day + 1'000));
  finished(h, h.user, "ses_pg000002", t1 + day + 2'000);

  const LogPage newest = h.repo.log.log(h.user, page(t1 + 2 * day, 1));
  const LogPage whole = h.repo.log.log(h.user, page(t1 + 2 * day, 50));

  // The squat mark this page has to beat comes back beside it; the BENCH mark does not.
  REQUIRE_EQ(newest.sessions.size(), static_cast<std::size_t>(1));
  CHECK_EQ(newest.standing, (std::vector<PriorMark>{PriorMark{ExerciseId{"back-squat"}, 100.0, 5, t1}}));
  // The whole log on one page: nothing was finished before its oldest row, so nothing stands.
  REQUIRE_EQ(whole.sessions.size(), static_cast<std::size_t>(2));
  CHECK_EQ(whole.standing, std::vector<PriorMark>{});
}

// The two windows differ on purpose: a page carries the OPEN workout as a row, while the standing marks count FINISHED sessions alone.
TEST(pg_gym_log_lists_the_open_session_and_never_lets_its_marks_stand_before_a_page) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Harness h;
  const std::uint64_t t1 = 1'700'000'000'000;
  const std::uint64_t day = 86'400'000;

  started(h, h.user, "ses_pg000001", t1);
  logged(h, h.user, "ses_pg000001", squat("set_pg000001", 100, 5, t1 + 1'000));
  finished(h, h.user, "ses_pg000001", t1 + 2'000);
  started(h, h.user, "ses_pg000002", t1 + day);   // still running, and the heavier day
  logged(h, h.user, "ses_pg000002", squat("set_pg000002", 110, 5, t1 + day + 1'000));

  const LogPage newest = h.repo.log.log(h.user, page(t1 + 2 * day, 1));
  const LogPage whole = h.repo.log.log(h.user, page(t1 + 2 * day, 50));

  // The open workout is the newest row, and what stands before it is the finished day alone.
  REQUIRE_EQ(newest.sessions.size(), static_cast<std::size_t>(1));
  CHECK_EQ(newest.sessions[0].session.id, SessionId{"ses_pg000002"});
  CHECK_EQ(newest.sessions[0].session.finishedAtMs, std::optional<std::uint64_t>());
  CHECK_EQ(newest.standing, (std::vector<PriorMark>{PriorMark{ExerciseId{"back-squat"}, 100.0, 5, t1}}));
  // Both rows on one page: the open one's 110 × 5 is a mark of the PAGE and never a standing one.
  REQUIRE_EQ(whole.sessions.size(), static_cast<std::size_t>(2));
  CHECK_EQ(whole.sessions[0].workingMarks,
           (std::vector<PriorMark>{PriorMark{ExerciseId{"back-squat"}, 110.0, 5, t1 + day}}));
  CHECK_EQ(whole.standing, std::vector<PriorMark>{});
}

// One ladder per FINISHED session oldest first, the routines naming the movement once each, then the recent days.
TEST(pg_gym_movement_history_is_a_ladder_per_finished_session_the_routines_and_the_recent_days) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Harness h;
  const std::uint64_t t1 = 1'700'000'000'000;
  const std::uint64_t day = 86'400'000;
  // The same movement twice in one routine — heavy, then a back-off — is still ONE routine.
  planned(h, "rt_pg000001", "Legs", {entryAt(1, "back-squat"), entryAt(2, "back-squat")});

  started(h, h.user, "ses_pg000001", t1);
  logged(h, h.user, "ses_pg000001", squat("set_pg000001", 60, 10, t1 + 1'000, SetKind::warmup));
  logged(h, h.user, "ses_pg000001", squat("set_pg000002", 100, 5, t1 + 2'000));
  logged(h, h.user, "ses_pg000001", squat("set_pg000003", 95, 10, t1 + 3'000));
  finished(h, h.user, "ses_pg000001", t1 + 4'000);
  started(h, h.user, "ses_pg000002", t1 + day);   // still open: not history yet

  const MovementHistory history = h.repo.log.movementHistory(h.user, ExerciseId{"back-squat"});

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
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Harness h;
  movement(h, h.other, "ex_pg000002", "Theirs");

  CHECK_EQ(h.repo.log.movementHistory(h.user, ExerciseId{"ex_pg000002"}).exercise, std::optional<Exercise>());
  CHECK_EQ(h.repo.log.movementHistory(h.user, ExerciseId{"no-such"}).exercise, std::optional<Exercise>());
  // A movement in the catalog nobody has lifted is the OTHER answer: present, with nothing in it.
  const MovementHistory never = h.repo.log.movementHistory(h.user, ExerciseId{"back-squat"});
  REQUIRE(never.exercise.has_value());
  CHECK(never.routines.empty());
  CHECK(never.sessions.empty());
  CHECK(never.recent.empty());
}

TEST(pg_gym_set_batch_rolls_back_rows_and_receipts_on_an_invalid_last_exercise) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Harness h;
  const std::uint64_t now = 1'700'000'000'000;
  started(h, h.user, "ses_batch001", now);
  h.clock.now = now + 3'000;
  const SetWrite first = bench("set_batch001", 80, now + 1'000);
  SetWrite last = bench("set_batch002", 82.5, now + 2'000);
  last.exercise = ExerciseId{"missing"};
  const auto rejected = h.door.appendSets(h.user, SessionId{"ses_batch001"}, {first, last});
  CHECK(rejected.error == BatchLogError::unknownExercise);
  CHECK_EQ(rejected.errorIndex, std::optional<std::size_t>{1});
  CHECK(h.repo.log.setsOf(SessionId{"ses_batch001"}).empty());
  CHECK_EQ(sql("SELECT count(*) FROM gym_write_receipts WHERE user_id=$1::uuid AND kind='set'",
               pqxx::params{h.user.str()})[0][0].as<int>(), 0);
  last.exercise = ExerciseId{"bench-press"};
  const auto created = h.door.appendSets(h.user, SessionId{"ses_batch001"}, {first, last});
  CHECK(created.error == BatchLogError::none);
  REQUIRE_EQ(created.sets.size(), 2u);
  REQUIRE(created.sets[0].current.has_value());
  REQUIRE(created.sets[1].current.has_value());
  CHECK_EQ(created.sets[0].current->setNumber, 1);
  CHECK_EQ(created.sets[1].current->setNumber, 2);
  fixed(h, "set_batch001", sync::parseJson(R"({"reps":3})"));
  h.kill(h.user, "set", "set_batch002");
  const auto replay = h.door.appendSets(h.user, SessionId{"ses_batch001"}, {first, last});
  CHECK(replay.replayed);
  REQUIRE_EQ(replay.sets.size(), 2u);
  REQUIRE(replay.sets[0].current.has_value());
  CHECK_EQ(replay.sets[0].current->reps, 3);
  CHECK_FALSE(replay.sets[1].current.has_value());
  SetWrite changed = first;
  changed.reps = 3;
  CHECK(h.door.appendSets(h.user, SessionId{"ses_batch001"}, {changed, last}).error == BatchLogError::payloadConflict);
}

TEST(pg_gym_completed_import_is_atomic_retry_safe_and_cannot_be_recreated_through_single_writes) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Harness h;
  const std::uint64_t now = 1'700'000'000'000;
  const Session live = started(h, h.user, "ses_live0001", now);
  const SetWrite first = bench("set_import01", 80, now - 5'000);
  SetWrite bad = bench("set_import02", 80, now - 4'000);
  bad.exercise = ExerciseId{"absent"};
  const SessionImport rejected{SessionId{"ses_import01"}, now - 10'000, now - 1'000, std::nullopt, {first, bad}};
  CHECK(h.door.importSession(h.user, rejected).error == BatchLogError::unknownExercise);
  CHECK_FALSE(h.repo.log.session(h.user, SessionId{"ses_import01"}).has_value());
  const SessionImport imported{SessionId{"ses_import01"}, now - 10'000, now - 1'000, std::nullopt, {first}};
  CHECK(h.door.importSession(h.user, imported).error == BatchLogError::none);
  CHECK_EQ(h.repo.log.open(h.user), std::optional<Session>{live});
  CHECK(h.door.importSession(h.user, imported).replayed);
  CHECK_EQ(h.door.discard(h.user, imported.id), DiscardOutcome::done);
  CHECK(h.door.importSession(h.user, imported).sessionDeleted);
  finished(h, h.user, live.id.str(), now + 1'000);
  CHECK_EQ(h.door.start(h.user, SessionStart{imported.id, now, false}).error, StartError::idTaken);
  CHECK_FALSE(h.repo.log.session(h.user, imported.id).has_value());
  started(h, h.user, "ses_new00001", now);
  SetWrite resurrection = first;
  resurrection.completedAtMs = now;
  CHECK(h.door.append(h.user, SessionId{"ses_new00001"}, resurrection).error == AppendError::deleted);
  CHECK(h.repo.log.setsOf(SessionId{"ses_new00001"}).empty());
  CHECK(h.door.importSession(h.user, imported).sessionDeleted);
}

TEST(pg_gym_batch_and_single_writes_serialize_set_numbers_under_the_same_session_lock) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Harness h;
  const std::uint64_t now = 1'700'000'000'000;
  started(h, h.user, "ses_batch001", now);
  h.clock.now = now + 3'000;
  std::atomic<bool> go = false;
  BatchLogOutcome batch;
  AppendOutcome single{std::nullopt, AppendError::notFound};
  std::thread one([&] {
    while (!go.load()) std::this_thread::yield();
    batch = h.door.appendSets(h.user, SessionId{"ses_batch001"},
        {bench("set_batch001", 80, now + 1'000), bench("set_batch002", 80, now + 2'000)});
  });
  std::thread two([&] {
    while (!go.load()) std::this_thread::yield();
    single = h.door.append(h.user, SessionId{"ses_batch001"}, bench("set_single01", 80, now + 1'500));
  });
  go = true;
  one.join();
  two.join();
  CHECK(batch.error == BatchLogError::none);
  CHECK(single.error == AppendError::none);
  CHECK_EQ(numbersOf(h, "ses_batch001"), (std::vector<int>{1, 2, 3}));
  REQUIRE_EQ(batch.sets.size(), 2u);
  REQUIRE(batch.sets[0].current.has_value());
  REQUIRE(batch.sets[1].current.has_value());
  CHECK_EQ(batch.sets[1].current->setNumber, batch.sets[0].current->setNumber + 1);
}

TEST(pg_gym_batch_hashes_the_same_precision_the_store_holds) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Harness h;
  const std::uint64_t now = 1'700'000'000'000;
  started(h, h.user, "ses_batch001", now);
  h.clock.now = now + 2'000;
  const SetWrite approximate = bench("set_batch001", 82.5000000001, now + 1'000);
  const auto first = h.door.appendSets(h.user, SessionId{"ses_batch001"}, {approximate});
  CHECK(first.error == BatchLogError::none);
  const SetWrite exact = bench("set_batch001", 82.5, now + 1'000);
  CHECK(h.door.appendSets(h.user, SessionId{"ses_batch001"}, {exact}).replayed);
  SetWrite single = approximate;
  single.id = SetId{"set_single01"};
  single.rpe = 7.1000000001;
  REQUIRE(h.door.append(h.user, SessionId{"ses_batch001"}, single).set.has_value());
  single.weightKg = 82.5;
  single.rpe = 7.1;
  CHECK(h.door.appendSets(h.user, SessionId{"ses_batch001"}, {single}).replayed);
  SetWrite halfCent = single;
  halfCent.id = SetId{"set_half0001"};
  halfCent.weightKg = 1.005;
  halfCent.rpe = 7.05;
  const auto stored = h.door.append(h.user, SessionId{"ses_batch001"}, halfCent);
  REQUIRE(stored.set.has_value());
  CHECK_EQ(stored.set->weightKg, 1.01);
  CHECK_EQ(stored.set->rpe, std::optional<double>{7.1});
  CHECK(h.door.appendSets(h.user, SessionId{"ses_batch001"},
                              {SetWrite{stored.set->id, stored.set->exercise, stored.set->weightKg, stored.set->reps,
                                        stored.set->kind, stored.set->rpe, stored.set->note, stored.set->completedAtMs}})
            .replayed);
}

TEST(pg_gym_single_and_import_compete_for_one_durable_set_id_across_sessions) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Harness h;
  const std::uint64_t now = 1'700'000'000'000;
  const Session live = started(h, h.user, "ses_live0001", now);
  const SessionImport historical{SessionId{"ses_import01"}, now - 10'000, now - 1'000, std::nullopt,
                                 {bench("set_shared01", 80, now - 5'000)}};
  const SetWrite singleSet = bench("set_shared01", 80, now + 1'000);
  std::atomic<bool> go = false;
  BatchLogOutcome imported;
  AppendOutcome single{std::nullopt, AppendError::notFound};
  std::thread one([&] {
    while (!go.load()) std::this_thread::yield();
    imported = h.door.importSession(h.user, historical);
  });
  std::thread two([&] {
    while (!go.load()) std::this_thread::yield();
    single = h.door.append(h.user, live.id, singleSet);
  });
  go = true;
  one.join();
  two.join();
  const bool importWon = imported.error == BatchLogError::none;
  CHECK_EQ(single.error == AppendError::none, !importWon);
  if (importWon) {
    REQUIRE_EQ(h.door.discard(h.user, historical.id), DiscardOutcome::done);
    CHECK(h.door.importSession(h.user, historical).sessionDeleted);
    CHECK(h.door.append(h.user, live.id, singleSet).error == AppendError::deleted);
  } else {
    finished(h, h.user, live.id.str(), now + 2'000);
    REQUIRE_EQ(h.door.discard(h.user, live.id), DiscardOutcome::done);
    CHECK(h.door.importSession(h.user, historical).error == BatchLogError::payloadConflict);
    CHECK_EQ(h.door.start(h.user, SessionStart{live.id, now, false}).error, StartError::idTaken);
    CHECK_FALSE(h.repo.log.session(h.user, live.id).has_value());
  }
  CHECK_FALSE(h.repo.log.setOf(h.user, singleSet.id).has_value());
}

TEST(pg_gym_an_import_crossing_a_finished_session_is_refused_naming_it_and_a_replay_is_not) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Harness h;
  const std::uint64_t now = 1'700'000'000'000;
  const SessionImport first{SessionId{"ses_first001"}, now - 20'000, now - 10'000, std::nullopt,
                            {bench("set_first001", 80, now - 15'000)}};
  CHECK(h.door.importSession(h.user, first).error == BatchLogError::none);
  // Another account's hour and this account's open session are nobody's obstacle.
  CHECK(h.door.importSession(h.other, SessionImport{SessionId{"ses_theirs01"}, now - 9'000, now - 7'000, std::nullopt, {}})
            .error == BatchLogError::none);
  started(h, h.user, "ses_open0001", now - 8'500);

  const SessionImport crossing{SessionId{"ses_cross001"}, now - 12'000, now - 9'000, std::nullopt, {}};
  const BatchLogOutcome refused = h.door.importSession(h.user, crossing);
  CHECK(refused.error == BatchLogError::overlap);
  CHECK_EQ(refused.overlapping, h.repo.log.session(h.user, first.id));
  CHECK_FALSE(h.repo.log.session(h.user, crossing.id).has_value());
  // Touching ends crosses nothing, and the exact replay of the first answers as itself.
  CHECK(h.door.importSession(h.user, SessionImport{SessionId{"ses_touch001"}, now - 10'000, now - 8'000, std::nullopt, {}})
            .error == BatchLogError::none);
  CHECK(h.door.importSession(h.user, first).replayed);
}

// Different imports into one hour, all in flight at once: the account's scope queues them, so exactly one lands.
TEST(pg_gym_imports_racing_into_one_hour_land_exactly_one) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Harness h;
  const std::uint64_t now = 1'700'000'000'000;
  constexpr int kRacers = 6;
  std::vector<BatchLogError> answers(kRacers, BatchLogError::none);
  std::vector<std::string> thrown(kRacers);
  std::latch together{kRacers};
  std::vector<std::thread> racers;
  for (int at = 0; at < kRacers; ++at)
    racers.emplace_back([&, at] {
      const SessionImport racing{SessionId{"ses_race000" + std::to_string(at)},
                                 now - 20'000 + static_cast<std::uint64_t>(at), now - 10'000, std::nullopt, {}};
      together.arrive_and_wait();
      try {
        answers[at] = h.door.importSession(h.user, racing).error;
      } catch (const std::exception& failed) {
        thrown[at] = failed.what();
      }
    });
  for (std::thread& racer : racers) racer.join();

  for (int at = 0; at < kRacers; ++at) CHECK_EQ(thrown[at], std::string(""));
  CHECK_EQ(std::count(answers.begin(), answers.end(), BatchLogError::none), 1);
  CHECK_EQ(std::count(answers.begin(), answers.end(), BatchLogError::overlap), kRacers - 1);
  CHECK_EQ(sql("SELECT count(*) FROM gym_sessions WHERE user_id = $1::uuid", pqxx::params{h.user.str()})[0][0].as<int>(), 1);
}
