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

// An AskAgent that never leaves the process: it records what it was handed, runs its plan, answers.
struct FakeAsk : AskAgent {
  bool wired = true;
  bool answers = true;
  // Metered vendor round trips this run completed; zero is a run that reached nobody.
  int turnsSpent = 1;
  bool throwsUp = false;
  int runs = 0;
  ToolScope grantedScope;
  Json::Value seenCatalog{Json::arrayValue};
  std::vector<AskTurn> seenTurns;
  // What the "model" reaches for, in order.
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
    out.modelTurns = turnsSpent;
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
  FakeGym repo;
  FakeClock clock;
  FakeTokens tokens;
  FakeSubscriptionRepository subs;
  FakeAiUsageRepository usage;
  Entitlements entitlements{subs, usage};
  TrainingService training{repo.log, repo.program, clock, tokens};
  CatalogService catalog{repo.catalog};
  ProgramService program{repo.program, clock};
  ThreadService threadService{repo.threads, clock};
  GymTools gymTools{training, catalog, program, "https://windmill.works"};
  FakeAsk agent;
  AskService ask{training, threadService, agent, gymTools, entitlements};

  const UserId lifter{"lifter"};
  const SessionId session{"ses_11111111"};

  Harness() {
    repo.db.seed(benchPress());
    repo.db.seed(backSquat());
    training.start(lifter, SessionStart{session, 1'700'000'000'000});
    training.append(lifter, session,
               SetWrite{setId(), ExerciseId{"back-squat"}, 100, 5, SetKind::working, std::nullopt,
                        "", 1'700'000'300'000});
    training.finish(lifter, session, 1'700'000'900'000);
  }

  void subscribe() { subs.subscribe(lifter, "active"); }

  void seedRoutine() {
    repo.db.routineRows.push_back(Routine{rtId(), lifter, "Push A", 0, {benchEntry()}});
  }

  // ask() answers on a worker thread when it runs and inline when it refuses; both land here.
  AskReply question(const ThreadId& thread, const std::string& text, const UserId& caller) {
    std::promise<AskReply> settled;
    std::future<AskReply> reply = settled.get_future();
    ask.ask(caller, "sam@example.com", thread, text,
            [&settled](AskReply answer) { settled.set_value(std::move(answer)); });
    return reply.get();
  }

  AskReply question(const std::string& text, const UserId& caller) {
    return question(nextThread(), text, caller);
  }

  AskReply question(const std::string& text) { return question(nextThread(), text, lifter); }

  ThreadId nextThread() { return ThreadId{"thr_000000" + std::to_string(++threads)}; }

  int threads = 0;
};

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

TEST(ask_tools_hand_the_model_gyms_reads_and_the_two_tools_that_only_propose) {
  Harness h;
  AskTools hands(h.gymTools, ThreadId{"thr_00000001"});

  const std::vector<ToolDeclaration> offered = hands.declareTools();
  // Every read gym publishes is here.
  CHECK(holds(offered, "list_exercises"));
  CHECK(holds(offered, "list_sessions"));
  CHECK(holds(offered, "get_session"));
  CHECK(holds(offered, "last_time"));
  CHECK(holds(offered, "list_routines"));
  CHECK(holds(offered, "get_stats"));
  CHECK_FALSE(holds(offered, "get_preferences"));
  CHECK(holds(offered, "propose_routine_change"));
  CHECK(holds(offered, "propose_routine_removal"));
  CHECK_FALSE(holds(offered, "log_set"));
  CHECK_FALSE(holds(offered, "start_session"));
  CHECK_FALSE(holds(offered, "finish_session"));
  CHECK_FALSE(holds(offered, "create_routine"));
  CHECK_FALSE(holds(offered, "create_exercise"));
  CHECK_FALSE(holds(offered, "share_session"));
  CHECK_FALSE(holds(offered, "discard_session"));
  CHECK_FALSE(holds(offered, "revoke_share"));

  // `mintsProposal` is a name prefix, so any future `propose_*` tool joins this list.
  std::vector<std::string> names;
  for (const ToolDeclaration& tool : offered) names.push_back(tool.name());
  std::sort(names.begin(), names.end());
  CHECK_EQ(names, (std::vector<std::string>{"get_session", "get_stats", "last_time",
                                            "list_exercises", "list_routines", "list_sessions",
                                            "propose_routine_change", "propose_routine_removal"}));
}

