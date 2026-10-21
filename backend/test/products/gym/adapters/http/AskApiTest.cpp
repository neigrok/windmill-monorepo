#include "products/gym/adapters/http/AskApi.h"

#include "platform/domain/AiUsage.h"
#include "test/DrogonLoopback.h"
#include "test/platform/FakeAiBudgetRepository.h"
#include "test/products/gym/adapters/http/GymApiFixture.h"

#include <trantor/net/AsyncStream.h>

#include <cstddef>
#include <future>
#include <condition_variable>
#include <memory>
#include <mutex>
#include <stdexcept>
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

struct AskModel : FakeAsk {
  std::string refusal;
  std::function<void()> beforeAnswer;
  AskAnswer answer(const std::vector<AskTurn>& turns, const ToolCaller& caller, ToolHost& tools) override {
    if (beforeAnswer) beforeAnswer();
    if (refusal.empty()) return FakeAsk::answer(turns, caller, tools);
    ++runs;
    AskAnswer answer;
    answer.outcomeCode = refusal;
    return answer;
  }
};

struct CoachFailures : FailureReporter {
  std::vector<std::string> reports;
  void report(const std::string& kind, const std::string& where, const std::string& detail) override {
    reports.push_back(kind + " " + where + " " + detail);
  }
};

struct AskHarness {
  Harness h;
  FakeSubscriptionRepository subs;
  FakeAiUsageRepository usage;
  FakeAiBudgetRepository allowances;
  AiBudgetLimits limits;
  std::shared_ptr<AiBudgetService> budgets = std::make_shared<AiBudgetService>(
      allowances, [this] { return limits; }, [this] { return static_cast<long long>(h.clock.now); });
  Entitlements entitlements;
  GymTools gymTools{*h.trainingService, h.door, h.repo.catalog, h.repo.program, h.repo.notes,
                    h.repo.bodyweight, "https://windmill.works"};
  AskModel agent;
  std::shared_ptr<CoachFailures> failures = std::make_shared<CoachFailures>();
  std::shared_ptr<AskService> askService = std::make_shared<AskService>(
      *h.trainingService, h.repo.threads, h.clock, agent, gymTools, entitlements, failures);
  AskApi api{askService, h.auth};
  UserId lifter = h.signIn("s-live");

  explicit AskHarness(bool monthly = false) : entitlements{subs, usage, {}, {}, monthly ? budgets : nullptr} {}

  // The answer lands on a worker thread when the model runs and inline when the door refuses.
  drogon::HttpResponsePtr ask(const std::string& thread, const std::string& question,
                              const std::string& cookie = "s-live", const std::string& requestId = "",
                              const std::string& purpose = "") {
    Json::Value body(Json::objectValue);
    body["thread"] = thread;
    body["question"] = question;
    if (!purpose.empty()) body["purpose"] = purpose;
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
  a.h.repo.db.seedSession(Session{SessionId{"ses_22222222"}, a.lifter, 1'700'100'000'000});
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

TEST(gym_monthly_allowance_exhaustion_returns_exact_usd_and_calendar_reset_without_a_model_call) {
  AskHarness a{true};
  a.allowances.totals.subject.spentNanos = 250'000'000;
  const auto response = a.ask("thr_monthly01", "How did training go?");
  CHECK_EQ(response->getStatusCode(), drogon::k429TooManyRequests);
  auto expected = parse(R"({"code":"subject_exhausted","reason":"allowance_exhausted",
      "error":"Your AI allowance is fully used or reserved.","allowance":{
      "currency":"USD","period":"calendar_month_utc","tier":"logged_in","configured":true,
      "limit":"0.250000000","used":"0.250000000","reserved":"0.000000000","remaining":"0.000000000"}})");
  expected["allowance"]["resetsAtMs"] = Json::Int64(AiBudgetPeriod::at(a.h.clock.now)->endMs);
  expected["allowance"]["code"] = "subject_exhausted";
  expected["allowance"]["budgetResetsAtMs"] = expected["allowance"]["resetsAtMs"];
  CHECK_EQ(bodyOf(response), expected);
  CHECK_EQ(a.agent.runs, 0);
  CHECK(a.failures->reports.empty());
}

TEST(gym_monthly_shared_cap_refusals_keep_personal_usd_balance_and_do_not_report_issues) {
  for (const bool serviceCap : {true, false}) {
    AskHarness a{true};
    if (serviceCap) a.allowances.totals.freeMonth.spentNanos = a.limits.freeMonthlyNanos;
    else a.allowances.totals.freeDay.spentNanos = a.limits.freeDailyNanos;
    const auto response = a.ask("thr_shared001", "How did training go?");
    CHECK_EQ(response->getStatusCode(), drogon::k503ServiceUnavailable);
    auto expected = parse(R"({"reason":"unavailable","allowance":{
        "currency":"USD","period":"calendar_month_utc","tier":"logged_in","configured":true,
        "limit":"0.250000000","used":"0.000000000","reserved":"0.000000000","remaining":"0.250000000"}})");
    expected["code"] = serviceCap ? "free_month_exhausted" : "free_day_exhausted";
    expected["error"] = serviceCap ? "Coach's shared free AI capacity is unavailable for this month."
                                    : "Coach's shared free AI capacity is unavailable for today.";
    expected["allowance"]["resetsAtMs"] = Json::Int64(AiBudgetPeriod::at(a.h.clock.now)->endMs);
    expected["allowance"]["code"] = expected["code"];
    expected["allowance"]["budgetResetsAtMs"] = Json::Int64(serviceCap
        ? AiBudgetPeriod::at(a.h.clock.now)->endMs : AiBudgetPeriod::dayAt(a.h.clock.now)->endMs);
    CHECK_EQ(bodyOf(response), expected);
    CHECK_EQ(a.agent.runs, 0);
    CHECK(a.failures->reports.empty());
  }
}

