#include "test/products/gym/adapters/http/GymApiFixture.h"
#include "test/products/gym/sync/adapters/postgres/GymDoorFixture.h"
#include "products/gym/adapters/postgres/PgAskThreadRepository.h"
#include "products/gym/application/AskService.h"

#include <cstdlib>
#include <set>

using namespace wm;
using namespace wm::fake;
using namespace wm::gym;
using namespace wm::gym::apitest;

namespace {

struct DoorApis : doortest::Harness {
  FakeAuthRepository authRepo;
  FakeEmail email;
  FakeOAuthRepository oauthRepo;
  OAuthService oauth{oauthRepo, tokens, clock};
  FakeAccountFootprint footprint;
  FakeSessionRevocations revocations;
  std::shared_ptr<AuthService> auth = std::make_shared<AuthService>(authRepo, email, tokens, clock, oauth, footprint, revocations, "https://windmill.works");
  std::shared_ptr<TrainingService> trainingService = std::make_shared<TrainingService>(log, program, clock, tokens, &door);
  std::shared_ptr<CatalogService> catalogService = std::make_shared<CatalogService>(catalog, &door);
  std::shared_ptr<ProgramService> programService = std::make_shared<ProgramService>(program, clock, &door);
  std::shared_ptr<NotesService> notesService = std::make_shared<NotesService>(notes, clock, &door);
  std::shared_ptr<BodyweightService> bodyweightService = std::make_shared<BodyweightService>(bodyweight, &door);
  std::shared_ptr<PreferencesService> preferencesService = std::make_shared<PreferencesService>(preferences, &door);
  PgAskThreadRepository threadRepository{doortest::pool()};
  std::shared_ptr<ThreadService> threadService = std::make_shared<ThreadService>(threadRepository, clock, &door);
  TrainingApi trainingApi{trainingService, auth, "https://windmill.works"};
  CatalogApi catalogApi{catalogService, trainingService, auth};
  ProgramApi programApi{programService, auth};
  NotesApi notesApi{notesService, auth};
  BodyweightApi bodyweightApi{bodyweightService, auth, clock};
  PreferencesApi preferencesApi{preferencesService, auth};
  ThreadsApi threadsApi{threadService, auth};
  GymTools tools{*trainingService, *catalogService, *programService, *notesService, *bodyweightService, "https://windmill.works"};

  DoorApis() {
    const User account{user, Email{"gym-door@example.com"}, "Lifter", std::nullopt};
    authRepo.usersById.emplace(user.str(), account);
    authRepo.usersByEmail.emplace(account.email.value, account);
    authRepo.insertSession(tokens.digestOf("s-door"), user, clock.now + 1000000, "", "", clock.now);
  }

  long long seq() {
    PgLease lease{*doortest::pool()};
    pqxx::work txn{*lease};
    const auto rows = txn.exec_params("select coalesce((select seq from sync_scopes where key=$1),0)", "acct:" + user.str() + "/gym");
    return rows[0][0].as<long long>();
  }

  ToolResult call(const std::string& name, const Json::Value& args) {
    return tools.callTool(name, args, ToolCaller{user, ToolScope::everything(), ToolConnection{"cli_gymdoor", "Gym door test"}});
  }
};

Json::Value sessionArgs(const std::string& id) {
  Json::Value args(Json::objectValue);
  args["sessionId"] = id;
  return args;
}

}