TEST(ask_tools_refuse_a_destructive_tool_and_the_workout_survives) {
  Harness h;
  AskTools hands(h.gymTools, ThreadId{"thr_00000001"});
  const ToolCaller actor{h.lifter, ToolScope::everything()};

  const ToolResult refused = hands.callTool("discard_session", sessionArgs(h.session), actor);

  CHECK(refused.isError);
  CHECK(refused.content[0]["text"].asString().find("theirs to change") != std::string::npos);
  CHECK(h.training.detail(h.lifter, h.session).has_value());  // the workout is still in the log
}

TEST(ask_tools_refuse_a_write_tool_even_when_the_arguments_are_perfect) {
  Harness h;
  AskTools hands(h.gymTools, ThreadId{"thr_00000001"});
  const ToolCaller actor{h.lifter, ToolScope::everything()};

  CHECK(hands.callTool("share_session", sessionArgs(h.session), actor).isError);
  CHECK(h.repo.db.shares.empty());  // no coach link was minted behind the lifter's back
}

TEST(ask_tools_refuse_a_tool_the_callers_grant_does_not_reach) {
  Harness h;
  AskTools hands(h.gymTools, ThreadId{"thr_00000001"});
  const ToolCaller ungranted{h.lifter, ToolScope{}};  // grants nothing, the fail-closed default

  CHECK_EQ(hands.listTools(ungranted).size(), 0u);  // the catalog says nothing is reachable…
  const ToolResult refused =
      hands.callTool("list_sessions", Json::Value(Json::objectValue), ungranted);
  REQUIRE(refused.isError);  // …and the call agrees
  CHECK(refused.content[0]["text"].asString().find("was not granted gym:read") != std::string::npos);
  CHECK_EQ(hands.read().tally(), (ReadTally{0, 0, 0}));

  // …and a grant that reaches the reads but not `del` keeps the removal mint out of both halves.
  const ToolCaller readOnly{h.lifter, ToolScope({{"gym", Access::read}, {"gym", Access::write}})};
  CHECK_FALSE(hands.callTool("list_sessions", Json::Value(Json::objectValue), readOnly).isError);
  const ToolResult removal =
      hands.callTool("propose_routine_removal", Json::Value(Json::objectValue), readOnly);
  REQUIRE(removal.isError);
  CHECK(removal.content[0]["text"].asString().find("was not granted gym:delete") !=
        std::string::npos);

  const ToolCaller widest{h.lifter, ToolScope::everything()};
  for (const ToolCaller& actor : {ungranted, readOnly, widest})
    CHECK(hands.callTool("discard_session", sessionArgs(h.session), actor)
              .content[0]["text"]
              .asString()
              .find("theirs to change") != std::string::npos);
  CHECK(h.training.detail(h.lifter, h.session).has_value());
}

TEST(ask_tools_refuse_a_name_no_catalog_holds) {
  Harness h;
  AskTools hands(h.gymTools, ThreadId{"thr_00000001"});
  const ToolCaller actor{h.lifter, ToolScope::everything()};
  CHECK(hands.callTool("delete_everything", Json::Value(Json::objectValue), actor).isError);
}

TEST(ask_tools_count_what_the_tools_served_and_count_an_overlap_once) {
  Harness h;
  AskTools hands(h.gymTools, ThreadId{"thr_00000001"});
  const ToolCaller actor{h.lifter, ToolScope::everything()};

  hands.callTool("list_sessions", Json::Value(Json::objectValue), actor);   // names the workout
  hands.callTool("get_session", sessionArgs(h.session), actor);             // hands over its set
  hands.callTool("get_session", sessionArgs(h.session), actor);             // …asked for twice

  CHECK_EQ(hands.read().tally(), (ReadTally{1, 1, 1}));
}