TEST(gym_provider_admission_refusal_distinguishes_request_capacity_from_spent_monthly_allowance) {
  AskHarness a{true};
  a.allowances.totals.subject.spentNanos = 200'000'000;
  a.agent.refusal = "subject_exhausted";
  const auto response = a.ask("thr_capacity1", "How did training go?", "s-live", "req_capacity1");
  CHECK_EQ(response->getStatusCode(), drogon::k429TooManyRequests);
  auto expected = parse(R"({"code":"subject_exhausted","reason":"request_exceeds_remaining",
      "error":"This request needs more AI capacity than your remaining allowance.","allowance":{
      "currency":"USD","period":"calendar_month_utc","tier":"logged_in","configured":true,
      "limit":"0.250000000","used":"0.200000000","reserved":"0.000000000","remaining":"0.050000000"},
      "thread":"thr_capacity1","results":[],"generation":{"requestId":"req_capacity1",
      "question":"How did training go?","status":"failed","answer":"","steps":[],"results":[],
      "receipt":{"version":1,"read":{"sets":0,"sessions":0,"weeks":0},"steps":[],"proposals":[],"observations":[]}}})");
  const auto actual = bodyOf(response);
  REQUIRE(wellFormedId(actual["generation"]["id"].asString()));
  expected["generation"]["id"] = actual["generation"]["id"];
  expected["generation"]["at"] = Json::UInt64(a.h.clock.now);
  expected["generation"]["revision"] = Json::UInt64(2);
  expected["allowance"]["resetsAtMs"] = Json::Int64(AiBudgetPeriod::at(a.h.clock.now)->endMs);
  expected["allowance"]["code"] = "subject_exhausted";
  expected["allowance"]["budgetResetsAtMs"] = expected["allowance"]["resetsAtMs"];
  expected["generation"]["allowanceRefusal"] = expected["allowance"];
  CHECK_EQ(actual, expected);
  CHECK_EQ(a.agent.runs, 1);
  CHECK(a.failures->reports.empty());

  const auto stored = a.h.repo.threads.generation(a.lifter, ThreadId{"thr_capacity1"}, "req_capacity1");
  REQUIRE(stored);
  CHECK_EQ(generationFrom(toJson(*stored)), *stored);
  const auto history = send(a.h.threads, &ThreadsApi::getThread,
      getRequest("/v1/gym/threads/thr_capacity1", "s-live"), "thr_capacity1");
  CHECK_EQ(bodyOf(history)["generation"]["allowanceRefusal"], expected["allowance"]);

  a.allowances.totals.subject.spentNanos = 250'000'000;
  const auto refusedRetry = a.ask("thr_capacity1", "How did training go?", "s-live", "req_capacity1");
  CHECK_EQ(refusedRetry->getStatusCode(), drogon::k429TooManyRequests);
  auto latest = expected["allowance"];
  latest["used"] = "0.250000000";
  latest["remaining"] = "0.000000000";
  CHECK_EQ(bodyOf(refusedRetry)["generation"]["allowanceRefusal"], latest);
  CHECK_EQ(a.agent.runs, 1);

  a.agent.refusal.clear();
  a.allowances.totals.subject.spentNanos = 0;
  const auto acceptedRetry = a.ask("thr_capacity1", "How did training go?", "s-live", "req_capacity1");
  CHECK_EQ(acceptedRetry->getStatusCode(), drogon::k200OK);
  CHECK_FALSE(bodyOf(acceptedRetry)["generation"].isMember("allowanceRefusal"));
  CHECK_EQ(a.agent.runs, 2);
}

