#include "products/gym/application/CoachService.h"

#include "products/gym/adapters/mcp/GymToolCatalog.h"
#include "products/gym/adapters/mcp/GymTools.h"
#include "test/platform/Fakes.h"
#include "test/products/gym/Fakes.h"
#include "test/testing.h"

#include <algorithm>
#include <future>
#include <string>
#include <vector>

using namespace wm;
using namespace wm::fake;
using namespace wm::gym;
using namespace wm::gym::fake;

namespace {

// A CoachAgent that never leaves the process: it records the grant it was handed and the catalog it
// could see, and answers whatever it was told to. The panel's gates are what this file is about, and
// they all sit BEFORE this is reached.
struct FakeCoach : CoachAgent {
  bool wired = true;
  int runs = 0;
  ToolScope grantedScope;
  Json::Value seenCatalog{Json::arrayValue};
  std::vector<CoachTurn> seenTurns;

  bool configured() const override { return wired; }

  CoachAnswer answer(const SessionId&, const std::vector<CoachTurn>& turns, const ToolCaller& caller,
                     ToolHost& tools) override {
    ++runs;
    grantedScope = caller.scope;
    seenCatalog = tools.listTools(caller);
    seenTurns = turns;
    CoachAnswer out;
    out.ok = true;
    out.answer = "You squatted 100 for five.";
    return out;
  }
};

struct Harness {
  FakeTrainingRepository repo;
  FakeClock clock;
  FakeTokens tokens;
  FakeSubscriptionRepository subs;
  FakeAiUsageRepository usage;
  Entitlements entitlements{subs, usage};
  LogService log{repo, clock, tokens};
  GymTools gymTools{log, "https://windmill.works"};
  FakeCoach agent;
  CoachService coach{log, agent, gymTools, entitlements};

  const UserId lifter{"lifter"};
  const SessionId session{"ses_11111111"};

  Harness() {
    repo.seed(benchPress());
    repo.seed(backSquat());
    log.start(lifter, SessionStart{session, 1'700'000'000'000});
    log.finish(lifter, session, 1'700'000'900'000);
  }

  void subscribe() { subscribe(lifter); }
  void subscribe(const UserId& who) { subs.subscribe(who, "active"); }

  // ask() answers on a worker thread when it runs and inline when it refuses; both land here.
  CoachReply ask(std::vector<CoachTurn> turns, const UserId& caller, const SessionId& id) {
    std::promise<CoachReply> settled;
    std::future<CoachReply> reply = settled.get_future();
    coach.ask(caller, "sam@example.com", id, std::move(turns),
              [&settled](CoachReply answer) { settled.set_value(std::move(answer)); });
    return reply.get();
  }

  CoachReply ask(std::vector<CoachTurn> turns) { return ask(std::move(turns), lifter, session); }
};

std::vector<CoachTurn> question(const char* text) { return {CoachTurn{true, text}}; }

bool holds(const std::vector<ToolDeclaration>& tools, const std::string& name) {
  return std::any_of(tools.begin(), tools.end(),
                     [&name](const ToolDeclaration& tool) { return tool.name() == name; });
}

}  // namespace

// --- CoachTools: the narrowing, against gym's REAL catalog ----------------------------------

TEST(coach_tools_hand_the_model_gyms_reads_and_nothing_else) {
  Harness h;
  CoachTools hands(h.gymTools, h.session);

  const std::vector<ToolDeclaration> offered = hands.declareTools();
  for (const ToolDeclaration& tool : offered) CHECK(tool.access == Access::read);

  // Every read gym publishes is here…
  CHECK(holds(offered, "list_exercises"));
  CHECK(holds(offered, "list_sessions"));
  CHECK(holds(offered, "get_session"));
  CHECK(holds(offered, "last_time"));
  CHECK(holds(offered, "list_routines"));
  CHECK(holds(offered, "get_stats"));
  // …and not one thing that writes or takes away. A panel that could see log_set would be a panel
  // somebody would eventually let write.
  CHECK_FALSE(holds(offered, "log_set"));
  CHECK_FALSE(holds(offered, "start_session"));
  CHECK_FALSE(holds(offered, "finish_session"));
  CHECK_FALSE(holds(offered, "save_routine"));
  CHECK_FALSE(holds(offered, "create_exercise"));
  CHECK_FALSE(holds(offered, "share_session"));
  CHECK_FALSE(holds(offered, "discard_session"));
  CHECK_FALSE(holds(offered, "delete_routine"));
  CHECK_FALSE(holds(offered, "revoke_share"));

  std::size_t reads = 0;
  for (const ToolDeclaration& tool : gymToolCatalog())
    if (tool.access == Access::read) ++reads;
  CHECK_EQ(offered.size(), reads);
}

