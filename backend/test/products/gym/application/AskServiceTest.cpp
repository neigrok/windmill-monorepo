#include "products/gym/application/AskService.h"
#include "products/gym/application/ThreadService.h"
#include "platform/application/WriteObservation.h"

#include "products/gym/adapters/json/GymJson.h"
#include "products/gym/adapters/llm/AnthropicAsk.h"
#include "products/gym/adapters/mcp/GymToolCatalog.h"
#include "products/gym/adapters/mcp/GymTools.h"
#include "products/gym/adapters/postgres/PgAskThreadRepository.h"
#include "test/platform/Fakes.h"
#include "test/products/gym/Fakes.h"
#include "test/products/gym/sync/GymDoorFixture.h"
#include "test/testing.h"

#include <pqxx/pqxx>

#include <algorithm>
#include <cstdlib>
#include <future>
#include <stdexcept>
#include <string>
#include <vector>
#include <typeinfo>

using namespace wm;
using namespace wm::fake;
using namespace wm::gym;
using namespace wm::gym::fake;

namespace {

struct RecordedFailures : FailureReporter {
  std::vector<std::string> events;
  bool throwReport = false;
  std::vector<std::string> requestIds;
  std::vector<std::string> doors;

  void reportWrite(const std::string& operation, const std::string& product,
                   const std::string& door, const std::string& outcome,
                   const std::string& requestId, const std::string& exceptionType) override {
    events.push_back(product + " | " + operation + " | " + exceptionType);
    requestIds.push_back(requestId);
    doors.push_back(door);
    CHECK_EQ(outcome, std::string("failed"));
    if (throwReport) throw std::runtime_error("reporter unavailable");
  }

  void report(const std::string& kind, const std::string& where,
              const std::string& detail) override {
    events.push_back(kind + " | " + where + " | " + detail);
    if (throwReport) throw std::runtime_error("reporter unavailable");
  }
};

// Coach as main.cpp builds it, over the one gym door, for a lifter with one finished workout of squats.
struct Coach : doortest::Harness {
  FakeSubscriptionRepository subs;
  FakeAiUsageRepository usage;
  Entitlements entitlements{subs, usage};
  FakeAsk agent;
  std::shared_ptr<RecordedFailures> reports = std::make_shared<RecordedFailures>();
  AskService ask{training, repo.threads, clock, agent, tools, entitlements, reports};

  const SessionId session{"ses_11111111"};
  int asked = 0;

  Coach() {
    door.start(user, SessionStart{session, 1'700'000'000'000});
    door.append(user, session,
               SetWrite{setId(), ExerciseId{"back-squat"}, 100, 5, SetKind::working, std::nullopt,
                        "", 1'700'000'300'000});
    door.finish(user, session, 1'700'000'900'000);
  }

  void subscribe() { subs.subscribe(user, "active"); }

  void seedRoutine(const RoutineId& id = rtId(), const std::string& name = "Push A", int position = 0) {
    door.createRoutine(user, RoutineWrite{id, name, position, {benchEntry()}}, std::nullopt);
  }

  // ask() answers on a worker thread when it runs and inline when it refuses; both land here.
  AskReply question(AskService& service, const ThreadId& thread, const std::string& text, const UserId& caller,
                    const std::string& requestId = "") {
    std::promise<AskReply> settled;
    std::future<AskReply> reply = settled.get_future();
    service.ask(caller, "sam@example.com", thread, text,
                [&settled](AskReply answer) { settled.set_value(std::move(answer)); }, requestId);
    return reply.get();
  }

  AskReply question(const ThreadId& thread, const std::string& text, const UserId& caller, const std::string& requestId = "") {
    return question(ask, thread, text, caller, requestId);
  }

  AskReply question(const std::string& text) { return question(nextThread(), text, user); }

  ThreadId nextThread() { return ThreadId{"thr_000000" + std::to_string(++asked)}; }
};

// Every row a query answers, each one its columns joined by " | ", so a case states the whole table.
std::vector<std::string> stored(const std::string& query) {
  PgLease lease{*doortest::pool()};
  pqxx::work txn{*lease};
  const pqxx::result rows = txn.exec(query);
  std::vector<std::string> lines;
  for (const auto& row : rows) {
    std::string line;
    for (int column = 0; column < rows.columns(); ++column) {
      if (column > 0) line += " | ";
      line += row[column].is_null() ? "null" : row[column].as<std::string>();
    }
    lines.push_back(line);
  }
  return lines;
}

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
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Coach h;
  AskTools hands(h.tools, ThreadId{"thr_00000001"});

  const std::vector<ToolDeclaration> offered = hands.declareTools();
  // Every read gym publishes is here.
  CHECK(holds(offered, "list_exercises"));
  CHECK(holds(offered, "list_sessions"));
  CHECK(holds(offered, "get_session"));
  CHECK(holds(offered, "last_time"));
  CHECK(holds(offered, "list_routines"));
  CHECK(holds(offered, "get_stats"));
  CHECK(holds(offered, "list_notes"));
  CHECK(holds(offered, "list_bodyweight"));
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
  CHECK_EQ(names, (std::vector<std::string>{"get_last_times", "get_session", "get_sessions", "get_stats", "last_time",
                                            "list_bodyweight", "list_exercises", "list_notes",
                                            "list_routines", "list_sessions",
                                            "propose_routine_change", "propose_routine_removal"}));
  // And no tool by the name that would let Coach create: the prefix is the grant.
  for (const ToolDeclaration& tool : gymToolCatalog()) CHECK(tool.name() != "propose_routine_create");
  CHECK_FALSE(holds(offered, "propose_routine_create"));
}

// One proposal per turn: the second mint in a run is refused BEFORE the inner call, in a sentence
// the model can act on, so the first is never superseded by its own author mid-answer.
TEST(ask_tools_refuse_a_second_proposal_in_one_run_before_anything_is_minted) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Coach h;
  h.seedRoutine();
  h.seedRoutine(rtId("rt_00000002"), "Pull A", 1);
  const ThreadId thread{"thr_00000001"};
  REQUIRE_EQ(h.threads.openThread(h.user, thread, "Heavier bench").error, ThreadOpenError::none);
  AskTools hands(h.tools, thread);
  const ToolCaller actor{h.user, ToolScope::everything()};
  const auto proposal = [](const char* id, const char* routine, double kg) {
    Json::Value entry(Json::objectValue);
    entry["exerciseId"] = "bench-press";
    entry["sets"] = toJson(straight(5, 3, kg));
    Json::Value entries(Json::arrayValue);
    entries.append(entry);
    Json::Value args(Json::objectValue);
    args["id"] = id;
    args["routineId"] = routine;
    args["entries"] = entries;
    return args;
  };
  Json::Value removal(Json::objectValue);
  removal["id"] = "prop_00000003";
  removal["routineId"] = rtId("rt_00000002").str();

  // A mint that never landed does not spend the turn.
  CHECK(hands.callTool("propose_routine_change", proposal("prop_00000000", "rt_00000009", 87.5), actor)
            .isError);
  CHECK_EQ(hands.proposals().size(), 0u);
  CHECK_FALSE(hands.callTool("propose_routine_change", proposal("prop_00000001", "rt_00000001", 87.5), actor)
                  .isError);
  const ToolResult second =
      hands.callTool("propose_routine_change", proposal("prop_00000002", "rt_00000001", 90.0), actor);
  const ToolResult removed = hands.callTool("propose_routine_removal", removal, actor);

  REQUIRE(second.isError);
  CHECK_EQ(second.content[0]["text"].asString(),
           std::string("propose_routine_change: you already wrote a proposal this turn; fold both "
                       "into one document"));
  REQUIRE(removed.isError);
  CHECK_EQ(removed.content[0]["text"].asString(),
           std::string("propose_routine_removal: you already wrote a proposal this turn; fold both "
                       "into one document"));
  // Nothing reached the store: the first proposal still stands pending under its own id.
  CHECK_EQ(stored("select id, routine_id, state, door, thread_id from gym_proposals order by id"),
           std::vector<std::string>{"prop_00000001 | rt_00000001 | pending | ask | thr_00000001"});
  CHECK_EQ(hands.proposals(), std::vector<std::string>{"prop_00000001"});
  // The reads are still open after a mint.
  CHECK_FALSE(hands.callTool("list_routines", Json::Value(Json::objectValue), actor).isError);
}

TEST(ask_tools_refuse_a_destructive_tool_and_the_workout_survives) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Coach h;
  AskTools hands(h.tools, ThreadId{"thr_00000001"});
  const ToolCaller actor{h.user, ToolScope::everything()};

  const ToolResult refused = hands.callTool("discard_session", sessionArgs(h.session), actor);

  CHECK(refused.isError);
  CHECK(refused.content[0]["text"].asString().find("theirs to change") != std::string::npos);
  CHECK(h.training.detail(h.user, h.session).has_value());  // the workout is still in the log
}