TEST(gym_monthly_budget_codes_are_not_reinterpreted_when_monthly_budgets_are_disabled) {
  AskHarness a;
  a.agent.refusal = "subject_exhausted";
  const auto response = a.ask("thr_legacy001", "How did training go?");
  CHECK_EQ(response->getStatusCode(), drogon::k502BadGateway);
  CHECK_EQ(bodyOf(response)["error"].asString(), "Coach didn’t answer. Try again in a moment");
  CHECK_FALSE(bodyOf(response).isMember("allowance"));
  CHECK_FALSE(bodyOf(response).isMember("code"));
}

TEST(gym_streamed_monthly_refusal_preserves_the_json_contract_and_reset_timestamp) {
  AskHarness a{true};
  a.allowances.totals.freeDay.spentNanos = a.limits.freeDailyNanos;
  struct Wire {
    std::mutex mutex;
    std::condition_variable changed;
    std::string sent;
    bool closed = false;
  } wire;
  struct Stream : trantor::AsyncStream {
    explicit Stream(Wire& wire) : wire(wire) {}
    Wire& wire;
    bool send(const char* data, std::size_t size) override {
      std::lock_guard lock(wire.mutex);
      wire.sent.append(data, size);
      return true;
    }
    void close() override {
      std::lock_guard lock(wire.mutex);
      wire.closed = true;
      wire.changed.notify_all();
    }
  };
  const auto request = postRequest("/v1/gym/ask", parse(R"({"thread":"thr_stream001",
      "requestId":"req_stream001","question":"How did training go?","stream":true})"), "s-live");
  drogon::HttpResponsePtr response;
  a.api.ask(request, [&](const auto& reply) { response = reply; });
  REQUIRE(response);
  CHECK_EQ(response->contentTypeString(), "text/event-stream");
  response->asyncStreamCallback()(std::make_unique<drogon::ResponseStream>(std::make_unique<Stream>(wire)));
  std::unique_lock lock(wire.mutex);
  REQUIRE(wire.changed.wait_for(lock, std::chrono::seconds(5), [&] { return wire.closed; }));
  std::string content;
  for (std::size_t at = 0; at < wire.sent.size();) {
    const auto lineEnd = wire.sent.find("\r\n", at);
    REQUIRE(lineEnd != std::string::npos);
    const std::size_t size = std::stoull(wire.sent.substr(at, lineEnd - at), nullptr, 16);
    if (!size) break;
    at = lineEnd + 2;
    content += wire.sent.substr(at, size);
    at += size + 2;
  }
  std::string events;
  for (std::size_t at = 0; at < content.size();) {
    const auto end = content.find("\n\n", at);
    REQUIRE(end != std::string::npos);
    const auto frame = content.substr(at, end + 2 - at);
    if (!frame.starts_with(":")) events += frame;
    at = end + 2;
  }
  auto expected = parse(R"({"code":"free_day_exhausted","reason":"unavailable","status":503,
      "error":"Coach's shared free AI capacity is unavailable for today.","allowance":{
      "currency":"USD","period":"calendar_month_utc","tier":"logged_in","configured":true,
      "limit":"0.250000000","used":"0.000000000","reserved":"0.000000000","remaining":"0.250000000"}})");
  expected["allowance"]["resetsAtMs"] = Json::Int64(AiBudgetPeriod::at(a.h.clock.now)->endMs);
  expected["allowance"]["code"] = "free_day_exhausted";
  expected["allowance"]["budgetResetsAtMs"] = Json::Int64(AiBudgetPeriod::dayAt(a.h.clock.now)->endMs);
  CHECK_EQ(events, "event: error\ndata: " + dump(expected) + "\n\n");
  CHECK_EQ(a.agent.runs, 0);
  CHECK(a.failures->reports.empty());
}

