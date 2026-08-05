#include "products/roadmap/application/TendingService.h"

#include "platform/application/Entitlements.h"
#include "test/platform/Fakes.h"
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

// The durable store, thread-safe because start() writes the `running` row on the calling thread
// and the worker writes the terminal row on its own — the same two-writer shape as production.
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

// The op-log seam the service reads the seq footprint through: get_tree answers with the head.
struct FakeToolHost : ToolHost {
  std::uint64_t seq = 0;
  bool getTreeErrors = false;

  Json::Value listTools() const override { return Json::Value(Json::arrayValue); }
  ToolResult callTool(const std::string& name, const Json::Value&, const UserId&) override {
    if (name != "get_tree") return ToolResult::failure("unexpected tool: " + name);
    if (getTreeErrors) return ToolResult::failure("no such tree");
    Json::Value out(Json::objectValue);
    out["seq"] = Json::Value::UInt64(seq);
    return ToolResult::json(out);
  }
};

// The agent loop stands in for the parallel work: it records the call, runs an optional side
// effect (to advance the fake head), and either returns a scripted outcome or throws.
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

struct Harness {
  FakeTendRunRepository runs;
  FakeToolHost tools;
  FakePlanAgent agent;
  FakeClock clock;
  FakeTokens tokens;
  FakeSubscriptionRepository subs;
  Entitlements entitlements{subs};
};

// The worker finishes asynchronously; spin on the durable row until it leaves `running`.
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

// Seed `count` already-finished runs this month, so the next start sees a partly- or fully-spent
// allowance. A summary rides on `id` so newest-first ordering in the ledger is checkable.
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
  TendingService service(h.runs, h.agent, h.tools, h.clock, h.tokens, h.entitlements, /*enabled=*/false);

  TendRun run = service.start(TreeId{"t"}, UserId{"u"}, "u@example.com","add a testing branch under backend");

  CHECK_EQ(run.status, TendStatus::refused);
  CHECK_EQ(run.refusal, TendRefusal::notEnabled);
  CHECK_EQ(h.agent.calls.load(), 0);  // the worker was never handed the run
  std::optional<TendRun> stored = h.runs.find(run.id);
  CHECK(stored.has_value());
  CHECK_EQ(stored->status, TendStatus::refused);
  CHECK_EQ(stored->refusal, TendRefusal::notEnabled);
  CHECK_EQ(stored->finishedAtMs, stored->startedAtMs);  // a refusal begins and ends at once
}

TEST(an_empty_prompt_refuses_without_work) {
  Harness h;
  TendingService service(h.runs, h.agent, h.tools, h.clock, h.tokens, h.entitlements, /*enabled=*/true);

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
  TendingService service(h.runs, h.agent, h.tools, h.clock, h.tokens, h.entitlements, /*enabled=*/true);

  const std::string tooLong(kMaxTendPromptBytes + 1, 'x');
  TendRun run = service.start(TreeId{"t"}, UserId{"u"}, "u@example.com",tooLong);

  CHECK_EQ(run.status, TendStatus::refused);
  CHECK_EQ(run.refusal, TendRefusal::promptTooLong);
  CHECK_EQ(h.agent.calls.load(), 0);
}

TEST(a_spent_free_allowance_refuses_without_work) {
  Harness h;
  seedDoneRuns(h.runs, UserId{"u"}, kFreeMonthlyTendings, h.clock.now);  // 30 this month, no subscription
  TendingService service(h.runs, h.agent, h.tools, h.clock, h.tokens, h.entitlements, /*enabled=*/true);

  TendRun run = service.start(TreeId{"t"}, UserId{"u"}, "u@example.com", "one more please");

  CHECK_EQ(run.status, TendStatus::refused);
  CHECK_EQ(run.refusal, TendRefusal::outOfAllowance);
  CHECK_EQ(h.agent.calls.load(), 0);
}