TEST(ask_tools_refuse_a_write_tool_even_when_the_arguments_are_perfect) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Coach h;
  AskTools hands(h.tools, ThreadId{"thr_00000001"});
  const ToolCaller actor{h.user, ToolScope::everything()};

  CHECK(hands.callTool("share_session", sessionArgs(h.session), actor).isError);
  CHECK_EQ(stored("select session_id from gym_session_shares"),
           std::vector<std::string>{});  // no share link was minted behind the lifter's back
}

TEST(ask_tools_refuse_a_tool_the_callers_grant_does_not_reach) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Coach h;
  AskTools hands(h.tools, ThreadId{"thr_00000001"});
  const ToolCaller ungranted{h.user, ToolScope{}};  // grants nothing, the fail-closed default

  CHECK_EQ(hands.listTools(ungranted).size(), 0u);  // the catalog says nothing is reachable…
  const ToolResult refused =
      hands.callTool("list_sessions", Json::Value(Json::objectValue), ungranted);
  REQUIRE(refused.isError);  // …and the call agrees
  CHECK(refused.content[0]["text"].asString().find("was not granted gym:read") != std::string::npos);
  CHECK_EQ(hands.read().tally(), (ReadTally{0, 0, 0}));

  // …and a grant that reaches the reads but not `del` keeps the removal mint out of both halves.
  const ToolCaller readOnly{h.user, ToolScope({{"gym", Access::read}, {"gym", Access::write}})};
  CHECK_FALSE(hands.callTool("list_sessions", Json::Value(Json::objectValue), readOnly).isError);
  const ToolResult removal =
      hands.callTool("propose_routine_removal", Json::Value(Json::objectValue), readOnly);
  REQUIRE(removal.isError);
  CHECK(removal.content[0]["text"].asString().find("was not granted gym:delete") !=
        std::string::npos);

  const ToolCaller widest{h.user, ToolScope::everything()};
  for (const ToolCaller& actor : {ungranted, readOnly, widest})
    CHECK(hands.callTool("discard_session", sessionArgs(h.session), actor)
              .content[0]["text"]
              .asString()
              .find("theirs to change") != std::string::npos);
  CHECK(h.training.detail(h.user, h.session).has_value());
}

TEST(ask_tools_refuse_a_name_no_catalog_holds) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Coach h;
  AskTools hands(h.tools, ThreadId{"thr_00000001"});
  const ToolCaller actor{h.user, ToolScope::everything()};
  CHECK(hands.callTool("delete_everything", Json::Value(Json::objectValue), actor).isError);
}

TEST(ask_tools_count_what_the_tools_served_and_count_an_overlap_once) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Coach h;
  AskTools hands(h.tools, ThreadId{"thr_00000001"});
  const ToolCaller actor{h.user, ToolScope::everything()};

  hands.callTool("list_sessions", Json::Value(Json::objectValue), actor);   // names the workout
  hands.callTool("get_session", sessionArgs(h.session), actor);             // hands over its set
  hands.callTool("get_session", sessionArgs(h.session), actor);             // …asked for twice

  CHECK_EQ(hands.read().tally(), (ReadTally{1, 1, 1}));
}

TEST(ask_refuses_an_argument_no_schema_declares_and_names_the_one_it_takes) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Coach h;
  AskTools hands(h.tools, ThreadId{"thr_00000001"});
  const ToolCaller actor{h.user, ToolScope::everything()};

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
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Coach h;
  AskTools hands(h.tools, ThreadId{"thr_00000001"});
  const ToolCaller actor{h.user, ToolScope::everything()};

  const ToolResult retired = hands.callTool("save_routine", Json::Value(Json::objectValue), actor);

  REQUIRE(retired.isError);
  CHECK_EQ(retired.content[0]["text"].asString(),
           "save_routine: " + h.tools.retirement("save_routine")->sentence);
  CHECK(retired.content[0]["text"].asString().find("propose_routine_change") != std::string::npos);
  CHECK(retired.content[0]["text"].asString().find("granted") == std::string::npos);
  const ToolResult missing = hands.callTool("frobnicate", Json::Value(Json::objectValue), actor);
  REQUIRE(missing.isError);
  CHECK_EQ(missing.content[0]["text"].asString(),
           std::string("frobnicate: no such tool — call tools/list for what Coach may do."));
  CHECK_EQ(hands.read().tally(), (ReadTally{0, 0, 0}));
}

TEST(a_refused_read_leaves_the_runs_line_exactly_where_it_was) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Coach h;
  AskTools hands(h.tools, ThreadId{"thr_00000001"});
  const ToolCaller actor{h.user, ToolScope::everything()};

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
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Coach h;
  const ToolCaller actor{h.user, ToolScope::everything()};

  const ToolResult workout = h.tools.callTool("get_session", sessionArgs(h.session), actor);
  CHECK_EQ(workout.payload["read"]["sets"].asInt(), 1);
  CHECK_EQ(workout.payload["read"]["sessions"].asInt(), 1);
  CHECK_EQ(workout.payload["read"]["weeks"].asInt(), 1);
  // The wire carries it too — `payload` never leaves this process.
  CHECK(workout.content[0]["text"].asString().find("\"read\":") != std::string::npos);

  const ToolResult catalog =
      h.tools.callTool("list_exercises", Json::Value(Json::objectValue), actor);
  CHECK_FALSE(catalog.payload.isMember("read"));  // a movement is not a log row: no claim is made
}

TEST(a_proposal_ask_mints_is_recorded_by_id_and_carries_its_own_door) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Coach h;
  h.seedRoutine();
  const ThreadId thread{"thr_00000001"};
  REQUIRE_EQ(h.threads.openThread(h.user, thread, "Heavier bench").error, ThreadOpenError::none);
  AskTools hands(h.tools, thread);
  const ToolCaller actor{h.user, ToolScope::everything()};

  Json::Value entry(Json::objectValue);
  entry["exerciseId"] = "bench-press";
  entry["sets"] = toJson(straight(5, 3, 87.5));
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
  const std::optional<Routine> standing = h.repo.program.routine(h.user, rtId());
  REQUIRE(standing.has_value());
  CHECK_EQ(standing->entries, std::vector<RoutineEntry>{benchEntry()});
}

TEST(ask_answers_a_lifter_who_holds_nothing_because_there_is_nothing_to_buy) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Coach h;  // no subscription

  const AskReply reply = h.question("how did the squats go?");

  CHECK(reply.refusal == AskRefusal::none);
  CHECK(reply.answer.ok);
  CHECK_EQ(reply.answer.answer, std::string("You squatted 100 for five."));
  CHECK_EQ(h.agent.runs, 1);
}

TEST(the_run_is_handed_gyms_three_levels_and_no_other_product) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Coach h;

  h.question("how did the squats go?");

  CHECK(h.agent.grantedScope.allows("gym", Access::read));
  CHECK(h.agent.grantedScope.allows("gym", Access::write));
  CHECK(h.agent.grantedScope.allows("gym", Access::del));
  CHECK_FALSE(h.agent.grantedScope.allows("roadmap", Access::read));
  CHECK_FALSE(h.agent.grantedScope.allows("journal", Access::read));
  // What the model can SEE is narrower than the grant: the reads plus the two mints.
  std::size_t allowed = 0;
  for (const ToolDeclaration& tool : gymToolCatalog())
    if (tool.access == Access::read || mintsProposal(tool.name()) || (tool.name() == "create_routine" || tool.name() == "save_note")) ++allowed;
  CHECK_EQ(h.agent.seenCatalog.size(), allowed);
}

TEST(a_lifter_with_a_workout_open_is_refused_before_anything_is_spent) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Coach h;
  h.clock.now = 1'700'100'000'000;
  h.door.start(h.user, SessionStart{SessionId{"ses_22222222"}, 1'700'100'000'000});

  const AskReply reply = h.question("what should I do next?");

  CHECK(reply.refusal == AskRefusal::sessionOpen);
  CHECK_EQ(h.agent.runs, 0);
}

TEST(a_stale_workout_the_four_hour_rule_closes_does_not_hold_ask_shut) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Coach h;
  h.clock.now = 1'700'100'000'000;
  h.door.start(h.user, SessionStart{SessionId{"ses_33333333"}, 1'700'100'000'000});
  h.clock.now = 1'700'100'000'000 + 5 * 60 * 60 * 1000;  // five hours later, nothing logged since

  const AskReply reply = h.question("how has my squat moved?");

  CHECK(reply.refusal == AskRefusal::none);
  CHECK_EQ(h.agent.runs, 1);
}

TEST(an_unconfigured_deployment_refuses_rather_than_pretending_a_model_exists) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Coach h;
  h.agent.wired = false;

  CHECK(h.question("how did it go?").refusal == AskRefusal::notConfigured);
  CHECK_FALSE(h.ask.configured());  // …which is what keeps the route from being mounted at all
  CHECK_EQ(h.agent.runs, 0);
}

