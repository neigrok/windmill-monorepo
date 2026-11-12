#include "products/roadmap/application/TendingService.h"

#include "platform/application/Entitlements.h"
#include "products/roadmap/domain/LooseGraph.h"
#include "test/platform/Fakes.h"
#include "test/products/roadmap/Fakes.h"
#include "test/products/roadmap/adapters/mcp/ToolsHarness.h"
#include "test/testing.h"

#include <algorithm>
#include <atomic>
#include <chrono>
#include <functional>
#include <map>
#include <mutex>
#include <optional>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>

using namespace wm;
using namespace wm::fake;

namespace {

// Thread-safe: start() writes the `running` row on the calling thread and the worker writes the terminal row on its own.
struct FakeTendRunRepository : TendRunRepository {
  mutable std::mutex mutex;
  std::map<std::string, TendRun> byId;

  void save(const TendRun& run) override {
    std::lock_guard<std::mutex> lock(mutex);
    byId[run.id] = run;
  }
  std::optional<TendRun> find(const std::string& id) override {
    std::lock_guard<std::mutex> lock(mutex);
    auto it = byId.find(id);
    if (it == byId.end()) return std::nullopt;
    return it->second;
  }
  int countForUser(const UserId& user, std::uint64_t sinceMs) override {
    std::lock_guard<std::mutex> lock(mutex);
    int n = 0;
    for (const auto& [id, run] : byId)
      if (run.user == user && run.startedAtMs >= sinceMs && run.status != TendStatus::refused) ++n;
    return n;
  }
  std::vector<TendRun> recentForUser(const UserId& user, std::uint64_t sinceMs, int limit) override {
    std::lock_guard<std::mutex> lock(mutex);
    std::vector<TendRun> out;
    for (const auto& [id, run] : byId)
      if (run.user == user && run.startedAtMs >= sinceMs && run.status != TendStatus::refused)
        out.push_back(run);
    std::sort(out.begin(), out.end(),
              [](const TendRun& a, const TendRun& b) { return a.startedAtMs > b.startedAtMs; });
    if (static_cast<int>(out.size()) > limit) out.resize(limit);
    return out;
  }
  int failOrphanedRuns() override {
    std::lock_guard<std::mutex> lock(mutex);
    int reaped = 0;
    for (auto& [id, run] : byId)
      if (run.status == TendStatus::running) {
        run.status = TendStatus::failed;
        if (run.detail.empty()) run.detail = "interrupted — the run did not survive a restart";
        ++reaped;
      }
    return reaped;
  }
};

// Thread-safe where it records: the worker pool reads the seq from several threads at once.
struct FakeToolHost : ToolHost {
  std::uint64_t seq = 0;
  bool getTreeErrors = false;
  std::mutex mutex;
  std::vector<Json::Value> getTreeArguments;

  std::vector<ToolDeclaration> declareTools() const override { return {}; }
  ToolResult callTool(const std::string& name, const Json::Value& arguments, const ToolCaller&) override {
    if (name != "get_tree") return ToolResult::failure("unexpected tool: " + name);
    {
      std::lock_guard<std::mutex> lock(mutex);
      getTreeArguments.push_back(arguments);
    }
    if (getTreeErrors) return ToolResult::failure("no such tree");
    Json::Value out(Json::objectValue);
    out["seq"] = Json::Value::UInt64(seq);
    return ToolResult::json(out);
  }
};

struct FakePlanAgent : PlanAgent {
  bool isConfigured = true;
  AgentOutcome outcome;
  bool shouldThrow = false;
  std::string throwWhat = "upstream died";
  std::function<void()> onRun;
  std::atomic<int> calls{0};
  std::string lastPrompt;

  bool configured() const override { return isConfigured; }
  AgentOutcome run(const std::string& prompt, const TreeId&, const UserId&, ToolHost&,
                   const std::function<void(const AgentStep&)>&) override {
    lastPrompt = prompt;
    calls.fetch_add(1);
    if (onRun) onRun();
    if (shouldThrow) throw std::runtime_error(throwWhat);
    return outcome;
  }
};

// Tree "t" is u's own, the tree every case tends unless it is about whose tree it is.
struct Harness {
  FakeTendRunRepository runs;
  FakeToolHost tools;
  FakeTreeRepository trees;
  FakeOpLog ops;
  FakeBus bus;
  RoomRegistry rooms{trees, ops, bus};
  FakePlanAgent agent;
  FakeClock clock;
  FakeTokens tokens;
  FakeSubscriptionRepository subs;
  FakeAiUsageRepository usage;
  Entitlements entitlements{subs, usage};

