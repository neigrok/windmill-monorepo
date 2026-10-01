#include "test/products/gym/adapters/http/GymApiFixture.h"
#include "products/gym/adapters/http/AskApi.h"
#include "products/gym/adapters/mcp/GymTools.h"
#include "products/gym/application/GymSwitches.h"

#include <cstdlib>
#include <functional>
#include <optional>
#include <string>
#include <vector>

using namespace wm;
using namespace wm::fake;
using namespace wm::gym;
using namespace wm::gym::fake;
using namespace wm::gym::apitest;

namespace {

struct Environment {
  std::string name;
  std::optional<std::string> previous;

  Environment(std::string name, const char* value) : name(std::move(name)) {
    if (const char* held = std::getenv(this->name.c_str())) previous = held;
    setenv(this->name.c_str(), value, 1);
  }
  ~Environment() {
    if (previous) { setenv(name.c_str(), previous->c_str(), 1); return; }
    unsetenv(name.c_str());
  }
};

void frozenReply(const drogon::HttpResponsePtr& response) {
  CHECK(response);
  if (!response) return;
  CHECK_EQ(response->getStatusCode(), drogon::k503ServiceUnavailable);
  CHECK_EQ(dump(bodyOf(response)), std::string(R"({"code":"gym-frozen","error":"gym writes are temporarily frozen"})"));
}

GymTools toolsFor(Harness& h) {
  return GymTools{*h.trainingService, *h.catalogService, *h.programService,
                  *h.notesService, *h.bodyweightService, "https://windmill.works"};
}

}

TEST(gym_freeze_refuses_every_rest_write_door_before_it_can_write) {
  for (const char* engine : {"0", "1"}) {
    Environment engineWrites("GYM_ENGINE_WRITES", engine);
    Environment freeze("GYM_WRITE_FREEZE", "1");
    Harness h;
    h.signIn("s-live");
    AskApi ask{nullptr, h.auth};
    const auto request = postRequest("/v1/gym/write", Json::Value(Json::objectValue), "s-live");
    frozenReply(send(h.training, &TrainingApi::startSession, request));
    frozenReply(send(h.training, &TrainingApi::importSession, request));
    frozenReply(send(h.training, &TrainingApi::appendSet, request, "ses_11111111"));
    frozenReply(send(h.training, &TrainingApi::fixSet, request, "ses_11111111", "set_11111111"));
    frozenReply(send(h.training, &TrainingApi::deleteSet, request, "ses_11111111", "set_11111111"));
    frozenReply(send(h.training, &TrainingApi::finishSession, request, "ses_11111111"));
    frozenReply(send(h.training, &TrainingApi::discardSession, request, "ses_11111111"));
    frozenReply(send(h.training, &TrainingApi::correctSession, request, "ses_11111111"));
    frozenReply(send(h.training, &TrainingApi::shareSession, request, "ses_11111111"));
    frozenReply(send(h.training, &TrainingApi::revokeShare, request, "ses_11111111"));
    frozenReply(send(h.training, &TrainingApi::createLogShare, request));
    frozenReply(send(h.training, &TrainingApi::revokeLogShare, request, "share_11111111"));
    frozenReply(send(h.catalog, &CatalogApi::createExercise, request));
    frozenReply(send(h.catalog, &CatalogApi::renameExercise, request, "bench-press"));
    frozenReply(send(h.program, &ProgramApi::createRoutine, request));
    frozenReply(send(h.program, &ProgramApi::replaceRoutine, request, "rt_11111111"));
    frozenReply(send(h.program, &ProgramApi::deleteRoutine, request, "rt_11111111"));
    frozenReply(send(h.program, &ProgramApi::applyProposal, request, "prop_11111111"));
    frozenReply(send(h.program, &ProgramApi::dismissProposal, request, "prop_11111111"));
    frozenReply(send(h.notes, &NotesApi::saveNote, request, "note_11111111"));
    frozenReply(send(h.notes, &NotesApi::deleteNote, request, "note_11111111"));
    frozenReply(send(h.notes, &NotesApi::reorderNotes, request));
    frozenReply(send(h.bodyweight, &BodyweightApi::saveEntry, request, "2023-11-14"));
    frozenReply(send(h.bodyweight, &BodyweightApi::deleteEntry, request, "2023-11-14"));
    frozenReply(send(h.preferences, &PreferencesApi::savePreferences, request));
    frozenReply(send(h.threads, &ThreadsApi::deleteThread, request, "thr_11111111"));
    frozenReply(send(h.threads, &ThreadsApi::putImage, request, "thr_11111111", "img_11111111"));
    frozenReply(send(h.threads, &ThreadsApi::stopGeneration, request, "thr_11111111", "req_11111111"));
    frozenReply(send(ask, &AskApi::ask, request));
    CHECK(h.repo.db.sessions.empty());
    CHECK(h.repo.db.sets.empty());
    CHECK(h.repo.db.routineRows.empty());
    CHECK(h.repo.db.proposalRows.empty());
    CHECK(h.repo.db.customs.empty());
    CHECK(h.repo.db.shares.empty());
    CHECK(h.repo.db.preferenceRows.empty());
    CHECK(h.repo.db.noteRows.empty());
    CHECK(h.repo.db.bodyweightRows.empty());
    CHECK(h.repo.db.threadRows.empty());
    CHECK(h.repo.threads.images.empty());
    CHECK(h.repo.threads.generations.empty());
  }
}