TEST(gym_closing_connections_receive_buffered_sse_for_repeated_failed_requests) {
  AskHarness a{true};
  a.agent.refusal = "subject_exhausted";
  const auto refused = a.ask("thr_closing01", "How did training go?", "s-live", "req_closing01");
  REQUIRE_EQ(refused->statusCode(), drogon::k429TooManyRequests);
  Json::Value expected = bodyOf(refused);
  expected["status"] = 429;
  const std::string body = R"({"thread":"thr_closing01","requestId":"req_closing01","question":"How did training go?","stream":true})";
  std::uint64_t revision = expected["generation"]["revision"].asUInt64();
  for (const auto* requestLine : {"POST /v1/gym/ask HTTP/1.1\r\nConnection: close\r\n",
                                 "POST /v1/gym/ask HTTP/1.0\r\n"}) {
    wm::test::DrogonLoopback::Connection wire;
    drogon::HttpResponsePtr response;
    const auto exchange = wire.exchange(std::string(requestLine) +
        "Host: localhost\r\nCookie: wm_session=s-live\r\nContent-Type: application/json\r\nContent-Length: " +
        std::to_string(body.size()) + "\r\n\r\n" + body, [&](const auto& request) {
      std::promise<drogon::HttpResponsePtr> settled;
      auto reply = settled.get_future();
      a.api.ask(request, [&settled](const auto& answer) { settled.set_value(answer); });
      if (reply.wait_for(std::chrono::seconds(5)) != std::future_status::ready)
        throw std::runtime_error("Coach fixture did not complete");
      response = reply.get();
      return response;
    });
    REQUIRE(exchange.request);
    REQUIRE(response);
    CHECK_EQ(response->statusCode(), drogon::k200OK);
    CHECK_EQ(response->contentTypeString(), std::string("text/event-stream"));
    CHECK_FALSE(static_cast<bool>(response->asyncStreamCallback()));
    const auto headerEnd = exchange.answer.find("\r\n\r\n");
    REQUIRE(headerEnd != std::string::npos);
    revision += 2;
    expected["generation"]["revision"] = Json::UInt64(revision);
    CHECK_EQ(exchange.answer.substr(headerEnd + 4), "event: error\ndata: " + dump(expected) + "\n\n");
  }
  CHECK_EQ(a.agent.runs, 3);
  CHECK(a.failures->reports.empty());
}

TEST(gym_closing_connections_receive_the_same_completed_snapshot_without_rerunning_coach) {
  AskHarness a;
  const auto completed = a.ask("thr_closing02", "How did training go?", "s-live", "req_closing02");
  REQUIRE_EQ(completed->statusCode(), drogon::k200OK);
  const auto answer = bodyOf(completed);
  Json::Value expected(Json::objectValue);
  expected["thread"] = answer["thread"];
  expected["generation"] = answer["generation"];
  const auto request = postRequest("/v1/gym/ask", parse(R"({"thread":"thr_closing02",
      "requestId":"req_closing02","question":"How did training go?","stream":true})"), "s-live");
  request->addHeader("Connection", "keep-alive, CLOSE");
  std::promise<drogon::HttpResponsePtr> settled;
  auto reply = settled.get_future();
  a.api.ask(request, [&settled](const auto& response) { settled.set_value(response); });
  REQUIRE(reply.wait_for(std::chrono::seconds(5)) == std::future_status::ready);
  const auto response = reply.get();
  REQUIRE(response);
  CHECK_EQ(response->contentTypeString(), std::string("text/event-stream"));
  CHECK_FALSE(static_cast<bool>(response->asyncStreamCallback()));
  CHECK_EQ(std::string(response->getBody()), "id: " + answer["generation"]["id"].asString() + ":" +
      std::to_string(answer["generation"]["revision"].asUInt64()) +
      "\nevent: snapshot\ndata: " + dump(expected) + "\n\n");
  CHECK_EQ(a.agent.runs, 1);
  CHECK(a.failures->reports.empty());
}

