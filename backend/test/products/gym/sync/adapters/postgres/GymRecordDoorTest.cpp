#include "test/products/gym/sync/adapters/postgres/GymDoorFixture.h"
#include "products/gym/application/BodyweightService.h"
#include "products/gym/application/NotesService.h"
#include "products/gym/application/PreferencesService.h"
#include "test/testing.h"
#include "platform/adapters/postgres/PgSyncStore.h"
#include "platform/application/WorkerPool.h"
#include "products/gym/sync/adapters/postgres/PgGym.h"
#include "products/gym/sync/adapters/postgres/PgGymBackfill.h"
#include "products/gym/sync/GymRegistry.h"

#include <chrono>
#include <future>
#include <thread>

using namespace wm;
using namespace wm::gym;

namespace {

RoutineWrite routineWrite(std::string id = "routine_0001", std::string name = "Press") {
  return RoutineWrite{RoutineId{id}, name, 2, {RoutineEntry{1, ExerciseId{"dip"}, {}, std::nullopt}}, std::nullopt};
}

ProposalWrite proposalWrite(std::string id = "proposal_001", ProposalDoor door = ProposalDoor::mcp) {
  return ProposalWrite{ProposalId{id}, RoutineId{"routine_0001"}, "New press", "Rename the day",
      {RoutineEntry{1, ExerciseId{"dip"}, {}, std::nullopt}}, ProposalSource{door, "", "", std::nullopt}};
}

}

TEST(gym_record_engine_routine_doors_keep_replay_revision_and_spent_identity) {
  if (!std::getenv("WM_PG_TEST")) SKIP("requires WM_PG_TEST");
  doortest::Harness h;
  doortest::EngineSwitch enabled;
  ProgramService program{h.program, h.clock, &h.door};
  const auto created = program.createRoutine(h.user, routineWrite(), std::nullopt);
  REQUIRE(created.routine);
  CHECK_EQ(created.error, RoutineWriteError::none);
  CHECK_EQ(created.routine->revision, 1);
  CHECK_EQ(program.createRoutine(h.user, routineWrite("routine_0001", "Ignored replay"), std::nullopt).routine, created.routine);
  auto edit = routineWrite("routine_0001", "Changed"); edit.expectedRevision = 2;
  CHECK_EQ(program.replaceRoutine(h.user, edit.id, edit).error, RoutineWriteError::stale);
  edit.expectedRevision = 1;
  const auto edited = program.replaceRoutine(h.user, edit.id, edit);
  REQUIRE(edited.routine);
  CHECK_EQ(edited.routine->revision, 2);
  CHECK(program.deleteRoutine(h.user, edit.id));
  CHECK(!program.deleteRoutine(h.user, edit.id));
  CHECK_EQ(program.replaceRoutine(h.user, edit.id, edit).error, RoutineWriteError::notFound);
  CHECK_EQ(program.createRoutine(h.user, edit, std::nullopt).error, RoutineWriteError::idTaken);
  CHECK_EQ(program.createRoutine(h.other, edit, std::nullopt).error, RoutineWriteError::idTaken);
  edit.entries = {RoutineEntry{1, ExerciseId{"."}, {}, std::nullopt}};
  CHECK_EQ(program.createRoutine(h.user, edit, std::nullopt).error, RoutineWriteError::idTaken);
  CHECK_EQ(program.createRoutine(h.other, edit, std::nullopt).error, RoutineWriteError::idTaken);
}

TEST(gym_record_engine_routines_translate_unknown_exercise_and_foreign_ids) {
  if (!std::getenv("WM_PG_TEST")) SKIP("requires WM_PG_TEST");
  doortest::Harness h;
  doortest::EngineSwitch enabled;
  ProgramService program{h.program, h.clock, &h.door};
  auto missing = routineWrite(); missing.entries = {RoutineEntry{1, ExerciseId{"unknown-move"}, {}, std::nullopt}};
  CHECK_EQ(program.createRoutine(h.user, missing, std::nullopt).error, RoutineWriteError::unknownExercise);
  auto malformed = missing; malformed.entries = {RoutineEntry{1, ExerciseId{"."}, {}, std::nullopt}};
  CHECK_EQ(program.createRoutine(h.user, malformed, std::nullopt).error, RoutineWriteError::unknownExercise);
  REQUIRE(program.createRoutine(h.user, routineWrite(), std::nullopt).routine);
  CHECK_EQ(program.createRoutine(h.other, routineWrite(), std::nullopt).error, RoutineWriteError::idTaken);
  CHECK_EQ(program.createRoutine(h.other, malformed, std::nullopt).error, RoutineWriteError::idTaken);
  CHECK_EQ(program.createRoutine(h.user, malformed, std::nullopt).error, RoutineWriteError::none);
  CHECK_EQ(program.replaceRoutine(h.user, missing.id, missing).error, RoutineWriteError::unknownExercise);
  CHECK_EQ(program.replaceRoutine(h.user, malformed.id, malformed).error, RoutineWriteError::unknownExercise);
  CHECK_EQ(program.replaceRoutine(h.other, missing.id, missing).error, RoutineWriteError::notFound);
  CHECK(!program.deleteRoutine(h.other, missing.id));
}