TEST(a_thread_id_this_product_cannot_hold_is_refused) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Coach h;

  CHECK(h.question(ThreadId{""}, "hi", h.user).refusal == AskRefusal::threadMalformed);
  CHECK(h.question(ThreadId{"thr_1"}, "hi", h.user).refusal == AskRefusal::threadMalformed);
  CHECK(h.question(ThreadId{"thr_00000001; drop"}, "hi", h.user).refusal ==
        AskRefusal::threadMalformed);
  CHECK_EQ(h.agent.runs, 0);
}

TEST(a_thread_id_another_account_holds_is_refused_rather_than_appended_to) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Coach h;
  const ThreadId shared{"thr_00009999"};
  CHECK(h.question(shared, "how did the squats go?", h.user).refusal == AskRefusal::none);

  CHECK(h.question(shared, "and mine?", h.other).refusal == AskRefusal::threadTaken);
  CHECK_EQ(h.agent.runs, 1);
  CHECK_EQ(h.threads.thread(h.user, shared)->turns.size(), 2u);
  CHECK_FALSE(h.threads.thread(h.other, shared).has_value());
}

TEST(a_thread_the_store_could_not_open_costs_no_vendor_call_and_no_lost_answer) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Coach h;
  // The concurrent-mint race: the loser's insert loses to ON CONFLICT DO NOTHING and reads back empty.
  struct LosingThreads : PgAskThreadRepository {
    using PgAskThreadRepository::PgAskThreadRepository;
    ThreadOpenOutcome openThread(const UserId&, const ThreadId&, const std::string&, std::uint64_t) override {
      return {std::nullopt, ThreadOpenError::none};
    }
  } threads{doortest::pool()};
  AskService ask{h.training, threads, h.clock, h.agent, h.tools, h.entitlements};

  CHECK(h.question(ask, h.nextThread(), "how did the squats go?", h.user).refusal ==
        AskRefusal::threadTaken);
  CHECK_EQ(h.agent.runs, 0);
  CHECK_EQ(h.threads.threads(h.user).size(), 0u);
}

TEST(a_blank_question_and_an_oversized_one_are_each_their_own_refusal) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Coach h;

  CHECK(h.question("   \n ").refusal == AskRefusal::questionEmpty);
  CHECK(h.question(std::string(kMaxAskTurnBytes + 1, 'a')).refusal ==
        AskRefusal::questionTooLong);
  CHECK_EQ(h.agent.runs, 0);
}

TEST(a_question_the_store_cannot_hold_is_refused_before_a_thread_is_opened) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Coach h;
  const ThreadId nulled = h.nextThread();
  const ThreadId malformed = h.nextThread();

  CHECK(h.question(nulled, std::string("why is my bench\0STUCK", 21), h.user).refusal ==
        AskRefusal::questionUnstorable);
  CHECK(h.question(malformed, "bench \xED\xA0\x80 stuck", h.user).refusal ==
        AskRefusal::questionUnstorable);
  CHECK_EQ(h.agent.runs, 0);
  CHECK_FALSE(h.threads.thread(h.user, nulled).has_value());
  CHECK_FALSE(h.threads.thread(h.user, malformed).has_value());
  CHECK_EQ(h.threads.threads(h.user).size(), 0u);
}

// The cap bites on the pair this ask would add, so a conversation is never capped halfway through.
TEST(a_long_conversation_keeps_history_and_bounds_only_model_context) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Coach h;
  const ThreadId thread = h.nextThread();

  h.repo.threads.openThread(h.user, thread, "a", 1'700'000'000'000);
  for (std::size_t pair = 0; pair < kMaxContextTurns / 2; ++pair) {
    AskGeneration answered{"gen_long" + std::to_string(pair), "req_long" + std::to_string(pair), "a"};
    answered.status = "completed";
    answered.answer = "a";
    answered.atMs = 1'700'000'000'000;
    h.repo.threads.saveGeneration(h.user, thread, answered);
  }

  CHECK(h.question(thread, "once more", h.user).refusal == AskRefusal::none);
  CHECK_EQ(h.agent.runs, 1);
  CHECK_EQ(h.agent.seenTurns.size(), kMaxContextTurns + 1);
  CHECK_EQ(h.threads.thread(h.user, thread)->turns.size(), kMaxContextTurns + 2);
}

// The daily limit, one bucket saying both halves: three back to back, about ten a day.
TEST(the_daily_limit_refuses_the_fourth_question_in_a_burst) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Coach h;

  CHECK(h.question("one").refusal == AskRefusal::none);
  CHECK(h.question("two").refusal == AskRefusal::none);
  CHECK(h.question("three").refusal == AskRefusal::none);
  CHECK(h.question("four").refusal == AskRefusal::dailyLimit);
  CHECK_EQ(h.agent.runs, 3);
}

TEST(a_run_the_vendor_never_answered_gives_the_question_back) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Coach h;
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
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Coach h;
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
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Coach h;
  h.agent.throwsUp = true;

  const AskReply thrown = h.question("how did the squats go?");

  CHECK(thrown.refusal == AskRefusal::none);
  CHECK_FALSE(thrown.answer.ok);
  CHECK_EQ(thrown.answer.answer, std::string(""));
  CHECK_EQ(thrown.answer.error, std::string("Coach failed at ask.run"));
  CHECK_EQ(h.reports->events, (std::vector<std::string>{
      std::string("gym | ask.run | ") + typeid(std::runtime_error).name()}));

  h.agent.throwsUp = false;
  for (int attempt = 0; attempt < 3; ++attempt)
    CHECK(h.question("how did the squats go?").refusal == AskRefusal::none);
  CHECK_EQ(h.agent.runs, 4);
  CHECK_EQ(h.reports->events.size(), 1u);
}

TEST(coach_worker_persistence_failures_reply_and_report_once_without_private_exception_text) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Coach h;
  // The running generation lands; every save of how it ended is refused.
  struct FailingThreads : PgAskThreadRepository {
    using PgAskThreadRepository::PgAskThreadRepository;
    void saveGeneration(const UserId& user, const ThreadId& thread, AskGeneration& generation) override {
      if (generation.status != "running") throw std::runtime_error("database rejected a private Coach answer");
      PgAskThreadRepository::saveGeneration(user, thread, generation);
    }
  } threads{doortest::pool()};
  AskService ask{h.training, threads, h.clock, h.agent, h.tools, h.entitlements, h.reports};

  const AskReply persist = h.question(ask, h.nextThread(), "private question", h.user);
  h.agent.answers = false;
  const AskReply cleanup = h.question(ask, h.nextThread(), "private question", h.user);
  h.agent.throwsUp = true;
  const AskReply both = h.question(ask, h.nextThread(), "private question", h.user);

  CHECK_FALSE(persist.answer.ok);
  CHECK_EQ(persist.answer.answer, std::string("You squatted 100 for five."));
  CHECK_EQ(persist.answer.error, std::string("Coach failed at ask.persist"));
  CHECK_FALSE(cleanup.answer.ok);
  CHECK_EQ(cleanup.answer.error, std::string("Coach failed at ask.persist"));
  CHECK_FALSE(both.answer.ok);
  CHECK_EQ(h.reports->events, (std::vector<std::string>{
      std::string("gym | ask.run | ") + typeid(std::runtime_error).name(),
      std::string("gym | ask.run | ") + typeid(std::runtime_error).name(),
      std::string("gym | ask.run | ") + typeid(std::runtime_error).name()}));
}

TEST(a_failure_reporter_cannot_prevent_coach_from_replying) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Coach h;
  h.agent.throwsUp = true;
  h.reports->throwReport = true;

  const ThreadId thread = h.nextThread();
  const AskReply reply = h.question(thread, "private question", h.user);

  CHECK_FALSE(reply.answer.ok);
  CHECK_EQ(reply.answer.error, std::string("Coach failed at ask.run"));
  CHECK_EQ(stored("select id from gym_ask_threads"), std::vector<std::string>{thread.str()});
  const std::optional<AskThread> held = h.threads.thread(h.user, thread);
  REQUIRE(held.has_value());
  REQUIRE(held->generation.has_value());
  CHECK_EQ(held->generation->status, std::string("failed"));
  CHECK_EQ(h.reports->events, (std::vector<std::string>{
      std::string("gym | ask.run | ") + typeid(std::runtime_error).name()}));
}

// The question is taken AFTER every other rung, so a refusal that answered nothing costs nothing.
TEST(a_refusal_above_the_ration_costs_none_of_the_days_questions) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Coach h;
  h.usage.spentByProduct[""] = kProMonthlyAiNanos;

  for (int attempt = 0; attempt < 4; ++attempt)
    CHECK(h.question("how did the squats go?").refusal == AskRefusal::outOfBudget);

  h.usage.spentByProduct[""] = 0;  // the trailing window rolls on
  CHECK(h.question("how did the squats go?").refusal == AskRefusal::none);
  CHECK(h.question("and the bench?").refusal == AskRefusal::none);
  CHECK(h.question("what about next week?").refusal == AskRefusal::none);
  CHECK_EQ(h.agent.runs, 3);
  CHECK(h.reports->events.empty());
}

