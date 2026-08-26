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
      *h.trainingService, *h.threadService, agent, gymTools, entitlements);
  AskApi api{askService, h.auth};
  UserId lifter = h.signIn("s-live");

  // The answer lands on a worker thread when the model runs and inline when the door refuses.
  drogon::HttpResponsePtr ask(const std::string& thread, const std::string& question,
                              const std::string& cookie = "s-live") {
    Json::Value body(Json::objectValue);
    body["thread"] = thread;
    body["question"] = question;
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
  CHECK_EQ(body.getMemberNames().size(), body.isMember("code") ? 2u : 1u);
  return {response->getStatusCode(), body["error"].asString(), body["code"].asString()};
}

}  // namespace

TEST(gym_ask_answers_with_the_servers_own_read_line_and_no_steps_it_did_not_take) {
  AskHarness a;

  const drogon::HttpResponsePtr response = a.ask("thr_00000001", "how did the squats go?");

  CHECK_EQ(response->getStatusCode(), drogon::k200OK);
  CHECK_EQ(dump(bodyOf(response)),
           std::string(R"({"answer":"You squatted 100 for five.","proposals":[],)"
                       R"("read":{"sessions":0,"sets":0,"weeks":0},"steps":[],)"
                       R"("thread":"thr_00000001"})"));
  CHECK_EQ(a.agent.runs, 1);
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
  a.seedThread(a.lifter, "thr_00000003", kMaxThreadTurns);

  const drogon::HttpResponsePtr taken = a.ask("thr_00000002", "and mine?");
  const drogon::HttpResponsePtr full = a.ask("thr_00000003", "once more");
  a.h.clock.now = 1'700'100'000'000;
  a.h.trainingService->start(a.lifter, SessionStart{SessionId{"ses_22222222"}, 1'700'100'000'000});
  const drogon::HttpResponsePtr open = a.ask("thr_00000004", "what should I do next?");

  CHECK_EQ(refusalOf(taken),
           (Refusal{drogon::k409Conflict,
                    "that conversation id is already in use — start a new one",
                    "ask-thread-taken"}));
  CHECK_EQ(refusalOf(full),
           (Refusal{drogon::k409Conflict,
                    "this conversation holds four questions — start a new one",
                    "ask-thread-full"}));
  CHECK_EQ(refusalOf(open),
           (Refusal{drogon::k409Conflict,
                    "finish your workout first — Coach reads a log that has stopped moving",
                    "ask-session-open"}));
  CHECK_EQ(a.agent.runs, 0);
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
  CHECK_EQ(a.h.threadService->threads(a.lifter).size(), 0u);   // nothing stored for either
}
