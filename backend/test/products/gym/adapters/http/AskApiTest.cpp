#include "products/gym/adapters/http/AskApi.h"

#include "platform/domain/AiUsage.h"
#include "test/products/gym/adapters/http/GymApiFixture.h"

#include <cstddef>
#include <future>
#include <memory>
#include <string>
#include <vector>

using namespace wm;
using namespace wm::fake;
using namespace wm::gym;
using namespace wm::gym::fake;
using namespace wm::gym::apitest;

// AskApi over the real AskService and a fake model: every sentence the Coach door sends a lifter,
// byte for byte, beside its status and code. The three clients pin these same bytes.

namespace {

struct AskHarness {
  Harness h;
  FakeSubscriptionRepository subs;
  FakeAiUsageRepository usage;
  Entitlements entitlements{subs, usage};
  GymTools gymTools{*h.trainingService, *h.catalogService, *h.programService, *h.notesService,
                    *h.bodyweightService, "https://windmill.works"};
  FakeAsk agent;
  std::shared_ptr<AskService> askService = std::make_shared<AskService>(
      *h.trainingService, h.repo.threads, h.clock, agent, gymTools, entitlements);
  AskApi api{askService, h.auth};
  UserId lifter = h.signIn("s-live");

  // The answer lands on a worker thread when the model runs and inline when the door refuses.
  drogon::HttpResponsePtr ask(const std::string& thread, const std::string& question,
                              const std::string& cookie = "s-live", const std::string& requestId = "") {
    Json::Value body(Json::objectValue);
    body["thread"] = thread;
    body["question"] = question;
    if (!requestId.empty()) body["requestId"] = requestId;
    std::promise<drogon::HttpResponsePtr> settled;
    std::future<drogon::HttpResponsePtr> reply = settled.get_future();
    api.ask(postRequest("/v1/gym/ask", body, cookie),
            [&settled](const drogon::HttpResponsePtr& response) { settled.set_value(response); });
    return reply.get();
  }

  void seedThread(const UserId& owner, const std::string& id, std::size_t turns) {
    std::vector<ThreadTurn> said;
    for (std::size_t at = 0; at < turns; ++at)
      said.push_back(ThreadTurn{at % 2 == 0, "a", 1'700'000'000'000});
    h.repo.db.threadRows.push_back(
        AskThread{ThreadId{id}, owner, "a", 1'700'000'000'000, 1'700'000'000'000, said, {}});
  }
};

// A refusal as a client reads it: the status, the sentence under `error` (decoded — `dump` would
// escape the ’ and — the contract pins), and the code, "" where the client is meant to read rather
// than branch. Nothing else rides in the body.
struct Refusal {
  drogon::HttpStatusCode status;
  std::string error;
  std::string code;

  bool operator==(const Refusal&) const = default;
};

Refusal refusalOf(const drogon::HttpResponsePtr& response) {
  const Json::Value body = bodyOf(response);
  CHECK_EQ(body.getMemberNames().size(), body.isMember("generation") ? (body.isMember("code") ? 5u : 4u) : body.isMember("code") ? 2u : 1u);
  return {response->getStatusCode(), body["error"].asString(), body["code"].asString()};
}

}  // namespace

TEST(gym_ask_answers_with_the_servers_own_read_line_and_no_steps_it_did_not_take) {
  AskHarness a;

  const drogon::HttpResponsePtr response = a.ask("thr_00000001", "how did the squats go?");

  CHECK_EQ(response->getStatusCode(), drogon::k200OK);
  const Json::Value actual = bodyOf(response);
  REQUIRE(wellFormedId(actual["generation"]["id"].asString()));
  REQUIRE(wellFormedId(actual["generation"]["requestId"].asString()));
  Json::Value expected = parse(R"({"answer":"You squatted 100 for five.","proposals":[],"results":[],
      "read":{"sessions":0,"sets":0,"weeks":0},"receipt":{"observations":[],"proposals":[],
      "read":{"sessions":0,"sets":0,"weeks":0},"steps":[],"version":1},"steps":[],"thread":"thr_00000001"})");
  expected["generation"] = parse(R"({"question":"how did the squats go?","status":"completed",
      "answer":"You squatted 100 for five.","steps":[],"results":[]})");
  expected["generation"]["id"] = actual["generation"]["id"];
  expected["generation"]["requestId"] = actual["generation"]["requestId"];
  expected["generation"]["revision"] = Json::UInt64(2);
  expected["generation"]["at"] = Json::UInt64(a.h.clock.now);
  expected["generation"]["receipt"] = expected["receipt"];
  CHECK_EQ(actual, expected);
  CHECK_EQ(a.agent.runs, 1);
}

