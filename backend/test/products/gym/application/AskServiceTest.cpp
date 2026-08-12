#include "products/gym/application/AskService.h"

#include "products/gym/adapters/mcp/GymToolCatalog.h"
#include "products/gym/adapters/mcp/GymTools.h"
#include "test/platform/Fakes.h"
#include "test/products/gym/Fakes.h"
#include "test/testing.h"

#include <algorithm>
#include <future>
#include <stdexcept>
#include <string>
#include <vector>

using namespace wm;
using namespace wm::fake;
using namespace wm::gym;
using namespace wm::gym::fake;

namespace {

// An AskAgent that never leaves the process: it records the grant it was handed and the catalog it
// could see, runs whatever tools it was told to, and answers. Ask's gates are what this file is
// about, and they all sit BEFORE this is reached.
struct FakeAsk : AskAgent {
  bool wired = true;
  // A vendor that answers, or one that does not: a dead upstream, an early stop, a cap hit mid-loop —
  // every one of them reaches the lifter as "Ask didn't answer" and none of them may cost a question.
  bool answers = true;
  // …and the harsher one: a run that throws where nothing above it catches.
  bool throwsUp = false;
  int runs = 0;
  ToolScope grantedScope;
  Json::Value seenCatalog{Json::arrayValue};
  std::vector<AskTurn> seenTurns;
  // What the "model" reaches for, in order — so a test can watch the receipt and the proposal ledger
  // fill from the tools rather than from anything the answer says.
  std::vector<std::pair<std::string, Json::Value>> plan;

  bool configured() const override { return wired; }