TEST(pro_gets_a_larger_allowance_than_free) {
  Harness h;
  h.subs.subscribe(UserId{"u"});
  h.agent.outcome = ok("grew it", 1);
  // The 30 that would exhaust a Free account leave a Pro account with room to spare.
  seedDoneRuns(h.runs, UserId{"u"}, kFreeMonthlyTendings, h.clock.now);
  TendingService service(h.runs, h.agent, h.tools, h.clock, h.tokens, h.entitlements, /*enabled=*/true);

  TendRun allowed = service.start(TreeId{"t"}, UserId{"u"}, "u@example.com", "one more please");
  CHECK_EQ(allowed.status, TendStatus::running);  // Pro's 300 is nowhere near spent at 30
  CHECK_EQ(awaitTerminal(h.runs, allowed.id).status, TendStatus::done);

  // Fill the rest of Pro's 300 and the next one is refused just like Free's was.
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
  TendingService service(h.runs, h.agent, h.tools, h.clock, h.tokens, h.entitlements, /*enabled=*/true);

  const TendingSummary free = service.summaryFor(UserId{"u"}, "u@example.com");
  CHECK(free.enabled);  // this service was built armed; the summary carries the arming signal through
  CHECK_EQ(free.allowance.plan, Plan::free);
  CHECK_EQ(free.allowance.limit, 30);
  CHECK_EQ(free.allowance.used, 3);
  CHECK_EQ(free.allowance.remaining(), 27);
  CHECK_EQ(free.resetAtMs, nextMonthStartMsUtc(h.clock.now));
  CHECK_EQ(free.recent.size(), static_cast<std::size_t>(3));
  CHECK_EQ(free.recent.front().summary, std::string("receipt 2"));  // newest first

  h.subs.subscribe(UserId{"u"});
  const TendingSummary pro = service.summaryFor(UserId{"u"}, "u@example.com");
  CHECK_EQ(pro.allowance.plan, Plan::pro);
  CHECK_EQ(pro.allowance.limit, 300);
  CHECK_EQ(pro.allowance.remaining(), 297);
}

TEST(a_successful_run_persists_done_summary_and_edits) {
  Harness h;
  h.agent.outcome = ok("Added 3 steps under Backend", 3);
  TendingService service(h.runs, h.agent, h.tools, h.clock, h.tokens, h.entitlements, /*enabled=*/true);

  TendRun started = service.start(TreeId{"t"}, UserId{"u"}, "u@example.com","add a testing branch under backend");
  CHECK_EQ(started.status, TendStatus::running);  // the request is answered while the loop runs on

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
  TendingService service(h.runs, h.agent, h.tools, h.clock, h.tokens, h.entitlements, /*enabled=*/true);

  TendRun started = service.start(TreeId{"t"}, UserId{"u"}, "u@example.com","reshape the whole thing");
  TendRun failed = awaitTerminal(h.runs, started.id);

  CHECK_EQ(failed.status, TendStatus::failed);
  CHECK_EQ(failed.detail, std::string("the model would not settle"));  // the diagnostic, kept for triage
  CHECK_EQ(failed.summary, std::string(""));                            // no receipt on a failure
  CHECK_EQ(h.agent.calls.load(), 1);
}

TEST(the_seq_range_is_recorded) {
  Harness h;
  h.tools.seq = 10;                                  // the head before the agent writes anything
  h.agent.onRun = [&h] { h.tools.seq = 13; };        // the agent advances the head by three ops
  h.agent.outcome = ok("Grew the tree", 3);
  TendingService service(h.runs, h.agent, h.tools, h.clock, h.tokens, h.entitlements, /*enabled=*/true);

  TendRun started = service.start(TreeId{"t"}, UserId{"u"}, "u@example.com","grow it");
  TendRun done = awaitTerminal(h.runs, started.id);

  CHECK_EQ(done.status, TendStatus::done);
  CHECK_EQ(done.seqFrom, static_cast<std::uint64_t>(10));
  CHECK_EQ(done.seqTo, static_cast<std::uint64_t>(13));
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

  CHECK_EQ(runs.failOrphanedRuns(), 1);  // only the orphaned running one is reaped
  CHECK_EQ(runs.find("tr_a")->status, TendStatus::failed);
  CHECK_FALSE(runs.find("tr_a")->detail.empty());              // reaped runs carry a diagnostic
  CHECK_EQ(runs.find("tr_b")->status, TendStatus::done);       // a finished run is untouched
  CHECK_EQ(runs.find("tr_b")->summary, std::string("Added 3 steps"));
  CHECK_EQ(runs.find("tr_c")->status, TendStatus::refused);    // a refusal is untouched
  CHECK_EQ(runs.failOrphanedRuns(), 0);                        // idempotent — nothing left running
}

TEST(the_worker_pool_completes_more_runs_than_it_has_threads) {
  Harness h;
  h.agent.outcome = ok("grew it", 1);
  TendingService service(h.runs, h.agent, h.tools, h.clock, h.tokens, h.entitlements, /*enabled=*/true);

  // Eight runs against a four-thread pool: the excess must queue and still finish, never deadlock
  // or drop. Distinct users so the per-account allowance never trips.
  std::vector<std::string> ids;
  for (int i = 0; i < 8; ++i)
    ids.push_back(service.start(TreeId{"t"}, UserId{"u" + std::to_string(i)}, "", "grow it").id);

  for (const std::string& id : ids)
    CHECK_EQ(awaitTerminal(h.runs, id).status, TendStatus::done);
  CHECK_EQ(h.agent.calls.load(), 8);
}