TEST(ask_refuses_an_argument_no_schema_declares_and_names_the_one_it_takes) {
  Harness h;
  AskTools hands(h.gymTools, ThreadId{"thr_00000001"});
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

TEST(ask_answers_a_retired_name_with_gyms_own_sentence) {
  Harness h;
  AskTools hands(h.gymTools, ThreadId{"thr_00000001"});
  const ToolCaller actor{h.lifter, ToolScope::everything()};

  const ToolResult retired = hands.callTool("save_routine", Json::Value(Json::objectValue), actor);

  REQUIRE(retired.isError);
  CHECK_EQ(retired.content[0]["text"].asString(),
           "save_routine: " + h.gymTools.retirement("save_routine")->sentence);
  CHECK(retired.content[0]["text"].asString().find("propose_routine_change") != std::string::npos);
  CHECK(retired.content[0]["text"].asString().find("granted") == std::string::npos);
  const ToolResult missing = hands.callTool("frobnicate", Json::Value(Json::objectValue), actor);
  REQUIRE(missing.isError);
  CHECK_EQ(missing.content[0]["text"].asString(),
           std::string("frobnicate: no such tool — call tools/list for what Ask may do."));
  CHECK_EQ(hands.read().tally(), (ReadTally{0, 0, 0}));
}

TEST(a_refused_read_leaves_the_runs_line_exactly_where_it_was) {
  Harness h;
  AskTools hands(h.gymTools, ThreadId{"thr_00000001"});
  const ToolCaller actor{h.lifter, ToolScope::everything()};

  Json::Value notAnId(Json::objectValue);
  notAnId["exerciseId"] = 5;  // declared, and not the non-empty string the tool takes

  CHECK(hands.callTool("get_stats", notAnId, actor).isError);
  CHECK_EQ(hands.read().tally(), (ReadTally{0, 0, 0}));

  Json::Value narrowed(Json::objectValue);
  narrowed["exerciseId"] = "back-squat";
  CHECK_FALSE(hands.callTool("get_stats", narrowed, actor).isError);
  CHECK_EQ(hands.read().tally(), (ReadTally{0, 0, 1}));
}

TEST(a_read_answers_with_what_it_served_and_a_catalog_read_says_nothing) {
  Harness h;
  const ToolCaller actor{h.lifter, ToolScope::everything()};

  const ToolResult workout = h.gymTools.callTool("get_session", sessionArgs(h.session), actor);
  CHECK_EQ(workout.payload["read"]["sets"].asInt(), 1);
  CHECK_EQ(workout.payload["read"]["sessions"].asInt(), 1);
  CHECK_EQ(workout.payload["read"]["weeks"].asInt(), 1);
  // The wire carries it too — `payload` never leaves this process.
  CHECK(workout.content[0]["text"].asString().find("\"read\":") != std::string::npos);

  const ToolResult catalog =
      h.gymTools.callTool("list_exercises", Json::Value(Json::objectValue), actor);
  CHECK_FALSE(catalog.payload.isMember("read"));  // a movement is not a log row: no claim is made
}

TEST(a_proposal_ask_mints_is_recorded_by_id_and_carries_its_own_door) {
  Harness h;
  h.seedRoutine();
  AskTools hands(h.gymTools, ThreadId{"thr_00000001"});
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
  const std::optional<Routine> standing = h.program.routine(h.lifter, rtId());
  REQUIRE(standing.has_value());
  CHECK_EQ(standing->entries, std::vector<RoutineEntry>{benchEntry()});
}

TEST(ask_answers_a_lifter_who_holds_nothing_because_there_is_nothing_to_buy) {
  Harness h;  // no subscription

  const AskReply reply = h.question("how did the squats go?");

  CHECK(reply.refusal == AskRefusal::none);
  CHECK(reply.answer.ok);
  CHECK_EQ(reply.answer.answer, std::string("You squatted 100 for five."));
  CHECK_EQ(h.agent.runs, 1);
}

TEST(the_run_is_handed_gyms_three_levels_and_no_other_product) {
  Harness h;

  h.question("how did the squats go?");

  CHECK(h.agent.grantedScope.allows("gym", Access::read));
  CHECK(h.agent.grantedScope.allows("gym", Access::write));
  CHECK(h.agent.grantedScope.allows("gym", Access::del));
  CHECK_FALSE(h.agent.grantedScope.allows("roadmap", Access::read));
  CHECK_FALSE(h.agent.grantedScope.allows("journal", Access::read));
  // What the model can SEE is narrower than the grant: the reads plus the two mints.
  std::size_t allowed = 0;
  for (const ToolDeclaration& tool : gymToolCatalog())
    if (tool.access == Access::read || mintsProposal(tool.name())) ++allowed;
  CHECK_EQ(h.agent.seenCatalog.size(), allowed);
}

TEST(a_lifter_with_a_workout_open_is_refused_before_anything_is_spent) {
  Harness h;
  h.clock.now = 1'700'100'000'000;
  h.training.start(h.lifter, SessionStart{SessionId{"ses_22222222"}, 1'700'100'000'000});

  const AskReply reply = h.question("what should I do next?");

  CHECK(reply.refusal == AskRefusal::sessionOpen);
  CHECK_EQ(h.agent.runs, 0);
}

TEST(a_stale_workout_the_four_hour_rule_closes_does_not_hold_ask_shut) {
  Harness h;
  h.clock.now = 1'700'100'000'000;
  h.training.start(h.lifter, SessionStart{SessionId{"ses_33333333"}, 1'700'100'000'000});
  h.clock.now = 1'700'100'000'000 + 5 * 60 * 60 * 1000;  // five hours later, nothing logged since

  const AskReply reply = h.question("how has my squat moved?");

  CHECK(reply.refusal == AskRefusal::none);
  CHECK_EQ(h.agent.runs, 1);
}

TEST(an_unconfigured_deployment_refuses_rather_than_pretending_a_model_exists) {
  Harness h;
  h.agent.wired = false;

  CHECK(h.question("how did it go?").refusal == AskRefusal::notConfigured);
  CHECK_FALSE(h.ask.configured());  // …which is what keeps the route from being mounted at all
  CHECK_EQ(h.agent.runs, 0);
}

TEST(a_thread_id_this_product_cannot_hold_is_refused) {
  Harness h;

  CHECK(h.question(ThreadId{""}, "hi", h.lifter).refusal == AskRefusal::threadMalformed);
  CHECK(h.question(ThreadId{"thr_1"}, "hi", h.lifter).refusal == AskRefusal::threadMalformed);
  CHECK(h.question(ThreadId{"thr_00000001; drop"}, "hi", h.lifter).refusal ==
        AskRefusal::threadMalformed);
  CHECK_EQ(h.agent.runs, 0);
}

TEST(a_thread_id_another_account_holds_is_refused_rather_than_appended_to) {
  Harness h;
  const ThreadId shared{"thr_00009999"};
  CHECK(h.question(shared, "how did the squats go?", h.lifter).refusal == AskRefusal::none);

  const UserId stranger{"stranger"};
  CHECK(h.question(shared, "and mine?", stranger).refusal == AskRefusal::threadTaken);
  CHECK_EQ(h.agent.runs, 1);
  CHECK_EQ(h.threadService.thread(h.lifter, shared)->turns.size(), 2u);
  CHECK_FALSE(h.threadService.thread(stranger, shared).has_value());
}

TEST(a_thread_the_store_could_not_open_costs_no_vendor_call_and_no_lost_answer) {
  Harness h;
  h.repo.db.loseThreadRace = true;

  CHECK(h.question(h.nextThread(), "how did the squats go?", h.lifter).refusal ==
        AskRefusal::threadTaken);
  CHECK_EQ(h.agent.runs, 0);
  CHECK_EQ(h.threadService.threads(h.lifter).size(), 0u);
}

TEST(a_blank_question_and_an_oversized_one_are_each_their_own_refusal) {
  Harness h;

  CHECK(h.question("   \n ").refusal == AskRefusal::questionEmpty);
  CHECK(h.question(std::string(kMaxAskTurnBytes + 1, 'a')).refusal ==
        AskRefusal::questionTooLong);
  CHECK_EQ(h.agent.runs, 0);
}

TEST(a_question_the_store_cannot_hold_is_refused_before_a_thread_is_opened) {
  Harness h;
  const ThreadId nulled = h.nextThread();
  const ThreadId malformed = h.nextThread();

  CHECK(h.question(nulled, std::string("why is my bench\0STUCK", 21), h.lifter).refusal ==
        AskRefusal::questionUnstorable);
  CHECK(h.question(malformed, "bench \xED\xA0\x80 stuck", h.lifter).refusal ==
        AskRefusal::questionUnstorable);
  CHECK_EQ(h.agent.runs, 0);
  CHECK_FALSE(h.threadService.thread(h.lifter, nulled).has_value());
  CHECK_FALSE(h.threadService.thread(h.lifter, malformed).has_value());
  CHECK_EQ(h.threadService.threads(h.lifter).size(), 0u);
}

// The cap bites on the pair this ask would add, so a conversation is never capped halfway through.
TEST(a_conversation_as_long_as_ask_holds_refuses_the_next_question) {
  Harness h;
  const ThreadId thread = h.nextThread();

  std::vector<ThreadTurn> said;
  for (std::size_t at = 0; at < kMaxThreadTurns; ++at)
    said.push_back(ThreadTurn{at % 2 == 0, "a", 1'700'000'000'000});
  h.repo.db.threadRows.push_back(
      AskThread{thread, h.lifter, "a", 1'700'000'000'000, 1'700'000'000'000, said, {}});

  CHECK(h.question(thread, "once more", h.lifter).refusal == AskRefusal::tooManyTurns);
  CHECK_EQ(h.agent.runs, 0);
  CHECK_EQ(h.threadService.thread(h.lifter, thread)->turns.size(), kMaxThreadTurns);
}

// The daily limit, one bucket saying both halves: three back to back, about ten a day.
TEST(the_daily_limit_refuses_the_fourth_question_in_a_burst) {
  Harness h;

  CHECK(h.question("one").refusal == AskRefusal::none);
  CHECK(h.question("two").refusal == AskRefusal::none);
  CHECK(h.question("three").refusal == AskRefusal::none);
  CHECK(h.question("four").refusal == AskRefusal::dailyLimit);
  CHECK_EQ(h.agent.runs, 3);
}

TEST(a_run_the_vendor_never_answered_gives_the_question_back) {
  Harness h;
  h.agent.answers = false;
  h.agent.turnsSpent = 0;  // the fuse tripped, or the upstream never picked up: nothing was billed

  for (int attempt = 0; attempt < 3; ++attempt) {
    const AskReply dead = h.question("how did the squats go?");
    CHECK(dead.refusal == AskRefusal::none);  // it reached the vendor; the vendor is what failed
    CHECK_FALSE(dead.answer.ok);
  }

  h.agent.answers = true;
  h.agent.turnsSpent = 1;
  const AskReply answered = h.question("how did the squats go?");

  CHECK(answered.refusal == AskRefusal::none);
  CHECK(answered.answer.ok);
  CHECK_EQ(h.agent.runs, 4);
}

TEST(a_failure_that_burned_vendor_turns_still_costs_one_of_the_days_questions) {
  Harness h;
  h.agent.answers = false;
  h.agent.turnsSpent = 8;  // the iteration cap: eight metered round trips, no answer

  for (int attempt = 0; attempt < 3; ++attempt) {
    const AskReply spent = h.question("tell me everything");
    CHECK(spent.refusal == AskRefusal::none);
    CHECK_FALSE(spent.answer.ok);
  }

  CHECK(h.question("and once more").refusal == AskRefusal::dailyLimit);
  CHECK_EQ(h.agent.runs, 3);
}

TEST(a_run_that_threw_answers_the_lifter_rather_than_taking_the_process_with_it) {
  Harness h;
  h.agent.throwsUp = true;

  const AskReply thrown = h.question("how did the squats go?");

  CHECK(thrown.refusal == AskRefusal::none);
  CHECK_FALSE(thrown.answer.ok);
  CHECK_EQ(thrown.answer.answer, std::string(""));

  h.agent.throwsUp = false;
  for (int attempt = 0; attempt < 3; ++attempt)
    CHECK(h.question("how did the squats go?").refusal == AskRefusal::none);
  CHECK_EQ(h.agent.runs, 4);
}

// The question is taken AFTER every other rung, so a refusal that answered nothing costs nothing.
TEST(a_refusal_above_the_ration_costs_none_of_the_days_questions) {
  Harness h;
  h.usage.spentByProduct[""] = kProMonthlyAiNanos;

  for (int attempt = 0; attempt < 4; ++attempt)
    CHECK(h.question("how did the squats go?").refusal == AskRefusal::outOfBudget);

  h.usage.spentByProduct[""] = 0;  // the trailing window rolls on
  CHECK(h.question("how did the squats go?").refusal == AskRefusal::none);
  CHECK(h.question("and the bench?").refusal == AskRefusal::none);
  CHECK(h.question("what about next week?").refusal == AskRefusal::none);
  CHECK_EQ(h.agent.runs, 3);
}

TEST(an_account_over_its_ai_ceiling_is_refused_before_the_question_travels) {
  Harness h;
  h.usage.spentByProduct[""] = kProMonthlyAiNanos;  // this account's own window is spent

  const AskReply reply = h.question("how did the squats go?");

  CHECK(reply.refusal == AskRefusal::outOfBudget);
  CHECK_EQ(h.agent.runs, 0);  // nothing is spent proving we are out of budget
}

TEST(a_subscriber_over_the_free_ceiling_but_under_their_own_still_gets_an_answer) {
  Harness h;
  h.subscribe();
  h.usage.spentByProduct[""] = kFreeMonthlyAiNanos;  // spent for a free account, not for this one

  const AskReply reply = h.question("how did the squats go?");

  CHECK(reply.refusal == AskRefusal::none);
  CHECK_EQ(h.agent.runs, 1);
}

TEST(a_maxed_journal_sweep_never_stops_ask_answering) {
  Harness h;
  // The background bucket is its own: a sweep the lifter did not ask for cannot take Ask from them.
  h.usage.spentByProduct["journal"] = kSweepMonthlyAiNanos;
  h.usage.spentByProduct[""] = kSweepMonthlyAiNanos;

  CHECK(h.question("how did the squats go?").refusal == AskRefusal::none);
  CHECK_EQ(h.agent.runs, 1);
}

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

  const AskReply reply = h.question("write me the triples block");

  CHECK(reply.refusal == AskRefusal::none);
  CHECK_EQ(reply.read, (ReadTally{1, 1, 1}));  // one workout, its one set, the week it fell in
  REQUIRE_EQ(reply.proposals.size(), 1u);
  CHECK_EQ(reply.proposals[0], std::string("prop_00000009"));
  REQUIRE_EQ(reply.answer.steps.size(), 3u);
  CHECK_FALSE(reply.answer.steps[2].failed);
}