  Harness() { plant("t", UserId{"u"}, Visibility::private_); }

  void plant(const std::string& tree, const std::optional<UserId>& owner, Visibility visibility) {
    trees.byId[tree] = StoredTree{LooseGraph().exportState(), LegendState{}, {"Tree", {}}, 0, owner, visibility};
  }
};

TendRun awaitTerminal(FakeTendRunRepository& runs, const std::string& id) {
  for (int i = 0; i < 3000; ++i) {
    std::optional<TendRun> run = runs.find(id);
    if (run && run->status != TendStatus::running) return *run;
    std::this_thread::sleep_for(std::chrono::milliseconds(1));
  }
  return runs.find(id).value_or(TendRun{});
}

AgentOutcome ok(const std::string& summary, int edits) {
  AgentOutcome outcome;
  outcome.ok = true;
  outcome.summary = summary;
  outcome.detail = "because you asked";
  outcome.edits = edits;
  return outcome;
}

// Seed `count` already-finished runs this month. A summary rides on `id` so newest-first ordering is checkable.
void seedDoneRuns(FakeTendRunRepository& runs, const UserId& user, int count, std::uint64_t at) {
  for (int i = 0; i < count; ++i) {
    TendRun seeded;
    seeded.id = "seed_" + user.str() + "_" + std::to_string(i);
    seeded.user = user;
    seeded.status = TendStatus::done;
    seeded.summary = "receipt " + std::to_string(i);
    seeded.startedAtMs = at + i;  // strictly increasing, so DESC order is deterministic
    runs.save(seeded);
  }
}

}

TEST(a_refusal_never_starts_work_and_is_persisted) {
  Harness h;
  TendingService service(h.runs, h.agent, h.tools, h.rooms, h.clock, h.tokens, h.entitlements, /*enabled=*/false);

  TendRun run = service.start(TreeId{"t"}, UserId{"u"}, "u@example.com","add a testing branch under backend");

  CHECK_EQ(run.status, TendStatus::refused);
  CHECK_EQ(run.refusal, TendRefusal::notEnabled);
  CHECK_EQ(h.agent.calls.load(), 0);
  std::optional<TendRun> stored = h.runs.find(run.id);
  REQUIRE(stored.has_value());
  CHECK_EQ(stored->status, TendStatus::refused);
  CHECK_EQ(stored->refusal, TendRefusal::notEnabled);
  CHECK_EQ(stored->finishedAtMs, stored->startedAtMs);  // a refusal begins and ends at once
}

TEST(an_empty_prompt_refuses_without_work) {
  Harness h;
  TendingService service(h.runs, h.agent, h.tools, h.rooms, h.clock, h.tokens, h.entitlements, /*enabled=*/true);

  TendRun blank = service.start(TreeId{"t"}, UserId{"u"}, "u@example.com","");
  CHECK_EQ(blank.status, TendStatus::refused);
  CHECK_EQ(blank.refusal, TendRefusal::promptEmpty);

  TendRun whitespace = service.start(TreeId{"t"}, UserId{"u"}, "u@example.com","   \t\n");
  CHECK_EQ(whitespace.status, TendStatus::refused);
  CHECK_EQ(whitespace.refusal, TendRefusal::promptEmpty);

  CHECK_EQ(h.agent.calls.load(), 0);
}

TEST(an_over_length_prompt_refuses_without_work) {
  Harness h;
  TendingService service(h.runs, h.agent, h.tools, h.rooms, h.clock, h.tokens, h.entitlements, /*enabled=*/true);

  const std::string tooLong(kMaxTendPromptBytes + 1, 'x');
  TendRun run = service.start(TreeId{"t"}, UserId{"u"}, "u@example.com",tooLong);

  CHECK_EQ(run.status, TendStatus::refused);
  CHECK_EQ(run.refusal, TendRefusal::promptTooLong);
  CHECK_EQ(h.agent.calls.load(), 0);
}

TEST(a_spent_free_allowance_refuses_without_work) {
  Harness h;
  seedDoneRuns(h.runs, UserId{"u"}, kFreeMonthlyTendings, h.clock.now);
  TendingService service(h.runs, h.agent, h.tools, h.rooms, h.clock, h.tokens, h.entitlements, /*enabled=*/true);

  TendRun run = service.start(TreeId{"t"}, UserId{"u"}, "u@example.com", "one more please");

  CHECK_EQ(run.status, TendStatus::refused);
  CHECK_EQ(run.refusal, TendRefusal::outOfAllowance);
  CHECK_EQ(h.agent.calls.load(), 0);
}