  AskAnswer answer(const std::vector<AskTurn>& turns, const ToolCaller& caller,
                   ToolHost& tools) override {
    ++runs;
    if (throwsUp) throw std::runtime_error("the vendor sent a document nobody can read");
    grantedScope = caller.scope;
    seenCatalog = tools.listTools(caller);
    seenTurns = turns;
    AskAnswer out;
    for (const std::pair<std::string, Json::Value>& step : plan) {
      const ToolResult result = tools.callTool(step.first, step.second, caller);
      out.steps.push_back(AskStep{step.first, result.isError});
    }
    out.ok = answers;
    if (!answers) {
      out.error = "the upstream never answered";
      return out;
    }
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
  FakeAsk agent;
  AskService ask{log, agent, gymTools, entitlements};

  const UserId lifter{"lifter"};
  const SessionId session{"ses_11111111"};

  Harness() {
    repo.seed(benchPress());
    repo.seed(backSquat());
    log.start(lifter, SessionStart{session, 1'700'000'000'000});
    log.append(lifter, session,
               SetWrite{setId(), ExerciseId{"back-squat"}, 100, 5, SetKind::working, std::nullopt,
                        "", 1'700'000'300'000});
    log.finish(lifter, session, 1'700'000'900'000);
  }

  void subscribe() { subs.subscribe(lifter, "active"); }

  // A day of the program this lifter owns, so a proposal has something to be about.
  void seedRoutine() {
    repo.routineRows.push_back(Routine{rtId(), lifter, "Push A", 0, {benchEntry()}});
  }

  // ask() answers on a worker thread when it runs and inline when it refuses; both land here.
  AskReply question(std::vector<AskTurn> turns, const UserId& caller) {
    std::promise<AskReply> settled;
    std::future<AskReply> reply = settled.get_future();
    ask.ask(caller, "sam@example.com", std::move(turns),
            [&settled](AskReply answer) { settled.set_value(std::move(answer)); });
    return reply.get();
  }

  AskReply question(std::vector<AskTurn> turns) { return question(std::move(turns), lifter); }
};

std::vector<AskTurn> asked(const char* text) { return {AskTurn{true, text}}; }

Json::Value sessionArgs(const SessionId& id) {
  Json::Value args(Json::objectValue);
  args["sessionId"] = id.str();
  return args;
}

bool holds(const std::vector<ToolDeclaration>& tools, const std::string& name) {
  return std::any_of(tools.begin(), tools.end(),
                     [&name](const ToolDeclaration& tool) { return tool.name() == name; });
}

}  // namespace

// --- AskTools: the narrowing, against gym's REAL catalog -------------------------------------

TEST(ask_tools_hand_the_model_gyms_reads_and_the_two_tools_that_only_propose) {
  Harness h;
  AskTools hands(h.gymTools);

  const std::vector<ToolDeclaration> offered = hands.declareTools();
  // Every read gym publishes is here — Ask reads the LOG, not one workout…
  CHECK(holds(offered, "list_exercises"));
  CHECK(holds(offered, "list_sessions"));
  CHECK(holds(offered, "get_session"));
  CHECK(holds(offered, "last_time"));
  CHECK(holds(offered, "list_routines"));
  CHECK(holds(offered, "get_stats"));
  CHECK(holds(offered, "get_preferences"));
  // …and the safeguard ladder's middle rung: the two tools that change nothing and hand over a diff.
  CHECK(holds(offered, "propose_routine_change"));
  CHECK(holds(offered, "propose_routine_removal"));
  // Not one thing that changes what a lifter did. A chat that could see log_set is a chat somebody
  // would eventually let write.
  CHECK_FALSE(holds(offered, "log_set"));
  CHECK_FALSE(holds(offered, "start_session"));
  CHECK_FALSE(holds(offered, "finish_session"));
  CHECK_FALSE(holds(offered, "create_routine"));
  CHECK_FALSE(holds(offered, "create_exercise"));
  CHECK_FALSE(holds(offered, "share_session"));
  CHECK_FALSE(holds(offered, "discard_session"));
  CHECK_FALSE(holds(offered, "revoke_share"));

  std::size_t allowed = 0;
  for (const ToolDeclaration& tool : gymToolCatalog())
    if (tool.access == Access::read || mintsProposal(tool.name())) ++allowed;
  CHECK_EQ(offered.size(), allowed);
}

// THE ONE THAT MATTERS. GymTools does not gate — over MCP the grant was settled above it — so if Ask
// were wired straight to it, a model that named a delete tool would DELETE. This is the lock.
TEST(ask_tools_refuse_a_destructive_tool_and_the_workout_survives) {
  Harness h;
  AskTools hands(h.gymTools);
  const ToolCaller actor{h.lifter, ToolScope::everything()};

  const ToolResult refused = hands.callTool("discard_session", sessionArgs(h.session), actor);

  CHECK(refused.isError);
  CHECK(refused.content[0]["text"].asString().find("theirs to change") != std::string::npos);
  CHECK(h.log.detail(h.lifter, h.session).has_value());  // the workout is still in the log
}

TEST(ask_tools_refuse_a_write_tool_even_when_the_arguments_are_perfect) {
  Harness h;
  AskTools hands(h.gymTools);
  const ToolCaller actor{h.lifter, ToolScope::everything()};

  CHECK(hands.callTool("share_session", sessionArgs(h.session), actor).isError);
  CHECK(h.repo.shares.empty());  // no coach link was minted behind the lifter's back
}

TEST(ask_tools_refuse_a_name_no_catalog_holds) {
  Harness h;
  AskTools hands(h.gymTools);
  const ToolCaller actor{h.lifter, ToolScope::everything()};
  CHECK(hands.callTool("delete_everything", Json::Value(Json::objectValue), actor).isError);
}

// THE RECEIPT IS SERVER-OBSERVED. It is filled from the rows the tools handed over, merged by id, and
// nothing the model says can move it — which is the whole reason the line is printable at all.
TEST(ask_tools_count_what_the_tools_served_and_count_an_overlap_once) {
  Harness h;
  AskTools hands(h.gymTools);
  const ToolCaller actor{h.lifter, ToolScope::everything()};

  hands.callTool("list_sessions", Json::Value(Json::objectValue), actor);   // names the workout
  hands.callTool("get_session", sessionArgs(h.session), actor);             // hands over its set
  hands.callTool("get_session", sessionArgs(h.session), actor);             // …asked for twice

  CHECK_EQ(hands.read().tally(), (ReadTally{1, 1, 1}));
}

// THE TWO DOORS REFUSE THE SAME CALL. Every gym tool publishes `additionalProperties: false`; over
// MCP CompositeToolHost keeps that promise and Ask does not pass through it, so a misspelt argument
// was named on one door and silently DROPPED on the other — which on `get_stats` meant answering with
// every movement the lifter has ever trained while the model believed it had asked about one.
TEST(ask_refuses_an_argument_no_schema_declares_and_names_the_one_it_takes) {
  Harness h;
  AskTools hands(h.gymTools);
  const ToolCaller actor{h.lifter, ToolScope::everything()};

  Json::Value misspelt(Json::objectValue);
  misspelt["exerciseID"] = "back-squat";

  const ToolResult refused = hands.callTool("get_stats", misspelt, actor);

  REQUIRE(refused.isError);
  const std::string said = refused.content[0]["text"].asString();
  CHECK(said.find("unknown argument \"exerciseID\"") != std::string::npos);
  CHECK(said.find("exerciseId") != std::string::npos);  // …and the spelling it should have used
  CHECK(said.find("movements") == std::string::npos);   // the whole statistics were NOT handed over
  CHECK_EQ(hands.read().tally(), (ReadTally{0, 0, 0}));
}

// THE RECEIPT NEVER CLAIMS A ROW IT DID NOT HAND OVER, and a refusal hands over none: `get_stats`
// marked every week on the run's line before its own argument could fail, so a read that answered
// with one sentence still inflated the number printed under the answer.
TEST(a_refused_read_leaves_the_runs_line_exactly_where_it_was) {
  Harness h;
  AskTools hands(h.gymTools);
  const ToolCaller actor{h.lifter, ToolScope::everything()};

  Json::Value notAnId(Json::objectValue);
  notAnId["exerciseId"] = 5;  // declared, and not the non-empty string the tool takes

  CHECK(hands.callTool("get_stats", notAnId, actor).isError);
  CHECK_EQ(hands.read().tally(), (ReadTally{0, 0, 0}));

  // …while the same read, spelled right, counts the weeks it really served.
  Json::Value narrowed(Json::objectValue);
  narrowed["exerciseId"] = "back-squat";
  CHECK_FALSE(hands.callTool("get_stats", narrowed, actor).isError);
  CHECK_EQ(hands.read().tally(), (ReadTally{0, 0, 1}));
}

// And the same count rides in the tool's own reply, so a lifter's Claude over MCP reads the accounting
// Ask prints.
TEST(a_read_answers_with_what_it_served_and_a_catalog_read_says_nothing) {
  Harness h;
  const ToolCaller actor{h.lifter, ToolScope::everything()};

  const ToolResult workout = h.gymTools.callTool("get_session", sessionArgs(h.session), actor);
  CHECK_EQ(workout.payload["read"]["sets"].asInt(), 1);
  CHECK_EQ(workout.payload["read"]["sessions"].asInt(), 1);
  CHECK_EQ(workout.payload["read"]["weeks"].asInt(), 1);
  // The wire carries it too — `payload` never leaves this process, and the envelope has to reach a
  // connected agent to be worth anything.
  CHECK(workout.content[0]["text"].asString().find("\"read\":") != std::string::npos);

  const ToolResult catalog =
      h.gymTools.callTool("list_exercises", Json::Value(Json::objectValue), actor);
  CHECK_FALSE(catalog.payload.isMember("read"));  // a movement is not a log row: no claim is made
}

// A proposal Ask mints is the same object an agent's is — W6 built `source` as a column precisely so
// this stays one system — and the id is observed at the tool, never read out of the answer's prose.
TEST(a_proposal_ask_mints_is_recorded_by_id_and_carries_its_own_door) {
  Harness h;
  h.seedRoutine();
  AskTools hands(h.gymTools);
  const ToolCaller actor{h.lifter, ToolScope::everything()};

  Json::Value entry(Json::objectValue);
  entry["exerciseId"] = "bench-press";
  entry["targetSets"] = 5;
  entry["targetReps"] = 3;
  entry["targetWeightKg"] = 87.5;
  Json::Value entries(Json::arrayValue);
  entries.append(entry);

  Json::Value args(Json::objectValue);
  args["id"] = "prop_00000001";
  args["routineId"] = rtId().str();
  args["entries"] = entries;

  const ToolResult minted = hands.callTool("propose_routine_change", args, actor);

  CHECK_FALSE(minted.isError);
  REQUIRE_EQ(hands.proposals().size(), 1u);
  CHECK_EQ(hands.proposals()[0], std::string("prop_00000001"));
  CHECK_EQ(minted.payload["proposal"]["source"]["door"].asString(), std::string("ask"));
  // …and it changed nothing: the routine still reads as it did.
  const std::optional<Routine> standing = h.log.routine(h.lifter, rtId());
  REQUIRE(standing.has_value());
  CHECK_EQ(standing->entries, std::vector<RoutineEntry>{benchEntry()});
}

// --- AskService: every gate, and every one of them before a token is spent -------------------

// THE MONEY DECISION (W7 §4), pinned. Windmill One cannot be bought, so an Ask locked behind it would
// advertise a purchase that answers 503. It ships open, with a cap.
TEST(ask_answers_a_lifter_who_holds_nothing_because_there_is_nothing_to_buy) {
  Harness h;  // no subscription

  const AskReply reply = h.question(asked("how did the squats go?"));

  CHECK(reply.refusal == AskRefusal::none);
  CHECK(reply.answer.ok);
  CHECK_EQ(reply.answer.answer, std::string("You squatted 100 for five."));
  CHECK_EQ(h.agent.runs, 1);
}

TEST(the_run_is_handed_gyms_three_levels_and_no_other_product) {
  Harness h;

  h.question(asked("how did the squats go?"));

  CHECK(h.agent.grantedScope.allows("gym", Access::read));
  CHECK(h.agent.grantedScope.allows("gym", Access::write));
  CHECK(h.agent.grantedScope.allows("gym", Access::del));
  CHECK_FALSE(h.agent.grantedScope.allows("roadmap", Access::read));
  CHECK_FALSE(h.agent.grantedScope.allows("journal", Access::read));
  // What the model can actually SEE is narrower than the grant: the reads plus the two mints.
  std::size_t allowed = 0;
  for (const ToolDeclaration& tool : gymToolCatalog())
    if (tool.access == Access::read || mintsProposal(tool.name())) ++allowed;
  CHECK_EQ(h.agent.seenCatalog.size(), allowed);
}

// NEVER OFFERED MID-SESSION, AND THE SERVER IS WHERE THAT IS TRUE. Three clients each remembering it
// is three chances to forget.
TEST(a_lifter_with_a_workout_open_is_refused_before_anything_is_spent) {
  Harness h;
  h.log.start(h.lifter, SessionStart{SessionId{"ses_22222222"}, 1'700'100'000'000});

  const AskReply reply = h.question(asked("what should I do next?"));

  CHECK(reply.refusal == AskRefusal::sessionOpen);
  CHECK_EQ(h.agent.runs, 0);
}

// …and the same read is what settles a workout somebody walked away from, so yesterday's forgotten
// session does not lock Ask out for good.
TEST(a_stale_workout_the_four_hour_rule_closes_does_not_hold_ask_shut) {
  Harness h;
  h.log.start(h.lifter, SessionStart{SessionId{"ses_33333333"}, 1'700'100'000'000});
  h.clock.now = 1'700'100'000'000 + 5 * 60 * 60 * 1000;  // five hours later, nothing logged since

  const AskReply reply = h.question(asked("how has my squat moved?"));

  CHECK(reply.refusal == AskRefusal::none);
  CHECK_EQ(h.agent.runs, 1);
}

TEST(an_unconfigured_deployment_refuses_rather_than_pretending_a_model_exists) {
  Harness h;
  h.agent.wired = false;

  CHECK(h.question(asked("how did it go?")).refusal == AskRefusal::notConfigured);
  CHECK_FALSE(h.ask.configured());  // …which is what keeps the route from being mounted at all
  CHECK_EQ(h.agent.runs, 0);
}

TEST(a_thread_that_is_not_a_conversation_is_refused) {
  Harness h;

  CHECK(h.question({}).refusal == AskRefusal::turnsMalformed);
  // Ends on Ask: there is nothing being asked.
  CHECK(h.question({AskTurn{true, "hi"}, AskTurn{false, "hello"}}).refusal ==
        AskRefusal::turnsMalformed);
  // Opens on Ask: a reply to a question nobody asked.
  CHECK(h.question({AskTurn{false, "hello"}}).refusal == AskRefusal::turnsMalformed);
  // Two lifter turns in a row: a thread the client assembled wrong.
  CHECK(h.question({AskTurn{true, "hi"}, AskTurn{true, "still hi"}}).refusal ==
        AskRefusal::turnsMalformed);
  CHECK_EQ(h.agent.runs, 0);
}

TEST(a_blank_question_and_an_oversized_one_are_each_their_own_refusal) {
  Harness h;

  CHECK(h.question(asked("   \n ")).refusal == AskRefusal::questionEmpty);
  CHECK(h.question({AskTurn{true, std::string(kMaxAskTurnBytes + 1, 'a')}}).refusal ==
        AskRefusal::questionTooLong);
  CHECK_EQ(h.agent.runs, 0);
}

TEST(a_thread_longer_than_ask_holds_is_refused) {
  Harness h;

  std::vector<AskTurn> thread;
  for (std::size_t index = 0; index <= kMaxAskTurns; ++index)
    thread.push_back(AskTurn{index % 2 == 0, "a"});
  if (!thread.back().fromLifter) thread.push_back(AskTurn{true, "a"});

  CHECK(h.question(thread).refusal == AskRefusal::tooManyTurns);
  CHECK_EQ(h.agent.runs, 0);
}

// THE DAILY LIMIT — the plainly-worded cap that lets Ask ship open. One bucket says both halves: three
// back to back, about ten a day.
TEST(the_daily_limit_refuses_the_fourth_question_in_a_burst) {
  Harness h;

  CHECK(h.question(asked("one")).refusal == AskRefusal::none);
  CHECK(h.question(asked("two")).refusal == AskRefusal::none);
  CHECK(h.question(asked("three")).refusal == AskRefusal::none);
  CHECK(h.question(asked("four")).refusal == AskRefusal::dailyLimit);
  CHECK_EQ(h.agent.runs, 3);
}

// A QUESTION NOBODY ANSWERED IS NOT ONE OF THE DAY'S. Three dead upstreams used to spend a lifter's
// whole burst and then tell them — in the cap's own copy, the one sentence the money ruling says must
// be honest — that they had used the day's questions, having been given no answer at all.
TEST(a_run_the_vendor_never_answered_gives_the_question_back) {
  Harness h;
  h.agent.answers = false;

  for (int attempt = 0; attempt < 3; ++attempt) {
    const AskReply dead = h.question(asked("how did the squats go?"));
    CHECK(dead.refusal == AskRefusal::none);  // it reached the vendor; the vendor is what failed
    CHECK_FALSE(dead.answer.ok);
  }

  h.agent.answers = true;
  const AskReply answered = h.question(asked("how did the squats go?"));

  CHECK(answered.refusal == AskRefusal::none);
  CHECK(answered.answer.ok);
  CHECK_EQ(h.agent.runs, 4);
}

// AND A RUN THAT THREW TAKES NOTHING WITH IT. Nothing sits above a worker loop to catch an exception,
// so one leaving the run is every product on the box gone and a request nobody ever answers — where
// the lifter's own answer to all of it is the 502 a dead upstream already gets.
TEST(a_run_that_threw_answers_the_lifter_rather_than_taking_the_process_with_it) {
  Harness h;
  h.agent.throwsUp = true;

  const AskReply thrown = h.question(asked("how did the squats go?"));

  CHECK(thrown.refusal == AskRefusal::none);
  CHECK_FALSE(thrown.answer.ok);
  CHECK_EQ(thrown.answer.answer, std::string(""));

  // …and it cost none of the day's questions either.
  h.agent.throwsUp = false;
  for (int attempt = 0; attempt < 3; ++attempt)
    CHECK(h.question(asked("how did the squats go?")).refusal == AskRefusal::none);
  CHECK_EQ(h.agent.runs, 4);
}

// …and the question is taken AFTER every other rung, so a refusal that answered nothing costs nothing
// either. An account held at OUR ceiling was charged one of the day's questions for a run that never
// left the building, and read the cap's sentence once the window rolled on.
TEST(a_refusal_above_the_ration_costs_none_of_the_days_questions) {
  Harness h;
  h.usage.spentByProduct[""] = kProMonthlyAiNanos;

  for (int attempt = 0; attempt < 4; ++attempt)
    CHECK(h.question(asked("how did the squats go?")).refusal == AskRefusal::outOfBudget);

  h.usage.spentByProduct[""] = 0;  // the trailing window rolls on
  CHECK(h.question(asked("how did the squats go?")).refusal == AskRefusal::none);
  CHECK(h.question(asked("and the bench?")).refusal == AskRefusal::none);
  CHECK(h.question(asked("what about next week?")).refusal == AskRefusal::none);
  CHECK_EQ(h.agent.runs, 3);
}

TEST(an_account_over_its_ai_ceiling_is_refused_before_the_question_travels) {
  Harness h;
  h.usage.spentByProduct[""] = kProMonthlyAiNanos;  // this account's own window is spent

  const AskReply reply = h.question(asked("how did the squats go?"));

  CHECK(reply.refusal == AskRefusal::outOfBudget);
  CHECK_EQ(h.agent.runs, 0);  // nothing is spent proving we are out of budget
}

// The One gate is one predicate away rather than gone: the plan already picks the ceiling, so a
// subscriber gets the larger one on exactly the line the gate would arm on.
TEST(a_subscriber_over_the_free_ceiling_but_under_their_own_still_gets_an_answer) {
  Harness h;
  h.subscribe();
  h.usage.spentByProduct[""] = kFreeMonthlyAiNanos;  // spent for a free account, not for this one

  const AskReply reply = h.question(asked("how did the squats go?"));

  CHECK(reply.refusal == AskRefusal::none);
  CHECK_EQ(h.agent.runs, 1);
}

TEST(a_maxed_journal_sweep_never_stops_ask_answering) {
  Harness h;
  // The background bucket is its own. Ask is the thing the lifter ASKED for, and a sweep they did not
  // ask for cannot take it from them.
  h.usage.spentByProduct["journal"] = kSweepMonthlyAiNanos;
  h.usage.spentByProduct[""] = kSweepMonthlyAiNanos;

  CHECK(h.question(asked("how did the squats go?")).refusal == AskRefusal::none);
  CHECK_EQ(h.agent.runs, 1);
}

// THE ANSWER'S TWO SERVER-OBSERVED HALVES, end to end: what the run read, and what it minted.
TEST(the_reply_carries_the_servers_own_read_line_and_the_proposals_the_run_minted) {
  Harness h;
  h.seedRoutine();

  Json::Value entry(Json::objectValue);
  entry["exerciseId"] = "bench-press";
  entry["targetSets"] = 5;
  entry["targetReps"] = 3;
  entry["targetWeightKg"] = 87.5;
  Json::Value entries(Json::arrayValue);
  entries.append(entry);
  Json::Value propose(Json::objectValue);
  propose["id"] = "prop_00000009";
  propose["routineId"] = rtId().str();
  propose["entries"] = entries;

  h.agent.plan = {{"list_sessions", Json::Value(Json::objectValue)},
                  {"get_session", sessionArgs(h.session)},
                  {"propose_routine_change", propose}};

  const AskReply reply = h.question(asked("write me the triples block"));

  CHECK(reply.refusal == AskRefusal::none);
  CHECK_EQ(reply.read, (ReadTally{1, 1, 1}));  // one workout, its one set, the week it fell in
  REQUIRE_EQ(reply.proposals.size(), 1u);
  CHECK_EQ(reply.proposals[0], std::string("prop_00000009"));
  REQUIRE_EQ(reply.answer.steps.size(), 3u);
  CHECK_FALSE(reply.answer.steps[2].failed);
}

// A run that reached for something it may not have still answers, and the refusal is the tool's — the
// step is marked failed and nothing was touched.
TEST(a_refused_tool_marks_its_step_and_leaves_the_log_alone) {
  Harness h;
  h.agent.plan = {{"discard_session", sessionArgs(h.session)}};

  const AskReply reply = h.question(asked("delete tuesday"));

  CHECK(reply.refusal == AskRefusal::none);
  REQUIRE_EQ(reply.answer.steps.size(), 1u);
  CHECK(reply.answer.steps[0].failed);
  CHECK(h.log.detail(h.lifter, h.session).has_value());
  CHECK_EQ(reply.proposals.size(), 0u);
}