TEST(gym_live_and_reopened_answer_evidence_is_exact_even_after_the_log_changes) {
  AskHarness a;
  const Session session{SessionId{"ses_evidence1"}, a.lifter, 1'700'000'000'000,
                        1'700'000'900'000, std::nullopt, PlanSnapshot{"Push A", {}}};
  a.h.repo.db.sessions.push_back(session);
  a.h.repo.db.sets = {
      Set{SetId{"set_evidence1"}, session.id, ExerciseId{"bench-press"}, 1, 20, 5,
          SetKind::warmup, std::nullopt, "", 1'700'000'100'000},
      Set{SetId{"set_evidence2"}, session.id, ExerciseId{"bench-press"}, 2, 80, 5,
          SetKind::working, std::nullopt, "", 1'700'000'200'000}};
  a.agent.plan = {{"list_sessions", parse("{}")},
      {"get_session", parse(R"({"sessionId":"ses_evidence1"})")},
      {"last_time", parse(R"({"exerciseId":"bench-press"})")},
      {"get_session", parse(R"({"sessionId":"ses_absent01"})")}};
  const Json::Value receipt = parse(R"({"version":1,"read":{"sets":2,"sessions":1,"weeks":1},
      "steps":[{"tool":"list_sessions","failed":false},{"tool":"get_session","failed":false},
               {"tool":"last_time","failed":false},{"tool":"get_session","failed":true}],
      "proposals":[],"observations":[
        {"tool":"list_sessions","sessionId":"ses_evidence1","startedAt":1700000000000,
         "finishedAt":1700000900000,"routine":"Push A","coverage":"summary","setsRead":0,
         "workout":{"workingSetCount":1,"tonnageKg":400.0,"durationMs":900000}},
        {"tool":"get_session","sessionId":"ses_evidence1","startedAt":1700000000000,
         "finishedAt":1700000900000,"routine":"Push A","coverage":"session","setsRead":2,
         "workout":{"workingSetCount":1,"tonnageKg":400.0,"durationMs":900000}},
        {"tool":"last_time","sessionId":"ses_evidence1","startedAt":1700000000000,
         "finishedAt":1700000900000,"routine":"Push A","coverage":"movement","setsRead":1,
         "exerciseId":"bench-press"}]})");
  Json::Value expected = parse(R"({"answer":"You squatted 100 for five.","proposals":[],
      "read":{"sets":2,"sessions":1,"weeks":1},"thread":"thr_evidence1"})");
  expected["receipt"] = receipt;
  expected["steps"] = receipt["steps"];

  const auto live = a.ask("thr_evidence1", "What did I train?");
  REQUIRE_EQ(live->getStatusCode(), drogon::k200OK);
  expected["results"] = Json::Value(Json::arrayValue);
  expected["generation"] = parse(R"({"question":"What did I train?","status":"completed","answer":"You squatted 100 for five.","results":[]})");
  expected["generation"]["id"] = bodyOf(live)["generation"]["id"];
  expected["generation"]["requestId"] = bodyOf(live)["generation"]["requestId"];
  expected["generation"]["revision"] = Json::UInt64(2);
  expected["generation"]["at"] = Json::UInt64(a.h.clock.now);
  expected["generation"]["steps"] = receipt["steps"];
  expected["generation"]["receipt"] = receipt;
  CHECK_EQ(dump(bodyOf(live)), dump(expected));
  a.h.repo.db.sets.clear();
  a.h.repo.db.sessions.clear();

  const auto history = send(a.h.threads, &ThreadsApi::getThread,
      getRequest("/v1/gym/threads/thr_evidence1", "s-live"), "thr_evidence1");
  Json::Value stored = parse(R"({"id":"thr_evidence1","title":"What did I train?",
      "outcome":{"kind":"read-only","changes":0},"proposals":[],"turns":[
        {"from":"lifter","text":"What did I train?"},
        {"from":"ask","text":"You squatted 100 for five."}]})");
  stored["createdAt"] = Json::UInt64(a.h.clock.now);
  stored["askedAt"] = Json::UInt64(a.h.clock.now);
  stored["turns"][0]["at"] = Json::UInt64(a.h.clock.now);
  stored["turns"][1]["at"] = Json::UInt64(a.h.clock.now);
  stored["turns"][1]["receipt"] = receipt;
  stored["generation"] = expected["generation"];
  for (Json::ArrayIndex i = 0; i < 2; ++i) {
    stored["turns"][i]["position"] = Json::UInt64(i + 1);
    stored["turns"][i]["generationId"] = expected["generation"]["id"];
    stored["turns"][i]["requestId"] = expected["generation"]["requestId"];
    stored["turns"][i]["status"] = "completed";
  }
  CHECK_EQ(history->getStatusCode(), drogon::k200OK);
  CHECK_EQ(dump(bodyOf(history)), dump(stored));
  CHECK_EQ(receiptFrom(receipt), a.h.repo.db.threadRows[0].turns[1].receipt);
}