TEST(pro_gets_a_larger_allowance_than_free) {
  Harness h;
  h.subs.subscribe(UserId{"u"});
  h.agent.outcome = ok("grew it", 1);
  seedDoneRuns(h.runs, UserId{"u"}, kFreeMonthlyTendings, h.clock.now);
  TendingService service(h.runs, h.agent, h.tools, h.rooms, h.clock, h.tokens, h.entitlements, /*enabled=*/true);

  TendRun allowed = service.start(TreeId{"t"}, UserId{"u"}, "u@example.com", "one more please");
  CHECK_EQ(allowed.status, TendStatus::running);
  CHECK_EQ(awaitTerminal(h.runs, allowed.id).status, TendStatus::done);

  seedDoneRuns(h.runs, UserId{"u"}, kProMonthlyTendings, h.clock.now);
  TendRun refused = service.start(TreeId{"t"}, UserId{"u"}, "u@example.com", "and another");
  CHECK_EQ(refused.status, TendStatus::refused);
  CHECK_EQ(refused.refusal, TendRefusal::outOfAllowance);
}

TEST(the_summary_reports_the_plan_budget_reset_and_recent_receipts) {
  Harness h;
  seedDoneRuns(h.runs, UserId{"u"}, 3, h.clock.now);
  TendRun refused;  // a refusal spends nothing and never appears in the ledger
  refused.id = "tr_refused";
  refused.user = UserId{"u"};
  refused.status = TendStatus::refused;
  refused.startedAtMs = h.clock.now + 100;
  h.runs.save(refused);
  TendingService service(h.runs, h.agent, h.tools, h.rooms, h.clock, h.tokens, h.entitlements, /*enabled=*/true);

  const TendingSummary free = service.summaryFor(UserId{"u"}, "u@example.com");
  CHECK(free.enabled);
  CHECK_EQ(free.allowance.plan, Plan::free);
  CHECK_EQ(free.allowance.limit, 30);
  CHECK_EQ(free.allowance.used, 3);
  CHECK_EQ(free.allowance.remaining(), 27);
  CHECK_EQ(free.resetAtMs, nextMonthStartMsUtc(h.clock.now));
  REQUIRE_EQ(free.recent.size(), static_cast<std::size_t>(3));
  CHECK_EQ(free.recent.front().summary, std::string("receipt 2"));

  h.subs.subscribe(UserId{"u"});
  const TendingSummary pro = service.summaryFor(UserId{"u"}, "u@example.com");
  CHECK_EQ(pro.allowance.plan, Plan::pro);
  CHECK_EQ(pro.allowance.limit, 300);
  CHECK_EQ(pro.allowance.remaining(), 297);
}

TEST(a_successful_run_persists_done_summary_and_edits) {
  Harness h;
  h.agent.outcome = ok("Added 3 steps under Backend", 3);
  TendingService service(h.runs, h.agent, h.tools, h.rooms, h.clock, h.tokens, h.entitlements, /*enabled=*/true);

  TendRun started = service.start(TreeId{"t"}, UserId{"u"}, "u@example.com","add a testing branch under backend");
  CHECK_EQ(started.status, TendStatus::running);

  TendRun done = awaitTerminal(h.runs, started.id);
  CHECK_EQ(done.status, TendStatus::done);
  CHECK_EQ(done.summary, std::string("Added 3 steps under Backend"));
  CHECK_EQ(done.detail, std::string("because you asked"));
  CHECK_EQ(done.edits, 3);
  CHECK_EQ(h.agent.calls.load(), 1);
  CHECK_EQ(h.agent.lastPrompt, std::string("add a testing branch under backend"));
  CHECK(done.finishedAtMs >= done.startedAtMs);
}

TEST(a_throwing_agent_yields_failed_not_a_crash) {
  Harness h;
  h.agent.shouldThrow = true;
  h.agent.throwWhat = "the model would not settle";
  TendingService service(h.runs, h.agent, h.tools, h.rooms, h.clock, h.tokens, h.entitlements, /*enabled=*/true);

  TendRun started = service.start(TreeId{"t"}, UserId{"u"}, "u@example.com","reshape the whole thing");
  TendRun failed = awaitTerminal(h.runs, started.id);

  CHECK_EQ(failed.status, TendStatus::failed);
  CHECK_EQ(failed.detail, std::string("the model would not settle"));
  CHECK_EQ(failed.summary, std::string(""));
  CHECK_EQ(h.agent.calls.load(), 1);
}