TEST(gym_closing_connection_replays_wait_for_the_running_request_to_finish_without_rerunning_coach) {
  for (const auto* requestLine : {"POST /v1/gym/ask HTTP/1.1\r\nConnection: close\r\n",
                                 "POST /v1/gym/ask HTTP/1.0\r\n"}) {
    wm::test::DrogonLoopback::Connection wire;
    AskHarness a;
    std::promise<void> entered;
    auto modelEntered = entered.get_future();
    std::promise<void> release;
    auto modelReleased = release.get_future().share();
    a.agent.beforeAnswer = [&] {
      entered.set_value();
      modelReleased.wait();
    };
    Json::Value body = parse(R"({"thread":"thr_closing03","requestId":"req_closing03",
        "question":"How did training go?"})");
    std::promise<drogon::HttpResponsePtr> original;
    auto completed = original.get_future();
    a.api.ask(postRequest("/v1/gym/ask", body, "s-live"),
              [&original](const auto& response) { original.set_value(response); });
    const bool modelStarted = modelEntered.wait_for(std::chrono::seconds(5)) == std::future_status::ready;
    if (!modelStarted) release.set_value();
    REQUIRE(modelStarted);
    body["stream"] = true;
    const std::string payload = dump(body);
    bool answeredWhileRunning = false;
    drogon::HttpResponsePtr response;
    const auto exchange = wire.exchange(std::string(requestLine) +
        "Host: localhost\r\nCookie: wm_session=s-live\r\nContent-Type: application/json\r\nContent-Length: " +
        std::to_string(payload.size()) + "\r\n\r\n" + payload, [&](const auto& request) {
      std::promise<drogon::HttpResponsePtr> settled;
      auto reply = settled.get_future();
      a.api.ask(request, [&settled](const auto& answer) { settled.set_value(answer); });
      answeredWhileRunning = reply.wait_for(std::chrono::milliseconds(100)) == std::future_status::ready;
      release.set_value();
      if (reply.wait_for(std::chrono::seconds(5)) != std::future_status::ready)
        throw std::runtime_error("Coach replay did not complete");
      response = reply.get();
      return response;
    });
    CHECK_FALSE(answeredWhileRunning);
    REQUIRE(completed.wait_for(std::chrono::seconds(5)) == std::future_status::ready);
    const auto answer = bodyOf(completed.get());
    CHECK_EQ(answer["generation"]["status"].asString(), std::string("completed"));
    Json::Value expected(Json::objectValue);
    expected["thread"] = answer["thread"];
    expected["generation"] = answer["generation"];
    REQUIRE(response);
    CHECK_EQ(response->contentTypeString(), std::string("text/event-stream"));
    CHECK_FALSE(static_cast<bool>(response->asyncStreamCallback()));
    const auto headerEnd = exchange.answer.find("\r\n\r\n");
    REQUIRE(headerEnd != std::string::npos);
    CHECK_EQ(exchange.answer.substr(headerEnd + 4), "id: " + answer["generation"]["id"].asString() + ":" +
        std::to_string(answer["generation"]["revision"].asUInt64()) +
        "\nevent: snapshot\ndata: " + dump(expected) + "\n\n");
    CHECK_EQ(a.agent.runs, 1);
    CHECK(a.failures->reports.empty());
  }
}

TEST(gym_setup_wire_preserves_typed_choices_and_immutable_purpose) {
  AskHarness a;
  const auto details = parse(R"({"question":"How many days can you train?","groups":[{"id":"days","label":"Days per week","multiple":false,"options":[{"id":"three","label":"3 days"},{"id":"four","label":"4 days"}]}]})");
  a.agent.plan = {{"ask_setup_details", details}};
  const auto first = a.ask("thr_setup001", "Help me build a routine", "s-live", "req_setup001", "routine_setup");
  REQUIRE_EQ(first->getStatusCode(), drogon::k200OK);
  const auto body = bodyOf(first);
  auto expected = details;
  expected["id"] = "clarify_" + body["generation"]["id"].asString();
  CHECK_EQ(body["clarification"], expected);
  CHECK_EQ(body["generation"]["clarification"], expected);
  CHECK_EQ(body["generation"]["purpose"], Json::Value("routine_setup"));
  const auto replay = a.ask("thr_setup001", "Help me build a routine", "s-live", "req_setup001", "routine_setup");
  CHECK_EQ(bodyOf(replay), body);
  CHECK_EQ(a.agent.runs, 1);
  CHECK_EQ(a.ask("thr_setup001", "Help me build a routine", "s-live", "req_setup001", "conversation")->getStatusCode(), drogon::k409Conflict);
  const auto stored = a.h.repo.threads.thread(a.lifter, ThreadId{"thr_setup001"});
  REQUIRE(stored);
  CHECK_EQ(toJson(*stored)["turns"][1]["clarification"], expected);
  CHECK_EQ(toJson(*stored)["turns"][0]["purpose"], Json::Value("routine_setup"));
  CHECK_FALSE(toJson(*stored)["turns"][0].isMember("clarification"));
  CHECK(a.failures->reports.empty());
}

