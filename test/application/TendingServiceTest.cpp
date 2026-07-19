#include "application/TendingService.h"

#include "test/application/AuthFakes.h"
#include "test/testing.h"

#include <atomic>
#include <chrono>
#include <functional>
#include <map>
#include <mutex>
#include <optional>
#include <stdexcept>
#include <string>
#include <thread>

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
      if (run.user == user && run.startedAtMs >= sinceMs) ++n;
    return n;
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

}

TEST(a_refusal_never_starts_work_and_is_persisted) {
  Harness h;
  TendingService service(h.runs, h.agent, h.tools, h.clock, h.tokens, /*enabled=*/false);

  TendRun run = service.start(TreeId{"t"}, UserId{"u"}, "add a testing branch under backend");

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
  TendingService service(h.runs, h.agent, h.tools, h.clock, h.tokens, /*enabled=*/true);

  TendRun blank = service.start(TreeId{"t"}, UserId{"u"}, "");
  CHECK_EQ(blank.status, TendStatus::refused);
  CHECK_EQ(blank.refusal, TendRefusal::promptEmpty);

  TendRun whitespace = service.start(TreeId{"t"}, UserId{"u"}, "   \t\n");
  CHECK_EQ(whitespace.status, TendStatus::refused);
  CHECK_EQ(whitespace.refusal, TendRefusal::promptEmpty);

  CHECK_EQ(h.agent.calls.load(), 0);
}

TEST(an_over_length_prompt_refuses_without_work) {
  Harness h;
  TendingService service(h.runs, h.agent, h.tools, h.clock, h.tokens, /*enabled=*/true);

  const std::string tooLong(kMaxTendPromptBytes + 1, 'x');
  TendRun run = service.start(TreeId{"t"}, UserId{"u"}, tooLong);

  CHECK_EQ(run.status, TendStatus::refused);
  CHECK_EQ(run.refusal, TendRefusal::promptTooLong);
  CHECK_EQ(h.agent.calls.load(), 0);
}

TEST(a_spent_allowance_refuses_without_work) {
  Harness h;
  // Seed a full day's worth of runs for this user, all inside the window.
  for (int i = 0; i < 20; ++i) {
    TendRun seeded;
    seeded.id = "seed" + std::to_string(i);
    seeded.user = UserId{"u"};
    seeded.status = TendStatus::done;
    seeded.startedAtMs = h.clock.now;
    h.runs.save(seeded);
  }
  TendingService service(h.runs, h.agent, h.tools, h.clock, h.tokens, /*enabled=*/true);

  TendRun run = service.start(TreeId{"t"}, UserId{"u"}, "one more please");

  CHECK_EQ(run.status, TendStatus::refused);
  CHECK_EQ(run.refusal, TendRefusal::outOfAllowance);
  CHECK_EQ(h.agent.calls.load(), 0);
}

TEST(a_successful_run_persists_done_summary_and_edits) {
  Harness h;
  h.agent.outcome = ok("Added 3 steps under Backend", 3);
  TendingService service(h.runs, h.agent, h.tools, h.clock, h.tokens, /*enabled=*/true);

  TendRun started = service.start(TreeId{"t"}, UserId{"u"}, "add a testing branch under backend");
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
  TendingService service(h.runs, h.agent, h.tools, h.clock, h.tokens, /*enabled=*/true);

  TendRun started = service.start(TreeId{"t"}, UserId{"u"}, "reshape the whole thing");
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
  TendingService service(h.runs, h.agent, h.tools, h.clock, h.tokens, /*enabled=*/true);

  TendRun started = service.start(TreeId{"t"}, UserId{"u"}, "grow it");
  TendRun done = awaitTerminal(h.runs, started.id);

  CHECK_EQ(done.status, TendStatus::done);
  CHECK_EQ(done.seqFrom, static_cast<std::uint64_t>(10));
  CHECK_EQ(done.seqTo, static_cast<std::uint64_t>(13));
}