// THE ONE THAT MATTERS. GymTools does not gate — over MCP the grant was settled above it — so if the
// panel were wired straight to it, a model that named a delete tool would DELETE. This is the lock.
TEST(coach_tools_refuse_a_destructive_tool_and_the_workout_survives) {
  Harness h;
  CoachTools hands(h.gymTools, h.session);
  const ToolCaller actor{h.lifter, ToolScope({{"gym", Access::read}})};

  Json::Value arguments(Json::objectValue);
  arguments["sessionId"] = h.session.str();
  const ToolResult refused = hands.callTool("discard_session", arguments, actor);

  CHECK(refused.isError);
  CHECK(refused.content[0]["text"].asString().find("never changes it") != std::string::npos);
  CHECK(h.log.detail(h.lifter, h.session).has_value());  // the workout is still in the log
}

TEST(coach_tools_refuse_a_write_tool_even_when_the_arguments_are_perfect) {
  Harness h;
  CoachTools hands(h.gymTools, h.session);
  const ToolCaller actor{h.lifter, ToolScope({{"gym", Access::read}})};

  Json::Value arguments(Json::objectValue);
  arguments["sessionId"] = h.session.str();
  CHECK(hands.callTool("share_session", arguments, actor).isError);
  CHECK(h.repo.shares.empty());  // no coach link was minted behind the lifter's back
}

TEST(coach_tools_pin_every_call_to_the_workout_the_panel_was_opened_on) {
  Harness h;
  // A second workout the lifter also owns — a note inside the first must not be able to steer the
  // panel onto it.
  const SessionId other{"ses_22222222"};
  h.log.start(h.lifter, SessionStart{other, 1'700'100'000'000});
  h.log.finish(h.lifter, other, 1'700'100'900'000);

  CoachTools hands(h.gymTools, h.session);
  const ToolCaller actor{h.lifter, ToolScope({{"gym", Access::read}})};

  Json::Value arguments(Json::objectValue);
  arguments["sessionId"] = other.str();
  const ToolResult read = hands.callTool("get_session", arguments, actor);

  CHECK_FALSE(read.isError);
  CHECK_EQ(read.payload["session"]["id"].asString(), h.session.str());
}

TEST(coach_tools_refuse_a_name_no_catalog_holds) {
  Harness h;
  CoachTools hands(h.gymTools, h.session);
  const ToolCaller actor{h.lifter, ToolScope({{"gym", Access::read}})};
  CHECK(hands.callTool("delete_everything", Json::Value(Json::objectValue), actor).isError);
}

// --- CoachService: every gate, and every one of them before a token is spent ----------------

TEST(the_panel_answers_a_subscriber_and_hands_the_run_a_read_only_grant) {
  Harness h;
  h.subscribe();

  const CoachReply reply = h.ask(question("how did the squats go?"));

  CHECK(reply.refusal == CoachRefusal::none);
  CHECK(reply.answer.ok);
  CHECK_EQ(reply.answer.answer, std::string("You squatted 100 for five."));
  CHECK_EQ(h.agent.runs, 1);

  // The grant said out loud at the call site: gym, read, and nothing else — not this account's
  // write, not its delete, and not another product it happens to own.
  CHECK(h.agent.grantedScope.allows("gym", Access::read));
  CHECK_FALSE(h.agent.grantedScope.allows("gym", Access::write));
  CHECK_FALSE(h.agent.grantedScope.allows("gym", Access::del));
  CHECK_FALSE(h.agent.grantedScope.allows("roadmap", Access::read));
  // And the catalog it could actually see is that grant made visible.
  CHECK_EQ(h.agent.seenCatalog.size(), 6u);
}

TEST(a_lifter_without_windmill_one_is_refused_before_the_question_travels) {
  Harness h;  // no subscription

  const CoachReply reply = h.ask(question("how did the squats go?"));

  CHECK(reply.refusal == CoachRefusal::notEntitled);
  CHECK_EQ(h.agent.runs, 0);  // a non-subscriber's words never reach the vendor
}

TEST(an_unconfigured_deployment_refuses_rather_than_pretending_a_model_exists) {
  Harness h;
  h.subscribe();
  h.agent.wired = false;

  CHECK(h.ask(question("how did it go?")).refusal == CoachRefusal::notConfigured);
  CHECK_FALSE(h.coach.configured());  // …which is what keeps the route from being mounted at all
  CHECK_EQ(h.agent.runs, 0);
}

TEST(a_workout_this_account_cannot_read_is_one_answer_absent_and_anothers_alike) {
  Harness h;
  h.subscribe();
  // The stranger holds Windmill One too, so what refuses them below is ownership and nothing else —
  // the entitlement is read first, and a test that left them unsubscribed would be proving the
  // paywall a second time while claiming to prove the scoping.
  const UserId stranger{"stranger"};
  h.subscribe(stranger);

  CHECK(h.ask(question("how did it go?"), h.lifter, SessionId{"ses_99999999"}).refusal ==
        CoachRefusal::unknownSession);
  CHECK(h.ask(question("how did it go?"), stranger, h.session).refusal ==
        CoachRefusal::unknownSession);
  CHECK_EQ(h.agent.runs, 0);
}