TEST(a_refused_tool_marks_its_step_and_leaves_the_log_alone) {
  Harness h;
  h.agent.plan = {{"discard_session", sessionArgs(h.session)}};

  const AskReply reply = h.question("delete tuesday");

  CHECK(reply.refusal == AskRefusal::none);
  REQUIRE_EQ(reply.answer.steps.size(), 1u);
  CHECK(reply.answer.steps[0].failed);
  CHECK(h.training.detail(h.lifter, h.session).has_value());
  CHECK_EQ(reply.proposals.size(), 0u);
}

TEST(a_first_question_opens_a_thread_titled_by_that_question_byte_for_byte) {
  Harness h;
  const ThreadId thread = h.nextThread();
  const std::string typed = "Bench “stuck” at 82.5 — three weeks 💀. What do you see?";

  CHECK(h.question(thread, typed, h.lifter).refusal == AskRefusal::none);

  const std::optional<AskThread> held = h.threadService.thread(h.lifter, thread);
  REQUIRE(held.has_value());
  CHECK_EQ(held->title, typed);
  REQUIRE_EQ(held->turns.size(), 2u);
  CHECK(held->turns[0].fromLifter);
  CHECK_EQ(held->turns[0].text, typed);
  CHECK_FALSE(held->turns[1].fromLifter);
  CHECK_EQ(held->turns[1].text, std::string("You squatted 100 for five."));
}