TEST(an_account_over_its_ai_ceiling_is_refused_before_the_question_travels) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Coach h;
  h.usage.spentByProduct[""] = kProMonthlyAiNanos;  // this account's own window is spent

  const AskReply reply = h.question("how did the squats go?");

  CHECK(reply.refusal == AskRefusal::outOfBudget);
  CHECK_EQ(h.agent.runs, 0);  // nothing is spent proving we are out of budget
}

TEST(a_subscriber_over_the_free_ceiling_but_under_their_own_still_gets_an_answer) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Coach h;
  h.subscribe();
  h.usage.spentByProduct[""] = kFreeMonthlyAiNanos;  // spent for a free account, not for this one

  const AskReply reply = h.question("how did the squats go?");

  CHECK(reply.refusal == AskRefusal::none);
  CHECK_EQ(h.agent.runs, 1);
}

TEST(a_maxed_journal_sweep_never_stops_ask_answering) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Coach h;
  // The background bucket is its own: a sweep the lifter did not ask for cannot take Ask from them.
  h.usage.spentByProduct["journal"] = kSweepMonthlyAiNanos;
  h.usage.spentByProduct[""] = kSweepMonthlyAiNanos;

  CHECK(h.question("how did the squats go?").refusal == AskRefusal::none);
  CHECK_EQ(h.agent.runs, 1);
}

TEST(the_reply_carries_the_servers_own_read_line_and_the_proposals_the_run_minted) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Coach h;
  h.seedRoutine();

  Json::Value entry(Json::objectValue);
  entry["exerciseId"] = "bench-press";
  entry["sets"] = toJson(straight(5, 3, 87.5));
  Json::Value entries(Json::arrayValue);
  entries.append(entry);
  Json::Value propose(Json::objectValue);
  propose["id"] = "prop_00000009";
  propose["routineId"] = rtId().str();
  propose["entries"] = entries;

  h.agent.plan = {{"list_sessions", Json::Value(Json::objectValue)},
                  {"get_session", sessionArgs(h.session)},
                  {"propose_routine_change", propose}};

  const ThreadId thread = h.nextThread();
  const AskReply reply = h.question(thread, "write me the triples block", h.user);

  CHECK(reply.refusal == AskRefusal::none);
  CHECK_EQ(reply.read, (ReadTally{1, 1, 1}));  // one workout, its one set, the week it fell in
  REQUIRE_EQ(reply.proposals.size(), 1u);
  CHECK_EQ(reply.proposals[0], std::string("prop_00000009"));
  REQUIRE_EQ(reply.answer.steps.size(), 3u);
  CHECK_FALSE(reply.answer.steps[2].failed);
  REQUIRE(reply.receipt.has_value());
  CHECK_EQ(reply.receipt->read, reply.read);
  CHECK_EQ(reply.receipt->proposals, reply.proposals);
  CHECK_EQ(reply.receipt->steps, reply.answer.steps);
  const auto held = h.threads.thread(h.user, thread);
  REQUIRE(held.has_value());
  REQUIRE_EQ(held->turns.size(), 2u);
  CHECK_FALSE(held->turns[0].receipt.has_value());
  CHECK_EQ(held->turns[1].receipt, reply.receipt);
  CHECK_EQ(held->turns[0].atMs, held->turns[1].atMs);
}

TEST(a_refused_tool_marks_its_step_and_leaves_the_log_alone) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Coach h;
  h.agent.plan = {{"discard_session", sessionArgs(h.session)}};

  const AskReply reply = h.question("delete tuesday");

  CHECK(reply.refusal == AskRefusal::none);
  REQUIRE_EQ(reply.answer.steps.size(), 1u);
  CHECK(reply.answer.steps[0].failed);
  CHECK(h.training.detail(h.user, h.session).has_value());
  CHECK_EQ(reply.proposals.size(), 0u);
}

TEST(a_first_question_opens_a_thread_titled_by_that_question_byte_for_byte) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Coach h;
  const ThreadId thread = h.nextThread();
  const std::string typed = "Bench “stuck” at 82.5 — three weeks 💀. What do you see?";

  CHECK(h.question(thread, typed, h.user).refusal == AskRefusal::none);

  const std::optional<AskThread> held = h.threads.thread(h.user, thread);
  REQUIRE(held.has_value());
  CHECK_EQ(held->title, typed);
  REQUIRE_EQ(held->turns.size(), 2u);
  CHECK(held->turns[0].fromLifter);
  CHECK_EQ(held->turns[0].text, typed);
  CHECK_FALSE(held->turns[1].fromLifter);
  CHECK_EQ(held->turns[1].text, std::string("You squatted 100 for five."));
}

TEST(a_second_question_is_answered_against_the_stored_conversation) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Coach h;
  const ThreadId thread = h.nextThread();
  h.question(thread, "how did the squats go?", h.user);

  CHECK(h.question(thread, "and the bench?", h.user).refusal == AskRefusal::none);

  REQUIRE_EQ(h.agent.seenTurns.size(), 3u);
  CHECK_EQ(h.agent.seenTurns[0].text, std::string("how did the squats go?"));
  CHECK_FALSE(h.agent.seenTurns[1].fromLifter);
  CHECK_EQ(h.agent.seenTurns[2].text, std::string("and the bench?"));
  const std::optional<AskThread> held = h.threads.thread(h.user, thread);
  REQUIRE(held.has_value());
  CHECK_EQ(held->title, std::string("how did the squats go?"));
  CHECK_EQ(held->turns.size(), 4u);
}

TEST(a_failed_generation_preserves_its_question_and_retry_completes_the_same_pair) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Coach h;
  h.agent.answers = false;
  h.agent.turnsSpent = 0;
  h.agent.plan = {{"get_session", sessionArgs(h.session)}};
  const ThreadId thread = h.nextThread();

  const AskReply failed = h.question(thread, "how did the squats go?", h.user, "req_retry0001");
  CHECK_FALSE(failed.answer.ok);
  CHECK(failed.receipt.has_value());
  CHECK_EQ(failed.read, (ReadTally{1, 1, 1}));
  REQUIRE(h.threads.thread(h.user, thread).has_value());
  CHECK_EQ(h.threads.thread(h.user, thread)->turns.size(), 2u);

  h.agent.answers = true;
  CHECK(h.question(thread, "how did the squats go?", h.user, "req_retry0001").refusal == AskRefusal::none);
  const std::optional<AskThread> landed = h.threads.thread(h.user, thread);
  REQUIRE(landed.has_value());
  CHECK_EQ(landed->turns.size(), 2u);
}

TEST(the_actual_model_loop_receipt_includes_opening_reads_and_failed_attempts_in_order) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Coach h;
  AskTools hands{h.tools, ThreadId{"thr_evidence1"}};
  int calls = 0;
  const AskCall model = [&calls](const Json::Value&) -> std::optional<Json::Value> {
    if (++calls == 1) return parse(R"({"stop_reason":"tool_use","content":[
        {"type":"tool_use","id":"toolu_1","name":"get_session","input":{"sessionId":"ses_absent01"}},
        {"type":"tool_use","id":"toolu_2","name":"get_session","input":{"sessionId":"ses_11111111"}}]})");
    return parse(R"({"stop_reason":"end_turn","content":[{"type":"text","text":"One squat set."}]})");
  };
  const AskAnswer answer = driveAsk({AskTurn{true, "What did I train?"}},
      ToolCaller{h.user, ToolScope::everything()}, hands, model,
      [](const std::string&, const std::string&) {});

  CHECK(answer.ok);
  CHECK_EQ(answer.answer, std::string("One squat set."));
  CHECK_EQ(calls, 2);
  CHECK_EQ(answer.steps, (std::vector<AskStep>{{"list_notes", false},
      {"get_session", true}, {"get_session", false}}));
  CHECK_EQ(hands.steps(), (std::vector<AskStep>{{"list_sessions", false}, {"list_notes", false},
      {"get_session", true}, {"get_session", false}}));
  CHECK_EQ(hands.read().tally(), (ReadTally{1, 1, 1}));
  const Session session = *h.repo.log.session(h.user, h.session);
  CHECK_EQ(hands.read().observations(), (std::vector<SessionObservation>{
      {"list_sessions", session, ReadCoverage::summary, 0, WorkoutObservation{session, 1, 500}},
      {"get_session", session, ReadCoverage::session, 1, WorkoutObservation{session, 1, 500}}}));
}

TEST(a_failed_follow_up_leaves_the_conversation_that_already_happened_alone) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Coach h;
  const ThreadId thread = h.nextThread();
  h.question(thread, "how did the squats go?", h.user);

  h.agent.answers = false;
  h.agent.turnsSpent = 0;
  CHECK_FALSE(h.question(thread, "and the bench?", h.user).answer.ok);

  const std::optional<AskThread> held = h.threads.thread(h.user, thread);
  REQUIRE(held.has_value());
  REQUIRE_EQ(held->turns.size(), 4u);
  CHECK_EQ(held->turns[1].text, std::string("You squatted 100 for five."));
  CHECK_EQ(held->turns[3].status, std::string("failed"));
}

