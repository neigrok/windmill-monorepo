#include "test/products/gym/sync/adapters/postgres/GymDoorFixture.h"
#include "test/testing.h"
#include "platform/adapters/postgres/PgSyncStore.h"
#include "platform/application/WorkerPool.h"
#include "platform/domain/sync/FractionalIndex.h"
#include "products/gym/sync/adapters/postgres/PgGym.h"
#include "products/gym/sync/GymRegistry.h"

#include <chrono>
#include <future>
#include <thread>

using namespace wm;
using namespace wm::gym;

namespace {

RoutineWrite routineWrite(std::string id = "routine_0001", std::string name = "Press") {
  return RoutineWrite{RoutineId{id}, name, 2, {RoutineEntry{1, ExerciseId{"dip"}, {}, std::nullopt}}};
}

ProposalWrite proposalWrite(std::string id = "proposal_001", ProposalDoor door = ProposalDoor::mcp) {
  return ProposalWrite{ProposalId{id}, RoutineId{"routine_0001"}, "New press", "Rename the day",
      {RoutineEntry{1, ExerciseId{"dip"}, {}, std::nullopt}}, ProposalSource{door, "", "", std::nullopt}};
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

}

TEST(gym_record_engine_routine_doors_keep_replay_revision_and_spent_identity) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  doortest::Harness h;
  const auto created = h.program.createRoutine(h.user, routineWrite(), ProposalDoor::mcp);
  REQUIRE(created.routine);
  CHECK_EQ(created.error, RoutineWriteError::none);
  CHECK_EQ(created.routine->revision, 1);
  CHECK_EQ(h.program.createRoutine(h.user, routineWrite("routine_0001", "Ignored replay"), ProposalDoor::mcp).routine,
           created.routine);
  Json::Value renamed(Json::objectValue);
  renamed["name"] = "Changed";
  GymDoor::requireOk(h.admit(h.user, {GymDoor::delta("routine", "routine_0001", renamed)}));
  CHECK_EQ(h.program.routine(h.user, RoutineId{"routine_0001"}).value().revision, 2);
  h.kill(h.user, "routine", "routine_0001");
  auto edit = routineWrite("routine_0001", "Changed");
  CHECK_EQ(h.program.createRoutine(h.user, edit, ProposalDoor::mcp).error, RoutineWriteError::idTaken);
  CHECK_EQ(h.program.createRoutine(h.other, edit, ProposalDoor::mcp).error, RoutineWriteError::idTaken);
  edit.entries = {RoutineEntry{1, ExerciseId{"."}, {}, std::nullopt}};
  CHECK_EQ(h.program.createRoutine(h.user, edit, ProposalDoor::mcp).error, RoutineWriteError::idTaken);
  CHECK_EQ(h.program.createRoutine(h.other, edit, ProposalDoor::mcp).error, RoutineWriteError::idTaken);
}

TEST(gym_record_engine_routines_translate_unknown_exercise_and_foreign_ids) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  doortest::Harness h;
  auto missing = routineWrite(); missing.entries = {RoutineEntry{1, ExerciseId{"unknown-move"}, {}, std::nullopt}};
  CHECK_EQ(h.program.createRoutine(h.user, missing, ProposalDoor::mcp).error, RoutineWriteError::unknownExercise);
  auto malformed = missing; malformed.entries = {RoutineEntry{1, ExerciseId{"."}, {}, std::nullopt}};
  CHECK_EQ(h.program.createRoutine(h.user, malformed, ProposalDoor::mcp).error, RoutineWriteError::unknownExercise);
  REQUIRE(h.program.createRoutine(h.user, routineWrite(), ProposalDoor::mcp).routine);
  CHECK_EQ(h.program.createRoutine(h.other, routineWrite(), ProposalDoor::mcp).error, RoutineWriteError::idTaken);
  CHECK_EQ(h.program.createRoutine(h.other, malformed, ProposalDoor::mcp).error, RoutineWriteError::idTaken);
  CHECK_EQ(h.program.createRoutine(h.user, malformed, ProposalDoor::mcp).error, RoutineWriteError::none);
}

