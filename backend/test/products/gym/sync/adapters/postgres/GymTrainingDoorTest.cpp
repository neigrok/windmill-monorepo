#include "test/products/gym/sync/adapters/postgres/GymDoorFixture.h"
#include "test/testing.h"

#include "products/gym/adapters/json/TrainingJson.h"
#include "products/gym/application/GymSwitches.h"

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
  return h.door.execute(user, "refusal_test", fields, [&](sync::SyncTxn&) {
    auto value = GymDoor::intent();
    value["d"].append(GymDoor::delta("set", incoming.id.str(), fields, true));
    return std::optional<Json::Value>{value};
  });
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
  h.door.deleteSet(h.user, session, SetId{"set_kept0001"});
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
  h.door.deleteSet(h.user, session, sets[0].id);
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

TEST(gym_training_engine_correction_maps_open_payload_overlap_and_set_taken) {
  if (!std::getenv("WM_PG_TEST")) SKIP("requires WM_SYNC_DATABASE_URL");
  Harness h;
  const auto end = h.clock.now;
  const SessionId session{"session_correct"};
  REQUIRE(h.door.start(h.user, startAt("session_correct", end - 2000)).session);
  auto inputSet = setAt("set_correct01", end - 1500);
  Set set{inputSet.id, session, inputSet.exercise, 1, inputSet.weightKg, inputSet.reps,
          inputSet.kind, inputSet.rpe, inputSet.note, inputSet.completedAtMs};
  SessionCorrectionIn incoming{"correct_request1", end - 2000, end - 1000, "Renamed", {{set, true, true}}};
  CHECK_EQ(h.door.correctSession(h.user, session, incoming).error, CorrectionError::open);
  REQUIRE(h.door.finish(h.user, session, end - 1000).session);
  const auto corrected = h.door.correctSession(h.user, session, incoming);
  REQUIRE_EQ(corrected.error, CorrectionError::none);
  REQUIRE_EQ(corrected.sets.size(), 1u);
  CHECK(h.door.correctSession(h.user, session, incoming).replayed);
  incoming.routineName = "Different";
  auto changedArgs = toJson(incoming);
  changedArgs["sessionId"] = session.str();
  CHECK_EQ(GymDoor::refusal(h.door.command(h.user, "gym.correctSession", changedArgs)), "payload-conflict");
  CHECK_EQ(h.door.correctSession(h.user, session, incoming).error, CorrectionError::payloadConflict);
  incoming.requestId = "correct_request2";
  incoming.sets[0].set.exercise = ExerciseId{"missing-movement"};
  bool invalid = false;
  try { h.door.correctSession(h.user, session, incoming); }
  catch (const InvalidTraining&) { invalid = true; }
  CHECK(invalid);
  incoming.sets[0].set.id = SetId{"set_unknown2"};
  CHECK_EQ(h.door.correctSession(h.user, session, incoming).error, CorrectionError::unknownExercise);
  SessionImport other{SessionId{"session_taken1"}, end - 5000, end - 4000, std::nullopt,
                      {setAt("set_taken001", end - 4500)}};
  REQUIRE_EQ(h.door.importSession(h.user, other).error, BatchLogError::none);
  incoming.sets[0].set.exercise = ExerciseId{"dip"};
  incoming.sets[0].set.id = SetId{"set_taken001"};
  CHECK_EQ(h.door.correctSession(h.user, session, incoming).error, CorrectionError::idTaken);
  incoming.sets[0].set.id = SetId{"set_correct01"};
  incoming.startedAtMs = end - 5000;
  CHECK_EQ(h.door.correctSession(h.user, session, incoming).error, CorrectionError::overlap);
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
  const auto result = h.door.execute(h.user, "parent_refusal", args, [&](sync::SyncTxn&) {
    auto value = GymDoor::intent();
    value["d"].append(GymDoor::delta("set", set.id.str(), args, true));
    return std::optional<Json::Value>{value};
  });
  CHECK_EQ(GymDoor::refusal(result), "parent-dead");
  CHECK_EQ(h.door.append(h.user, SessionId{"session_absent"}, set).error, AppendError::notFound);
  CHECK(h.failures.messages.empty());
}

TEST(gym_training_engine_stale_settle_is_a_command_and_freeze_preserves_rows) {
  if (!std::getenv("WM_PG_TEST")) SKIP("requires WM_SYNC_DATABASE_URL");
  EngineSwitch enabled;
  Harness h;
  TrainingService training{h.log, h.program, h.clock, h.tokens, &h.door};
  const auto at = h.clock.now;
  REQUIRE(training.start(h.user, startAt("session_stale1", at)).session);
  h.clock.now += kAutoCloseMs;
  const char* old = std::getenv("GYM_WRITE_FREEZE");
  const auto previous = old ? std::optional<std::string>{old} : std::nullopt;
  setenv("GYM_WRITE_FREEZE", "1", 1);
  const auto frozen = training.openSession(h.user);
  CHECK(frozen);
  if (frozen) CHECK(!frozen->finishedAtMs);
  bool refused = false;
  try { training.finish(h.user, SessionId{"session_stale1"}, h.clock.now); }
  catch (const GymUnavailable& error) { refused = error.code == "gym-frozen"; }
  CHECK(refused);
  if (previous) setenv("GYM_WRITE_FREEZE", previous->c_str(), 1);
  else unsetenv("GYM_WRITE_FREEZE");
  CHECK(!training.openSession(h.user));
  const auto settled = h.log.session(h.user, SessionId{"session_stale1"});
  REQUIRE(settled);
  CHECK_EQ(settled->finishedAtMs, std::optional<std::uint64_t>{at});
  CHECK_EQ(settled->closedBy, std::optional<ClosedBy>{ClosedBy::stale});
  CHECK(h.failures.messages.empty());
}