TEST(a_thread_that_is_not_a_conversation_is_refused) {
  Harness h;
  h.subscribe();

  CHECK(h.ask({}).refusal == CoachRefusal::turnsMalformed);
  // Ends on the coach: there is nothing being asked.
  CHECK(h.ask({CoachTurn{true, "hi"}, CoachTurn{false, "hello"}}).refusal ==
        CoachRefusal::turnsMalformed);
  // Opens on the coach: a reply to a question nobody asked.
  CHECK(h.ask({CoachTurn{false, "hello"}}).refusal == CoachRefusal::turnsMalformed);
  // Two lifter turns in a row: a thread the client assembled wrong.
  CHECK(h.ask({CoachTurn{true, "hi"}, CoachTurn{true, "still hi"}}).refusal ==
        CoachRefusal::turnsMalformed);
  CHECK_EQ(h.agent.runs, 0);
}

TEST(a_blank_question_and_an_oversized_one_are_each_their_own_refusal) {
  Harness h;
  h.subscribe();

  CHECK(h.ask(question("   \n ")).refusal == CoachRefusal::questionEmpty);
  CHECK(h.ask({CoachTurn{true, std::string(kMaxCoachTurnBytes + 1, 'a')}}).refusal ==
        CoachRefusal::questionTooLong);
  CHECK_EQ(h.agent.runs, 0);
}

TEST(a_thread_longer_than_the_panel_holds_is_refused) {
  Harness h;
  h.subscribe();

  std::vector<CoachTurn> thread;
  for (std::size_t index = 0; index <= kMaxCoachTurns; ++index)
    thread.push_back(CoachTurn{index % 2 == 0, "a"});
  if (!thread.back().fromLifter) thread.push_back(CoachTurn{true, "a"});

  CHECK(h.ask(thread).refusal == CoachRefusal::tooManyTurns);
  CHECK_EQ(h.agent.runs, 0);
}

TEST(the_per_account_brake_refuses_the_fourth_question_in_a_burst) {
  Harness h;
  h.subscribe();

  CHECK(h.ask(question("one")).refusal == CoachRefusal::none);
  CHECK(h.ask(question("two")).refusal == CoachRefusal::none);
  CHECK(h.ask(question("three")).refusal == CoachRefusal::none);
  CHECK(h.ask(question("four")).refusal == CoachRefusal::rateLimited);
  CHECK_EQ(h.agent.runs, 3);
}

TEST(an_account_over_its_ai_ceiling_is_refused_before_the_question_travels) {
  Harness h;
  h.subscribe();
  h.usage.spentByProduct[""] = kProMonthlyAiNanos;  // this account's own window is spent

  const CoachReply reply = h.ask(question("how did the squats go?"));

  CHECK(reply.refusal == CoachRefusal::outOfBudget);
  CHECK_EQ(h.agent.runs, 0);  // nothing is spent proving we are out of budget
}

TEST(a_subscriber_over_the_free_ceiling_but_under_their_own_still_gets_an_answer) {
  Harness h;
  h.subscribe();
  h.usage.spentByProduct[""] = kFreeMonthlyAiNanos;  // spent for a free account, not for this one

  const CoachReply reply = h.ask(question("how did the squats go?"));

  CHECK(reply.refusal == CoachRefusal::none);
  CHECK_EQ(h.agent.runs, 1);
}

TEST(a_maxed_journal_sweep_never_stops_the_coach_answering) {
  Harness h;
  h.subscribe();
  // The background bucket is gone; the account's own total is barely touched. The panel is the
  // thing the lifter ASKED for, and a sweep they did not ask for cannot take it from them.
  h.usage.spentByProduct["journal"] = kSweepMonthlyAiNanos;
  h.usage.spentByProduct[""] = kSweepMonthlyAiNanos;

  const CoachReply reply = h.ask(question("how did the squats go?"));

  CHECK(reply.refusal == CoachRefusal::none);
  CHECK_EQ(h.agent.runs, 1);
}

TEST(an_unentitled_account_over_the_ceiling_hears_the_reason_that_is_actually_theirs) {
  Harness h;  // no subscription
  h.usage.spentByProduct[""] = kProMonthlyAiNanos;

  // Both rungs would refuse. The entitlement is the true one and comes first — telling somebody
  // they are over a ceiling they never had access to would be a refusal that explains nothing.
  CHECK(h.ask(question("how did the squats go?")).refusal == CoachRefusal::notEntitled);
}