TEST(a_proposal_minted_in_a_conversation_carries_that_conversation) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Coach h;
  h.seedRoutine();
  const ThreadId thread = h.nextThread();

  Json::Value entry(Json::objectValue);
  entry["exerciseId"] = "bench-press";
  entry["sets"] = toJson(straight(5, 3, 87.5));
  Json::Value entries(Json::arrayValue);
  entries.append(entry);
  Json::Value propose(Json::objectValue);
  propose["id"] = "prop_00000009";
  propose["routineId"] = rtId().str();
  propose["entries"] = entries;
  h.agent.plan = {{"propose_routine_change", propose}};

  CHECK(h.question(thread, "heavier triples please", h.user).refusal == AskRefusal::none);

  const std::optional<RoutineProposal> minted =
      h.repo.program.proposal(h.user, ProposalId{"prop_00000009"});
  REQUIRE(minted.has_value());
  CHECK(minted->head.source.door == ProposalDoor::ask);
  REQUIRE(minted->head.source.thread.has_value());
  CHECK(*minted->head.source.thread == thread);
  const std::optional<AskThread> held = h.threads.thread(h.user, thread);
  REQUIRE(held.has_value());
  const ThreadOutcome outcome = outcomeOf(*held);
  CHECK(outcome.kind == ThreadOutcomeKind::proposed);
  CHECK_EQ(outcome.routineName, std::string("Push A"));
}

TEST(a_proposal_from_the_mcp_door_carries_no_conversation) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Coach h;
  h.seedRoutine();

  Json::Value entry(Json::objectValue);
  entry["exerciseId"] = "bench-press";
  entry["sets"] = toJson(straight(5, 3, 87.5));
  Json::Value entries(Json::arrayValue);
  entries.append(entry);
  Json::Value propose(Json::objectValue);
  propose["id"] = "prop_00000010";
  propose["routineId"] = rtId().str();
  propose["entries"] = entries;

  const ToolCaller agent{h.user, ToolScope({{"gym", Access::write}})};
  h.tools.callTool("propose_routine_change", propose, agent);

  const std::optional<RoutineProposal> minted =
      h.repo.program.proposal(h.user, ProposalId{"prop_00000010"});
  REQUIRE(minted.has_value());
  CHECK(minted->head.source.door == ProposalDoor::mcp);
  CHECK_FALSE(minted->head.source.thread.has_value());
}

TEST(coach_request_replays_completed_answer_without_spend_and_refuses_changed_question) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Coach h;
  const ThreadId thread{"thr_request01"};
  const auto first = h.question(thread, "how did it go?", h.user, "req_request01");
  REQUIRE(first.answer.ok);
  h.usage.spentByProduct[""] = kProMonthlyAiNanos;
  const auto replay = h.question(thread, "how did it go?", h.user, "req_request01");
  CHECK(replay.answer.ok);
  CHECK_EQ(replay.generation, first.generation);
  CHECK_EQ(replay.receipt, first.receipt);
  CHECK_EQ(h.agent.runs, 1);
  CHECK_EQ(h.threads.thread(h.user, thread)->turns.size(), 2u);
  CHECK(h.question(thread, "different", h.user, "req_request01").refusal == AskRefusal::requestConflict);
  CHECK_FALSE(h.repo.threads.generation(h.other, thread, "req_request01").has_value());
}

TEST(coach_creation_recovers_after_failure_and_never_recreates_a_deleted_routine) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Coach h;
  const ThreadId thread{"thr_creation1"};
  Json::Value create = parse(R"({"id":"rt_model0001","name":"Upper body","position":0,"entries":[{"exerciseId":"bench-press","sets":[{"reps":8}]}]})");
  h.agent.plan = {{"list_notes", Json::Value(Json::objectValue)},
                  {"list_exercises", Json::Value(Json::objectValue)}, {"create_routine", create}};
  h.agent.answers = false;
  const auto failed = h.question(thread, "create an upper-body routine using my bench", h.user, "req_creation1");
  REQUIRE(failed.generation.has_value());
  REQUIRE_EQ(failed.generation->results.size(), 1u);
  const CoachResult created = failed.generation->results.front();
  CHECK(created.routineId != "rt_model0001");
  CHECK_EQ(stored("select id, name, created_door from gym_routines order by id"),
           std::vector<std::string>{created.routineId + " | Upper body | ask"});
  REQUIRE_EQ(h.threads.thread(h.user, thread)->turns.size(), 2u);
  CHECK_EQ(h.threads.thread(h.user, thread)->turns.back().status, std::string("failed"));
  CHECK(outcomeOf(*h.threads.thread(h.user, thread)).kind == ThreadOutcomeKind::created);
  h.kill(h.user, "routine", created.routineId);
  // A crash may happen after the routine transaction commits but before operation result persistence.
  std::vector<CoachOperation> operations = h.repo.threads.operations(h.user, thread, failed.generation->id);
  REQUIRE_EQ(operations.size(), 1u);
  operations.front().result.reset();
  h.repo.threads.saveOperation(h.user, thread, failed.generation->id, operations.front());
  AskGeneration unrecorded = *failed.generation;
  unrecorded.results.clear();
  h.repo.threads.saveGeneration(h.user, thread, unrecorded);
  h.agent.answers = true;
  const auto recovered = h.question(thread, "create an upper-body routine using my bench", h.user, "req_creation1");
  REQUIRE(recovered.answer.ok);
  CHECK_EQ(recovered.generation->results, (std::vector<CoachResult>{created}));
  CHECK_EQ(stored("select id from gym_routines"), std::vector<std::string>{});
  const auto history = h.threads.thread(h.user, thread);
  REQUIRE_EQ(history->turns.size(), 2u);
  CHECK_EQ(history->turns.back().status, std::string("completed"));
  CHECK_EQ(history->turns.back().requestId, std::string("req_creation1"));
  CHECK_EQ(history->turns.back().results, (std::vector<CoachResult>{created}));
  CHECK_EQ(h.question(thread, "create an upper-body routine using my bench", h.user, "req_creation1").generation, recovered.generation);
  CHECK_EQ(h.agent.runs, 2);
}

TEST(coach_requires_notes_and_catalog_before_creating_and_corrects_invalid_movements_in_place) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Coach h;
  Json::Value create = parse(R"({"id":"rt_model0001","name":"Upper body","position":0,"entries":[{"exerciseId":"missing-movement","sets":[{"reps":8}]}]})");
  Json::Value valid = create;
  valid["entries"][0]["exerciseId"] = "bench-press";
  h.agent.plan = {{"create_routine", valid}, {"list_notes", Json::Value(Json::objectValue)},
      {"list_exercises", Json::Value(Json::objectValue)}, {"create_routine", create}, {"create_routine", valid}, {"create_routine", valid}};
  const auto answer = h.question(ThreadId{"thr_catalog01"}, "Create my routine", h.user, "req_catalog01");
  REQUIRE(answer.answer.ok);
  REQUIRE(answer.generation.has_value());
  CHECK_EQ(answer.answer.steps, (std::vector<AskStep>{{"create_routine", true}, {"list_notes", false},
      {"list_exercises", false}, {"create_routine", true}, {"create_routine", false}, {"create_routine", false}}));
  CHECK_EQ(stored("select id, name, created_door from gym_routines order by id"),
           std::vector<std::string>{"rt_" + answer.generation->id + " | Upper body | ask"});
  CHECK_EQ(answer.generation->results.size(), 1u);
}

TEST(coach_active_generation_replays_pending_identity_and_guards_conversation_deletion) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Coach h;
  struct BlockingAgent : FakeAsk {
    std::promise<void> entered;
    std::promise<void> release;
    AskAnswer answer(const std::vector<AskTurn>& turns, const ToolCaller& caller, ToolHost& tools) override {
      entered.set_value();
      release.get_future().wait();
      return FakeAsk::answer(turns, caller, tools);
    }
  } agent;
  AskService service{h.training, h.repo.threads, h.clock, agent, h.tools, h.entitlements};
  std::promise<AskReply> first;
  service.ask(h.user, "sam@example.com", ThreadId{"thr_active01"}, "one", [&](AskReply reply) { first.set_value(reply); }, "req_active01");
  agent.entered.get_future().wait();
  std::promise<AskReply> duplicate;
  service.ask(h.user, "sam@example.com", ThreadId{"thr_active01"}, "one", [&](AskReply reply) { duplicate.set_value(reply); }, "req_active01");
  const auto pending = duplicate.get_future().get();
  REQUIRE(pending.generation.has_value());
  CHECK_EQ(pending.generation->status, std::string("running"));
  CHECK_FALSE(pending.answer.ok);
  bool refused = false;
  try { h.threads.deleteThread(h.user, ThreadId{"thr_active01"}); }
  catch (const ThreadBusy&) { refused = true; }
  CHECK(refused);
  CHECK_FALSE(h.threads.deleteThread(h.other, ThreadId{"thr_active01"}));
  agent.release.set_value();
  CHECK(first.get_future().get().answer.ok);
  CHECK_EQ(agent.runs, 1);
}