TEST(gym_setup_refuses_unknown_purpose_and_accepts_eight_thousand_utf8_bytes) {
  AskHarness a;
  CHECK_EQ(a.ask("thr_badpurpose", "Hello", "s-live", "req_badpurpose", "purchase")->getStatusCode(), drogon::k400BadRequest);
  std::string text;
  for (int index = 0; index < 2000; ++index) text += "🏋";
  REQUIRE_EQ(text.size(), 8000u);
  CHECK_EQ(a.ask("thr_eightkb1", text, "s-live", "req_eightkb1", "routine_setup")->getStatusCode(), drogon::k200OK);
  CHECK_EQ(a.agent.seenTurns.back().text, text);
  CHECK_EQ(a.ask("thr_eightkb2", text + "x", "s-live", "req_eightkb2", "routine_setup")->getStatusCode(), drogon::k400BadRequest);
  CHECK_EQ(a.agent.runs, 1);
}

TEST(gym_setup_rejects_malformed_choices_and_only_offers_the_tool_for_setup) {
  const auto valid = parse(R"({"id":"clarify_valid","question":"How many days?","groups":[{"id":"days","label":"Days","multiple":false,"options":[{"id":"three","label":"3 days"}]}]})");
  REQUIRE(clarificationFrom(valid));
  std::vector<Json::Value> bad;
  auto value = valid; value["groups"][0]["options"][0]["action"] = "create"; bad.push_back(value);
  value = valid; value["groups"].append(value["groups"][0]); bad.push_back(value);
  value = valid; value["groups"][0]["multiple"] = true; bad.push_back(value);
  value = valid; value["groups"][0]["id"] = "purchase"; bad.push_back(value);
  value = valid; value["groups"][0]["options"].append(value["groups"][0]["options"][0]); bad.push_back(value);
  value = valid; value["question"] = std::string(501, 'a'); bad.push_back(value);
  value = valid; value["groups"][0]["options"][0]["label"] = std::string("\0secret", 7); bad.push_back(value);
  value = valid; value["groups"][0]["options"] = Json::Value(Json::arrayValue); bad.push_back(value);
  value = valid; for (int index = 0; index < 7; ++index) { value["groups"][0]["options"][index]["id"] = "choice" + std::to_string(index); value["groups"][0]["options"][index]["label"] = "Choice"; } bad.push_back(value);
  for (const auto& malformed : bad) CHECK_FALSE(clarificationFrom(malformed));
  AskHarness a;
  auto args = valid; args.removeMember("id");
  a.agent.plan = {{"ask_setup_details", args}};
  const auto response = a.ask("thr_plain001", "Help me train");
  CHECK_EQ(bodyOf(response)["steps"], parse(R"([{"tool":"ask_setup_details","failed":true}])"));
  CHECK_FALSE(bodyOf(response)["generation"].isMember("clarification"));
}