TEST(gym_record_engine_proposal_doors_translate_identity_and_settled_states) {
  if (!std::getenv("WM_PG_TEST")) SKIP("requires WM_PG_TEST");
  doortest::Harness h;
  doortest::EngineSwitch enabled;
  ProgramService program{h.program, h.clock, &h.door};
  CHECK_EQ(program.propose(h.user, proposalWrite()).error, ProposalMintError::unknownRoutine);
  REQUIRE(program.createRoutine(h.user, routineWrite(), std::nullopt).routine);
  const auto minted = program.propose(h.user, proposalWrite());
  REQUIRE(minted.proposal);
  CHECK_EQ(program.propose(h.user, proposalWrite()).proposal, minted.proposal);
  auto reused = proposalWrite(); reused.summary = "Another document";
  CHECK_EQ(program.propose(h.user, reused).error, ProposalMintError::idReused);
  REQUIRE(program.createRoutine(h.other, routineWrite("routine_0002"), std::nullopt).routine);
  auto foreign = proposalWrite(); foreign.routine = RoutineId{"routine_0002"};
  CHECK_EQ(program.propose(h.other, foreign).error, ProposalMintError::idTaken);
  auto noChange = proposalWrite("proposal_002"); noChange.name.reset();
  CHECK_EQ(program.propose(h.user, noChange).error, ProposalMintError::noChange);
  auto unknown = proposalWrite("proposal_003"); unknown.entries = {RoutineEntry{1, ExerciseId{"unknown-move"}, {}, std::nullopt}};
  CHECK_EQ(program.propose(h.user, unknown).error, ProposalMintError::unknownExercise);
  unknown.entries = {RoutineEntry{1, ExerciseId{"."}, {}, std::nullopt}};
  CHECK_EQ(program.propose(h.user, unknown).error, ProposalMintError::unknownExercise);
  CHECK_EQ(program.apply(h.other, minted.proposal->head.id).error, ProposalSettleError::notFound);
  const auto dismissed = program.dismiss(h.user, minted.proposal->head.id);
  REQUIRE(dismissed.proposal);
  CHECK_EQ(dismissed.proposal->head.state, ProposalState::dismissed);
  h.clock.now += 1000;
  CHECK_EQ(program.dismiss(h.user, minted.proposal->head.id).proposal, dismissed.proposal);
  CHECK_EQ(program.apply(h.user, minted.proposal->head.id).error, ProposalSettleError::settled);
  const auto second = program.propose(h.user, proposalWrite("proposal_004"));
  REQUIRE(second.proposal);
  const auto applied = program.apply(h.user, second.proposal->head.id);
  REQUIRE(applied.proposal);
  REQUIRE(applied.routine);
  CHECK_EQ(applied.proposal->head.state, ProposalState::applied);
  CHECK_EQ(applied.routine->name, "New press");
  CHECK_EQ(program.apply(h.user, second.proposal->head.id).proposal, applied.proposal);
  CHECK_EQ(program.dismiss(h.user, second.proposal->head.id).error, ProposalSettleError::settled);
}

