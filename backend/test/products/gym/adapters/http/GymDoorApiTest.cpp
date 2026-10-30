#include "test/products/gym/adapters/http/GymApiFixture.h"
#include "test/products/gym/sync/GymDoorFixture.h"
#include "products/gym/adapters/postgres/PgAskThreadRepository.h"
#include "products/gym/application/AskService.h"

#include "platform/adapters/http/WriteRoutes.h"

#include <cstdlib>
#include <future>
#include <set>
#include <string>
#include <vector>

using namespace wm;
using namespace wm::fake;
using namespace wm::gym;
using namespace wm::gym::apitest;

namespace {

Json::Value sessionArgs(const std::string& id) {
  Json::Value args(Json::objectValue);
  args["sessionId"] = id;
  return args;
}

}

TEST(gym_engine_real_mcp_write_catalog_admits_synced_records_and_keeps_shares) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
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
  admit("update_exercise", parse(R"({"exerciseId":"bench-press","equipment":"dumbbell","loadCount":2})"));
  Json::Value start = startBody("ses_door0001", h.clock.now - 120000);
  start["routineId"] = "rt_door0001";
  const auto started = admit("start_session", start);
  CHECK_EQ(started.payload["id"].asString(), "ses_door0001");
  Json::Value set = setBody("set_door0001", "bench-press", 80, h.clock.now - 100000);
  set["sessionId"] = "ses_door0001";
  admit("log_set", set);
  Json::Value batch = sessionArgs("ses_door0001");
  batch["sets"] = Json::Value(Json::arrayValue);
  batch["sets"].append(setBody("set_door0002", "bench-press", 82.5, h.clock.now - 80000));
  admit("log_sets", batch);
  Json::Value workout(Json::objectValue);
  workout["id"] = "prop_door003";
  workout["sessionId"] = "ses_door0001";
  workout["entries"] = routineBody("rt_door0001")["entries"];
  workout["entries"].append(parse(R"({"exerciseId":"back-squat"})"));
  admit("propose_workout_change", workout);
  Json::Value finish = sessionArgs("ses_door0001");
  finish["finishedAt"] = Json::UInt64(h.clock.now - 60000);
  admit("finish_session", finish);
  const auto shared = admit("share_session", sessionArgs("ses_door0001"), false);
  REQUIRE(shared.payload["token"].isString());
  CHECK(h.repo.log.sharedSession(shared.payload["token"].asString(), h.clock.now));
  admit("revoke_share", sessionArgs("ses_door0001"), false);
  CHECK_FALSE(h.repo.log.sharedSession(shared.payload["token"].asString(), h.clock.now));
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
  CHECK_EQ(written.size(), std::size_t{15});
  PgLease lease{*doortest::pool()};
  pqxx::work txn{*lease};
  const auto spent = txn.exec_params("select type,id from sync_spent where scope_key=$1 order by type,id", "acct:" + h.user.str() + "/gym");
  // The discarded workout, its two sets and the workout proposal it killed.
  CHECK_EQ(spent.size(), std::size_t{4});
  const auto metadata = txn.exec("select seq,born,name_stamp from gym_routines where id='rt_door0001'");
  REQUIRE_EQ(metadata.size(), std::size_t{1});
  CHECK(metadata[0]["seq"].as<long long>() > 0);
  CHECK_FALSE(metadata[0]["born"].is_null());
  CHECK_FALSE(metadata[0]["name_stamp"].is_null());
  CHECK(h.failures.messages.empty());
}

TEST(gym_engine_real_coach_records_keep_provenance_and_thread_delete_admits_unlink) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  DoorApis h;
  const ThreadId thread{"thr_doormcp01"};
  REQUIRE_EQ(h.threads.openThread(h.user, thread, "Strength plan").error, ThreadOpenError::none);
  AskGeneration generation;
  generation.id = "gen_doorcoach";
  generation.requestId = "req_doorcoach";
  generation.routineReview = true;
  generation.atMs = h.clock.now;
  h.repo.threads.saveGeneration(h.user, thread, generation);
  AskTools coach{h.tools, thread, &h.repo.threads, &generation};
  const ToolCaller caller{h.user, ToolScope::everything()};
  REQUIRE(!coach.callTool("list_notes", Json::Value(Json::objectValue), caller).isError);
  REQUIRE(!coach.callTool("list_exercises", Json::Value(Json::objectValue), caller).isError);
  const auto created = coach.callTool("create_routine", routineBody("rt_unused001"), caller);
  REQUIRE(!created.isError);
  const auto routineId = created.payload["id"].asString();
  CHECK_EQ(routineId, "rt_gen_doorcoach_0");
  CHECK(h.repo.program.routines(h.user).empty());
  FakeSubscriptionRepository subscriptions;
  FakeAiUsageRepository usage;
  Entitlements entitlements{subscriptions, usage};
  FakeAsk agent;
  AskService service{h.training, h.repo.threads, h.clock, agent, h.tools, entitlements};
  generation.status = "completed";
  h.repo.threads.saveGeneration(h.user, thread, generation);
  REQUIRE(service.confirmRoutine(h.user, thread, generation.requestId, generation.routineDrafts.front().operationId).generation);
  Json::Value note(Json::objectValue);
  note["id"] = "note_doorcoach";
  note["title"] = "Goal";
  note["body"] = "Build strength";
  REQUIRE(!coach.callTool("save_note", note, caller).isError);
  AskTools proposals{h.tools, thread};
  Json::Value proposal = routineBody("prop_coach001", "Push B");
  proposal.removeMember("position");
  proposal["routineId"] = routineId;
  REQUIRE(!proposals.callTool("propose_routine_change", proposal, caller).isError);
  const auto stored = h.repo.program.proposal(h.user, ProposalId{"prop_coach001"});
  REQUIRE(stored);
  CHECK_EQ(stored->head.source.door, ProposalDoor::ask);
  CHECK_EQ(stored->head.source.thread, std::optional<ThreadId>{thread});
  const auto before = h.seq();
  auto lease = h.repo.threads.tryLease(h.user, thread);
  REQUIRE(lease);
  const auto busy = send(h.threadsApi, &ThreadsApi::deleteThread, deleteRequest("/v1/gym/threads/" + thread.str(), "s-door"), thread.str());
  CHECK_EQ(busy->getStatusCode(), drogon::k409Conflict);
  CHECK_EQ(h.seq(), before);
  CHECK_EQ(h.repo.program.proposal(h.user, ProposalId{"prop_coach001"})->head.source.thread, std::optional<ThreadId>{thread});
  lease.reset();
  const auto removed = send(h.threadsApi, &ThreadsApi::deleteThread, deleteRequest("/v1/gym/threads/" + thread.str(), "s-door"), thread.str());
  REQUIRE_EQ(removed->getStatusCode(), drogon::k204NoContent);
  CHECK(h.seq() > before);
  CHECK_FALSE(h.threads.thread(h.user, thread));
  const auto orphan = h.repo.program.proposal(h.user, ProposalId{"prop_coach001"});
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