TEST(gym_record_engine_proposal_mint_translates_identity_replay_and_refusals) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  doortest::Harness h;
  CHECK_EQ(h.program.propose(h.user, proposalWrite()).error, ProposalMintError::unknownRoutine);
  REQUIRE(h.program.createRoutine(h.user, routineWrite(), ProposalDoor::mcp).routine);
  const auto minted = h.program.propose(h.user, proposalWrite());
  REQUIRE(minted.proposal);
  CHECK_EQ(h.program.propose(h.user, proposalWrite()).proposal, minted.proposal);
  auto reused = proposalWrite(); reused.summary = "Another document";
  CHECK_EQ(h.program.propose(h.user, reused).error, ProposalMintError::idReused);
  REQUIRE(h.program.createRoutine(h.other, routineWrite("routine_0002"), ProposalDoor::mcp).routine);
  auto foreign = proposalWrite(); foreign.routine = RoutineId{"routine_0002"};
  CHECK_EQ(h.program.propose(h.other, foreign).error, ProposalMintError::idTaken);
  auto noChange = proposalWrite("proposal_002"); noChange.name.reset();
  CHECK_EQ(h.program.propose(h.user, noChange).error, ProposalMintError::noChange);
  auto unknown = proposalWrite("proposal_003"); unknown.entries = {RoutineEntry{1, ExerciseId{"unknown-move"}, {}, std::nullopt}};
  CHECK_EQ(h.program.propose(h.user, unknown).error, ProposalMintError::unknownExercise);
  unknown.entries = {RoutineEntry{1, ExerciseId{"."}, {}, std::nullopt}};
  CHECK_EQ(h.program.propose(h.user, unknown).error, ProposalMintError::unknownExercise);
}

TEST(gym_record_engine_catalog_create_rounds_its_step_and_refuses_taken_and_seed_ids) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  doortest::Harness h;
  const ExerciseWrite incoming{ExerciseId{"exercise_001"}, "Custom press", Pattern::press, Equipment::barbell, std::nullopt};
  const auto created = h.catalog.createExercise(h.user, incoming);
  REQUIRE(created.exercise);
  CHECK_EQ(h.catalog.createExercise(h.user, incoming).exercise, created.exercise);
  const auto rounded = h.catalog.createExercise(h.user, ExerciseWrite{ExerciseId{"exercise_002"}, "Precise step", Pattern::press, Equipment::barbell, 1.234});
  REQUIRE(rounded.exercise);
  CHECK_EQ(rounded.exercise->stepKg, 1.23);
  CHECK_EQ(h.catalog.createExercise(h.other, incoming).error, ExerciseInsertError::idTaken);
  CHECK_EQ(h.catalog.createExercise(h.user, ExerciseWrite{ExerciseId{"dip"}, "Taken seed", Pattern::press, Equipment::bodyweight, std::nullopt}).error, ExerciseInsertError::idTaken);
}

TEST(gym_record_engine_insight_receipts_preserve_snapshot_after_edit_and_delete) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  doortest::Harness h;
  const Note incoming{NoteId{"note_0000001"}, h.user, "Constraint", "Keep sessions short"};
  const auto saved = h.notes.saveInsight(incoming);
  REQUIRE(saved.note);
  CHECK_EQ(h.notes.noteSave(h.user, incoming.id), saved.note);
  GymDoor::requireOk(phoneNote(h, h.user, incoming.id.str(), "Edited", "Changed"));
  CHECK_EQ(h.notes.saveInsight(incoming).note, saved.note);
  CHECK_EQ(h.notes.saveInsight(Note{incoming.id, h.user, "Different", "Text"}).error, NoteWriteError::idTaken);
  h.kill(h.user, "note", incoming.id.str());
  CHECK_EQ(h.notes.saveInsight(incoming).note, saved.note);
  CHECK(h.notes.notes(h.user).empty());
  const auto first = h.notes.saveInsight(Note{NoteId{"note_second1"}, h.user, "Duplicate", "Same text"});
  REQUIRE(first.note);
  const auto duplicate = h.notes.saveInsight(Note{NoteId{"note_third01"}, h.user, "Duplicate", "Same text"});
  CHECK_EQ(duplicate.note, first.note);
  CHECK_EQ(h.notes.noteSave(h.user, NoteId{"note_third01"}), first.note);
  CHECK_EQ(h.notes.notes(h.user).size(), 1U);
}