TEST(gym_record_engine_proposals_translate_every_supersession_reason) {
  if (!std::getenv("WM_PG_TEST")) SKIP("requires WM_PG_TEST");
  doortest::Harness h;
  doortest::EngineSwitch enabled;
  ProgramService program{h.program, h.clock, &h.door};
  REQUIRE(program.createRoutine(h.user, routineWrite(), std::nullopt).routine);
  const auto replaced = program.propose(h.user, proposalWrite());
  REQUIRE(replaced.proposal);
  REQUIRE(program.propose(h.user, proposalWrite("proposal_002")).proposal);
  CHECK_EQ(program.apply(h.user, replaced.proposal->head.id).error, ProposalSettleError::replaced);
  CHECK_EQ(program.dismiss(h.user, replaced.proposal->head.id).error, ProposalSettleError::replaced);
  const auto moved = program.propose(h.user, proposalWrite("proposal_003", ProposalDoor::ask));
  REQUIRE(moved.proposal);
  REQUIRE(program.replaceRoutine(h.user, RoutineId{"routine_0001"}, routineWrite("routine_0001", "Moved")).routine);
  CHECK_EQ(program.apply(h.user, moved.proposal->head.id).error, ProposalSettleError::routineMoved);
  CHECK_EQ(program.dismiss(h.user, moved.proposal->head.id).error, ProposalSettleError::routineMoved);
  const auto legacy = program.propose(h.user, proposalWrite("proposal_004"));
  REQUIRE(legacy.proposal);
  h.door.execute(h.user, "test_supersede", Json::Value(Json::objectValue), [&](sync::SyncTxn&) -> std::optional<Json::Value> {
    Json::Value fields(Json::objectValue); fields["state"] = "superseded"; fields["settledAt"] = Json::UInt64(h.clock.now);
    auto built = GymDoor::intent(); built["d"].append(GymDoor::delta("proposal", legacy.proposal->head.id.str(), fields)); return built;
  });
  CHECK_EQ(program.apply(h.user, legacy.proposal->head.id).error, ProposalSettleError::superseded);
  CHECK_EQ(program.dismiss(h.user, legacy.proposal->head.id).error, ProposalSettleError::superseded);
}

TEST(gym_record_engine_proposal_removal_composes_reply_before_death) {
  if (!std::getenv("WM_PG_TEST")) SKIP("requires WM_PG_TEST");
  doortest::Harness h;
  doortest::EngineSwitch enabled;
  ProgramService program{h.program, h.clock, &h.door};
  REQUIRE(program.createRoutine(h.user, routineWrite(), std::nullopt).routine);
  const auto proposal = program.proposeRemoval(h.user, ProposalId{"proposal_001"}, RoutineId{"routine_0001"}, "Drop this day", ProposalSource{ProposalDoor::mcp, "", "", std::nullopt});
  REQUIRE(proposal.proposal);
  const auto removed = program.apply(h.user, proposal.proposal->head.id);
  REQUIRE(removed.proposal);
  CHECK_EQ(removed.proposal->head.state, ProposalState::applied);
  CHECK(!removed.routine);
  CHECK(!program.routine(h.user, RoutineId{"routine_0001"}));
  CHECK_EQ(program.apply(h.user, proposal.proposal->head.id).error, ProposalSettleError::notFound);
}

TEST(gym_record_engine_catalog_create_rename_and_seed_override_keep_aliases) {
  if (!std::getenv("WM_PG_TEST")) SKIP("requires WM_PG_TEST");
  doortest::Harness h;
  doortest::EngineSwitch enabled;
  CatalogService catalog{h.catalog, &h.door};
  const ExerciseWrite incoming{ExerciseId{"exercise_001"}, "Custom press", Pattern::press, Equipment::barbell, std::nullopt};
  const auto created = catalog.createExercise(h.user, incoming);
  REQUIRE(created.exercise);
  CHECK_EQ(catalog.createExercise(h.user, incoming).exercise, created.exercise);
  const auto rounded = catalog.createExercise(h.user, ExerciseWrite{ExerciseId{"exercise_002"}, "Precise step", Pattern::press, Equipment::barbell, 1.234});
  REQUIRE(rounded.exercise);
  CHECK_EQ(rounded.exercise->stepKg, 1.23);
  CHECK_EQ(catalog.createExercise(h.other, incoming).error, ExerciseInsertError::idTaken);
  CHECK_EQ(catalog.createExercise(h.user, ExerciseWrite{ExerciseId{"dip"}, "Taken seed", Pattern::press, Equipment::bodyweight, std::nullopt}).error, ExerciseInsertError::idTaken);
  const auto renamed = catalog.renameExercise(h.user, incoming.id, "  Renamed  ");
  REQUIRE(renamed);
  CHECK_EQ(renamed->name, "Renamed");
  CHECK_EQ(renamed->aliases, std::vector<std::string>{"Custom press"});
  CHECK(!catalog.renameExercise(h.other, incoming.id, "Other"));
  const auto seed = catalog.renameExercise(h.user, ExerciseId{"dip"}, "Weighted dip");
  REQUIRE(seed);
  CHECK_EQ(seed->name, "Weighted dip");
  CHECK(!seed->custom);
}