TEST(the_seq_range_is_recorded) {
  Harness h;
  h.tools.seq = 10;                                  // the head before the agent writes anything
  h.agent.onRun = [&h] { h.tools.seq = 13; };        // the agent advances the head by three ops
  h.agent.outcome = ok("Grew the tree", 3);
  TendingService service(h.runs, h.agent, h.tools, h.rooms, h.clock, h.tokens, h.entitlements, /*enabled=*/true);

  TendRun started = service.start(TreeId{"t"}, UserId{"u"}, "u@example.com","grow it");
  TendRun done = awaitTerminal(h.runs, started.id);

  CHECK_EQ(done.status, TendStatus::done);
  CHECK_EQ(done.seqFrom, static_cast<std::uint64_t>(10));
  CHECK_EQ(done.seqTo, static_cast<std::uint64_t>(13));
  CHECK_EQ(h.tools.getTreeArguments,
           (std::vector<Json::Value>(2, parse(R"({"treeId":"t","includeGuides":false})"))));
}

// A run reads the tended tree alone: neither its two reads of the seq nor the agent's own get_tree walks to the
// trees above, over the real tools.
TEST(a_run_reads_no_tree_above_the_tended_one) {
  struct ReadingAgent : PlanAgent {
    Json::Value read;
    bool configured() const override { return true; }
    AgentOutcome run(const std::string&, const TreeId&, const UserId& user, ToolHost& tools,
                     const std::function<void(const AgentStep&)>&) override {
      read = test::body(tools.callTool("get_tree", Json::Value(Json::objectValue), ToolCaller{user, ToolScope::everything()}));
      return ok("Read the tree", 0);
    }
  } agent;
  test::Harness tended;
  tended.plant("t_root", tended.caller, "The method of every tree under this one.", {"t"});
  CHECK_FALSE(tended.call("describe_tree", test::with("guide", "Rig first, then sail.")).isError);
  Harness h;
  TendingService service(h.runs, agent, tended.tools, tended.registry, h.clock, h.tokens, h.entitlements, /*enabled=*/true);

  const TendRun started = service.start(TreeId{"t"}, tended.caller, "u@example.com", "read it");
  const TendRun done = awaitTerminal(h.runs, started.id);

  CHECK_EQ(done.status, TendStatus::done);
  CHECK_EQ(done.seqFrom, static_cast<std::uint64_t>(1));
  CHECK_EQ(done.seqTo, static_cast<std::uint64_t>(1));
  CHECK_EQ(agent.read["tree"], parse(R"({"guide":{"text":"Rig first, then sail.","yours":true},"id":"t","kinds":[],
                                         "nodes":[],"title":"Test Roadmap","url":"https://app.example/#/app/t"})"));
  CHECK(tended.trees.aboveReads.empty());
}

TEST(fail_orphaned_runs_settles_running_rows_and_leaves_finished_ones_alone) {
  FakeTendRunRepository runs;
  TendRun running;
  running.id = "tr_a";
  running.status = TendStatus::running;
  TendRun done;
  done.id = "tr_b";
  done.status = TendStatus::done;
  done.summary = "Added 3 steps";
  TendRun refused;
  refused.id = "tr_c";
  refused.status = TendStatus::refused;
  runs.save(running);
  runs.save(done);
  runs.save(refused);

  CHECK_EQ(runs.failOrphanedRuns(), 1);
  CHECK_EQ(runs.find("tr_a")->status, TendStatus::failed);
  CHECK_FALSE(runs.find("tr_a")->detail.empty());
  CHECK_EQ(runs.find("tr_b")->status, TendStatus::done);
  CHECK_EQ(runs.find("tr_b")->summary, std::string("Added 3 steps"));
  CHECK_EQ(runs.find("tr_c")->status, TendStatus::refused);
  CHECK_EQ(runs.failOrphanedRuns(), 0);
}

TEST(the_worker_pool_completes_more_runs_than_it_has_threads) {
  Harness h;
  h.agent.outcome = ok("grew it", 1);
  TendingService service(h.runs, h.agent, h.tools, h.rooms, h.clock, h.tokens, h.entitlements, /*enabled=*/true);

  // Eight runs against a four-thread pool: the excess must queue and still finish. Distinct users so the per-account allowance never trips.
  std::vector<std::string> ids;
  for (int i = 0; i < 8; ++i) {
    const std::string user = "u" + std::to_string(i);
    h.plant("t_" + user, UserId{user}, Visibility::private_);
    ids.push_back(service.start(TreeId{"t_" + user}, UserId{user}, "", "grow it").id);
  }

  for (const std::string& id : ids)
    CHECK_EQ(awaitTerminal(h.runs, id).status, TendStatus::done);
  CHECK_EQ(h.agent.calls.load(), 8);
}