TEST(gym_engine_real_mcp_write_catalog_admits_synced_records_and_keeps_shares) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  doortest::EngineSwitch engine;
  DoorApis h;
  std::set<std::string> written;
  const auto admit = [&](const std::string& name, const Json::Value& args, bool synced = true) {
    const auto before = h.seq();
    const auto result = h.call(name, args);
    CHECK_FALSE(result.isError);
    if (result.isError) std::cerr << result.content[0]["text"].asString() << "\n";
    if (synced) CHECK(h.seq() > before);
    else CHECK_EQ(h.seq(), before);
    written.insert(name);
    return result;
  };
  admit("create_exercise", exerciseBody("ex_door0001"));
  admit("create_routine", routineBody("rt_door0001"));
  Json::Value note(Json::objectValue);
  note["id"] = "note_door001";
  note["title"] = "Goal";
  note["body"] = "Build strength";
  admit("save_note", note);
  const auto started = admit("start_session", startBody("ses_door0001", h.clock.now - 120000));
  CHECK_EQ(started.payload["id"].asString(), "ses_door0001");
  Json::Value set = setBody("set_door0001", "bench-press", 80, h.clock.now - 100000);
  set["sessionId"] = "ses_door0001";
  admit("log_set", set);
  Json::Value batch = sessionArgs("ses_door0001");
  batch["sets"] = Json::Value(Json::arrayValue);
  batch["sets"].append(setBody("set_door0002", "bench-press", 82.5, h.clock.now - 80000));
  admit("log_sets", batch);
  Json::Value finish = sessionArgs("ses_door0001");
  finish["finishedAt"] = Json::UInt64(h.clock.now - 60000);
  admit("finish_session", finish);
  const auto shared = admit("share_session", sessionArgs("ses_door0001"), false);
  REQUIRE(shared.payload["token"].isString());
  CHECK(h.log.sharedSession(shared.payload["token"].asString(), h.clock.now));
  admit("revoke_share", sessionArgs("ses_door0001"), false);
  CHECK_FALSE(h.log.sharedSession(shared.payload["token"].asString(), h.clock.now));
  Json::Value proposal = routineBody("prop_door001", "Push B");
  proposal["routineId"] = "rt_door0001";
  proposal["summary"] = "Adjust the day";
  admit("propose_routine_change", proposal);
  Json::Value removal(Json::objectValue);
  removal["id"] = "prop_door002";
  removal["routineId"] = "rt_door0001";
  removal["summary"] = "Remove the day";
  admit("propose_routine_removal", removal);
  Json::Value imported = startBody("ses_door0002", h.clock.now - 600000);
  imported["finishedAt"] = Json::UInt64(h.clock.now - 500000);
  imported["sets"] = Json::Value(Json::arrayValue);
  imported["sets"].append(setBody("set_door0003", "bench-press", 70, h.clock.now - 550000));
  admit("import_session", imported);
  admit("discard_session", sessionArgs("ses_door0001"));
  for (const auto& tool : h.tools.declareTools())
    if (tool.access != Access::read) CHECK(written.contains(tool.name()));
  CHECK_EQ(written.size(), std::size_t{13});
  PgLease lease{*doortest::pool()};
  pqxx::work txn{*lease};
  const auto spent = txn.exec_params("select type,id from sync_spent where scope_key=$1 order by type,id", "acct:" + h.user.str() + "/gym");
  CHECK_EQ(spent.size(), std::size_t{3});
  const auto metadata = txn.exec("select seq,born,name_stamp from gym_routines where id='rt_door0001'");
  REQUIRE_EQ(metadata.size(), std::size_t{1});
  CHECK(metadata[0]["seq"].as<long long>() > 0);
  CHECK_FALSE(metadata[0]["born"].is_null());
  CHECK_FALSE(metadata[0]["name_stamp"].is_null());
  CHECK(h.failures.messages.empty());
}