TEST(gym_record_engine_notes_translate_cap_foreign_spent_and_order_mismatch) {
  if (!std::getenv("WM_PG_TEST")) SKIP("requires WM_PG_TEST");
  doortest::Harness h;
  doortest::EngineSwitch enabled;
  NotesService notes{h.notes, h.clock, &h.door};
  std::vector<NoteId> order;
  for (int i = 0; i < 10; ++i) {
    const Note incoming{NoteId{"note_0000" + std::to_string(i)}, h.user, "Title " + std::to_string(i), "Body"};
    const auto saved = notes.saveNote(incoming);
    REQUIRE(saved.note);
    CHECK_EQ(saved.note->position, i);
    order.push_back(incoming.id);
  }
  CHECK_EQ(notes.saveNote(Note{NoteId{"note_extra00"}, h.user, "Eleventh", ""}).error, NoteWriteError::full);
  CHECK_EQ(notes.saveNote(Note{order[0], h.other, "Foreign", ""}).error, NoteWriteError::idTaken);
  CHECK_EQ(notes.reorderNotes(h.user, {}).error, NotesOrderError::mismatch);
  std::reverse(order.begin(), order.end());
  const auto reordered = notes.reorderNotes(h.user, order);
  CHECK_EQ(reordered.error, NotesOrderError::none);
  REQUIRE(reordered.notes.size() == 10);
  for (int i = 0; i < 10; ++i) CHECK_EQ(reordered.notes[i].id, order[i]);
  notes.deleteNote(h.other, order[0]);
  CHECK_EQ(notes.notes(h.user).size(), 10U);
  notes.deleteNote(h.user, order[0]);
  CHECK_EQ(notes.saveNote(Note{order[0], h.user, "Deleted", ""}).error, NoteWriteError::idTaken);
  CHECK_EQ(notes.notes(h.user).size(), 9U);
}

TEST(gym_record_engine_insight_receipts_preserve_snapshot_after_edit_and_delete) {
  if (!std::getenv("WM_PG_TEST")) SKIP("requires WM_PG_TEST");
  doortest::Harness h;
  doortest::EngineSwitch enabled;
  NotesService notes{h.notes, h.clock, &h.door};
  const Note incoming{NoteId{"note_0000001"}, h.user, "Constraint", "Keep sessions short"};
  const auto saved = notes.saveInsight(incoming);
  REQUIRE(saved.note);
  CHECK_EQ(notes.noteSave(h.user, incoming.id), saved.note);
  REQUIRE(notes.saveNote(Note{incoming.id, h.user, "Edited", "Changed"}).note);
  CHECK_EQ(notes.saveInsight(incoming).note, saved.note);
  CHECK_EQ(notes.saveInsight(Note{incoming.id, h.user, "Different", "Text"}).error, NoteWriteError::idTaken);
  notes.deleteNote(h.user, incoming.id);
  CHECK_EQ(notes.saveInsight(incoming).note, saved.note);
  CHECK(notes.notes(h.user).empty());
  const auto first = notes.saveInsight(Note{NoteId{"note_second1"}, h.user, "Duplicate", "Same text"});
  REQUIRE(first.note);
  const auto duplicate = notes.saveInsight(Note{NoteId{"note_third01"}, h.user, "Duplicate", "Same text"});
  CHECK_EQ(duplicate.note, first.note);
  CHECK_EQ(notes.noteSave(h.user, NoteId{"note_third01"}), first.note);
  CHECK_EQ(notes.notes(h.user).size(), 1U);
}