TEST(gym_stored_receipts_omit_unknown_or_incomplete_evidence_without_inventing_facts) {
  const Json::Value empty = parse(R"({"version":1,"read":{"sets":0,"sessions":0,"weeks":0},
      "steps":[],"proposals":[],"observations":[]})");
  CHECK_EQ(receiptFrom(empty), std::optional<AnswerReceipt>{AnswerReceipt{}});
  for (Json::Value invalid : {Json::Value(), Json::Value("prose"), parse("{}")})
    CHECK_FALSE(receiptFrom(invalid).has_value());
  Json::Value invalid = empty;
  invalid["version"] = 2;
  CHECK_FALSE(receiptFrom(invalid).has_value());
  invalid = empty;
  invalid["read"].removeMember("sets");
  CHECK_FALSE(receiptFrom(invalid).has_value());
  invalid = empty;
  invalid["observations"].append(parse(R"({"tool":"last_time","sessionId":"ses_evidence1",
      "startedAt":1000,"coverage":"movement","exerciseId":"bench-press","setsRead":1,
      "workout":{"workingSetCount":1,"tonnageKg":400}})"));
  CHECK_FALSE(receiptFrom(invalid).has_value());
}

TEST(gym_open_ad_hoc_evidence_omits_unknown_names_finishes_and_durations) {
  const Session session{SessionId{"ses_evidence1"}, UserId{"u1"}, 1000};
  const AnswerReceipt receipt{1, {1, 1, 1}, {{"get_session", false}, {"last_time", false}}, {},
      {{"get_session", session, ReadCoverage::session, 1, WorkoutObservation{session, 1, 400}},
       {"last_time", session, ReadCoverage::movement, 1, std::nullopt, ExerciseId{"bench-press"}}}};
  const Json::Value expected = parse(R"({"version":1,"read":{"sets":1,"sessions":1,"weeks":1},
      "steps":[{"tool":"get_session","failed":false},{"tool":"last_time","failed":false}],
      "proposals":[],"observations":[
        {"tool":"get_session","sessionId":"ses_evidence1","startedAt":1000,"coverage":"session",
         "setsRead":1,"workout":{"workingSetCount":1,"tonnageKg":400.0}},
        {"tool":"last_time","sessionId":"ses_evidence1","startedAt":1000,"coverage":"movement",
         "setsRead":1,"exerciseId":"bench-press"}]})");
  CHECK_EQ(dump(toJson(receipt)), dump(expected));
  CHECK_EQ(receiptFrom(expected), std::optional<AnswerReceipt>{receipt});
}

TEST(gym_ask_refuses_a_stranger_with_the_one_sentence_every_gym_door_sends) {
  AskHarness a;

  const drogon::HttpResponsePtr response = a.ask("thr_00000001", "how did the squats go?", "");

  CHECK_EQ(refusalOf(response),
           (Refusal{drogon::k401Unauthorized, "sign in to open your training log", ""}));
  CHECK_EQ(a.agent.runs, 0);
}