TEST(gym_engine_real_rest_writes_use_typed_projection_and_preserve_error_envelopes) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  doortest::EngineSwitch engine;
  DoorApis h;
  CHECK_EQ(send(h.catalogApi, &CatalogApi::createExercise, postRequest("/v1/gym/exercises", exerciseBody("ex_rest0001"), "s-door"))->getStatusCode(), drogon::k200OK);
  CHECK_EQ(send(h.catalogApi, &CatalogApi::renameExercise, patchRequest("/v1/gym/exercises/bench-press", renameBody("Barbell Bench"), "s-door"), "bench-press")->getStatusCode(), drogon::k200OK);
  CHECK_EQ(send(h.programApi, &ProgramApi::createRoutine, postRequest("/v1/gym/routines", routineBody("rt_rest0001"), "s-door"))->getStatusCode(), drogon::k200OK);
  CHECK_EQ(send(h.programApi, &ProgramApi::replaceRoutine, putRequest("/v1/gym/routines/rt_rest0001", routineBody("rt_rest0001", "Push B"), "s-door"), "rt_rest0001")->getStatusCode(), drogon::k200OK);
  Json::Value note(Json::objectValue);
  note["title"] = "Goal";
  note["body"] = "Build strength";
  CHECK_EQ(send(h.notesApi, &NotesApi::saveNote, putRequest("/v1/gym/notes/note_rest001", note, "s-door"), "note_rest001")->getStatusCode(), drogon::k200OK);
  Json::Value order(Json::objectValue);
  order["order"] = Json::Value(Json::arrayValue);
  order["order"].append("note_rest001");
  CHECK_EQ(send(h.notesApi, &NotesApi::reorderNotes, putRequest("/v1/gym/notes", order, "s-door"))->getStatusCode(), drogon::k200OK);
  Json::Value weight(Json::objectValue);
  weight["weightKg"] = 80;
  weight["recordedAt"] = Json::UInt64(h.clock.now);
  CHECK_EQ(send(h.bodyweightApi, &BodyweightApi::saveEntry, putRequest("/v1/gym/bodyweight/2023-11-14", weight, "s-door"), "2023-11-14")->getStatusCode(), drogon::k200OK);
  CHECK_EQ(send(h.preferencesApi, &PreferencesApi::savePreferences, putRequest("/v1/gym/preferences", Json::Value(Json::objectValue), "s-door"))->getStatusCode(), drogon::k200OK);
  const auto started = send(h.trainingApi, &TrainingApi::startSession, postRequest("/v1/gym/sessions", startBody("ses_rest0001", h.clock.now - 120000), "s-door"));
  REQUIRE_EQ(started->getStatusCode(), drogon::k200OK);
  CHECK_EQ(send(h.trainingApi, &TrainingApi::appendSet, postRequest("/v1/gym/sessions/ses_rest0001/sets", setBody("set_rest0001", "bench-press", 80, h.clock.now - 100000), "s-door"), "ses_rest0001")->getStatusCode(), drogon::k200OK);
  Json::Value fix(Json::objectValue);
  fix["weightKg"] = 82.5;
  CHECK_EQ(send(h.trainingApi, &TrainingApi::fixSet, patchRequest("/v1/gym/sessions/ses_rest0001/sets/set_rest0001", fix, "s-door"), "ses_rest0001", "set_rest0001")->getStatusCode(), drogon::k200OK);
  CHECK_EQ(send(h.trainingApi, &TrainingApi::deleteSet, deleteRequest("/v1/gym/sessions/ses_rest0001/sets/set_rest0001", "s-door"), "ses_rest0001", "set_rest0001")->getStatusCode(), drogon::k204NoContent);
  const auto deletedSet = send(h.trainingApi, &TrainingApi::appendSet, postRequest("/v1/gym/sessions/ses_rest0001/sets", setBody("set_rest0001", "bench-press", 80, h.clock.now - 100000), "s-door"), "ses_rest0001");
  CHECK_EQ(deletedSet->getStatusCode(), drogon::k409Conflict);
  CHECK_EQ(dump(bodyOf(deletedSet)), std::string(R"({"code":"set-deleted","error":"that set was deleted"})"));
  CHECK_EQ(send(h.trainingApi, &TrainingApi::finishSession, postRequest("/v1/gym/sessions/ses_rest0001/finish", finishBody(h.clock.now - 60000), "s-door"), "ses_rest0001")->getStatusCode(), drogon::k200OK);
  CHECK_EQ(send(h.trainingApi, &TrainingApi::discardSession, deleteRequest("/v1/gym/sessions/ses_rest0001", "s-door"), "ses_rest0001")->getStatusCode(), drogon::k204NoContent);
  CHECK_EQ(send(h.notesApi, &NotesApi::deleteNote, deleteRequest("/v1/gym/notes/note_rest001", "s-door"), "note_rest001")->getStatusCode(), drogon::k204NoContent);
  CHECK_EQ(send(h.bodyweightApi, &BodyweightApi::deleteEntry, deleteRequest("/v1/gym/bodyweight/2023-11-14", "s-door"), "2023-11-14")->getStatusCode(), drogon::k204NoContent);
  CHECK_EQ(send(h.programApi, &ProgramApi::deleteRoutine, deleteRequest("/v1/gym/routines/rt_rest0001", "s-door"), "rt_rest0001")->getStatusCode(), drogon::k204NoContent);
  CHECK(h.seq() > 12);
  CHECK(h.failures.messages.empty());
}