// The confirmation route answers each outcome with its code, and the door's write line carries the route's
// request id although the save runs on the upload pool.
TEST(gym_engine_coach_confirmation_route_answers_each_outcome_under_one_request_id) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  DoorApis h;
  const ThreadId thread{"thr_doorconf1"};
  REQUIRE_EQ(h.threads.openThread(h.user, thread, "Upper day").error, ThreadOpenError::none);
  AskGeneration generation;
  generation.id = "gen_doorconf";
  generation.requestId = "req_doorconf";
  generation.routineReview = true;
  generation.atMs = h.clock.now;
  h.repo.threads.saveGeneration(h.user, thread, generation);
  AskTools coach{h.tools, thread, &h.repo.threads, &generation};
  const ToolCaller caller{h.user, ToolScope::everything()};
  REQUIRE(!coach.callTool("list_notes", Json::Value(Json::objectValue), caller).isError);
  REQUIRE(!coach.callTool("list_exercises", Json::Value(Json::objectValue), caller).isError);
  REQUIRE(!coach.callTool("create_routine", routineBody("rt_unused001"), caller).isError);
  generation.status = "completed";
  h.repo.threads.saveGeneration(h.user, thread, generation);
  const auto draft = generation.routineDrafts.front();
  FakeSubscriptionRepository subscriptions;
  FakeAiUsageRepository usage;
  Entitlements entitlements{subscriptions, usage};
  FakeAsk agent;
  auto service = std::make_shared<AskService>(h.training, h.repo.threads, h.clock, agent, h.tools, entitlements);
  ThreadsApi api{doortest::borrowed(h.threads), h.auth, service};
  std::vector<WriteCompletion> completions;
  installWriteSink([&](const WriteCompletion& completion) { completions.push_back(completion); });
  const auto confirm = [&](const std::string& operationId) {
    const std::string path = "/v1/gym/threads/" + thread.str() + "/generations/req_doorconf/routines/" + operationId + "/confirm";
    const auto request = postRequest(path, Json::Value(Json::objectValue), "s-door");
    const auto observation = beginWriteRequest(request, WriteRoute{path, "gym.coach.routine.confirm", "gym", "rest", {drogon::Post}});
    std::promise<drogon::HttpResponsePtr> reply;
    api.confirmRoutine(request, [&](const drogon::HttpResponsePtr& response) { reply.set_value(response); },
                       thread.str(), "req_doorconf", operationId);
    const auto response = reply.get_future().get();
    finishWriteRequest(request, response);
    return std::pair{response, observation->requestId()};
  };

  const auto [saved, savedRequest] = confirm(draft.operationId);
  REQUIRE_EQ(saved->getStatusCode(), drogon::k200OK);
  CHECK_EQ(bodyOf(saved)["generation"]["routineDrafts"][0]["state"].asString(), std::string("saved"));
  CHECK_EQ(bodyOf(saved)["results"], toJson(std::vector<CoachResult>{{draft.operationId, draft.routineId, "Push A", 1}}));
  const auto [again, againRequest] = confirm(draft.operationId);
  CHECK_EQ(again->getStatusCode(), drogon::k200OK);
  CHECK_EQ(bodyOf(again)["results"], bodyOf(saved)["results"]);
  const auto [absent, absentRequest] = confirm("op_unknown01");
  CHECK_EQ(absent->getStatusCode(), drogon::k404NotFound);
  CHECK_EQ(bodyOf(absent)["code"].asString(), std::string("coach-draft-not-found"));
  installWriteSink({});

  std::vector<std::string> lines;
  for (const auto& completion : completions)
    lines.push_back(completion.operation + " | " + completion.outcome + " | " +
                    (completion.requestId == savedRequest ? "saved" : completion.requestId == againRequest ? "again" :
                     completion.requestId == absentRequest ? "absent" : "other"));
  CHECK_EQ(lines, (std::vector<std::string>{"auth.session.refresh | ok | other", "sync.publish | ok | saved",
      "sync.admit | ok | saved", "gym.server_call | ok | saved", "gym.coach.routine.confirm | ok | saved",
      "auth.session.refresh | ok | other", "gym.coach.routine.confirm | ok | again",
      "auth.session.refresh | ok | other", "gym.coach.routine.confirm | coach-draft-not-found | absent"}));
  CHECK_EQ(h.repo.program.routines(h.user).size(), 1u);
  CHECK(h.failures.messages.empty());
}