TEST(gym_ask_refuses_a_body_that_is_not_a_question_in_a_thread) {
  AskHarness a;
  Json::Value noThread(Json::objectValue);
  noThread["question"] = "hi";

  const drogon::HttpResponsePtr response =
      send(a.api, &AskApi::ask, postRequest("/v1/gym/ask", noThread, "s-live"));

  CHECK_EQ(refusalOf(response), (Refusal{drogon::k400BadRequest, "expected json", ""}));
}

// The four 400s of the ladder, each its own sentence, each naming the room Coach with ’.
TEST(gym_ask_400s_say_what_coach_cannot_take) {
  AskHarness a;

  const drogon::HttpResponsePtr malformed = a.ask("thr_1", "how did the squats go?");
  const drogon::HttpResponsePtr blank = a.ask("thr_00000001", "  \n ");
  const drogon::HttpResponsePtr oversized =
      a.ask("thr_00000001", std::string(kMaxAskTurnBytes + 1, 'a'));
  const drogon::HttpResponsePtr nulled =
      a.ask("thr_00000001", std::string("why is my bench\0STUCK", 21));

  CHECK_EQ(refusalOf(malformed),
           (Refusal{drogon::k400BadRequest, "that isn’t a conversation Coach can answer", ""}));
  CHECK_EQ(refusalOf(blank),
           (Refusal{drogon::k400BadRequest, "ask something about your training", ""}));
  CHECK_EQ(refusalOf(oversized),
           (Refusal{drogon::k400BadRequest, "that question is longer than Coach takes", ""}));
  CHECK_EQ(refusalOf(nulled),
           (Refusal{drogon::k400BadRequest, "that question has characters Coach can’t store", ""}));
  CHECK_EQ(a.agent.runs, 0);
}

TEST(gym_ask_409s_name_the_taken_id_the_full_conversation_and_the_open_workout) {
  AskHarness a;
  a.seedThread(UserId{"stranger"}, "thr_00000002", 2);
  a.seedThread(a.lifter, "thr_00000003", kMaxContextTurns);

  const drogon::HttpResponsePtr taken = a.ask("thr_00000002", "and mine?");
  const drogon::HttpResponsePtr full = a.ask("thr_00000003", "once more");
  a.h.clock.now = 1'700'100'000'000;
  a.h.trainingService->start(a.lifter, SessionStart{SessionId{"ses_22222222"}, 1'700'100'000'000});
  const drogon::HttpResponsePtr open = a.ask("thr_00000004", "what should I do next?");

  CHECK_EQ(refusalOf(taken),
           (Refusal{drogon::k409Conflict,
                    "that conversation id is already in use — start a new one",
                    "ask-thread-taken"}));
  CHECK_EQ(full->getStatusCode(), drogon::k200OK);
  CHECK_EQ(refusalOf(open),
           (Refusal{drogon::k409Conflict,
                    "finish your workout first — Coach reads a log that has stopped moving",
                    "ask-session-open"}));
  CHECK_EQ(a.agent.runs, 1);
}

// The 429 says what to do next and never the allowance: the clients draw the numbers above the
// composer, and this sentence is the only other place a capped lifter reads.
TEST(gym_ask_429s_free_up_later_and_name_the_rolling_ceiling) {
  AskHarness a;

  CHECK_EQ(a.ask("thr_00000001", "one")->getStatusCode(), drogon::k200OK);
  CHECK_EQ(a.ask("thr_00000002", "two")->getStatusCode(), drogon::k200OK);
  CHECK_EQ(a.ask("thr_00000003", "three")->getStatusCode(), drogon::k200OK);
  const drogon::HttpResponsePtr capped = a.ask("thr_00000004", "four");
  a.usage.spentByProduct[""] = kProMonthlyAiNanos;
  const drogon::HttpResponsePtr ceiling = a.ask("thr_00000005", "five");

  CHECK_EQ(refusalOf(capped),
           (Refusal{drogon::k429TooManyRequests,
                    "the next question frees up in a couple of hours",
                    "ask-daily-limit"}));
  CHECK_EQ(refusalOf(ceiling),
           (Refusal{drogon::k429TooManyRequests,
                    "this account has reached its AI ceiling for the last 30 days. Coach will "
                    "answer again as that window rolls on",
                    "ask-out-of-budget"}));
  CHECK_EQ(a.agent.runs, 3);
}