TEST(gym_setup_http_retains_multiple_routine_drafts_after_later_usd_refusal) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  DoorApis h;
  FakeSubscriptionRepository subs;
  FakeAiUsageRepository usage;
  FakeAiBudgetRepository allowance;
  auto budgets = std::make_shared<AiBudgetService>(allowance, [] { return AiBudgetLimits{}; }, [&] { return static_cast<long long>(h.clock.now); });
  Entitlements entitlements{subs, usage, {}, {}, budgets};
  struct PartialModel : FakeAsk {
    AskAnswer answer(const std::vector<AskTurn>& turns, const ToolCaller& caller, ToolHost& tools) override {
      auto result = FakeAsk::answer(turns, caller, tools);
      result.ok = false;
      result.outcomeCode = "subject_exhausted";
      return result;
    }
  } agent;
  agent.plan = {{"list_notes", parse("{}")}, {"list_exercises", parse("{}")}};
  for (int index = 0; index < 3; ++index) {
    auto routine = parse(R"({"id":"rt_model0001","name":"Upper","position":0,"entries":[{"exerciseId":"bench-press","sets":[{"reps":8}]}]})");
    routine["id"] = "rt_httpmodel" + std::to_string(index);
    routine["name"] = "Day " + std::to_string(index + 1);
    routine["position"] = index;
    agent.plan.emplace_back("create_routine", routine);
  }
  auto failures = std::make_shared<CoachFailures>();
  auto service = std::make_shared<AskService>(h.training, h.repo.threads, h.clock, agent, h.tools, entitlements, failures);
  AskApi api{service, h.auth};
  const auto request = parse(R"({"thread":"thr_httpmulti","requestId":"req_httpmulti","question":"Build three days","purpose":"routine_setup","routineReview":true})");
  std::promise<drogon::HttpResponsePtr> settled;
  api.ask(postRequest("/v1/gym/ask", request, "s-door"), [&](const auto& response) { settled.set_value(response); });
  const auto response = settled.get_future().get();
  REQUIRE_EQ(response->getStatusCode(), drogon::k429TooManyRequests);
  const auto body = bodyOf(response);
  CHECK_EQ(body["code"], Json::Value("subject_exhausted"));
  CHECK_EQ(body["reason"], Json::Value("request_exceeds_remaining"));
  CHECK_EQ(body["allowance"]["currency"], Json::Value("USD"));
  REQUIRE_EQ(body["generation"]["routineDrafts"].size(), 3u);
  CHECK(body["results"].empty());
  CHECK_EQ(body["results"], body["generation"]["results"]);
  CHECK_EQ(body["generation"]["purpose"], Json::Value("routine_setup"));
  CHECK_EQ(body["generation"]["allowanceRefusal"], body["allowance"]);
  Json::Value results(Json::arrayValue);
  for (int index = 0; index < 3; ++index) {
    Json::Value result(Json::objectValue);
    result["state"] = "pending";
    result["position"] = index;
    result["entries"] = parse(R"([{"position":1,"exerciseId":"bench-press","sets":[{"reps":8}]}])");
    result["operationId"] = "op_create_" + std::to_string(index) + "_" + body["generation"]["id"].asString();
    result["routineId"] = "rt_" + body["generation"]["id"].asString() + "_" + std::to_string(index);
    result["name"] = "Day " + std::to_string(index + 1);
    results.append(result);
  }
  CHECK_EQ(body["generation"]["routineDrafts"], results);
  const auto stored = h.repo.threads.thread(h.user, ThreadId{"thr_httpmulti"});
  REQUIRE(stored);
  CHECK_EQ(toJson(*stored)["turns"][1]["routineDrafts"], results);
  CHECK_EQ(toJson(*stored)["turns"][1]["allowanceRefusal"], body["allowance"]);
  CHECK(failures->reports.empty());
}


TEST(gym_legacy_retry_inherits_a_failed_setup_generations_purpose) {
  AskHarness a;
  const auto details = parse(R"({"question":"How many days?","groups":[{"id":"days","label":"Days","multiple":false,"options":[{"id":"three","label":"3 days"}]}]})");
  a.agent.plan = {{"ask_setup_details", details}};
  a.agent.answers = false;
  const auto failed = a.ask("thr_legacysetup", "Help me train", "s-live", "req_legacysetup", "routine_setup");
  REQUIRE_EQ(failed->getStatusCode(), drogon::k502BadGateway);
  a.agent.answers = true;
  const auto retry = a.ask("thr_legacysetup", "Help me train", "s-live", "req_legacysetup");
  REQUIRE_EQ(retry->getStatusCode(), drogon::k200OK);
  CHECK_EQ(bodyOf(retry)["generation"]["id"], bodyOf(failed)["generation"]["id"]);
  CHECK_EQ(bodyOf(retry)["generation"]["purpose"], Json::Value("routine_setup"));
  CHECK_EQ(bodyOf(retry)["generation"]["clarification"], bodyOf(failed)["generation"]["clarification"]);
  CHECK_EQ(a.agent.runs, 2);
  CHECK_EQ(a.ask("thr_legacysetup", "Help me train", "s-live", "req_legacysetup", "conversation")->getStatusCode(), drogon::k409Conflict);
}