TEST(coach_stop_preserves_partial_text_and_created_routine_and_replays_without_a_new_run) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Coach h;
  const ThreadId thread{"thr_stop0001"};
  struct PartialAgent : FakeAsk {
    std::function<void()> stop;
    AskAnswer answer(const std::vector<AskTurn>& turns, const ToolCaller& caller, ToolHost& tools,
                     const AskControl& control) override {
      const auto completed = FakeAsk::answer(turns, caller, tools);
      control.text("Your new routine is ready. Next");
      stop();
      CHECK_FALSE(control.continueRun());
      AskAnswer partial;
      partial.modelTurns = completed.modelTurns;
      partial.steps = completed.steps;
      return partial;
    }
  } agent;
  agent.plan = {{"list_notes", parse("{}")}, {"list_exercises", parse("{}")},
      {"create_routine", parse(R"({"id":"rt_model0001","name":"Upper body","position":0,"entries":[{"exerciseId":"bench-press","sets":[{"reps":8}]}]})")}};
  agent.stop = [&] { REQUIRE(h.repo.threads.stopGeneration(h.user, thread, "req_stop0001").has_value()); };
  AskService service{h.training, h.repo.threads, h.clock, agent, h.tools, h.entitlements};
  const auto ask = [&] {
    std::promise<AskReply> reply;
    auto future = reply.get_future();
    service.ask(h.user, "sam@example.com", thread, "Create my routine", [&](AskReply answer) { reply.set_value(answer); }, "req_stop0001");
    return future.get();
  };
  const auto stopped = ask();
  REQUIRE(stopped.generation.has_value());
  CHECK_EQ(stopped.generation->status, std::string("stopped"));
  CHECK_EQ(stopped.generation->answer, std::string("Your new routine is ready. Next"));
  REQUIRE_EQ(stopped.generation->results.size(), 1u);
  CHECK_EQ(stored("select id, name, created_door from gym_routines order by id"),
           std::vector<std::string>{"rt_" + stopped.generation->id + " | Upper body | ask"});
  CHECK_EQ(h.threads.thread(h.user, thread)->turns.back().status, std::string("stopped"));
  CHECK_EQ(ask().generation, stopped.generation);
  CHECK_EQ(agent.runs, 1);
}

TEST(coach_image_only_question_has_a_photo_title_and_an_immutable_owner_scoped_attachment) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Coach h;
  const ThreadId thread{"thr_image001"};
  const CoachImage photo{{"img_image001", "image/png", 1, 1, 3}, "png"};
  REQUIRE(h.repo.threads.putImage(h.user, thread, photo) == ImageWriteError::none);
  const auto ask = [&](const UserId& user, std::vector<std::string> images) {
    std::promise<AskReply> reply;
    auto future = reply.get_future();
    h.ask.ask(user, "sam@example.com", thread, "", [&](AskReply answer) { reply.set_value(answer); }, "req_image001", images);
    return future.get();
  };
  CHECK(ask(h.other, {photo.attachment.id}).refusal == AskRefusal::attachmentInvalid);
  const auto answer = ask(h.user, {photo.attachment.id});
  REQUIRE(answer.answer.ok);
  REQUIRE(answer.generation.has_value());
  CHECK_EQ(answer.generation->attachments, (std::vector<CoachAttachment>{photo.attachment}));
  const auto held = h.threads.thread(h.user, thread);
  REQUIRE(held.has_value());
  CHECK_EQ(held->title, std::string("Photo"));
  CHECK_EQ(held->turns.front().attachments, answer.generation->attachments);
  REQUIRE_EQ(h.agent.seenTurns.back().images.size(), 1u);
  CHECK_EQ(h.agent.seenTurns.back().images.front().data, photo.data);
  CHECK(ask(h.user, {"img_different"}).refusal == AskRefusal::requestConflict);
  CHECK_EQ(ask(h.user, {photo.attachment.id}).generation, answer.generation);
  CHECK_EQ(h.agent.runs, 1);
}

TEST(coach_stop_after_restart_reconciles_committed_creation_without_executing_a_pending_write) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Coach h;
  const ThreadId thread{"thr_restart1"};
  h.repo.threads.openThread(h.user, thread, "Create routine", h.clock.now);
  AskGeneration generation{"gen_restart1", "req_restart1", "Create routine"};
  generation.atMs = h.clock.now;
  generation.answer = "I have started";
  h.repo.threads.saveGeneration(h.user, thread, generation);
  CoachOperation operation{"op_restart1", "create_routine", parse(R"({"id":"rt_restart01","name":"Upper body","position":0,"entries":[{"exerciseId":"bench-press","sets":[{"reps":8}]}]})")};
  h.repo.threads.saveOperation(h.user, thread, generation.id, operation);
  const auto stopped = h.ask.stop(h.user, thread, generation.requestId);
  REQUIRE(stopped.has_value());
  CHECK_EQ(stopped->status, std::string("stopped"));
  CHECK_EQ(stopped->answer, std::string("I have started"));
  CHECK(stopped->results.empty());
  CHECK_EQ(stored("select id from gym_routines"), std::vector<std::string>{});
  CHECK_EQ(h.agent.runs, 0);

  const ThreadId committedThread{"thr_restart2"};
  h.repo.threads.openThread(h.user, committedThread, "Create routine", h.clock.now);
  AskGeneration committed{"gen_restart2", "req_restart2", "Create routine"};
  committed.atMs = h.clock.now;
  h.repo.threads.saveGeneration(h.user, committedThread, committed);
  operation.id = "op_restart2";
  h.repo.threads.saveOperation(h.user, committedThread, committed.id, operation);
  ReadReceipt receipt;
  const ToolCaller caller{h.user, ToolScope::everything()};
  REQUIRE(!h.tools.callTool("create_routine", operation.arguments, caller,
      ProposalSource{ProposalDoor::ask, "", "", committedThread}, receipt).isError);
  h.kill(h.user, "routine", "rt_restart01");
  const auto recovered = h.ask.stop(h.user, committedThread, committed.requestId);
  REQUIRE(recovered.has_value());
  CHECK_EQ(recovered->status, std::string("stopped"));
  CHECK_EQ(recovered->results, (std::vector<CoachResult>{{"op_restart2", "rt_restart01", "Upper body"}}));
  CHECK_EQ(stored("select id from gym_routines"), std::vector<std::string>{});
  CHECK_EQ(h.agent.runs, 0);
}