TEST(gym_ask_503_names_the_absent_room_and_502_names_the_answer_that_never_came) {
  AskHarness a;
  a.agent.wired = false;
  const drogon::HttpResponsePtr absent = a.ask("thr_00000001", "how did the squats go?");
  a.agent.wired = true;
  a.agent.answers = false;
  const drogon::HttpResponsePtr silent = a.ask("thr_00000002", "how did the squats go?");

  CHECK_EQ(refusalOf(absent),
           (Refusal{drogon::k503ServiceUnavailable,
                    "Coach isn’t part of this Windmill. Your log is still yours to read.",
                    "ask-not-configured"}));
  CHECK_EQ(refusalOf(silent),
           (Refusal{drogon::k502BadGateway, "Coach didn’t answer. Try again in a moment", ""}));
  CHECK_EQ(a.agent.runs, 1);
  CHECK_EQ(a.h.threadService->threads(a.lifter).size(), 1u);
  CHECK_EQ(bodyOf(silent)["generation"]["status"].asString(), std::string("failed"));
}

TEST(gym_ask_pending_json_reuses_generation_and_completed_replay_is_byte_identical) {
  AskHarness a;
  const ThreadId thread{"thr_pending01"};
  a.h.threadService->openThread(a.lifter, thread, "Question");
  AskGeneration generation{"gen_pending01", "req_pending01", "Question"};
  generation.atMs = a.h.clock.now;
  a.h.repo.threads.saveGeneration(a.lifter, thread, generation);
  auto lease = a.h.repo.threads.tryLease(a.lifter, thread);
  const auto pending = a.ask(thread.str(), "Question", "s-live", "req_pending01");
  CHECK_EQ(pending->getStatusCode(), drogon::k202Accepted);
  Json::Value expected(Json::objectValue);
  expected["thread"] = thread.str();
  expected["generation"] = toJson(generation);
  expected["results"] = Json::Value(Json::arrayValue);
  CHECK_EQ(bodyOf(pending), expected);
  CHECK_EQ(a.agent.runs, 0);
  CHECK_EQ(refusalOf(a.ask(thread.str(), "Another question", "s-live", "req_another01")),
           (Refusal{drogon::k409Conflict, "Coach is still answering in this conversation", "ask-generation-active"}));
  lease.reset();
  const auto complete = a.ask(thread.str(), "Question", "s-live", "req_pending01");
  REQUIRE_EQ(complete->getStatusCode(), drogon::k200OK);
  a.h.clock.now += 1000;
  const auto replay = a.ask(thread.str(), "Question", "s-live", "req_pending01");
  CHECK_EQ(replay->getStatusCode(), drogon::k200OK);
  CHECK_EQ(replay->getBody(), complete->getBody());
  CHECK_EQ(a.agent.runs, 1);
  CHECK_EQ(a.h.threadService->thread(a.lifter, thread)->turns.size(), 2u);
}

TEST(gym_known_generation_refusal_retains_the_durable_identity_and_routine_result) {
  AskHarness a;
  const ThreadId thread{"thr_known001"};
  a.h.repo.threads.openThread(a.lifter, thread, "Create a routine", a.h.clock.now);
  AskGeneration generation{"gen_known001", "req_known001", "Create a routine"};
  generation.atMs = a.h.clock.now;
  generation.status = "failed";
  generation.results = {{"op_known001", "rt_known001", "Upper body"}};
  a.h.repo.threads.saveGeneration(a.lifter, thread, generation);
  a.usage.spentByProduct[""] = kProMonthlyAiNanos;
  const auto reply = a.ask(thread.str(), generation.question, "s-live", generation.requestId);
  CHECK_EQ(reply->getStatusCode(), drogon::k429TooManyRequests);
  auto expected = parse(R"({"error":"this account has reached its AI ceiling for the last 30 days. Coach will answer again as that window rolls on","code":"ask-out-of-budget"})");
  expected["thread"] = thread.str();
  expected["generation"] = toJson(generation);
  expected["results"] = toJson(generation.results);
  CHECK_EQ(bodyOf(reply), expected);
  CHECK_EQ(a.agent.runs, 0);
}