TEST(gym_engine_real_coach_records_keep_provenance_and_thread_delete_admits_unlink) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  doortest::EngineSwitch engine;
  DoorApis h;
  const ThreadId thread{"thr_doormcp01"};
  REQUIRE_EQ(h.threadService->openThread(h.user, thread, "Strength plan").error, ThreadOpenError::none);
  AskGeneration generation;
  generation.id = "gen_doorcoach";
  generation.requestId = "req_doorcoach";
  generation.atMs = h.clock.now;
  h.threadRepository.saveGeneration(h.user, thread, generation);
  AskTools coach{h.tools, thread, &h.threadRepository, &generation};
  const ToolCaller caller{h.user, ToolScope::everything()};
  REQUIRE(!coach.callTool("list_notes", Json::Value(Json::objectValue), caller).isError);
  REQUIRE(!coach.callTool("list_exercises", Json::Value(Json::objectValue), caller).isError);
  const auto created = coach.callTool("create_routine", routineBody("rt_unused001"), caller);
  REQUIRE(!created.isError);
  const auto routineId = created.payload["id"].asString();
  CHECK_EQ(routineId, "rt_gen_doorcoach");
  Json::Value note(Json::objectValue);
  note["title"] = "Goal";
  note["body"] = "Build strength";
  REQUIRE(!coach.callTool("save_note", note, caller).isError);
  AskTools proposals{h.tools, thread};
  Json::Value proposal = routineBody("prop_coach001", "Push B");
  proposal.removeMember("position");
  proposal["routineId"] = routineId;
  REQUIRE(!proposals.callTool("propose_routine_change", proposal, caller).isError);
  const auto stored = h.programService->proposal(h.user, ProposalId{"prop_coach001"});
  REQUIRE(stored);
  CHECK_EQ(stored->head.source.door, ProposalDoor::ask);
  CHECK_EQ(stored->head.source.thread, std::optional<ThreadId>{thread});
  const auto before = h.seq();
  auto lease = h.threadRepository.tryLease(h.user, thread);
  REQUIRE(lease);
  const auto busy = send(h.threadsApi, &ThreadsApi::deleteThread, deleteRequest("/v1/gym/threads/" + thread.str(), "s-door"), thread.str());
  CHECK_EQ(busy->getStatusCode(), drogon::k409Conflict);
  CHECK_EQ(h.seq(), before);
  CHECK_EQ(h.programService->proposal(h.user, ProposalId{"prop_coach001"})->head.source.thread, std::optional<ThreadId>{thread});
  lease.reset();
  const auto removed = send(h.threadsApi, &ThreadsApi::deleteThread, deleteRequest("/v1/gym/threads/" + thread.str(), "s-door"), thread.str());
  REQUIRE_EQ(removed->getStatusCode(), drogon::k204NoContent);
  CHECK(h.seq() > before);
  CHECK_FALSE(h.threadService->thread(h.user, thread));
  const auto orphan = h.programService->proposal(h.user, ProposalId{"prop_coach001"});
  REQUIRE(orphan);
  CHECK_FALSE(orphan->head.source.thread);
  PgLease connection{*doortest::pool()};
  pqxx::work txn{*connection};
  const auto metadata = txn.exec_params("select created_door,created_door_stamp from gym_routines where id=$1", routineId);
  REQUIRE_EQ(metadata.size(), std::size_t{1});
  CHECK_EQ(metadata[0]["created_door"].as<std::string>(), "ask");
  CHECK_FALSE(metadata[0]["created_door_stamp"].is_null());
  const auto unlink = txn.exec("select thread_id,thread_id_stamp from gym_proposals where id='prop_coach001'");
  REQUIRE_EQ(unlink.size(), std::size_t{1});
  CHECK(unlink[0]["thread_id"].is_null());
  CHECK_FALSE(unlink[0]["thread_id_stamp"].is_null());
  CHECK(h.failures.messages.empty());
}

TEST(gym_engine_real_freeze_reads_never_admit_the_stale_close) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  doortest::EngineSwitch engine;
  DoorApis h;
  const auto started = h.trainingService->start(h.user, SessionStart{SessionId{"ses_freeze001"}, h.clock.now - kAutoCloseMs - 1});
  REQUIRE_EQ(started.error, StartError::none);
  REQUIRE(started.session);
  REQUIRE(!started.session->finishedAtMs);
  const auto before = h.seq();
  struct Freeze {
    std::optional<std::string> previous;
    Freeze() {
      if (const char* held = std::getenv("GYM_WRITE_FREEZE")) previous = held;
      setenv("GYM_WRITE_FREEZE", "1", 1);
    }
    ~Freeze() {
      if (previous) { setenv("GYM_WRITE_FREEZE", previous->c_str(), 1); return; }
      unsetenv("GYM_WRITE_FREEZE");
    }
  } freeze;
  const auto request = getRequest("/v1/gym/read", "s-door");
  CHECK_EQ(send(h.trainingApi, &TrainingApi::listSessions, request)->getStatusCode(), drogon::k200OK);
  CHECK_EQ(send(h.trainingApi, &TrainingApi::getSession, request, "ses_freeze001")->getStatusCode(), drogon::k200OK);
  CHECK_EQ(send(h.trainingApi, &TrainingApi::stats, request)->getStatusCode(), drogon::k200OK);
  CHECK_EQ(send(h.trainingApi, &TrainingApi::history, request)->getStatusCode(), drogon::k200OK);
  CHECK_EQ(send(h.catalogApi, &CatalogApi::exerciseRecord, request, "bench-press")->getStatusCode(), drogon::k200OK);
  CHECK_FALSE(h.call("list_sessions", Json::Value(Json::objectValue)).isError);
  CHECK_FALSE(h.call("get_session", sessionArgs("ses_freeze001")).isError);
  Json::Value ids(Json::objectValue);
  ids["sessionIds"] = Json::Value(Json::arrayValue);
  ids["sessionIds"].append("ses_freeze001");
  CHECK_FALSE(h.call("get_sessions", ids).isError);
  CHECK_FALSE(h.call("get_stats", Json::Value(Json::objectValue)).isError);
  CHECK(h.trainingService->openSession(h.user));
  CHECK_EQ(h.seq(), before);
  const auto current = h.log.session(h.user, SessionId{"ses_freeze001"});
  REQUIRE(current);
  CHECK_FALSE(current->finishedAtMs);
  CHECK(h.failures.messages.empty());
}