namespace {

void insightReceiptRace(bool remove) {
  doortest::Harness h;
  const Note incoming{NoteId{"note_atomic1"}, h.user, "Constraint", "Keep sessions short"};
  PgLease lease{*doortest::pool()};
  pqxx::work txn{*lease};
  txn.exec("lock table gym_note_saves in share mode");
  auto save = std::async(std::launch::async, [&] { return h.notes.saveInsight(incoming); });
  int waiting = 0;
  const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(2);
  while (std::chrono::steady_clock::now() < deadline) {
    waiting = txn.exec("select count(*) from pg_locks where relation='gym_note_saves'::regclass and mode='RowExclusiveLock' and not granted")[0][0].as<int>();
    if (waiting == 1) break;
    std::this_thread::sleep_for(std::chrono::milliseconds(5));
  }
  CHECK_EQ(waiting, 1);
  // No reader sees the note without its receipt, and a phone's edit or delete queues behind the save.
  CHECK(h.notes.notes(h.user).empty());
  CHECK(!h.notes.noteSave(h.user, incoming.id));
  auto change = std::async(std::launch::async, [&] {
    if (remove) h.kill(h.user, "note", incoming.id.str());
    else GymDoor::requireOk(phoneNote(h, h.user, incoming.id.str(), "Edited", "Changed"));
  });
  CHECK_EQ(change.wait_for(std::chrono::milliseconds(50)), std::future_status::timeout);
  txn.commit();
  const auto saved = save.get();
  change.get();
  REQUIRE(saved.note);
  CHECK_EQ(saved.note->title, incoming.title);
  CHECK_EQ(saved.note->body, incoming.body);
  CHECK_EQ(h.notes.noteSave(h.user, incoming.id), saved.note);
  CHECK_EQ(h.notes.saveInsight(incoming).note, saved.note);
  const auto standing = h.notes.notes(h.user);
  if (remove) CHECK(standing.empty());
  else {
    REQUIRE_EQ(standing.size(), 1U);
    CHECK_EQ(standing[0].title, "Edited");
  }
  CHECK(h.failures.messages.empty());
}

struct FailingInsightReceipt {
  FailingInsightReceipt() {
    PgLease lease{*doortest::pool()};
    pqxx::work txn{*lease};
    txn.exec("create function gym_test_fail_note_receipt() returns trigger language plpgsql as $$ begin raise exception 'injected before insight receipt'; end $$");
    txn.exec("create trigger gym_test_fail_note_receipt before insert on gym_note_saves for each row execute function gym_test_fail_note_receipt()");
    txn.commit();
  }
  ~FailingInsightReceipt() {
    PgLease lease{*doortest::pool()};
    pqxx::work txn{*lease};
    txn.exec("drop trigger gym_test_fail_note_receipt on gym_note_saves");
    txn.exec("drop function gym_test_fail_note_receipt()");
    txn.commit();
  }
};

}

TEST(gym_record_engine_insight_note_and_receipt_are_atomic_during_concurrent_edit) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  insightReceiptRace(false);
}

TEST(gym_record_engine_insight_note_and_receipt_are_atomic_during_concurrent_delete) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  insightReceiptRace(true);
}

TEST(gym_record_engine_insight_receipt_failure_rolls_back_note_and_scope) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  doortest::Harness h;
  FailingInsightReceipt inject;
  const Note incoming{NoteId{"note_atomic1"}, h.user, "Constraint", "Keep sessions short"};
  bool failed = false;
  try { h.notes.saveInsight(incoming); }
  catch (const std::runtime_error&) { failed = true; }
  CHECK(failed);
  CHECK(h.notes.notes(h.user).empty());
  CHECK(!h.notes.noteSave(h.user, incoming.id));
  PgLease lease{*doortest::pool()};
  pqxx::work txn{*lease};
  CHECK_EQ(txn.exec("select count(*) from sync_scopes where key=$1", pqxx::params{"acct:" + h.user.str() + "/gym"})[0][0].as<int>(), 0);
  CHECK_EQ(h.failures.messages.size(), 1U);
}

