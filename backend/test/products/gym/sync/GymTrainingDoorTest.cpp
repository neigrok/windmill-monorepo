#include "test/products/gym/sync/GymDoorFixture.h"
#include "test/testing.h"

#include "products/gym/adapters/json/GymJson.h"
#include "platform/application/WorkerPool.h"
#include "platform/application/WriteObservation.h"
#include "platform/adapters/postgres/PgSyncStore.h"
#include "products/gym/sync/PgGym.h"
#include "products/gym/sync/GymProduct.h"

#include <cmath>
#include <cstdlib>

using namespace wm;
using namespace wm::gym;
using namespace wm::gym::doortest;

namespace {

SetWrite setAt(const char* id, std::uint64_t at, const char* exercise = "dip") {
  return {SetId{id}, ExerciseId{exercise}, 20.25, 5, SetKind::working, 7.5, "", at};
}

SessionStart startAt(const char* id, std::uint64_t at, bool join = true) {
  return {SessionId{id}, at, join, std::nullopt};
}

Json::Value rawAppend(Harness& h, const UserId& user, const SessionId& session, const SetWrite& incoming) {
  auto fields = toJson(Set{incoming.id, session, incoming.exercise, 0, incoming.weightKg, incoming.reps,
                           incoming.kind, incoming.rpe, incoming.note, incoming.completedAtMs});
  fields.removeMember("id");
  fields.removeMember("setNumber");
  fields["sessionId"] = session.str();
  return h.door.execute(user, [&](sync::SyncTxn&) {
    auto value = GymDoor::intent();
    value["d"].append(GymDoor::delta("set", incoming.id.str(), fields, true));
    return std::optional<Json::Value>{value};
  });
}

// A correction as a phone pushes it: the whole workout restated, each set by its id and number.
Json::Value correctionOf(const char* session, const char* request, std::uint64_t startedAt, std::uint64_t finishedAt,
                         const std::string& name, const std::vector<Json::Value>& sets) {
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

Json::Value lineOf(const char* id, const char* exercise, int setNumber, double weightKg, int reps, std::uint64_t completedAt) {
  Json::Value set(Json::objectValue);
  set["id"] = id;
  set["exerciseId"] = exercise;
  set["setNumber"] = setNumber;
  set["weightKg"] = weightKg;
  set["reps"] = reps;
  set["completedAt"] = Json::UInt64(completedAt);
  return set;
}

}

TEST(gym_training_engine_start_refusals_and_join_receipt_follow_D2) {
  if (!std::getenv("WM_PG_TEST")) SKIP("requires WM_SYNC_DATABASE_URL");
  Harness h;
  const auto at = h.clock.now;
  bool malformed = false;
  try { h.door.start(h.user, startAt("short", at)); }
  catch (const InvalidTraining&) { malformed = true; }
  CHECK(malformed);
  CHECK_EQ(h.door.start(h.user, startAt("session_ahead", at + kMaxClockAheadMs + 1)).error, StartError::clockAhead);
  auto missing = startAt("session_noplan", at);
  missing.routine = RoutineId{"routine_missing"};
  CHECK_EQ(h.door.start(h.user, missing).error, StartError::unknownRoutine);
  const auto first = h.door.start(h.user, startAt("session_first", at));
  REQUIRE(first.session);
  Json::Value startArgs(Json::objectValue);
  startArgs["id"] = "session_refused";
  startArgs["startedAt"] = Json::UInt64(at);
  startArgs["joinOpenSession"] = false;
  CHECK_EQ(GymDoor::refusal(h.door.command(h.user, "gym.start", startArgs)), "session-open");
  CHECK_EQ(h.door.start(h.user, startAt("session_refused", at, false)).error, StartError::alreadyOpen);
  auto joined = h.door.start(h.user, startAt("session_joined", at));
  CHECK_EQ(joined.session, first.session);
  REQUIRE(h.door.finish(h.user, first.session->id, at + 1000).session);
  h.clock.now += 2000;
  REQUIRE(h.door.start(h.user, startAt("session_second", h.clock.now)).session);
  joined = h.door.start(h.user, startAt("session_joined", at));
  REQUIRE(joined.session);
  CHECK_EQ(joined.session->id, first.session->id);
  CHECK_EQ(joined.session->finishedAtMs, std::optional<std::uint64_t>{at + 1000});
  CHECK(h.failures.messages.empty());
}

TEST(gym_training_engine_join_reserves_alias_for_retries_audit_next_writes_and_replicas) {
  if (!std::getenv("WM_PG_TEST")) SKIP("requires WM_SYNC_DATABASE_URL");
  Harness h;
  const auto at = h.clock.now;
  const auto original = h.door.start(h.user, startAt("session_original", at));
  REQUIRE(original.session);
  const auto joined = h.door.start(h.user, startAt("session_joinalias", at));
  CHECK_EQ(joined.session, original.session);
  const auto state = [&] {
    PgLease lease{*pool()};
    pqxx::read_transaction sql{*lease};
    return sql.exec("select seq,(select seq from sync_spent where scope_key=$1 and type='session' and id=$2) as alias_seq from sync_scopes where key=$1",
                     pqxx::params{"acct:" + h.user.str() + "/gym", "session_joinalias"});
  };
  const auto reserved = state();
  REQUIRE_EQ(reserved.size(), 1U);
  REQUIRE(!reserved[0]["alias_seq"].is_null());
  CHECK_EQ(reserved[0]["seq"].as<int>(), 2);
  CHECK_EQ(reserved[0]["alias_seq"].as<int>(), 2);
  CHECK_EQ(h.door.start(h.user, startAt("session_joinalias", at)).session, original.session);
  CHECK_EQ(state()[0]["seq"].as<int>(), 2);
  CHECK(doortest::scopeConsistent(h.user));
  REQUIRE(h.door.append(h.user, original.session->id, setAt("set_joinalias1", at)).set);
  CHECK_EQ(state()[0]["seq"].as<int>(), 3);
  CHECK(doortest::scopeConsistent(h.user));

  sync::SyncCatalog catalog{engine::registry()};
  engine::PgGym gym{engine::registry()};
  gym.bindTo(catalog);
  catalog.seal();
  sync::PgSyncStore store{pool(), sync::Limits{}.lockTimeoutMs};
  sync::NullChangeFeed feed;
  sync::ServerClock stamps;
  sync::Admission admission{catalog, store, feed, stamps, h.failures};
  Json::Value fields(Json::objectValue);
  auto delta = GymDoor::delta("session", "session_joinalias", fields, true);
  const std::string stamp = std::to_string(at) + ":0:r_session_alias";
  delta["born"] = stamp;
  delta["life"][1] = stamp;
  for (const auto& field : delta["f"].getMemberNames()) delta["f"][field][1] = stamp;
  auto built = GymDoor::intent();
  built["d"].append(delta);
  BlockingThread::Mark blocking;
  const auto outcome = admission.admit(sync::ReplicaOrigin{h.user, "r_session_alias", 1, sync::intentDigest(built)}, built, at);
  const auto* refused = std::get_if<sync::Admitted>(&outcome);
  REQUIRE(refused);
  CHECK_EQ(refused->result["code"].asString(), "id-spent");
  CHECK_EQ(state()[0]["seq"].as<int>(), 3);
  CHECK(!h.repo.log.session(h.user, SessionId{"session_joinalias"}));
  CHECK(doortest::scopeConsistent(h.user));
  CHECK(h.failures.messages.empty());
}

TEST(gym_training_engine_refused_join_rolls_back_reserved_alias) {
  if (!std::getenv("WM_PG_TEST")) SKIP("requires WM_SYNC_DATABASE_URL");
  Harness h;
  REQUIRE(h.door.start(h.user, startAt("session_joinbase", h.clock.now)).session);
  Json::Value args(Json::objectValue);
  args["id"] = "session_nojoin";
  args["startedAt"] = Json::UInt64(h.clock.now);
  args["joinOpenSession"] = false;
  const auto result = h.door.execute(h.user, [&](sync::SyncTxn& txn) {
    txn.reserveSpent("session", sync::RecordId{std::string{"session_nojoin"}});
    return std::optional<Json::Value>{GymDoor::intent("gym.start", args)};
  });
  CHECK_EQ(GymDoor::refusal(result), "session-open");
  PgLease lease{*pool()};
  pqxx::read_transaction sql{*lease};
  CHECK_EQ(sql.exec("select seq from sync_scopes where key=$1", pqxx::params{"acct:" + h.user.str() + "/gym"})[0][0].as<int>(), 1);
  CHECK_EQ(sql.exec("select count(*) from sync_spent where type='session' and id='session_nojoin'")[0][0].as<int>(), 0);
  CHECK_EQ(sql.exec("select count(*) from gym_write_receipts where kind='session' and id='session_nojoin'")[0][0].as<int>(), 0);
  CHECK(h.failures.messages.empty());
}

TEST(gym_training_engine_append_maps_missing_finished_unknown_taken_and_spent) {
  if (!std::getenv("WM_PG_TEST")) SKIP("requires WM_SYNC_DATABASE_URL");
  Harness h;
  const auto at = h.clock.now;
  const SessionId session{"session_append"};
  CHECK_EQ(h.door.append(h.user, session, setAt("set_absent01", at)).error, AppendError::notFound);
  auto invalidAbsent = setAt("set_absent01", at);
  invalidAbsent.reps = 0;
  CHECK_EQ(h.door.append(h.user, session, invalidAbsent).error, AppendError::notFound);
  REQUIRE(h.door.start(h.user, startAt("session_append", at)).session);
  CHECK_EQ(GymDoor::refusal(rawAppend(h, h.user, session, setAt("set_unknown1", at, "missing-movement"))), "unknown-exercise");
  CHECK_EQ(h.door.append(h.user, session, setAt("set_unknown1", at, "missing-movement")).error, AppendError::unknownExercise);
  REQUIRE(h.door.append(h.user, session, setAt("set_kept0001", at)).set);
  REQUIRE(h.door.start(h.other, startAt("session_other1", at)).session);
  REQUIRE(h.door.append(h.other, SessionId{"session_other1"}, setAt("set_other001", at)).set);
  CHECK_EQ(GymDoor::refusal(rawAppend(h, h.user, session, setAt("set_other001", at))), "id-taken");
  CHECK_EQ(h.door.append(h.user, session, setAt("set_other001", at)).error, AppendError::idTaken);
  h.kill(h.user, "set", "set_kept0001");
  CHECK_EQ(GymDoor::refusal(rawAppend(h, h.user, session, setAt("set_kept0001", at))), "id-spent");
  CHECK_EQ(h.door.append(h.user, session, setAt("set_kept0001", at)).error, AppendError::deleted);
  REQUIRE(h.door.finish(h.user, session, at + 1000).session);
  CHECK_EQ(GymDoor::refusal(rawAppend(h, h.user, session, setAt("set_afterend", at))), "session-finished");
  CHECK_EQ(h.door.append(h.user, session, setAt("set_afterend", at)).error, AppendError::finished);
  CHECK(h.failures.messages.empty());
}

TEST(gym_training_engine_finish_maps_bad_instant_unknown_and_dead) {
  if (!std::getenv("WM_PG_TEST")) SKIP("requires WM_SYNC_DATABASE_URL");
  Harness h;
  const auto at = h.clock.now;
  const SessionId session{"session_finish"};
  CHECK_EQ(h.door.finish(h.user, session, at).error, FinishError::notFound);
  CHECK_EQ(h.door.finish(h.user, SessionId{"short"}, at).error, FinishError::notFound);
  REQUIRE(h.door.start(h.user, startAt("session_finish", at)).session);
  CHECK_EQ(h.door.finish(h.user, session, at - 1).error, FinishError::badInstant);
  CHECK_EQ(h.door.discard(h.user, session), DiscardOutcome::open);
  REQUIRE(h.door.finish(h.user, session, at + 1000).session);
  CHECK_EQ(h.door.discard(h.user, session), DiscardOutcome::done);
  CHECK_EQ(h.door.finish(h.user, session, at + 1000).error, FinishError::notFound);
  CHECK_EQ(h.door.discard(h.user, session), DiscardOutcome::notFound);
  CHECK_EQ(h.door.start(h.user, startAt("session_finish", at)).error, StartError::idTaken);
  CHECK(h.failures.messages.empty());
}

TEST(gym_training_engine_batch_preserves_receipt_payload_and_deleted_replay) {
  if (!std::getenv("WM_PG_TEST")) SKIP("requires WM_SYNC_DATABASE_URL");
  Harness h;
  const auto at = h.clock.now;
  const SessionId session{"session_batch1"};
  REQUIRE(h.door.start(h.user, startAt("session_batch1", at)).session);
  const std::vector<SetWrite> sets{setAt("set_batch001", at), setAt("set_batch002", at)};
  auto landed = h.door.appendSets(h.user, session, sets);
  REQUIRE_EQ(landed.error, BatchLogError::none);
  REQUIRE_EQ(landed.sets.size(), 2u);
  CHECK(!landed.replayed);
  auto different = sets;
  different[1].reps++;
  auto conflict = h.door.appendSets(h.user, session, different);
  CHECK_EQ(conflict.error, BatchLogError::payloadConflict);
  CHECK_EQ(conflict.errorIndex, std::optional<std::size_t>{1});
  h.kill(h.user, "set", sets[0].id.str());
  auto replayed = h.door.appendSets(h.user, session, sets);
  REQUIRE_EQ(replayed.error, BatchLogError::none);
  REQUIRE_EQ(replayed.sets.size(), 2u);
  CHECK(replayed.replayed);
  CHECK(replayed.sets[0].replayed);
  CHECK(!replayed.sets[0].current);
  CHECK(replayed.sets[1].current);
  CHECK(h.failures.messages.empty());
}

TEST(gym_training_engine_import_preserves_hash_overlap_and_deleted_receipt) {
  if (!std::getenv("WM_PG_TEST")) SKIP("requires WM_SYNC_DATABASE_URL");
  Harness h;
  const auto end = h.clock.now;
  SessionImport incoming{SessionId{"session_import"}, end - 2000, end - 1000, std::nullopt,
                         {setAt("set_import01", end - 1500)}};
  auto landed = h.door.importSession(h.user, incoming);
  REQUIRE_EQ(landed.error, BatchLogError::none);
  REQUIRE(landed.session);
  CHECK(!landed.replayed);
  CHECK(h.door.importSession(h.user, incoming).replayed);
  auto changed = incoming;
  changed.sets[0].reps++;
  Json::Value changedArgs(Json::objectValue);
  changedArgs["id"] = changed.id.str();
  changedArgs["startedAt"] = Json::UInt64(changed.startedAtMs);
  changedArgs["finishedAt"] = Json::UInt64(changed.finishedAtMs);
  const auto& changedSet = changed.sets[0];
  changedArgs["sets"].append(toJson(Set{changedSet.id, changed.id, changedSet.exercise, 0, changedSet.weightKg,
                                      changedSet.reps, changedSet.kind, changedSet.rpe, changedSet.note, changedSet.completedAtMs}));
  changedArgs["sets"][0].removeMember("setNumber");
  CHECK_EQ(GymDoor::refusal(h.door.command(h.user, "gym.importSession", changedArgs)), "payload-conflict");
  CHECK_EQ(h.door.importSession(h.user, changed).error, BatchLogError::payloadConflict);
  auto overlap = incoming;
  overlap.id = SessionId{"session_overlap"};
  overlap.sets[0].id = SetId{"set_overlap01"};
  const auto crossed = h.door.importSession(h.user, overlap);
  CHECK_EQ(crossed.error, BatchLogError::overlap);
  CHECK_EQ(crossed.overlapping, landed.session);
  CHECK_EQ(h.door.discard(h.user, incoming.id), DiscardOutcome::done);
  const auto deleted = h.door.importSession(h.user, incoming);
  CHECK_EQ(deleted.error, BatchLogError::none);
  CHECK(deleted.replayed);
  CHECK(deleted.sessionDeleted);
  CHECK(h.failures.messages.empty());
}

TEST(gym_training_engine_correction_command_refuses_an_unknown_movement_a_taken_set_and_an_overlap) {
  if (!std::getenv("WM_PG_TEST")) SKIP("requires WM_SYNC_DATABASE_URL");
  Harness h;
  const auto end = h.clock.now;
  const SessionId session{"session_correct"};
  REQUIRE(h.door.start(h.user, startAt("session_correct", end - 2000)).session);
  const auto kept = h.door.append(h.user, session, setAt("set_correct01", end - 1500)).set;
  REQUIRE(kept);
  REQUIRE(h.door.finish(h.user, session, end - 1000).session);
  SessionImport other{SessionId{"session_taken1"}, end - 5000, end - 4000, std::nullopt,
                      {setAt("set_taken001", end - 4500)}};
  REQUIRE_EQ(h.door.importSession(h.user, other).error, BatchLogError::none);
  const auto before = h.repo.log.session(h.user, session);
  REQUIRE(before);
  CHECK_EQ(GymDoor::refusal(h.door.command(h.user, "gym.correctSession",
               correctionOf("session_correct", "correct_request1", end - 2000, end - 1000, "Renamed",
                            {lineOf("set_unknown2", "missing-movement", 1, 20.25, 5, end - 1500)}))),
           "unknown-exercise");
  CHECK_EQ(GymDoor::refusal(h.door.command(h.user, "gym.correctSession",
               correctionOf("session_correct", "correct_request1", end - 2000, end - 1000, "Renamed",
                            {lineOf("set_taken001", "dip", 1, 20.25, 5, end - 1500)}))),
           "id-taken");
  const auto crossing = h.door.command(h.user, "gym.correctSession",
      correctionOf("session_correct", "correct_request1", end - 5000, end - 1000, "Renamed",
                   {lineOf("set_correct01", "dip", 1, 20.25, 5, end - 1500)}));
  CHECK_EQ(GymDoor::refusal(crossing), "session-overlap");
  CHECK_EQ(crossing["detail"]["sessionId"].asString(), "session_taken1");
  CHECK_EQ(h.repo.log.session(h.user, session), before);
  CHECK_EQ(h.repo.log.setsOf(session), std::vector<Set>{*kept});
  CHECK(h.failures.messages.empty());
}

TEST(gym_training_engine_correction_command_refuses_padding_and_numbers_off_their_step) {
  if (!std::getenv("WM_PG_TEST")) SKIP("requires WM_SYNC_DATABASE_URL");
  Harness h;
  const auto end = h.clock.now;
  const SessionId session{"session_padding"};
  SessionImport imported{session, end - 2000, end - 1000, std::nullopt, {setAt("set_padding01", end - 1500)}};
  REQUIRE_EQ(h.door.importSession(h.user, imported).error, BatchLogError::none);
  const auto stored = h.repo.log.setOf(h.user, imported.sets[0].id);
  REQUIRE(stored);
  const auto correction = [&](const std::string& name, double keptKg, double keptRpe, double addedKg) {
    Json::Value keptLine = lineOf("set_padding01", "dip", 1, keptKg, 5, end - 1500);
    keptLine["rpe"] = keptRpe;
    Json::Value addedLine = lineOf("set_padding02", "dip", 2, addedKg, 8, end - 1400);
    addedLine["rpe"] = Json::Value();
    addedLine["note"] = "";
    return correctionOf("session_padding", "correct_padding1", end - 2000, end - 1000, name, {keptLine, addedLine});
  };
  const std::string padded = std::string(241, ' ') + "Valid workout" + std::string(241, ' ');
  CHECK_EQ(GymDoor::refusal(h.door.command(h.user, "gym.correctSession", correction(padded, 20.25, 7.5, 0))), "invalid");
  CHECK_EQ(GymDoor::refusal(h.door.command(h.user, "gym.correctSession", correction("Valid workout", 20.2500000001, 7.5, 0))), "invalid");
  CHECK_EQ(GymDoor::refusal(h.door.command(h.user, "gym.correctSession", correction("Valid workout", 20.25, 7.5000000001, 0))), "invalid");
  CHECK_EQ(GymDoor::refusal(h.door.command(h.user, "gym.correctSession", correction("Valid workout", 20.25, 7.5, -0.0000000001))), "invalid");
  CHECK_EQ(h.repo.log.setsOf(session), std::vector<Set>{*stored});
  GymDoor::requireOk(h.door.command(h.user, "gym.correctSession", correction("Valid workout", 20.25, 7.5, 0)));
  const auto corrected = h.repo.log.session(h.user, session);
  REQUIRE(corrected);
  CHECK_EQ(corrected->displayName, std::optional<std::string>{"Valid workout"});
  const auto sets = h.repo.log.setsOf(session);
  CHECK_EQ(sets, (std::vector<Set>{
      Set{SetId{"set_padding01"}, session, ExerciseId{"dip"}, 1, 20.25, 5, SetKind::working, 7.5, "", end - 1500},
      Set{SetId{"set_padding02"}, session, ExerciseId{"dip"}, 2, 0, 8, SetKind::working, std::nullopt, "", end - 1400}}));
  REQUIRE_EQ(sets.size(), 2u);
  CHECK(!std::signbit(sets[1].weightKg));
  CHECK(h.failures.messages.empty());
}

TEST(gym_training_engine_parent_refusal_is_an_absent_session_at_the_door) {
  if (!std::getenv("WM_PG_TEST")) SKIP("requires WM_SYNC_DATABASE_URL");
  Harness h;
  const auto set = setAt("set_orphan001", h.clock.now);
  auto args = toJson(Set{set.id, SessionId{"session_absent"}, set.exercise, 0, set.weightKg, set.reps,
                         set.kind, set.rpe, set.note, set.completedAtMs});
  args.removeMember("id");
  args.removeMember("setNumber");
  args["sessionId"] = "session_absent";
  const auto result = h.door.execute(h.user, [&](sync::SyncTxn&) {
    auto value = GymDoor::intent();
    value["d"].append(GymDoor::delta("set", set.id.str(), args, true));
    return std::optional<Json::Value>{value};
  });
  CHECK_EQ(GymDoor::refusal(result), "parent-dead");
  CHECK_EQ(h.door.append(h.user, SessionId{"session_absent"}, set).error, AppendError::notFound);
  CHECK(h.failures.messages.empty());
}

// A settling read admits the close only when the open workout has gone stale: until then it opens no
// transaction and logs no write line, and the close it does admit logs the command's lines once.
TEST(gym_training_a_settling_read_writes_only_a_real_stale_close) {
  if (!std::getenv("WM_PG_TEST")) SKIP("requires WM_SYNC_DATABASE_URL");
  Harness h;
  const auto at = h.clock.now;
  std::vector<std::string> lines;
  installWriteSink([&](const WriteCompletion& completion) {
    lines.push_back(completion.operation + " " + completion.product + " " + completion.door + " " + completion.outcome);
  });
  const auto readEverything = [&] {
    h.training.openSession(h.user);
    h.training.log(h.user, LogCursor{h.clock.now + 1, std::nullopt, 50});
    h.training.detail(h.user, SessionId{"session_quiet1"});
    h.training.sessions(h.user, {SessionId{"session_quiet1"}});
    h.training.statistics(h.user);
    h.training.progress(h.user);
    h.training.movementRecord(h.user, ExerciseId{"dip"});
  };
  readEverything();
  CHECK_EQ(lines, std::vector<std::string>{});

  REQUIRE(h.door.start(h.user, startAt("session_quiet1", at)).session);
  h.clock.now = at + 60'000;
  REQUIRE(h.door.append(h.user, SessionId{"session_quiet1"}, setAt("set_quiet0001", at + 60'000)).set);
  h.clock.now = at + 60'000 + kAutoCloseMs - 1;
  lines.clear();
  readEverything();
  CHECK_EQ(lines, std::vector<std::string>{});
  CHECK(h.training.openSession(h.user).has_value());

  h.clock.now = at + 60'000 + kAutoCloseMs;
  CHECK_EQ(h.training.openSession(h.user), std::optional<Session>());
  readEverything();
  installWriteSink({});
  CHECK_EQ(lines, (std::vector<std::string>{"sync.publish gym background ok",
                                            "sync.command.gym.closeStale gym command ok",
                                            "sync.admit gym server-origin ok",
                                            "gym.server_call gym server-origin ok"}));
  CHECK_EQ(h.repo.log.session(h.user, SessionId{"session_quiet1"}),
           std::optional<Session>(Session{SessionId{"session_quiet1"}, h.user, at, at + 60'000, std::nullopt,
                                          std::nullopt, ClosedBy::stale}));
  CHECK(h.failures.messages.empty());
}

TEST(gym_training_engine_stale_settle_is_a_command) {
  if (!std::getenv("WM_PG_TEST")) SKIP("requires WM_SYNC_DATABASE_URL");
  Harness h;
  const auto at = h.clock.now;
  REQUIRE(h.door.start(h.user, startAt("session_stale1", at)).session);
  h.clock.now += kAutoCloseMs;
  CHECK(!h.training.openSession(h.user));
  CHECK_EQ(h.repo.log.session(h.user, SessionId{"session_stale1"}),
           std::optional<Session>(Session{SessionId{"session_stale1"}, h.user, at, at, std::nullopt, std::nullopt, ClosedBy::stale}));
  CHECK(h.failures.messages.empty());
}