TEST(a_second_question_is_answered_against_the_stored_conversation) {
  Harness h;
  const ThreadId thread = h.nextThread();
  h.question(thread, "how did the squats go?", h.lifter);

  CHECK(h.question(thread, "and the bench?", h.lifter).refusal == AskRefusal::none);

  REQUIRE_EQ(h.agent.seenTurns.size(), 3u);
  CHECK_EQ(h.agent.seenTurns[0].text, std::string("how did the squats go?"));
  CHECK_FALSE(h.agent.seenTurns[1].fromLifter);
  CHECK_EQ(h.agent.seenTurns[2].text, std::string("and the bench?"));
  const std::optional<AskThread> held = h.threadService.thread(h.lifter, thread);
  REQUIRE(held.has_value());
  CHECK_EQ(held->title, std::string("how did the squats go?"));
  CHECK_EQ(held->turns.size(), 4u);
}

TEST(a_run_that_never_answered_stores_no_turns_and_leaves_no_empty_thread) {
  Harness h;
  h.agent.answers = false;
  h.agent.turnsSpent = 0;
  const ThreadId thread = h.nextThread();

  CHECK_FALSE(h.question(thread, "how did the squats go?", h.lifter).answer.ok);
  CHECK_FALSE(h.threadService.thread(h.lifter, thread).has_value());
  CHECK(h.threadService.threads(h.lifter).empty());

  h.agent.answers = true;
  CHECK(h.question(thread, "how did the squats go?", h.lifter).refusal == AskRefusal::none);
  const std::optional<AskThread> landed = h.threadService.thread(h.lifter, thread);
  REQUIRE(landed.has_value());
  CHECK_EQ(landed->turns.size(), 2u);
}