TEST(gym_record_engine_insight_duplicate_receipt_reserves_alias_for_feed_and_replicas) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  doortest::Harness h;
  const auto original = h.notes.saveInsight(Note{NoteId{"note_original1"}, h.user, "Constraint", "Same text"});
  REQUIRE(original.note);
  const Note duplicate{NoteId{"note_duplicate1"}, h.user, "Constraint", "Same text"};
  CHECK_EQ(h.notes.saveInsight(duplicate).note, original.note);
  CHECK_EQ(h.notes.noteSave(h.user, duplicate.id), original.note);
  const auto state = [&] {
    PgLease lease{*doortest::pool()};
    pqxx::work txn{*lease};
    return txn.exec("select seq,(select seq from sync_spent where scope_key=$1 and type='note' and id=$2) as alias_seq from sync_scopes where key=$1", pqxx::params{"acct:" + h.user.str() + "/gym", duplicate.id.str()});
  };
  const auto reserved = state();
  REQUIRE_EQ(reserved.size(), 1U);
  CHECK_EQ(reserved[0]["seq"].as<int>(), 2);
  CHECK_EQ(reserved[0]["alias_seq"].as<int>(), 2);
  CHECK_EQ(h.notes.saveInsight(duplicate).note, original.note);
  CHECK_EQ(state()[0]["seq"].as<int>(), 2);
  CHECK(doortest::scopeConsistent(h.user));
  GymDoor::requireOk(phoneNote(h, h.user, "note_nextwrite1", "Next", "Other text", sync::between(sync::between(std::nullopt, std::nullopt), std::nullopt)));
  CHECK_EQ(state()[0]["seq"].as<int>(), 3);
  CHECK(doortest::scopeConsistent(h.user));

  sync::SyncCatalog catalog{engine::registry()};
  engine::PgGym gym{engine::registry()};
  gym.bindTo(catalog);
  catalog.seal();
  sync::PgSyncStore store{doortest::pool(), sync::Limits{}.lockTimeoutMs};
  sync::NullChangeFeed feed;
  sync::ServerClock stamps;
  sync::Admission admission{catalog, store, feed, stamps, h.failures};
  Json::Value fields(Json::objectValue); fields["title"] = "Alias reused"; fields["body"] = "Changed"; fields["ord"] = "a1";
  auto delta = GymDoor::delta("note", duplicate.id.str(), fields, true);
  const std::string stamp = std::to_string(h.clock.now) + ":0:r_note_alias";
  delta["born"] = stamp;
  delta["life"][1] = stamp;
  for (const auto& field : delta["f"].getMemberNames()) delta["f"][field][1] = stamp;
  auto built = GymDoor::intent(); built["d"].append(delta);
  BlockingThread::Mark blocking;
  const auto outcome = admission.admit(sync::ReplicaOrigin{h.user, "r_note_alias", 1, sync::intentDigest(built)}, built, h.clock.now);
  const auto* refused = std::get_if<sync::Admitted>(&outcome);
  REQUIRE(refused);
  CHECK_EQ(refused->result["code"].asString(), "id-spent");
  CHECK_EQ(state()[0]["seq"].as<int>(), 3);
  CHECK_EQ(h.notes.notes(h.user).size(), 2U);
  CHECK(doortest::scopeConsistent(h.user));
  CHECK(h.failures.messages.empty());
}

TEST(gym_record_engine_insight_receipt_failure_rolls_back_alias_reservation_and_retry) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  doortest::Harness h;
  GymDoor::requireOk(phoneNote(h, h.user, "note_original1", "Constraint", "Same text", sync::between(std::nullopt, std::nullopt)));
  const Note original{NoteId{"note_original1"}, h.user, "Constraint", "Same text", 0, h.clock.now};
  const Note duplicate{NoteId{"note_duplicate1"}, h.user, "Constraint", "Same text"};
  {
    FailingInsightReceipt inject;
    bool failed = false;
    try { h.notes.saveInsight(duplicate); }
    catch (const std::runtime_error&) { failed = true; }
    CHECK(failed);
  }
  CHECK_EQ(h.notes.notes(h.user), std::vector<Note>{original});
  CHECK(!h.notes.noteSave(h.user, duplicate.id));
  {
    PgLease lease{*doortest::pool()};
    pqxx::work txn{*lease};
    CHECK_EQ(txn.exec("select seq from sync_scopes where key=$1", pqxx::params{"acct:" + h.user.str() + "/gym"})[0][0].as<int>(), 1);
    CHECK_EQ(txn.exec("select count(*) from sync_spent where type='note' and id=$1", pqxx::params{duplicate.id.str()})[0][0].as<int>(), 0);
  }
  CHECK_EQ(h.notes.saveInsight(duplicate).note, std::optional<Note>(original));
  CHECK(doortest::scopeConsistent(h.user));
  CHECK_EQ(h.failures.messages.size(), 1U);
}