TEST(an_account_over_its_ai_budget_refuses_without_work) {
  Harness h;
  h.usage.spentByProduct[""] = kFreeMonthlyAiNanos;  // runs to spare, money gone
  TendingService service(h.runs, h.agent, h.tools, h.rooms, h.clock, h.tokens, h.entitlements, /*enabled=*/true);

  TendRun run = service.start(TreeId{"t"}, UserId{"u"}, "u@example.com", "grow the tree");

  CHECK_EQ(run.status, TendStatus::refused);
  CHECK_EQ(run.refusal, TendRefusal::outOfBudget);
  CHECK_EQ(std::string{tendRefusalName(run.refusal)}, std::string{"out-of-budget"});
  CHECK_EQ(h.agent.calls.load(), 0);
}

TEST(the_run_allowance_is_still_its_own_ceiling_and_answers_first) {
  Harness h;
  seedDoneRuns(h.runs, UserId{"u"}, kFreeMonthlyTendings, h.clock.now);
  h.usage.spentByProduct[""] = kFreeMonthlyAiNanos;
  TendingService service(h.runs, h.agent, h.tools, h.rooms, h.clock, h.tokens, h.entitlements, /*enabled=*/true);

  TendRun run = service.start(TreeId{"t"}, UserId{"u"}, "u@example.com", "grow the tree");

  CHECK_EQ(run.refusal, TendRefusal::outOfAllowance);
  CHECK_EQ(h.agent.calls.load(), 0);
}

TEST(a_budget_under_the_ceiling_lets_the_run_start) {
  Harness h;
  h.agent.outcome = ok("grew it", 1);
  h.usage.spentByProduct[""] = kFreeMonthlyAiNanos - 1;  // one nano left is still room
  TendingService service(h.runs, h.agent, h.tools, h.rooms, h.clock, h.tokens, h.entitlements, /*enabled=*/true);

  TendRun run = service.start(TreeId{"t"}, UserId{"u"}, "u@example.com", "grow the tree");

  CHECK_EQ(run.status, TendStatus::running);
  CHECK_EQ(awaitTerminal(h.runs, run.id).status, TendStatus::done);
}

// A tend writes as its caller, so a tree the caller cannot write starts no agent, spends no
// allowance and reads no stranger's guide into a prompt. Each is a persisted refusal; an absent tree
// and a private one answer alike.
TEST(a_tend_runs_only_on_a_tree_its_caller_can_write) {
  Harness h;
  h.plant("t_public", UserId{"someone"}, Visibility::public_);
  h.plant("t_unlisted", UserId{"someone"}, Visibility::unlisted);
  h.plant("t_private", UserId{"someone"}, Visibility::private_);
  h.plant("t_demo", std::nullopt, Visibility::public_);
  TendingService service(h.runs, h.agent, h.tools, h.rooms, h.clock, h.tokens, h.entitlements, /*enabled=*/true);
  std::vector<WriteCompletion> lines;
  installWriteSink([&](const WriteCompletion& line) { lines.push_back(line); });

  const auto refusalOf = [&](const char* tree) {
    const TendRun run = service.start(TreeId{tree}, UserId{"u"}, "u@example.com", "Add a step");
    CHECK_EQ(run.status, TendStatus::refused);
    CHECK_EQ(h.runs.find(run.id)->refusal, run.refusal);
    return std::string(tendRefusalName(run.refusal));
  };
  CHECK_EQ(refusalOf("t_public"), std::string("not-yours"));
  CHECK_EQ(refusalOf("t_unlisted"), std::string("not-yours"));
  CHECK_EQ(refusalOf("t_demo"), std::string("nobodys-tree"));
  CHECK_EQ(refusalOf("t_private"), std::string("no-such-tree"));
  CHECK_EQ(refusalOf("t_absent"), std::string("no-such-tree"));
  service.stop();
  installWriteSink({});

  CHECK_EQ(h.agent.calls.load(), 0);
  CHECK(lines.empty());
  CHECK_EQ(h.runs.countForUser(UserId{"u"}, 0), 0);
  CHECK_FALSE(h.rooms.isOpen(TreeId{"t_public"}));
}