TEST(gym_freeze_refuses_every_mcp_and_coach_write_ability) {
  Environment freeze("GYM_WRITE_FREEZE", "1");
  Harness h;
  const auto user = h.signIn("s-live");
  GymTools tools = toolsFor(h);
  const ToolCaller caller{user, ToolScope::everything()};
  AskGeneration generation;
  generation.id = "gen_11111111";
  generation.requestId = "req_11111111";
  AskTools coach{tools, ThreadId{"thr_11111111"}, &h.repo.threads, &generation};
  int writes = 0;
  for (const auto& tool : tools.declareTools()) {
    if (tool.access == Access::read) continue;
    ++writes;
    const auto result = tools.callTool(tool.name(), Json::Value(Json::objectValue), caller);
    CHECK(result.isError);
    CHECK_EQ(result.content[0]["text"].asString(), tool.name() + ": gym-frozen: gym writes are temporarily frozen");
    const auto ability = coach.callTool(tool.name(), Json::Value(Json::objectValue), caller);
    CHECK(ability.isError);
    CHECK_EQ(ability.content[0]["text"].asString(), tool.name() + ": gym-frozen: gym writes are temporarily frozen");
  }
  CHECK_EQ(writes, 13);
  CHECK_FALSE(coach.callTool("list_notes", Json::Value(Json::objectValue), caller).isError);
  CHECK(h.repo.db.sessions.empty());
  CHECK(h.repo.db.routineRows.empty());
  CHECK(h.repo.db.proposalRows.empty());
  CHECK(h.repo.db.customs.empty());
  CHECK(h.repo.db.shares.empty());
  CHECK(h.repo.db.noteRows.empty());
  CHECK(h.repo.threads.generations.empty());
}

TEST(gym_freeze_reads_serve_stale_rows_without_settling_them) {
  for (const char* engine : {"0", "1"}) {
    Environment engineWrites("GYM_ENGINE_WRITES", engine);
    Harness h;
    const auto user = h.signIn("s-live");
    h.repo.db.sessions.emplace_back(SessionId{"ses_11111111"}, user, h.clock.now - kAutoCloseMs - 1);
    Environment freeze("GYM_WRITE_FREEZE", "1");
    const auto request = getRequest("/v1/gym/read", "s-live");
    CHECK_EQ(send(h.training, &TrainingApi::listSessions, request)->getStatusCode(), drogon::k200OK);
    CHECK_EQ(send(h.training, &TrainingApi::getSession, request, "ses_11111111")->getStatusCode(), drogon::k200OK);
    CHECK_EQ(send(h.training, &TrainingApi::stats, request)->getStatusCode(), drogon::k200OK);
    request->setParameter("projection", "progress");
    CHECK_EQ(send(h.training, &TrainingApi::stats, request)->getStatusCode(), drogon::k200OK);
    request->setParameter("projection", "");
    CHECK_EQ(send(h.training, &TrainingApi::history, request)->getStatusCode(), drogon::k200OK);
    CHECK_EQ(send(h.catalog, &CatalogApi::exerciseRecord, request, "bench-press")->getStatusCode(), drogon::k200OK);
    GymTools tools = toolsFor(h);
    const ToolCaller caller{user, ToolScope::everything()};
    Json::Value args(Json::objectValue);
    args["sessionId"] = "ses_11111111";
    args["sessionIds"] = Json::Value(Json::arrayValue);
    args["sessionIds"].append("ses_11111111");
    for (const auto& name : {"list_sessions", "get_session", "get_sessions", "get_stats"}) {
      const auto result = tools.callTool(name, args, caller);
      CHECK_FALSE(result.isError);
      CHECK_FALSE(h.repo.db.sessions.front().finishedAtMs);
    }
    CHECK(h.trainingService->openSession(user));
    CHECK_FALSE(h.repo.db.sessions.front().finishedAtMs);
  }
}

TEST(gym_freeze_refuses_server_coach_admission_and_thread_mutations) {
  Environment freeze("GYM_WRITE_FREEZE", "1");
  Harness h;
  const auto user = h.signIn("s-live");
  GymTools tools = toolsFor(h);
  FakeSubscriptionRepository subscriptions;
  FakeAiUsageRepository usage;
  Entitlements entitlements{subscriptions, usage};
  FakeAsk agent;
  AskService ask{*h.trainingService, h.repo.threads, h.clock, agent, tools, entitlements};
  std::optional<AskReply> reply;
  ask.ask(user, "sam@example.com", ThreadId{"thr_11111111"}, "Help my training",
          [&](AskReply answer) { reply = std::move(answer); });
  REQUIRE(reply);
  CHECK_EQ(reply->refusal, AskRefusal::frozen);
  int refused = 0;
  for (const auto& write : std::vector<std::function<void()>>{
      [&] { h.threadService->openThread(user, ThreadId{"thr_11111111"}, "Training"); },
      [&] { h.threadService->appendTurns(user, ThreadId{"thr_11111111"}, {}); },
      [&] { h.threadService->discardEmptyThread(user, ThreadId{"thr_11111111"}); },
      [&] { h.threadService->deleteThread(user, ThreadId{"thr_11111111"}); },
      [&] { h.threadService->putImage(user, ThreadId{"thr_11111111"}, CoachImage{}); },
      [&] { h.threadService->stopGeneration(user, ThreadId{"thr_11111111"}, "req_11111111"); },
      [&] { ask.stop(user, ThreadId{"thr_11111111"}, "req_11111111"); },
  }) {
    try { write(); }
    catch (const GymUnavailable& unavailable) { CHECK_EQ(unavailable.code, "gym-frozen"); ++refused; }
  }
  CHECK_EQ(refused, 7);
  CHECK(h.repo.db.threadRows.empty());
  CHECK(h.repo.threads.images.empty());
  CHECK(h.repo.threads.generations.empty());
  CHECK(agent.seenTurns.empty());
}