TEST(gym_record_engine_server_spent_batch_has_one_sequence_result_and_publication) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  doortest::Harness h;
  sync::SyncCatalog catalog{engine::registry()};
  engine::PgGym gym{engine::registry()};
  gym.bindTo(catalog);
  catalog.seal();
  sync::PgSyncStore store{doortest::pool(), sync::Limits{}.lockTimeoutMs};
  struct Feed : sync::ChangeFeed {
    std::vector<sync::CommittedChange> events;
    void publish(const sync::CommittedChange& event) override { events.push_back(event); }
  } feed;
  sync::ServerClock stamps;
  sync::Admission admission{catalog, store, feed, stamps, h.failures};
  BlockingThread::Mark blocking;
  const auto scopeIntent = GymDoor::intent("gym.closeStale", Json::Value(Json::objectValue));
  const auto reserve = [&] {
    return admission.admitBuilt(sync::ServerOrigin{h.user, std::nullopt}, scopeIntent, h.clock.now,
      [&](sync::SyncTxn& txn) -> std::optional<Json::Value> {
        txn.reserveSpent("note", sync::RecordId{std::string{"note_reserved1"}});
        txn.reserveSpent("note", sync::RecordId{std::string{"note_reserved2"}});
        txn.reserveSpent("note", sync::RecordId{std::string{"note_reserved1"}});
        return std::nullopt;
      });
  };
  const auto outcome = reserve();
  const auto* admitted = std::get_if<sync::Admitted>(&outcome);
  REQUIRE(admitted);
  CHECK_EQ(admitted->result["s"].asString(), "ok");
  CHECK_EQ(admitted->result["seq"].asInt(), 1);
  REQUIRE_EQ(feed.events.size(), 1U);
  REQUIRE_EQ(feed.events[0].changed.size(), 1U);
  CHECK_EQ(feed.events[0].changed[0].seq, 1U);
  REQUIRE_EQ(feed.events[0].changed[0].rows.size(), 2U);
  for (const auto& row : feed.events[0].changed[0].rows) {
    CHECK_EQ(row["seq"].asInt(), 1);
    CHECK_EQ(row["life"][0].asString(), "dead");
  }
  const auto replay = reserve();
  const auto* repeated = std::get_if<sync::Admitted>(&replay);
  REQUIRE(repeated);
  CHECK_EQ(repeated->result["seq"].asInt(), 1);
  CHECK_EQ(feed.events.size(), 1U);
  CHECK(doortest::scopeConsistent(h.user));
  CHECK(h.failures.messages.empty());
}

TEST(gym_record_engine_d3_server_and_replica_weighins_follow_whole_put_stamp_order) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  doortest::Harness h;
  const Bodyweight serverReading{h.user, "2023-11-14", 80.0, h.clock.now - 100};
  Json::Value reading(Json::objectValue);
  reading["kg"] = serverReading.weightKg;
  reading["recordedAt"] = Json::UInt64(serverReading.recordedAtMs);
  GymDoor::requireOk(h.admit(h.user, {GymDoor::delta("weighin", serverReading.dateLocal, reading, true)}));
  CHECK_EQ(h.repo.bodyweight.latest(h.user), std::optional(serverReading));
  sync::SyncCatalog catalog{engine::registry()};
  engine::PgGym gym{engine::registry()};
  gym.bindTo(catalog);
  catalog.seal();
  sync::PgSyncStore store{doortest::pool(), sync::Limits{}.lockTimeoutMs};
  sync::NullChangeFeed feed;
  sync::ServerClock stamps;
  sync::Admission admission{catalog, store, feed, stamps, h.failures};
  BlockingThread::Mark blocking;
  const auto put = [&](std::uint64_t stampMs, double kg, std::uint64_t recordedAt) {
    Json::Value fields(Json::objectValue); fields["kg"] = kg; fields["recordedAt"] = Json::UInt64(recordedAt);
    auto delta = GymDoor::delta("weighin", serverReading.dateLocal, fields, true);
    const std::string stamp = std::to_string(stampMs) + ":0:r_d3";
    delta["life"][1] = stamp;
    for (const auto& field : delta["f"].getMemberNames()) delta["f"][field][1] = stamp;
    auto built = GymDoor::intent(); built["d"].append(delta); return built;
  };
  const auto admit = [&](const Json::Value& built, std::uint64_t n) {
    const auto outcome = admission.admit(sync::ReplicaOrigin{h.user, "r_d3", n, sync::intentDigest(built)}, built, h.clock.now);
    const auto* admitted = std::get_if<sync::Admitted>(&outcome);
    if (!admitted) return Json::Value();
    return admitted->result;
  };
  const auto delayed = admit(put(h.clock.now - 1, 90.0, h.clock.now), 1);
  REQUIRE_EQ(delayed["s"].asString(), "ok");
  CHECK_EQ(h.repo.bodyweight.latest(h.user), std::optional(serverReading));
  const Bodyweight replicaReading{h.user, serverReading.dateLocal, 91.0, h.clock.now + 100};
  const auto newer = admit(put(h.clock.now + 1, replicaReading.weightKg, replicaReading.recordedAtMs), 2);
  REQUIRE_EQ(newer["s"].asString(), "ok");
  CHECK_EQ(h.repo.bodyweight.latest(h.user), std::optional(replicaReading));
  CHECK(h.failures.messages.empty());
}