TEST(a_failed_follow_up_leaves_the_conversation_that_already_happened_alone) {
  Harness h;
  const ThreadId thread = h.nextThread();
  h.question(thread, "how did the squats go?", h.lifter);

  h.agent.answers = false;
  h.agent.turnsSpent = 0;
  CHECK_FALSE(h.question(thread, "and the bench?", h.lifter).answer.ok);

  const std::optional<AskThread> held = h.threadService.thread(h.lifter, thread);
  REQUIRE(held.has_value());
  CHECK_EQ(held->turns.size(), 2u);
}

TEST(a_proposal_minted_in_a_conversation_carries_that_conversation) {
  Harness h;
  h.seedRoutine();
  const ThreadId thread = h.nextThread();

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
  h.agent.plan = {{"propose_routine_change", propose}};

  CHECK(h.question(thread, "heavier triples please", h.lifter).refusal == AskRefusal::none);

  const std::optional<RoutineProposal> minted =
      h.program.proposal(h.lifter, ProposalId{"prop_00000009"});
  REQUIRE(minted.has_value());
  CHECK(minted->head.source.door == ProposalDoor::ask);
  REQUIRE(minted->head.source.thread.has_value());
  CHECK(*minted->head.source.thread == thread);
  const std::optional<AskThread> held = h.threadService.thread(h.lifter, thread);
  REQUIRE(held.has_value());
  const ThreadOutcome outcome = outcomeOf(*held);
  CHECK(outcome.kind == ThreadOutcomeKind::proposed);
  CHECK_EQ(outcome.routineName, std::string("Push A"));
}

TEST(a_proposal_from_the_mcp_door_carries_no_conversation) {
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
  propose["id"] = "prop_00000010";
  propose["routineId"] = rtId().str();
  propose["entries"] = entries;

  const ToolCaller agent{h.lifter, ToolScope({{"gym", Access::write}})};
  h.gymTools.callTool("propose_routine_change", propose, agent);

  const std::optional<RoutineProposal> minted =
      h.program.proposal(h.lifter, ProposalId{"prop_00000010"});
  REQUIRE(minted.has_value());
  CHECK(minted->head.source.door == ProposalDoor::mcp);
  CHECK_FALSE(minted->head.source.thread.has_value());
}
