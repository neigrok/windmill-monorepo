#include "products/gym/adapters/json/TrainingJson.h"
#include "platform/adapters/json/JsonText.h"
#include "platform/domain/sync/Jcs.h"
#include "test/products/gym/sync/adapters/postgres/GymDoorFixture.h"
#include "test/testing.h"

#include <pqxx/pqxx>

#include <algorithm>
#include <cstdlib>
#include <stdexcept>

// The history, its shares and a phone's correction, over a log the door wrote.
using namespace wm;
using namespace wm::gym;
using namespace wm::gym::doortest;

namespace {

SetWrite bench(const std::string& id, double weightKg, std::uint64_t completedAtMs) {
  return SetWrite{SetId{id}, ExerciseId{"bench-press"}, weightKg, 8, SetKind::working, std::nullopt, "", completedAtMs};
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

// Push A as the agent wrote it: one bench line, five sets of five at 82.5, three minutes' rest.
Routine pushA(Harness& h, const std::string& id) {
  const RoutineWriteOutcome outcome = h.door.createRoutine(
      h.user,
      RoutineWrite{RoutineId{id}, "Push A", 0,
                   {RoutineEntry{1, ExerciseId{"bench-press"}, gym::fake::straight(5, 5, 82.5), 180}}},
      std::nullopt);
  if (!outcome.routine) throw std::runtime_error("the door planned no " + id);
  return *outcome.routine;
}

// A correction as a phone pushes it: the whole workout restated, each set by its id and number.
Json::Value correctionOf(const std::string& session, const std::string& request, std::uint64_t startedAt,
                         std::uint64_t finishedAt, const std::string& name, const std::vector<Json::Value>& sets) {
  Json::Value args(Json::objectValue);
  args["sessionId"] = session;
  args["requestId"] = request;
  args["startedAt"] = Json::UInt64(startedAt);
  args["finishedAt"] = Json::UInt64(finishedAt);
  args["routineName"] = name;
  args["sets"] = Json::Value(Json::arrayValue);
  for (const Json::Value& set : sets) args["sets"].append(set);
  return args;
}

Json::Value lineOf(const std::string& id, const std::string& exercise, int setNumber, double weightKg, int reps,
                   std::uint64_t completedAt) {
  Json::Value set(Json::objectValue);
  set["id"] = id;
  set["exerciseId"] = exercise;
  set["setNumber"] = setNumber;
  set["weightKg"] = weightKg;
  set["reps"] = reps;
  set["completedAt"] = Json::UInt64(completedAt);
  return set;
}

pqxx::result rowsOf(const std::string& query) {
  PgLease lease{*pool()};
  pqxx::read_transaction txn{*lease};
  return txn.exec(query);
}

}

TEST(pg_gym_history_filters_full_scope_and_pages_equal_instants_without_losing_totals) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Harness h;
  const std::uint64_t at = 1'700'000'000'000;
  for (int number = 1; number <= 3; ++number) {
    const std::string id = "ses_history0" + std::to_string(number);
    started(h, h.user, id, at);
    logged(h, h.user, id, bench("set_history0" + std::to_string(number), 80, at + 1'000));
    finished(h, h.user, id, at + 2'000);
  }
  started(h, h.user, "ses_open0001", at + 3'000);
  started(h, h.other, "ses_other001", at);
  finished(h, h.other, "ses_other001", at + 2'000);
  HistoryQuery query;
  query.exercise = "bench-press";
  query.limit = 1;
  query.includeProgress = true;
  query.asOfMs = at + 10'000;
  auto first = h.repo.log.history(h.user, query);
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
  auto second = h.repo.log.history(h.user, query);
  REQUIRE_EQ(second.sessions.size(), 1u);
  CHECK_EQ(second.sessions[0].id, "ses_history02");
  CHECK_EQ(wm::dump(toJson(second)["summary"]), wm::dump(toJson(first)["summary"]));
  query.beforeId = second.sessions[0].id;
  const auto last = h.repo.log.history(h.user, query);
  REQUIRE_EQ(last.sessions.size(), 1u);
  CHECK_EQ(last.sessions[0].id, "ses_history01");
  CHECK(!last.hasMore);
  query.untilMs = at;
  CHECK_EQ(h.repo.log.history(h.user, query).summary.sessions, 0);
  query.untilMs = at + 1;
  query.fromMs = at;
  query.beforeMs = kMaxInstantMs;
  query.beforeId = "";
  CHECK_EQ(h.repo.log.history(h.user, query).summary.sessions, 3);
  query.exercise = "back-squat";
  CHECK_EQ(h.repo.log.history(h.user, query).summary.sessions, 0);
}

TEST(pg_gym_log_snapshots_freeze_safe_facts_while_live_links_follow_corrections) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Harness h;
  const std::uint64_t at = 1'700'000'000'000;
  started(h, h.user, "ses_history01", at);
  SetWrite set = bench("set_history01", 80, at + 1'000);
  set.note = "private pain and coach note";
  logged(h, h.user, "ses_history01", set);
  finished(h, h.user, "ses_history01", at + 2'000);
  const LogShare frozen{"share_snapshot", h.user, "snapshot-secret", LogShareMode::snapshot,
                        false, 0, kMaxInstantMs, at + 3'000, at + 90'000};
  const LogShare live{"share_livelog", h.user, "live-secret", LogShareMode::live,
                      false, 0, kMaxInstantMs, at + 3'000, at + 90'000};
  REQUIRE(h.repo.log.createLogShare(frozen));
  REQUIRE(h.repo.log.createLogShare(live));
  const auto before = h.repo.log.sharedHistory(frozen.token, {}, at + 4'000);
  REQUIRE(before);
  const std::string snapshot = wm::dump(toJson(before->page));
  CHECK_EQ(snapshot.find("private"), std::string::npos);
  CHECK_EQ(snapshot.find("note"), std::string::npos);
  CHECK_EQ(snapshot.find("user"), std::string::npos);
  GymDoor::requireOk(h.admit(h.user, {GymDoor::delta("set", "set_history01", sync::parseJson(R"({"weightKg":95})"))}));
  const auto frozenAfter = h.repo.log.sharedHistory(frozen.token, {}, at + 4'000);
  const auto liveAfter = h.repo.log.sharedHistory(live.token, {}, at + 4'000);
  REQUIRE(frozenAfter);
  REQUIRE(liveAfter);
  CHECK_EQ(wm::dump(toJson(frozenAfter->page)), snapshot);
  CHECK_EQ(liveAfter->page.summary.tonnageKg, 760.0);
  REQUIRE_EQ(h.door.discard(h.user, SessionId{"ses_history01"}), DiscardOutcome::done);
  CHECK_EQ(h.repo.log.sharedHistory(frozen.token, {}, at + 4'000)->page.summary.sessions, 1);
  CHECK_EQ(h.repo.log.sharedHistory(live.token, {}, at + 4'000)->page.summary.sessions, 0);
  const auto rows = rowsOf("SELECT workout::text FROM gym_log_share_sessions WHERE share_id='share_snapshot'");
  REQUIRE_EQ(rows.size(), 1u);
  CHECK_EQ(rows[0][0].as<std::string>().find("note"), std::string::npos);
  CHECK_EQ(rows[0][0].as<std::string>().find("private"), std::string::npos);
}

TEST(pg_gym_log_share_scopes_replays_expiry_and_revocation_fail_closed) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Harness h;
  const std::uint64_t at = 1'700'000'000'000;
  for (int number = 1; number <= 3; ++number) {
    const auto start = at + number * 10'000;
    started(h, h.user, "ses_scope00" + std::to_string(number), start);
    finished(h, h.user, "ses_scope00" + std::to_string(number), start + 1'000);
  }
  for (const auto mode : {LogShareMode::snapshot, LogShareMode::live}) {
    const std::string id = mode == LogShareMode::snapshot ? "share_snapshot" : "share_live000";
    LogShare share{id, h.user, id + "-secret", mode, true, at + 20'000, at + 30'000,
                   at + 40'000, at + 50'000};
    REQUIRE(h.repo.log.createLogShare(share));
    LogShare replay = share;
    replay.token = "another-secret";
    replay.createdAtMs += 1;
    CHECK_EQ(h.repo.log.createLogShare(replay)->token, share.token);
    replay.fromMs -= 1;
    CHECK(!h.repo.log.createLogShare(replay));
    replay = share;
    replay.user = h.other;
    CHECK(!h.repo.log.createLogShare(replay));
    HistoryQuery widened;
    widened.beforeMs = kMaxInstantMs;
    widened.beforeId = "ses_zzzzzzzz";
    const auto result = h.repo.log.sharedHistory(share.token, widened, at + 41'000);
    REQUIRE(result);
    REQUIRE_EQ(result->page.sessions.size(), 1u);
    CHECK_EQ(result->page.sessions[0].id, "ses_scope002");
    widened.fromMs = at + 30'000;
    CHECK_EQ(h.repo.log.sharedHistory(share.token, widened, at + 41'000)->page.summary.sessions, 0);
    CHECK(!h.repo.log.sharedHistory(share.token, {}, share.expiresAtMs));
    h.repo.log.revokeLogShare(h.other, id);
    REQUIRE(h.repo.log.sharedHistory(share.token, {}, at + 41'000));
    h.repo.log.revokeLogShare(h.user, id);
    h.repo.log.revokeLogShare(h.user, id);
    CHECK(!h.repo.log.sharedHistory(share.token, {}, at + 41'000));
    CHECK(!h.repo.log.createLogShare(share));
  }
  CHECK(h.repo.log.logShares(h.user, at + 41'000).empty());
  CHECK(!h.repo.log.sharedHistory("never-created", {}, at + 41'000));
}

TEST(pg_gym_history_keeps_routine_identity_after_routine_deletion) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Harness h;
  const std::uint64_t at = 1'700'000'000'000;
  const Routine routine = pushA(h, "rt_history01");
  started(h, h.user, "ses_history01", at, routine.id);
  finished(h, h.user, "ses_history01", at + 1'000);
  HistoryQuery query;
  query.routine = routine.id.str();
  CHECK_EQ(h.repo.log.history(h.user, query).summary.sessions, 1);
  h.kill(h.user, "routine", routine.id.str());
  const auto history = h.repo.log.history(h.user, query);
  REQUIRE_EQ(history.sessions.size(), 1u);
  CHECK_EQ(history.sessions[0].routineId, routine.id.str());
  CHECK_EQ(history.sessions[0].routineName, "Push A");
}

TEST(pg_gym_correction_replaces_a_workout_atomically_preserves_plan_and_replays_current_truth) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Harness h;
  const std::uint64_t at = 1'700'000'000'000;
  const SessionId id{"ses_correct01"};
  const Routine routine = pushA(h, "rt_correct01");
  started(h, h.user, id.str(), at, routine.id);
  logged(h, h.user, id.str(), SetWrite{SetId{"set_correct01"}, ExerciseId{"bench-press"}, 60, 8, SetKind::warmup,
                                       6, "keep this note", at + 1'000});
  logged(h, h.user, id.str(), bench("set_correct02", 80, at + 2'000));
  finished(h, h.user, id.str(), at + 3'000);
  const auto plan = h.repo.log.session(h.user, id).value().plan;
  const LogShare snapshot{"share_correct01", h.user, "correction-snapshot", LogShareMode::snapshot,
                          false, 0, kMaxInstantMs, at + 4'000, at + 90'000};
  REQUIRE(h.repo.log.createLogShare(snapshot));
  const auto frozen = wm::dump(toJson(h.repo.log.sharedHistory(snapshot.token, {}, at + 5'000)->page));
  h.clock.now = at + 10'000;
  Json::Value added = lineOf("set_correct03", "back-squat", 1, 90, 5, at + 3'000);
  added["rpe"] = Json::Value();
  added["note"] = "new note";
  const Json::Value request = correctionOf(id.str(), "fix_correct01", at, at + 4'000, "Historical name",
                                           {lineOf("set_correct01", "bench-press", 1, 65, 8, at + 1'000), added});
  const auto result = h.door.command(h.user, "gym.correctSession", request);
  REQUIRE_EQ(GymDoor::refusal(result), "");
  CHECK_EQ(h.repo.log.session(h.user, id),
           std::optional<Session>(Session{id, h.user, at, at + 4'000, routine.id, plan, ClosedBy::finish, "Historical name"}));
  const std::vector<Set> after{
      Set{SetId{"set_correct01"}, id, ExerciseId{"bench-press"}, 1, 65, 8, SetKind::warmup, 6, "keep this note", at + 1'000},
      Set{SetId{"set_correct03"}, id, ExerciseId{"back-squat"}, 1, 90, 5, SetKind::working, std::nullopt, "new note", at + 3'000}};
  CHECK_EQ(h.repo.log.setsOf(id), after);
  CHECK_EQ(h.repo.log.history(h.user, {}).sessions[0].routineName, "Historical name");
  const auto replay = h.door.command(h.user, "gym.correctSession", request);
  CHECK_EQ(GymDoor::refusal(replay), "");
  CHECK_EQ(replay["seq"], result["seq"]);
  CHECK_EQ(h.repo.log.setsOf(id), after);
  Json::Value secondCorrection = request;
  secondCorrection["requestId"] = "fix_correct02";
  secondCorrection["sets"][0]["weightKg"] = 70;
  const auto second = h.door.command(h.user, "gym.correctSession", secondCorrection);
  REQUIRE_EQ(GymDoor::refusal(second), "");
  const auto later = h.door.command(h.user, "gym.correctSession", request);
  CHECK_EQ(GymDoor::refusal(later), "");
  CHECK_EQ(later["seq"], second["seq"]);
  CHECK_EQ(h.repo.log.setsOf(id)[0].weightKg, 70.0);
  CHECK_EQ(wm::dump(toJson(h.repo.log.sharedHistory(snapshot.token, {}, at + 10'000)->page)), frozen);
  Json::Value conflict = request;
  conflict["routineName"] = "Different request";
  CHECK_EQ(GymDoor::refusal(h.door.command(h.user, "gym.correctSession", conflict)), "payload-conflict");
  const auto revisions = rowsOf("SELECT set_id,weight_kg::float8,deleted FROM gym_set_revisions "
                                "WHERE session_id='ses_correct01' ORDER BY revision_id");
  REQUIRE_EQ(revisions.size(), 4u);
  CHECK_EQ(revisions[0]["set_id"].as<std::string>(), "set_correct01");
  CHECK_EQ(revisions[0]["weight_kg"].as<double>(), 60.0);
  CHECK(!revisions[0]["deleted"].as<bool>());
  CHECK_EQ(revisions[1]["set_id"].as<std::string>(), "set_correct02");
  CHECK_EQ(revisions[1]["weight_kg"].as<double>(), 80.0);
  CHECK(revisions[1]["deleted"].as<bool>());
  CHECK_EQ(revisions[2]["set_id"].as<std::string>(), "set_correct01");
  CHECK_EQ(revisions[2]["weight_kg"].as<double>(), 65.0);
  CHECK(!revisions[2]["deleted"].as<bool>());
  CHECK_EQ(revisions[3]["set_id"].as<std::string>(), "set_correct03");
  CHECK_EQ(revisions[3]["weight_kg"].as<double>(), 90.0);
  CHECK(!revisions[3]["deleted"].as<bool>());
  REQUIRE_EQ(h.door.discard(h.user, id), DiscardOutcome::done);
  CHECK_EQ(GymDoor::refusal(h.door.command(h.user, "gym.correctSession", request)), "record-dead");
}

TEST(pg_gym_correction_refusals_leave_every_set_and_session_unchanged) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Harness h;
  const std::uint64_t at = 1'700'000'000'000;
  const SessionId id{"ses_correct01"};
  started(h, h.user, id.str(), at);
  logged(h, h.user, id.str(), bench("set_correct01", 80, at + 1'000));
  finished(h, h.user, id.str(), at + 2'000);
  started(h, h.user, "ses_correct02", at + 5'000);
  finished(h, h.user, "ses_correct02", at + 6'000);
  const auto initialSession = h.repo.log.session(h.user, id);
  const auto initialSets = h.repo.log.setsOf(id);
  h.clock.now = at + 10'000;
  Json::Value kept = lineOf("set_correct01", "bench-press", 1, 99, 8, at + 1'000);
  kept["rpe"] = Json::Value();
  kept["note"] = "";
  Json::Value unknown = lineOf("set_correct02", "ex_unknown01", 1, 50, 5, at + 1'000);
  unknown["rpe"] = Json::Value();
  unknown["note"] = "";
  Json::Value request = correctionOf(id.str(), "fix_correct01", at, at + 2'000, "Changed", {kept, unknown});
  CHECK_EQ(GymDoor::refusal(h.door.command(h.user, "gym.correctSession", request)), "unknown-exercise");
  CHECK_EQ(h.repo.log.session(h.user, id), initialSession);
  CHECK_EQ(h.repo.log.setsOf(id), initialSets);
  request = correctionOf(id.str(), "fix_correct01", at, at + 5'001, "Changed", {kept});
  CHECK_EQ(GymDoor::refusal(h.door.command(h.user, "gym.correctSession", request)), "session-overlap");
  CHECK_EQ(h.repo.log.session(h.user, id), initialSession);
  CHECK_EQ(h.repo.log.setsOf(id), initialSets);
  CHECK_EQ(GymDoor::refusal(h.door.command(h.other, "gym.correctSession", request)), "unknown-record");
  request["finishedAt"] = Json::UInt64(at + 2'000);
  CHECK_EQ(GymDoor::refusal(h.door.command(h.user, "gym.correctSession", request)), "");
}

TEST(pg_gym_history_month_facets_include_empty_workouts_in_the_requested_local_zone) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Harness h;
  const std::uint64_t at = 1'704'067'200'000;
  started(h, h.user, "ses_zone0001", at);
  finished(h, h.user, "ses_zone0001", at + 1'000);
  HistoryQuery query;
  CHECK_EQ(wm::dump(toJson(h.repo.log.history(h.user, query))["months"]),
           "[{\"month\":\"2024-01\",\"sessions\":1}]");
  query.timeZone = "America/New_York";
  query.includeProgress = true;
  const auto result = h.repo.log.history(h.user, query);
  CHECK_EQ(wm::dump(toJson(result)["months"]), "[{\"month\":\"2023-12\",\"sessions\":1}]");
  CHECK_EQ(result.summary.sessions, 1);
  REQUIRE(result.progress);
  CHECK(result.progress->sessions.empty());
  query.timeZone = "Invalid/Timezone";
  bool refused = false;
  try { h.repo.log.history(h.user, query); } catch (const InvalidTraining&) { refused = true; }
  CHECK(refused);
}
