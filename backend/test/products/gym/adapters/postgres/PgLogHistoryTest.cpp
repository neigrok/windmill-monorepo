#include "products/gym/adapters/postgres/PgLogRepository.h"
#include "products/gym/adapters/postgres/PgProgramRepository.h"
#include "products/gym/adapters/json/TrainingJson.h"
#include "platform/adapters/json/JsonText.h"
#include "test/products/gym/adapters/postgres/PgGymFixture.h"
#include "test/testing.h"

#include <cstdlib>

using namespace wm::gym;
using namespace wm::gym::pgtest;

TEST(pg_gym_history_filters_full_scope_and_pages_equal_instants_without_losing_totals) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgLogRepository repo{wm::pgTestPool()};
  const std::uint64_t at = 1'700'000'000'000;
  for (int number = 1; number <= 3; ++number) {
    const std::string id = "ses_history0" + std::to_string(number);
    repo.insertSession(sessionAt(id, at));
    REQUIRE(repo.insertSet(benchSet("set_history0" + std::to_string(number), 80, at + 1'000, id)).set);
    repo.close(SessionId{id}, at + 2'000, ClosedBy::finish);
  }
  repo.insertSession(sessionAt("ses_open0001", at + 3'000));
  repo.insertSession(Session{SessionId{"ses_other001"}, wm::UserId{kOther}, at, at + 2'000});
  HistoryQuery query;
  query.exercise = "bench-press";
  query.limit = 1;
  query.includeProgress = true;
  query.asOfMs = at + 10'000;
  auto first = repo.history(wm::UserId{kUser}, query);
  REQUIRE_EQ(first.sessions.size(), 1u);
  CHECK_EQ(first.sessions[0].id, "ses_history03");
  CHECK(first.hasMore);
  REQUIRE(first.progress);
  CHECK_EQ(first.progress->sessions.size(), 3u);
  CHECK_EQ(wm::dump(toJson(first)["summary"]), "{\"reps\":24,\"sessions\":3,\"sets\":3,\"tonnageKg\":1920.0}");
  CHECK_EQ(wm::dump(toJson(first)["months"]), "[{\"month\":\"2023-11\",\"sessions\":3}]");
  CHECK_EQ(wm::dump(toJson(first)["exercises"]), "[{\"equipment\":\"barbell\",\"id\":\"bench-press\",\"name\":\"Bench Press\",\"sessions\":3}]");
  query.beforeMs = first.sessions[0].startedAtMs;
  query.beforeId = first.sessions[0].id;
  auto second = repo.history(wm::UserId{kUser}, query);
  REQUIRE_EQ(second.sessions.size(), 1u);
  CHECK_EQ(second.sessions[0].id, "ses_history02");
  CHECK_EQ(wm::dump(toJson(second)["summary"]), wm::dump(toJson(first)["summary"]));
  query.beforeId = second.sessions[0].id;
  const auto last = repo.history(wm::UserId{kUser}, query);
  REQUIRE_EQ(last.sessions.size(), 1u);
  CHECK_EQ(last.sessions[0].id, "ses_history01");
  CHECK(!last.hasMore);
  query.untilMs = at;
  CHECK_EQ(repo.history(wm::UserId{kUser}, query).summary.sessions, 0);
  query.untilMs = at + 1;
  query.fromMs = at;
  query.beforeMs = kMaxInstantMs;
  query.beforeId = "";
  CHECK_EQ(repo.history(wm::UserId{kUser}, query).summary.sessions, 3);
  query.exercise = "back-squat";
  CHECK_EQ(repo.history(wm::UserId{kUser}, query).summary.sessions, 0);
}

TEST(pg_gym_log_snapshots_freeze_safe_facts_while_live_links_follow_corrections) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgLogRepository repo{wm::pgTestPool()};
  const std::uint64_t at = 1'700'000'000'000;
  repo.insertSession(sessionAt("ses_history01", at));
  Set set = benchSet("set_history01", 80, at + 1'000, "ses_history01");
  set.note = "private pain and coach note";
  REQUIRE(repo.insertSet(set).set);
  repo.close(SessionId{"ses_history01"}, at + 2'000, ClosedBy::finish);
  const LogShare frozen{"share_snapshot", wm::UserId{kUser}, "snapshot-secret", LogShareMode::snapshot,
                        false, 0, kMaxInstantMs, at + 3'000, at + 90'000};
  const LogShare live{"share_livelog", wm::UserId{kUser}, "live-secret", LogShareMode::live,
                      false, 0, kMaxInstantMs, at + 3'000, at + 90'000};
  REQUIRE(repo.createLogShare(frozen));
  REQUIRE(repo.createLogShare(live));
  const auto before = repo.sharedHistory(frozen.token, {}, at + 4'000);
  REQUIRE(before);
  const std::string snapshot = wm::dump(toJson(before->page));
  CHECK_EQ(snapshot.find("private"), std::string::npos);
  CHECK_EQ(snapshot.find("note"), std::string::npos);
  CHECK_EQ(snapshot.find("user"), std::string::npos);
  set.weightKg = 95;
  set.setNumber = 1;
  REQUIRE(repo.updateSet(wm::UserId{kUser}, set));
  const auto frozenAfter = repo.sharedHistory(frozen.token, {}, at + 4'000);
  const auto liveAfter = repo.sharedHistory(live.token, {}, at + 4'000);
  REQUIRE(frozenAfter);
  REQUIRE(liveAfter);
  CHECK_EQ(wm::dump(toJson(frozenAfter->page)), snapshot);
  CHECK_EQ(liveAfter->page.summary.tonnageKg, 760.0);
  REQUIRE(repo.deleteSession(wm::UserId{kUser}, SessionId{"ses_history01"}));
  CHECK_EQ(repo.sharedHistory(frozen.token, {}, at + 4'000)->page.summary.sessions, 1);
  CHECK_EQ(repo.sharedHistory(live.token, {}, at + 4'000)->page.summary.sessions, 0);
  {
    wm::PgLease conn{*wm::pgTestPool()};
    pqxx::work txn{*conn};
    const auto rows = txn.exec("SELECT workout::text FROM gym_log_share_sessions WHERE share_id='share_snapshot'");
    REQUIRE_EQ(rows.size(), 1u);
    CHECK_EQ(rows[0][0].as<std::string>().find("note"), std::string::npos);
    CHECK_EQ(rows[0][0].as<std::string>().find("private"), std::string::npos);
  }
}

TEST(pg_gym_log_share_scopes_replays_expiry_and_revocation_fail_closed) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgLogRepository repo{wm::pgTestPool()};
  const std::uint64_t at = 1'700'000'000'000;
  for (int number = 1; number <= 3; ++number) {
    const auto start = at + number * 10'000;
    repo.insertSession(sessionAt("ses_scope00" + std::to_string(number), start));
    repo.close(SessionId{"ses_scope00" + std::to_string(number)}, start + 1'000, ClosedBy::finish);
  }
  for (const auto mode : {LogShareMode::snapshot, LogShareMode::live}) {
    const std::string id = mode == LogShareMode::snapshot ? "share_snapshot" : "share_live000";
    LogShare share{id, wm::UserId{kUser}, id + "-secret", mode, true, at + 20'000, at + 30'000,
                   at + 40'000, at + 50'000};
    REQUIRE(repo.createLogShare(share));
    LogShare replay = share;
    replay.token = "another-secret";
    replay.createdAtMs += 1;
    CHECK_EQ(repo.createLogShare(replay)->token, share.token);
    replay.fromMs -= 1;
    CHECK(!repo.createLogShare(replay));
    replay = share;
    replay.user = wm::UserId{kOther};
    CHECK(!repo.createLogShare(replay));
    HistoryQuery widened;
    widened.beforeMs = kMaxInstantMs;
    widened.beforeId = "ses_zzzzzzzz";
    const auto result = repo.sharedHistory(share.token, widened, at + 41'000);
    REQUIRE(result);
    REQUIRE_EQ(result->page.sessions.size(), 1u);
    CHECK_EQ(result->page.sessions[0].id, "ses_scope002");
    widened.fromMs = at + 30'000;
    CHECK_EQ(repo.sharedHistory(share.token, widened, at + 41'000)->page.summary.sessions, 0);
    CHECK(!repo.sharedHistory(share.token, {}, share.expiresAtMs));
    repo.revokeLogShare(wm::UserId{kOther}, id);
    REQUIRE(repo.sharedHistory(share.token, {}, at + 41'000));
    repo.revokeLogShare(wm::UserId{kUser}, id);
    repo.revokeLogShare(wm::UserId{kUser}, id);
    CHECK(!repo.sharedHistory(share.token, {}, at + 41'000));
    CHECK(!repo.createLogShare(share));
  }
  CHECK(repo.logShares(wm::UserId{kUser}, at + 41'000).empty());
  CHECK(!repo.sharedHistory("never-created", {}, at + 41'000));
}

TEST(pg_gym_history_keeps_routine_identity_after_routine_deletion) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgLogRepository repo{wm::pgTestPool()};
  PgProgramRepository program{wm::pgTestPool()};
  const Routine routine = routineAt("rt_history01", "Push A", {entryAt(1, "bench-press")});
  inserted(program, routine);
  repo.insertSession(Session{SessionId{"ses_history01"}, wm::UserId{kUser}, kNow, kNow + 1'000,
      routine.id, pushA()});
  HistoryQuery query;
  query.routine = routine.id.str();
  CHECK_EQ(repo.history(wm::UserId{kUser}, query).summary.sessions, 1);
  program.deleteRoutine(wm::UserId{kUser}, routine.id);
  const auto history = repo.history(wm::UserId{kUser}, query);
  REQUIRE_EQ(history.sessions.size(), 1u);
  CHECK_EQ(history.sessions[0].routineId, routine.id.str());
  CHECK_EQ(history.sessions[0].routineName, "Push A");
}

TEST(pg_gym_correction_replaces_a_workout_atomically_preserves_plan_and_replays_current_truth) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgLogRepository repo{wm::pgTestPool()};
  const std::uint64_t at = 1'700'000'000'000;
  const SessionId id{"ses_correct01"};
  repo.insertSession(Session{id, wm::UserId{kUser}, at, {}, {}, pushA()});
  Set first{SetId{"set_correct01"}, id, ExerciseId{"bench-press"}, 0, 60, 8, SetKind::warmup,
            6, "keep this note", at + 1'000};
  REQUIRE(repo.insertSet(first).set);
  REQUIRE(repo.insertSet(benchSet("set_correct02", 80, at + 2'000, id.str())).set);
  repo.close(id, at + 3'000, ClosedBy::finish);
  const auto plan = repo.session(wm::UserId{kUser}, id)->plan;
  const LogShare snapshot{"share_correct01", wm::UserId{kUser}, "correction-snapshot", LogShareMode::snapshot,
                          false, 0, kMaxInstantMs, at + 4'000, at + 90'000};
  REQUIRE(repo.createLogShare(snapshot));
  const auto frozen = wm::dump(toJson(repo.sharedHistory(snapshot.token, {}, at + 5'000)->page));
  first.setNumber = 1;
  first.weightKg = 65;
  first.kind = SetKind::working;
  first.note = "";
  first.rpe.reset();
  SessionCorrectionIn request{"fix_correct01", at, at + 4'000, "Historical name", {
      {first, false, false},
      {Set{SetId{"set_correct03"}, id, ExerciseId{"back-squat"}, 1, 90, 5, SetKind::working,
           {}, "new note", at + 3'000}, true, true}}};
  const auto result = repo.correctSession(wm::UserId{kUser}, id, request, at + 10'000);
  REQUIRE(result.session);
  CHECK_EQ(result.error, CorrectionError::none);
  CHECK(!result.replayed);
  CHECK_EQ(result.session->plan, plan);
  CHECK_EQ(result.session->displayName, std::optional<std::string>{"Historical name"});
  REQUIRE_EQ(result.sets.size(), 2u);
  CHECK_EQ(result.sets[0].kind, SetKind::warmup);
  CHECK_EQ(result.sets[0].note, "keep this note");
  CHECK_EQ(result.sets[0].rpe, std::optional<double>{6});
  CHECK_EQ(result.sets[1].kind, SetKind::working);
  CHECK_EQ(repo.history(wm::UserId{kUser}, {}).sessions[0].routineName, "Historical name");
  const auto after = repo.setsOf(id);
  const auto replay = repo.correctSession(wm::UserId{kUser}, id, request, at + 10'000);
  CHECK(replay.replayed);
  CHECK_EQ(replay.sets, after);
  auto secondCorrection = request;
  secondCorrection.requestId = "fix_correct02";
  secondCorrection.sets[0].set.weightKg = 70;
  REQUIRE(repo.correctSession(wm::UserId{kUser}, id, secondCorrection, at + 10'000).session);
  const auto later = repo.correctSession(wm::UserId{kUser}, id, request, at + 10'000);
  CHECK(later.replayed);
  CHECK_EQ(later.sets[0].weightKg, 70.0);
  CHECK_EQ(wm::dump(toJson(repo.sharedHistory(snapshot.token, {}, at + 10'000)->page)), frozen);
  auto conflict = request;
  conflict.routineName = "Different request";
  CHECK_EQ(repo.correctSession(wm::UserId{kUser}, id, conflict, at + 10'000).error,
           CorrectionError::payloadConflict);
  {
    wm::PgLease conn{*wm::pgTestPool()};
    pqxx::work txn{*conn};
    const auto revisions = txn.exec("SELECT set_id,deleted FROM gym_set_revisions WHERE session_id='ses_correct01' ORDER BY revision_id");
    REQUIRE_EQ(revisions.size(), 3u);
    CHECK_EQ(revisions[0]["set_id"].as<std::string>(), "set_correct01");
    CHECK(!revisions[0]["deleted"].as<bool>());
    CHECK_EQ(revisions[1]["set_id"].as<std::string>(), "set_correct02");
    CHECK(revisions[1]["deleted"].as<bool>());
  }
  REQUIRE(repo.deleteSession(wm::UserId{kUser}, id));
  CHECK_EQ(repo.correctSession(wm::UserId{kUser}, id, request, at + 10'000).error,
           CorrectionError::notFound);
}

TEST(pg_gym_correction_refusals_leave_every_set_and_session_unchanged) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgLogRepository repo{wm::pgTestPool()};
  const std::uint64_t at = 1'700'000'000'000;
  const SessionId id{"ses_correct01"};
  repo.insertSession(sessionAt(id.str(), at));
  const auto initialSet = repo.insertSet(benchSet("set_correct01", 80, at + 1'000, id.str())).set;
  REQUIRE(initialSet);
  repo.close(id, at + 2'000, ClosedBy::finish);
  repo.insertSession(Session{SessionId{"ses_correct02"}, wm::UserId{kUser}, at + 5'000, at + 6'000});
  const auto initialSession = repo.session(wm::UserId{kUser}, id);
  const auto initialSets = repo.setsOf(id);
  SessionCorrectionIn request{"fix_correct01", at, at + 2'000, "Changed", {{*initialSet,true,true}}};
  request.sets[0].set.weightKg = 99;
  request.sets.push_back({Set{SetId{"set_correct02"}, id, ExerciseId{"ex_unknown01"}, 1, 50, 5,
      SetKind::working, {}, "", at + 1'000}, true, true});
  CHECK_EQ(repo.correctSession(wm::UserId{kUser}, id, request, at + 10'000).error, CorrectionError::unknownExercise);
  CHECK_EQ(repo.session(wm::UserId{kUser}, id), initialSession);
  CHECK_EQ(repo.setsOf(id), initialSets);
  request.sets.pop_back();
  request.finishedAtMs = at + 5'001;
  CHECK_EQ(repo.correctSession(wm::UserId{kUser}, id, request, at + 10'000).error, CorrectionError::overlap);
  CHECK_EQ(repo.session(wm::UserId{kUser}, id), initialSession);
  CHECK_EQ(repo.setsOf(id), initialSets);
  CHECK_EQ(repo.correctSession(wm::UserId{kOther}, id, request, at + 10'000).error, CorrectionError::notFound);
  request.finishedAtMs = at + 2'000;
  REQUIRE(repo.correctSession(wm::UserId{kUser}, id, request, at + 10'000).session);
}

TEST(pg_gym_history_month_facets_include_empty_workouts_in_the_requested_local_zone) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgLogRepository repo{wm::pgTestPool()};
  const std::uint64_t at = 1'704'067'200'000;
  repo.insertSession(Session{SessionId{"ses_zone0001"}, wm::UserId{kUser}, at, at + 1'000});
  HistoryQuery query;
  CHECK_EQ(wm::dump(toJson(repo.history(wm::UserId{kUser}, query))["months"]),
           "[{\"month\":\"2024-01\",\"sessions\":1}]");
  query.timeZone = "America/New_York";
  query.includeProgress = true;
  const auto result = repo.history(wm::UserId{kUser}, query);
  CHECK_EQ(wm::dump(toJson(result)["months"]), "[{\"month\":\"2023-12\",\"sessions\":1}]");
  CHECK_EQ(result.summary.sessions, 1);
  REQUIRE(result.progress);
  CHECK(result.progress->sessions.empty());
  query.timeZone = "Invalid/Timezone";
  bool refused = false;
  try { repo.history(wm::UserId{kUser}, query); } catch (const InvalidTraining&) { refused = true; }
  CHECK(refused);
}