TEST(gym_record_engine_insight_global_receipt_race_has_one_owner_and_snapshot) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  doortest::Harness h;
  GymDoor::requireOk(phoneNote(h, h.user, "note_user001", "Constraint", "Same text", sync::between(std::nullopt, std::nullopt)));
  GymDoor::requireOk(phoneNote(h, h.other, "note_other01", "Constraint", "Same text", sync::between(std::nullopt, std::nullopt)));
  const Note ownerNote{NoteId{"note_user001"}, h.user, "Constraint", "Same text", 0, h.clock.now};
  const Note otherNote{NoteId{"note_other01"}, h.other, "Constraint", "Same text", 0, h.clock.now};
  PgLease lease{*doortest::pool()};
  pqxx::work txn{*lease};
  txn.exec("lock table gym_note_saves in share mode");
  const NoteId receiptId{"note_race001"};
  auto owner = std::async(std::launch::async, [&] { return h.notes.saveInsight(Note{receiptId, h.user, "Constraint", "Same text"}); });
  auto other = std::async(std::launch::async, [&] { return h.notes.saveInsight(Note{receiptId, h.other, "Constraint", "Same text"}); });
  int waiting = 0;
  int idWaiting = 0;
  const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(2);
  while (std::chrono::steady_clock::now() < deadline) {
    waiting = txn.exec("select count(*) from pg_locks where relation='gym_note_saves'::regclass and mode='RowExclusiveLock' and not granted")[0][0].as<int>();
    idWaiting = txn.exec("select count(*) from pg_locks where locktype='advisory' and database=(select oid from pg_database where datname=current_database()) and not granted")[0][0].as<int>();
    if (waiting == 1 && idWaiting == 1) break;
    std::this_thread::sleep_for(std::chrono::milliseconds(5));
  }
  CHECK_EQ(waiting, 1);
  CHECK_EQ(idWaiting, 1);
  txn.commit();
  const auto ownerResult = owner.get();
  const auto otherResult = other.get();
  CHECK_EQ((ownerResult.error == NoteWriteError::none) + (otherResult.error == NoteWriteError::none), 1);
  CHECK_EQ((ownerResult.error == NoteWriteError::idTaken) + (otherResult.error == NoteWriteError::idTaken), 1);
  if (ownerResult.error == NoteWriteError::none) {
    CHECK_EQ(ownerResult.note, std::optional<Note>(ownerNote));
    CHECK_EQ(h.notes.noteSave(h.user, receiptId), std::optional<Note>(ownerNote));
    CHECK(!h.notes.noteSave(h.other, receiptId));
  } else {
    CHECK_EQ(otherResult.note, std::optional<Note>(otherNote));
    CHECK_EQ(h.notes.noteSave(h.other, receiptId), std::optional<Note>(otherNote));
    CHECK(!h.notes.noteSave(h.user, receiptId));
  }
  CHECK(h.failures.messages.empty());
}