namespace {

void insightReceiptRace(bool remove) {
  doortest::Harness h;
  doortest::EngineSwitch enabled;
  NotesService notes{h.notes, h.clock, &h.door};
  const Note incoming{NoteId{"note_atomic1"}, h.user, "Constraint", "Keep sessions short"};
  PgLease lease{*doortest::pool()};
  pqxx::work txn{*lease};
  txn.exec("lock table gym_note_saves in share mode");
  auto save = std::async(std::launch::async, [&] { return notes.saveInsight(incoming); });
  int waiting = 0;
  const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(2);
  while (std::chrono::steady_clock::now() < deadline) {
    waiting = txn.exec("select count(*) from pg_locks where relation='gym_note_saves'::regclass and mode='RowExclusiveLock' and not granted")[0][0].as<int>();
    if (waiting == 1) break;
    std::this_thread::sleep_for(std::chrono::milliseconds(5));
  }
  CHECK_EQ(waiting, 1);
  // While the receipt insert is held up, readers must never see an admitted note without its
  // replay receipt. Both editor writes and deletes must queue until the whole save commits.
  CHECK(notes.notes(h.user).empty());
  CHECK(!notes.noteSave(h.user, incoming.id));
  auto change = std::async(std::launch::async, [&] {
    if (remove) notes.deleteNote(h.user, incoming.id);
    else CHECK(notes.saveNote(Note{incoming.id, h.user, "Edited", "Changed"}).note);
  });
  CHECK_EQ(change.wait_for(std::chrono::milliseconds(50)), std::future_status::timeout);
  txn.commit();
  const auto saved = save.get();
  change.get();
  REQUIRE(saved.note);
  CHECK_EQ(saved.note->title, incoming.title);
  CHECK_EQ(saved.note->body, incoming.body);
  CHECK_EQ(notes.noteSave(h.user, incoming.id), saved.note);
  CHECK_EQ(notes.saveInsight(incoming).note, saved.note);
  const auto standing = notes.notes(h.user);
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
  if (!std::getenv("WM_PG_TEST")) SKIP("requires WM_PG_TEST");
  insightReceiptRace(false);
}

TEST(gym_record_engine_insight_note_and_receipt_are_atomic_during_concurrent_delete) {
  if (!std::getenv("WM_PG_TEST")) SKIP("requires WM_PG_TEST");
  insightReceiptRace(true);
}

TEST(gym_record_engine_insight_receipt_failure_rolls_back_note_and_scope) {
  if (!std::getenv("WM_PG_TEST")) SKIP("requires WM_PG_TEST");
  doortest::Harness h;
  doortest::EngineSwitch enabled;
  NotesService notes{h.notes, h.clock, &h.door};
  FailingInsightReceipt inject;
  const Note incoming{NoteId{"note_atomic1"}, h.user, "Constraint", "Keep sessions short"};
  bool failed = false;
  try { notes.saveInsight(incoming); }
  catch (const std::runtime_error&) { failed = true; }
  CHECK(failed);
  CHECK(notes.notes(h.user).empty());
  CHECK(!notes.noteSave(h.user, incoming.id));
  PgLease lease{*doortest::pool()};
  pqxx::work txn{*lease};
  CHECK_EQ(txn.exec("select count(*) from sync_scopes where key=$1", pqxx::params{"acct:" + h.user.str() + "/gym"})[0][0].as<int>(), 0);
  CHECK_EQ(h.failures.messages.size(), 1U);
}

TEST(gym_record_engine_insight_duplicate_receipt_reserves_alias_for_feed_and_replicas) {
  if (!std::getenv("WM_PG_TEST")) SKIP("requires WM_PG_TEST");
  doortest::Harness h;
  doortest::EngineSwitch enabled;
  NotesService notes{h.notes, h.clock, &h.door};
  const auto original = notes.saveInsight(Note{NoteId{"note_original1"}, h.user, "Constraint", "Same text"});
  REQUIRE(original.note);
  const Note duplicate{NoteId{"note_duplicate1"}, h.user, "Constraint", "Same text"};
  CHECK_EQ(notes.saveInsight(duplicate).note, original.note);
  CHECK_EQ(notes.noteSave(h.user, duplicate.id), original.note);
  const auto state = [&] {
    PgLease lease{*doortest::pool()};
    pqxx::work txn{*lease};
    return txn.exec("select seq,(select seq from sync_spent where scope_key=$1 and type='note' and id=$2) as alias_seq from sync_scopes where key=$1", pqxx::params{"acct:" + h.user.str() + "/gym", duplicate.id.str()});
  };
  const auto reserved = state();
  REQUIRE_EQ(reserved.size(), 1U);
  CHECK_EQ(reserved[0]["seq"].as<int>(), 2);
  CHECK_EQ(reserved[0]["alias_seq"].as<int>(), 2);
  CHECK_EQ(notes.saveInsight(duplicate).note, original.note);
  CHECK_EQ(state()[0]["seq"].as<int>(), 2);
  engine::PgGymBackfill backfill{doortest::pool()};
  const auto audited = backfill.auditCurrent(h.user.str());
  REQUIRE_EQ(audited.size(), 1U);
  CHECK(audited[0]["audit"].asBool());
  REQUIRE(notes.saveNote(Note{NoteId{"note_nextwrite1"}, h.user, "Next", "Other text"}).note);
  CHECK_EQ(state()[0]["seq"].as<int>(), 3);
  CHECK(backfill.auditCurrent(h.user.str())[0]["audit"].asBool());

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
  CHECK_EQ(notes.notes(h.user).size(), 2U);
  CHECK(backfill.auditCurrent(h.user.str())[0]["audit"].asBool());
  CHECK(h.failures.messages.empty());
}

TEST(gym_record_engine_insight_receipt_failure_rolls_back_alias_reservation_and_retry) {
  if (!std::getenv("WM_PG_TEST")) SKIP("requires WM_PG_TEST");
  doortest::Harness h;
  doortest::EngineSwitch enabled;
  NotesService notes{h.notes, h.clock, &h.door};
  const auto original = notes.saveNote(Note{NoteId{"note_original1"}, h.user, "Constraint", "Same text"});
  REQUIRE(original.note);
  const Note duplicate{NoteId{"note_duplicate1"}, h.user, "Constraint", "Same text"};
  {
    FailingInsightReceipt inject;
    bool failed = false;
    try { notes.saveInsight(duplicate); }
    catch (const std::runtime_error&) { failed = true; }
    CHECK(failed);
  }
  CHECK_EQ(notes.notes(h.user), std::vector<Note>{*original.note});
  CHECK(!notes.noteSave(h.user, duplicate.id));
  {
    PgLease lease{*doortest::pool()};
    pqxx::work txn{*lease};
    CHECK_EQ(txn.exec("select seq from sync_scopes where key=$1", pqxx::params{"acct:" + h.user.str() + "/gym"})[0][0].as<int>(), 1);
    CHECK_EQ(txn.exec("select count(*) from sync_spent where type='note' and id=$1", pqxx::params{duplicate.id.str()})[0][0].as<int>(), 0);
  }
  CHECK_EQ(notes.saveInsight(duplicate).note, original.note);
  engine::PgGymBackfill backfill{doortest::pool()};
  CHECK(backfill.auditCurrent(h.user.str())[0]["audit"].asBool());
  CHECK_EQ(h.failures.messages.size(), 1U);
}

TEST(gym_record_engine_server_spent_batch_has_one_sequence_result_and_publication) {
  if (!std::getenv("WM_PG_TEST")) SKIP("requires WM_PG_TEST");
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
  auto scopeIntent = GymDoor::intent();
  scopeIntent["cmd"]["name"] = "gym.closeStale";
  scopeIntent["cmd"]["args"] = Json::Value(Json::objectValue);
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
  engine::PgGymBackfill backfill{doortest::pool()};
  CHECK(backfill.auditCurrent(h.user.str())[0]["audit"].asBool());
  CHECK(h.failures.messages.empty());
}

TEST(gym_record_engine_weighin_whole_put_and_preferences_keep_sql_reads) {
  if (!std::getenv("WM_PG_TEST")) SKIP("requires WM_PG_TEST");
  doortest::Harness h;
  doortest::EngineSwitch enabled;
  BodyweightService weight{h.bodyweight, &h.door};
  PreferencesService preferences{h.preferences, &h.door};
  const Bodyweight original{h.user, "2023-11-14", 80.0, h.clock.now};
  CHECK_EQ(weight.save(original), original);
  CHECK_EQ(weight.save(Bodyweight{h.user, original.dateLocal, 70.0, h.clock.now - 1}), original);
  const Bodyweight corrected{h.user, original.dateLocal, 81.0, h.clock.now + 1};
  CHECK_EQ(weight.save(corrected), corrected);
  weight.remove(h.other, original.dateLocal);
  CHECK_EQ(weight.latest(h.user), std::optional(corrected));
  weight.remove(h.user, original.dateLocal);
  CHECK(!weight.latest(h.user));
  CHECK_EQ(weight.save(original), original);
  const GymPreferences incoming{h.user, Unit::lb, 120, false, false, true};
  CHECK_EQ(preferences.savePreferences(incoming), incoming);
  CHECK_EQ(preferences.preferences(h.user), incoming);
  CHECK_EQ(preferences.preferences(h.other), GymPreferences{h.other});
}

TEST(gym_record_engine_weighin_translates_bad_instant_to_forecast_sentence) {
  if (!std::getenv("WM_PG_TEST")) SKIP("requires WM_PG_TEST");
  doortest::Harness h;
  doortest::EngineSwitch enabled;
  BodyweightService weight{h.bodyweight, &h.door};
  bool refused = false;
  try {
    weight.save(Bodyweight{h.user, "2023-11-16", 80.0, h.clock.now});
  } catch (const InvalidTraining& error) {
    refused = true;
    CHECK_EQ(std::string(error.what()), "A weigh-in is not a forecast — today or earlier.");
  }
  CHECK(refused);
  CHECK(!weight.latest(h.user));
}

TEST(gym_record_engine_d3_door_and_replica_weighins_follow_whole_put_stamp_order) {
  if (!std::getenv("WM_PG_TEST")) SKIP("requires WM_PG_TEST");
  doortest::Harness h;
  doortest::EngineSwitch enabled;
  BodyweightService weight{h.bodyweight, &h.door};
  const Bodyweight doorReading{h.user, "2023-11-14", 80.0, h.clock.now - 100};
  CHECK_EQ(weight.save(doorReading), doorReading);
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
    auto delta = GymDoor::delta("weighin", doorReading.dateLocal, fields, true);
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
  CHECK_EQ(weight.latest(h.user), std::optional(doorReading));
  const Bodyweight replicaReading{h.user, doorReading.dateLocal, 91.0, h.clock.now + 100};
  const auto newer = admit(put(h.clock.now + 1, replicaReading.weightKg, replicaReading.recordedAtMs), 2);
  REQUIRE_EQ(newer["s"].asString(), "ok");
  CHECK_EQ(weight.latest(h.user), std::optional(replicaReading));
  const auto seq = [&] {
    PgLease lease{*doortest::pool()}; pqxx::work txn{*lease};
    return txn.exec("select seq from sync_scopes where key=$1", pqxx::params{"acct:" + h.user.str() + "/gym"})[0][0].as<long long>();
  };
  const auto before = seq();
  CHECK_EQ(weight.save(Bodyweight{h.user, doorReading.dateLocal, 70.0, h.clock.now + 99}), replicaReading);
  CHECK_EQ(seq(), before);
  CHECK(h.failures.messages.empty());
}

TEST(gym_record_engine_insight_global_receipt_race_has_one_owner_and_snapshot) {
  if (!std::getenv("WM_PG_TEST")) SKIP("requires WM_PG_TEST");
  doortest::Harness h;
  doortest::EngineSwitch enabled;
  NotesService notes{h.notes, h.clock, &h.door};
  const auto ownerNote = notes.saveNote(Note{NoteId{"note_user001"}, h.user, "Constraint", "Same text"});
  const auto otherNote = notes.saveNote(Note{NoteId{"note_other01"}, h.other, "Constraint", "Same text"});
  REQUIRE(ownerNote.note);
  REQUIRE(otherNote.note);
  PgLease lease{*doortest::pool()};
  pqxx::work txn{*lease};
  txn.exec("lock table gym_note_saves in share mode");
  const NoteId receiptId{"note_race001"};
  auto owner = std::async(std::launch::async, [&] { return notes.saveInsight(Note{receiptId, h.user, "Constraint", "Same text"}); });
  auto other = std::async(std::launch::async, [&] { return notes.saveInsight(Note{receiptId, h.other, "Constraint", "Same text"}); });
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
    CHECK_EQ(ownerResult.note, ownerNote.note);
    CHECK_EQ(notes.noteSave(h.user, receiptId), ownerNote.note);
    CHECK(!notes.noteSave(h.other, receiptId));
  } else {
    CHECK_EQ(otherResult.note, otherNote.note);
    CHECK_EQ(notes.noteSave(h.other, receiptId), otherNote.note);
    CHECK(!notes.noteSave(h.user, receiptId));
  }
  CHECK(h.failures.messages.empty());
}