TEST(coach_admission_classifies_more_requests_than_model_workers_without_waiting_for_the_model) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Coach h;
  struct BlockingAgent : AskAgent {
    std::atomic<int> runs{0};
    std::promise<void> first;
    std::promise<void> second;
    std::promise<void> releaseFirst;
    std::promise<void> releaseSecond;
    std::shared_future<void> firstGate = releaseFirst.get_future().share();
    std::shared_future<void> secondGate = releaseSecond.get_future().share();
    bool configured() const override { return true; }
    AskAnswer answer(const std::vector<AskTurn>&, const ToolCaller&, ToolHost&) override {
      const int index = runs.fetch_add(1);
      if (index == 0) first.set_value();
      if (index == 1) second.set_value();
      if (index == 0) firstGate.wait();
      if (index == 1) secondGate.wait();
      AskAnswer reply;
      reply.ok = true;
      reply.answer = "Finished";
      reply.modelTurns = 1;
      return reply;
    }
  } agent;
  const ThreadId heldThread{"thr_held0001"};
  h.repo.threads.openThread(h.user, heldThread, "Earlier question", h.clock.now);
  AskGeneration held{"gen_held0001", "req_held0001", "Earlier question"};
  held.status = "failed";
  held.atMs = h.clock.now;
  held.results = {{"op_held0001", "rt_held0001", "Upper body"}};
  h.repo.threads.saveGeneration(h.user, heldThread, held);
  const ThreadId completeThread{"thr_done0001"};
  h.repo.threads.openThread(h.user, completeThread, "Already answered", h.clock.now);
  AskGeneration complete{"gen_done0001", "req_done0001", "Already answered"};
  complete.status = "completed";
  complete.answer = "Earlier answer";
  complete.atMs = h.clock.now;
  h.repo.threads.saveGeneration(h.user, completeThread, complete);
  const ThreadId deleted{"thr_gone0001"};
  h.repo.threads.openThread(h.user, deleted, "Deleted", h.clock.now);
  h.threads.deleteThread(h.user, deleted);
  AskService service{h.training, h.repo.threads, h.clock, agent, h.tools, h.entitlements};
  struct Release {
    std::promise<void>& first;
    std::promise<void>& second;
    ~Release() {
      try { first.set_value(); } catch (const std::future_error&) {}
      try { second.set_value(); } catch (const std::future_error&) {}
    }
  } release{agent.releaseFirst, agent.releaseSecond};
  const auto submit = [&](const UserId& owner, const ThreadId& thread, const std::string& question, const std::string& id) {
    const auto reply = std::make_shared<std::promise<AskReply>>();
    auto future = reply->get_future();
    service.ask(owner, "sam@example.com", thread, question,
        [reply](AskReply answer) { reply->set_value(std::move(answer)); }, id);
    return future;
  };
  const ThreadId firstThread{"thr_busy0001"};
  const ThreadId secondThread{"thr_busy0002"};
  auto first = submit(h.user, firstThread, "First", "req_busy0001");
  agent.first.get_future().wait();
  auto second = submit(h.user, secondThread, "Second", "req_busy0002");
  agent.second.get_future().wait();
  std::vector<std::future<AskReply>> overlaps;
  for (int index = 0; index < 6; ++index)
    overlaps.push_back(submit(h.user, firstThread, index % 2 ? "Different" : "First",
        index % 2 ? "req_other00" + std::to_string(index) : "req_busy0001"));
  auto fresh = submit(h.user, ThreadId{"thr_busy0003"}, "New", "req_busy0003");
  auto failed = submit(h.user, heldThread, held.question, held.requestId);
  auto replay = submit(h.user, completeThread, complete.question, complete.requestId);
  auto foreign = submit(h.other, firstThread, "First", "req_busy0001");
  auto gone = submit(h.user, deleted, "Deleted", "req_gone0001");
  for (std::size_t index = 0; index < overlaps.size(); ++index) {
    REQUIRE(overlaps[index].wait_for(std::chrono::seconds(2)) == std::future_status::ready);
    const auto reply = overlaps[index].get();
    if (index % 2) {
      CHECK(reply.refusal == AskRefusal::generationActive);
      CHECK_FALSE(reply.generation.has_value());
    } else {
      CHECK(reply.refusal == AskRefusal::none);
      REQUIRE(reply.generation.has_value());
      CHECK_EQ(reply.generation->status, std::string("running"));
      CHECK_EQ(reply.generation->requestId, std::string("req_busy0001"));
    }
  }
  REQUIRE(fresh.wait_for(std::chrono::seconds(2)) == std::future_status::ready);
  CHECK(fresh.get().refusal == AskRefusal::busy);
  const auto retained = failed.get();
  CHECK(retained.refusal == AskRefusal::busy);
  CHECK_EQ(retained.generation, std::optional<AskGeneration>{held});
  CHECK_EQ(replay.get().generation, std::optional<AskGeneration>{complete});
  CHECK(foreign.get().refusal == AskRefusal::threadTaken);
  CHECK(gone.get().refusal == AskRefusal::threadTaken);
  CHECK_FALSE(h.repo.threads.thread(h.user, ThreadId{"thr_busy0003"}).has_value());
  REQUIRE(service.stop(h.user, firstThread, "req_busy0001")->stopRequested);
  agent.releaseFirst.set_value();
  CHECK_EQ(first.get().generation->status, std::string("stopped"));
  agent.releaseSecond.set_value();
  CHECK_EQ(second.get().generation->status, std::string("completed"));
  CHECK_EQ(agent.runs.load(), 2);
  CHECK_EQ(h.repo.threads.thread(h.user, firstThread)->turns.size(), 2u);
}

TEST(coach_overlap_at_arrival_stays_refused_when_database_admission_is_delayed_past_completion) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Coach h;
  struct DelayedRepository : PgAskThreadRepository {
    using PgAskThreadRepository::PgAskThreadRepository;
    std::promise<void> entered;
    std::promise<void> release;
    bool threadAvailable(const UserId& user, const ThreadId& thread) override {
      if (thread.str() == "thr_delay002") { entered.set_value(); release.get_future().wait(); }
      return PgAskThreadRepository::threadAvailable(user, thread);
    }
  } repository{doortest::pool()};
  struct BlockingAgent : FakeAsk {
    std::promise<void> entered;
    std::promise<void> release;
    AskAnswer answer(const std::vector<AskTurn>& turns, const ToolCaller& caller, ToolHost& tools) override {
      if (runs == 0) { entered.set_value(); release.get_future().wait(); }
      return FakeAsk::answer(turns, caller, tools);
    }
  } agent;
  AskService service{h.training, repository, h.clock, agent, h.tools, h.entitlements};
  struct Release {
    std::promise<void>& model;
    std::promise<void>& database;
    ~Release() {
      try { model.set_value(); } catch (const std::future_error&) {}
      try { database.set_value(); } catch (const std::future_error&) {}
    }
  } release{agent.release, repository.release};
  const auto submit = [&](const std::string& thread, const std::string& request) {
    const auto reply = std::make_shared<std::promise<AskReply>>();
    auto future = reply->get_future();
    service.ask(h.user, "sam@example.com", ThreadId{thread}, "Question",
        [reply](AskReply answer) { reply->set_value(std::move(answer)); }, request);
    return future;
  };
  auto first = submit("thr_delay001", "req_delay001");
  agent.entered.get_future().wait();
  auto database = submit("thr_delay002", "req_delay002");
  repository.entered.get_future().wait();
  auto overlap = submit("thr_delay001", "req_overlap1");
  agent.release.set_value();
  REQUIRE(first.get().answer.ok);
  repository.release.set_value();
  REQUIRE(overlap.wait_for(std::chrono::seconds(2)) == std::future_status::ready);
  CHECK(overlap.get().refusal == AskRefusal::generationActive);
  CHECK(database.get().answer.ok);
  CHECK_EQ(agent.runs, 2);
  CHECK_EQ(repository.thread(h.user, ThreadId{"thr_delay001"})->turns.size(), 2u);
}

TEST(coach_failed_lease_reread_revalidates_the_immutable_request_payload) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Coach h;
  struct RaceRepository : PgAskThreadRepository {
    using PgAskThreadRepository::PgAskThreadRepository;
    bool armed = false;
    unsigned reads = 0;
    std::unique_ptr<ThreadLease> tryLease(const UserId&, const ThreadId&) override { return nullptr; }
    std::optional<AskGeneration> generation(const UserId& user, const ThreadId& thread, const std::string& request) override {
      if (armed && reads++ == 0) return std::nullopt;
      return PgAskThreadRepository::generation(user, thread, request);
    }
  } repository{doortest::pool()};
  const ThreadId thread{"thr_race0001"};
  const CoachImage photo{{"img_race0001", "image/png", 1, 1, 3}, "png"};
  REQUIRE(repository.putImage(h.user, thread, photo) == ImageWriteError::none);
  repository.openThread(h.user, thread, "Original", h.clock.now);
  AskGeneration held{"gen_race0001", "req_race0001", "Original"};
  held.atMs = h.clock.now;
  repository.saveGeneration(h.user, thread, held);
  AskService service{h.training, repository, h.clock, h.agent, h.tools, h.entitlements};
  for (const bool imageConflict : {false, true}) {
    repository.armed = false;
    held.question = imageConflict ? "Question" : "Original";
    if (imageConflict) held.attachments = {photo.attachment};
    repository.saveGeneration(h.user, thread, held);
    repository.reads = 0;
    repository.armed = true;
    std::promise<AskReply> reply;
    auto future = reply.get_future();
    service.ask(h.user, "sam@example.com", thread, "Question",
        [&](AskReply answer) { reply.set_value(std::move(answer)); }, held.requestId);
    const auto conflict = future.get();
    CHECK(conflict.refusal == AskRefusal::requestConflict);
    CHECK_EQ(conflict.generation, std::optional<AskGeneration>{held});
  }
  CHECK_EQ(h.agent.runs, 0);
}

TEST(coach_saves_one_user_insight_alongside_a_routine_and_recovers_both_without_duplicate_writes) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Coach h;
  const auto insight = parse(R"({"id":"note_model001","title":"Schedule","body":"I train on Monday and Thursday."})");
  const auto routine = parse(R"({"id":"rt_model0001","name":"Upper body","position":0,"entries":[{"exerciseId":"bench-press","sets":[{"reps":8}]}]})");
  h.agent.plan = {{"save_note", insight}, {"list_notes", parse("{}")}, {"save_note", insight},
                  {"list_exercises", parse("{}")}, {"create_routine", routine}};
  h.agent.answers = false;
  const ThreadId thread{"thr_note0001"};
  const auto first = h.question(thread, "I train on Monday and Thursday. Make a routine.", h.user, "req_note0001");
  REQUIRE(first.generation.has_value());
  CHECK_FALSE(first.answer.ok);
  const std::string note = "note_" + first.generation->id;
  const std::vector<std::string> routines{"rt_" + first.generation->id + " | Upper body | ask"};
  REQUIRE_EQ(stored("select id, title, body from gym_notes order by id"),
             std::vector<std::string>{note + " | Schedule | " + insight["body"].asString()});
  REQUIRE_EQ(stored("select id, name, created_door from gym_routines order by id"), routines);
  CHECK_EQ(first.answer.steps.front(), (AskStep{"save_note", true}));
  const auto operations = h.repo.threads.operations(h.user, thread, first.generation->id);
  REQUIRE_EQ(operations.size(), 2u);
  for (auto operation : operations) {
    REQUIRE(operation.result.has_value());
    CHECK_FALSE(operation.result->isError);
    operation.result.reset();
    h.repo.threads.saveOperation(h.user, thread, first.generation->id, operation);
  }
  h.kill(h.user, "note", note);
  h.agent.answers = true;
  const auto retried = h.question(thread, first.generation->question, h.user, "req_note0001");
  REQUIRE(retried.answer.ok);
  CHECK_EQ(stored("select id from gym_notes"), std::vector<std::string>{});
  CHECK_EQ(stored("select id, name, created_door from gym_routines order by id"), routines);
  CHECK_EQ(retried.generation->results, first.generation->results);
  CHECK(h.agent.seenTurns.back().text.find("Server-observed note save already completed") != std::string::npos);
  const auto completed = h.question(thread, first.generation->question, h.user, "req_note0001");
  CHECK_EQ(completed.generation, retried.generation);
  CHECK_EQ(h.agent.runs, 2);
}

