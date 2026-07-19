#include "application/TendingService.h"

#include <trantor/utils/Logger.h>

#include <json/json.h>

#include <exception>

namespace wm {

namespace {
// An agent loop is far more expensive than a paste-compose, so the per-user allowance is the real
// brake on a single account (the per-IP and global ceilings in infra guard the fleet). One day's
// worth of sentences is generous for the mobile moment this feature serves and cheap to count.
constexpr std::uint64_t kAllowanceWindowMs = 24ull * 60 * 60 * 1000;
constexpr int kAllowancePerDay = 20;

bool blank(const std::string& text) {
  return text.find_first_not_of(" \t\r\n") == std::string::npos;
}
}

TendingService::TendingService(TendRunRepository& runs, PlanAgent& agent, ToolHost& tools,
                               Clock& clock, TokenGenerator& tokens, bool enabled)
    : runs_(runs), agent_(agent), tools_(tools), clock_(clock), tokens_(tokens), enabled_(enabled) {
  worker_.run();
}

TendRun TendingService::start(const TreeId& tree, const UserId& caller, const std::string& prompt) {
  // The pipeline the contract pins, top to bottom: an unusable prompt, then a dark feature, then a
  // spent allowance — each a persisted refusal the client wears as a quiet face, none of them work.
  if (blank(prompt)) return refuse(tree, caller, prompt, TendRefusal::promptEmpty);
  // Over the cap is the "you pasted a document" case — paste-import is the door for that, not this.
  // The refusal set has no length-specific reason, so it wears the same prompt face.
  if (prompt.size() > kMaxTendPromptBytes) return refuse(tree, caller, prompt, TendRefusal::promptEmpty);
  if (!enabled_) return refuse(tree, caller, prompt, TendRefusal::notEnabled);
  if (overAllowance(caller)) return refuse(tree, caller, prompt, TendRefusal::outOfAllowance);

  TendRun run;
  run.id = "tr_" + tokens_.mint().digest.substr(0, 16);  // server-minted, unguessable — the catch-up key
  run.tree = tree;
  run.user = caller;
  run.prompt = prompt;
  run.status = TendStatus::running;
  run.startedAtMs = clock_.nowMs();
  runs_.save(run);  // durable BEFORE we answer, so the returned id is queryable the instant it lands

  // Hand the blocking loop to the private worker thread and return. The service is a process-lifetime
  // singleton, so capturing `this` is safe for as long as the worker (a member) lives.
  worker_.getLoop()->queueInLoop([this, run] { execute(run); });
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
  if (!run || run->user != caller) return std::nullopt;  // absent and not-yours are one answer
  return run;
}

bool TendingService::overAllowance(const UserId& caller) {
  const std::uint64_t now = clock_.nowMs();
  const std::uint64_t since = now > kAllowanceWindowMs ? now - kAllowanceWindowMs : 0;
  return runs_.countForUser(caller, since) >= kAllowancePerDay;
}

void TendingService::execute(TendRun run) {
  // The crash guard: whatever happens below, the worker thread must survive to serve the next run.
  try {
    run.seqFrom = seqOf(run.tree, run.user);  // the tree's head before the agent writes anything
    // The failed-run guard: an upstream error, a timeout, or a tool that would not settle becomes a
    // `failed` run carrying its diagnostic, never a thrown exception past this point.
    try {
      const AgentOutcome outcome =
          agent_.run(run.prompt, run.tree, run.user, tools_, [](const AgentStep&) {});
      run.status = outcome.ok ? TendStatus::done : TendStatus::failed;
      run.summary = outcome.summary;
      run.detail = outcome.ok ? outcome.detail : outcome.error;  // the error is diagnostic, not a receipt
      run.edits = outcome.edits;
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
  // The run's footprint in the op log is read through the very seam the agent edits through:
  // get_tree answers as the caller with the tree's current head seq. A tree the caller can't read
  // (or any tool error) reads as 0 — the run simply records no footprint rather than leaking one.
  Json::Value args(Json::objectValue);
  args["treeId"] = tree.str();
  const ToolResult result = tools_.callTool("get_tree", args, caller);
  if (result.isError || !result.structured.isObject()) return 0;
  return result.structured.get("seq", Json::Value::UInt64(0)).asUInt64();
}

}
