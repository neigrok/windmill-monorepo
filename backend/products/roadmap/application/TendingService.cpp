#include "products/roadmap/application/TendingService.h"

#include "products/roadmap/application/ScopedToolHost.h"

#include <trantor/utils/Logger.h>

#include <json/json.h>

#include <exception>

namespace wm {

namespace {
// Concurrent tends before they queue. Each run is a blocking agent loop of tens of seconds.
constexpr std::size_t kTendWorkers = 4;
// How many receipts the ledger read returns; the rest of the month lives in the count.
constexpr int kLedgerDepth = 20;

bool blank(const std::string& text) {
  return text.find_first_not_of(" \t\r\n") == std::string::npos;
}
}

TendingService::TendingService(TendRunRepository& runs, PlanAgent& agent, ToolHost& tools,
                               Clock& clock, TokenGenerator& tokens, Entitlements& entitlements,
                               bool enabled)
    : runs_(runs), agent_(agent), tools_(tools), clock_(clock), tokens_(tokens),
      entitlements_(entitlements), enabled_(enabled), workers_(kTendWorkers, "tend-workers") {
  workers_.start();
}

TendRun TendingService::start(const TreeId& tree, const UserId& caller, const std::string& email,
                              const std::string& prompt) {
  // The pipeline the contract pins, top to bottom: an unusable prompt, then a dark feature, then a
  // spent allowance — each a persisted refusal, none of them work.
  if (blank(prompt)) return refuse(tree, caller, prompt, TendRefusal::promptEmpty);
  // Over the cap is the "you pasted a document" case — paste-import is the door for that, not this.
  if (prompt.size() > kMaxTendPromptBytes) return refuse(tree, caller, prompt, TendRefusal::promptTooLong);
  if (!enabled_) return refuse(tree, caller, prompt, TendRefusal::notEnabled);
  if (!allowanceAt(caller, email, clock_.nowMs()).allows())
    return refuse(tree, caller, prompt, TendRefusal::outOfAllowance);
  // The dollar fuse, last because it is the only rung that reads the ledger. It measures what the
  // run count cannot: one sentence that sets a twelve-iteration agent loose costs many times another.
  if (!entitlements_.aiAllowanceFor(caller, email).allows())
    return refuse(tree, caller, prompt, TendRefusal::outOfBudget);

  TendRun run;
  run.id = "tr_" + tokens_.mint().digest.substr(0, 16);  // server-minted, unguessable — the catch-up key
  run.tree = tree;
  run.user = caller;
  run.prompt = prompt;
  run.status = TendStatus::running;
  run.startedAtMs = clock_.nowMs();
  runs_.save(run);  // durable BEFORE we answer, so the returned id is queryable the instant it lands

  // The service is a process-lifetime singleton, so capturing `this` is safe for as long as the pool
  // (a member) lives.
  workers_.getNextLoop()->queueInLoop([this, run] { execute(run); });
  return run;
}

TendRun TendingService::refuse(const TreeId& tree, const UserId& caller, const std::string& prompt,
                               TendRefusal reason) {
  TendRun run;
  run.id = "tr_" + tokens_.mint().digest.substr(0, 16);
  run.tree = tree;
  run.user = caller;
  run.prompt = prompt;
  run.status = TendStatus::refused;
  run.refusal = reason;
  run.startedAtMs = clock_.nowMs();
  run.finishedAtMs = run.startedAtMs;  // a refused run never ran, so it begins and ends at once
  runs_.save(run);
  return run;
}

std::optional<TendRun> TendingService::runFor(const std::string& id, const UserId& caller) {
  const std::optional<TendRun> run = runs_.find(id);
  if (!run || run->user != caller) return std::nullopt;
  return run;
}

TendingSummary TendingService::summaryFor(const UserId& caller, const std::string& email) {
  const std::uint64_t now = clock_.nowMs();  // one instant for the whole read: budget, reset, ledger
  TendingSummary summary;
  summary.enabled = enabled_;
  summary.allowance = allowanceAt(caller, email, now);
  summary.resetAtMs = nextMonthStartMsUtc(now);
  summary.recent = runs_.recentForUser(caller, monthStartMsUtc(now), kLedgerDepth);
  return summary;
}

// Takes the instant so the meter and the ledger are read against one calendar month, never
// straddling a roll between two clock reads.
TendingAllowance TendingService::allowanceAt(const UserId& caller, const std::string& email,
                                             std::uint64_t nowMs) {
  const Plan plan = entitlements_.hasWindmillOne(caller, email) ? Plan::pro : Plan::free;
  const int used = runs_.countForUser(caller, monthStartMsUtc(nowMs));
  return TendingAllowance{plan, monthlyLimitFor(plan), used};
}

void TendingService::execute(TendRun run) {
  // The crash guard: whatever happens below, the worker thread must survive to serve the next run.
  try {
    run.seqFrom = seqOf(run.tree, run.user);  // the tree's head before the agent writes anything
    // An upstream error, a timeout, or a tool that would not settle becomes a `failed` run carrying
    // its diagnostic, never a thrown exception past this point.
    try {
      // The agent is pinned to the tended tree, so an injected node label can't turn a tend into a raid
      // on the caller's other trees.
      ScopedToolHost scoped(tools_, run.tree);
      const AgentOutcome outcome =
          agent_.run(run.prompt, run.tree, run.user, scoped, [](const AgentStep&) {});
      run.status = outcome.ok ? TendStatus::done : TendStatus::failed;
      run.summary = outcome.summary;
      run.detail = outcome.ok ? outcome.detail : outcome.error;  // the error is diagnostic, not a receipt
      run.edits = outcome.edits;
      run.createdNodeIds = scoped.createdNodeIds();  // the authoritative set the receipt's Undo reverts
    } catch (const std::exception& error) {
      run.status = TendStatus::failed;
      run.detail = error.what();
    } catch (...) {
      run.status = TendStatus::failed;
      run.detail = "unknown error";
    }
    run.seqTo = seqOf(run.tree, run.user);  // the far end of the footprint — captured on any outcome
    run.finishedAtMs = clock_.nowMs();
    runs_.save(run);
  } catch (const std::exception& error) {
    LOG_ERROR << "tend run " << run.id << " could not be finalized: " << error.what();
  } catch (...) {
    LOG_ERROR << "tend run " << run.id << " could not be finalized";
  }
}

std::uint64_t TendingService::seqOf(const TreeId& tree, const UserId& caller) {
  // The footprint is read through the very seam the agent edits through: get_tree answers as the
  // caller with the tree's current head seq. A tree the caller can't read (or any tool error) reads
  // as 0 — the run records no footprint rather than leaking one.
  Json::Value args(Json::objectValue);
  args["treeId"] = tree.str();
  const ToolResult result =
      tools_.callTool("get_tree", args, ToolCaller{caller, ToolScope::everything()});
  if (result.isError || !result.payload.isObject()) return 0;
  return result.payload.get("seq", Json::Value::UInt64(0)).asUInt64();
}

}