TEST(coach_stopped_note_operation_reconciles_a_saved_note_but_never_executes_an_unsaved_one) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Coach h;
  const ThreadId thread{"thr_note_stop1"};
  h.repo.threads.openThread(h.user, thread, "Remember my schedule", h.clock.now);
  AskGeneration generation{"gen_note_stop1", "req_note_stop1", "Remember my schedule"};
  generation.atMs = h.clock.now;
  const auto session = *h.repo.log.session(h.user, h.session);
  const AnswerReceipt prior{1, {1, 1, 0}, {{"list_sessions", false}}, {"prop_prior001"},
      {SessionObservation{"get_session", session, ReadCoverage::session, 1, WorkoutObservation{session, 1, 500}}}};
  REQUIRE(prior.valid());
  generation.receipt = prior;
  generation.steps = prior.steps;
  h.repo.threads.saveGeneration(h.user, thread, generation);
  CoachOperation operation{"op_note_stop1", "save_note", parse(R"({"id":"note_stop001","title":"Schedule","body":"I train on Monday."})")};
  h.repo.threads.saveOperation(h.user, thread, generation.id, operation);
  AskTools pending(h.tools, thread, &h.repo.threads, &generation);
  pending.recover(ToolCaller{h.user, ToolScope::everything()}, false);
  CHECK_EQ(stored("select id from gym_notes"), std::vector<std::string>{});
  ReadReceipt read;
  REQUIRE(!h.tools.callTool("save_note", operation.arguments, ToolCaller{h.user, ToolScope::everything()},
      ProposalSource{ProposalDoor::ask, "", "", thread}, read).isError);
  h.kill(h.user, "note", "note_stop001");
  const auto stopped = h.ask.stop(h.user, thread, generation.requestId);
  REQUIRE(stopped.has_value());
  CHECK_EQ(stopped->status, std::string("stopped"));
  REQUIRE(stopped->receipt.has_value());
  auto expected = prior;
  expected.steps.push_back({"save_note", false});
  CHECK_EQ(stopped->steps, expected.steps);
  CHECK_EQ(stopped->receipt, std::optional<AnswerReceipt>{expected});
  CHECK_EQ(h.repo.threads.generation(h.user, thread, generation.requestId), stopped);
  CHECK_EQ(h.repo.threads.thread(h.user, thread)->turns.back().receipt, stopped->receipt);
  CHECK_EQ(stored("select id from gym_notes"), std::vector<std::string>{});
  const auto recovered = h.repo.threads.operations(h.user, thread, generation.id);
  REQUIRE_EQ(recovered.size(), 1u);
  REQUIRE(recovered[0].result.has_value());
  CHECK_EQ(recovered[0].result->payload["saved"], Json::Value(true));
  CHECK_EQ(h.agent.runs, 0);
}

TEST(coach_corrected_note_attempt_clears_its_prior_error_before_the_write_can_commit) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Coach h;
  struct LostAck : PgAskThreadRepository {
    using PgAskThreadRepository::PgAskThreadRepository;
    bool loseResult = false;
    void saveOperation(const UserId& user, const ThreadId& thread, const std::string& generation,
                       const CoachOperation& operation) override {
      if (loseResult && operation.result && !operation.result->isError)
        throw std::runtime_error("simulated process loss before operation result persistence");
      PgAskThreadRepository::saveOperation(user, thread, generation, operation);
    }
  } threads{doortest::pool()};
  const ThreadId thread{"thr_correct1"};
  threads.openThread(h.user, thread, "Remember my schedule", h.clock.now);
  AskGeneration generation{"gen_correct1", "req_correct1", "Remember my schedule"};
  generation.atMs = h.clock.now;
  threads.saveGeneration(h.user, thread, generation);
  AskTools hands(h.tools, thread, &threads, &generation);
  const ToolCaller caller{h.user, ToolScope::everything()};
  REQUIRE(!hands.callTool("list_notes", parse("{}"), caller).isError);
  auto input = parse(R"({"id":"note_model001","title":"Schedule","body":"I train on Monday."})");
  auto invalid = input;
  invalid["body"] = std::string(501, 'x');
  REQUIRE(hands.callTool("save_note", invalid, caller).isError);
  REQUIRE(threads.operations(h.user, thread, generation.id).front().result->isError);
  threads.loseResult = true;
  bool lost = false;
  try { hands.callTool("save_note", input, caller); }
  catch (const std::runtime_error&) { lost = true; }
  REQUIRE(lost);
  CHECK_FALSE(threads.operations(h.user, thread, generation.id).front().result.has_value());
  REQUIRE_EQ(stored("select id, title, body from gym_notes order by id"),
             std::vector<std::string>{"note_gen_correct1 | Schedule | I train on Monday."});
  h.kill(h.user, "note", "note_gen_correct1");
  threads.loseResult = false;
  AskService service{h.training, threads, h.clock, h.agent, h.tools, h.entitlements};
  const auto stopped = service.stop(h.user, thread, generation.requestId);
  REQUIRE(stopped.has_value());
  REQUIRE(stopped->receipt.has_value());
  CHECK_EQ(stopped->steps, (std::vector<AskStep>{{"save_note", false}}));
  CHECK_EQ(stopped->receipt->steps, stopped->steps);
  CHECK_EQ(stored("select id from gym_notes"), std::vector<std::string>{});
  CHECK_EQ(h.agent.runs, 0);
}

TEST(coach_write_completion_and_issue_share_request_without_private_content) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Coach h;
  std::vector<WriteCompletion> completions;
  installWriteSink([&](const WriteCompletion& completion) { completions.push_back(completion); });
  h.agent.throwsUp = true;
  const AskReply reply = h.question("PRIVATE_COACH_QUESTION");
  installWriteSink({});

  CHECK_FALSE(reply.answer.ok);
  // The open-workout check finds nothing stale and admits nothing, so the ask's own line is the only one.
  std::vector<std::string> lines;
  for (const WriteCompletion& completion : completions)
    lines.push_back(completion.operation + " " + completion.product + " " + completion.door + " " + completion.outcome);
  CHECK_EQ(lines, (std::vector<std::string>{"ask.run gym Coach failed"}));
  REQUIRE_EQ(completions.size(), 1u);
  const WriteCompletion& run = completions.back();
  CHECK(run.durationMs >= 0);
  REQUIRE_EQ(h.reports->requestIds.size(), 1u);
  for (const WriteCompletion& completion : completions) CHECK_EQ(completion.requestId, h.reports->requestIds.front());
  CHECK_EQ(h.reports->doors.front(), std::string("Coach"));
  CHECK_EQ(h.reports->events.front(), std::string("gym | ask.run | ") + typeid(std::runtime_error).name());
  CHECK(h.reports->events.front().find("PRIVATE_COACH_QUESTION") == std::string::npos);
  CHECK(h.reports->events.front().find("the vendor sent") == std::string::npos);
}

TEST(every_declared_coach_write_tool_has_one_completion_even_when_refused) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Coach h;
  AskGeneration generation{"generation", "request", "PRIVATE_COACH_QUESTION"};
  AskTools tools{h.tools, ThreadId{"thr_00000001"}, &h.repo.threads, &generation};
  const ToolCaller reader{h.user, ToolScope({{"gym", Access::read}})};
  std::vector<WriteCompletion> completions;
  installWriteSink([&](const WriteCompletion& completion) { completions.push_back(completion); });
  std::size_t writes = 0;
  for (const auto& declaration : tools.declareTools()) {
    if (declaration.access == Access::read) continue;
    ++writes;
    const auto before = completions.size();
    const ToolResult reply = tools.callTool(declaration.name(), Json::Value(Json::objectValue), reader);
    CHECK(reply.isError);
    CHECK_EQ(completions.size(), before + 1);
    if (completions.size() != before + 1) continue;
    CHECK_EQ(completions.back().operation, "gym." + declaration.name());
    CHECK_EQ(completions.back().product, std::string("gym"));
    CHECK_EQ(completions.back().door, std::string("Coach"));
    CHECK_EQ(completions.back().outcome, std::string("refused"));
    CHECK_FALSE(completions.back().requestId.empty());
  }
  installWriteSink({});
  CHECK_EQ(writes, 4u);
}
