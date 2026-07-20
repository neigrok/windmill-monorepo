#pragma once

#include "domain/Ids.h"
#include "domain/Tending.h"
#include "ports/Clock.h"
#include "ports/PlanAgent.h"
#include "ports/TendRunRepository.h"
#include "ports/TokenGenerator.h"
#include "ports/ToolHost.h"

#include <trantor/net/EventLoopThreadPool.h>

#include <cstdint>
#include <optional>
#include <string>

namespace wm {

// Starts and carries a tend run (domain/Tending.h). The one architectural fact this class exists
// to honor: a run is a JOB, not a stream. `start` answers the HTTP handler at once with a durable
// run — it validates, persists, and hands the agent loop to a private worker thread — so the
// request returns while the loop carries on server-side. The browser is then free to leave; the
// run's state lives in Postgres and the edits land through the tree's rooms, so a phone that comes
// back reads the finished run off `TendRunRepository`, never a half-done tree.
//
// The runs execute on a small POOL of private trantor event-loop threads (each blocking agent loop
// runs tens of seconds, so a single thread would serialize concurrent tends behind one another),
// never on a drogon request loop. Runs round-robin across the pool; excess beyond the pool queue
// behind it — a bound the per-account allowance and the fleet rate limits already keep small. An
// exception escaping a worker becomes a `failed` run, never a crash.
class TendingService {
public:
  TendingService(TendRunRepository& runs, PlanAgent& agent, ToolHost& tools, Clock& clock,
                 TokenGenerator& tokens, bool enabled);

  // Validate → persist → hand off → return. A refusal (not enabled, over allowance, or an unusable
  // prompt) is persisted as a `refused` run and returned without ever starting work — the client
  // renders it as a quiet face, not an error. Otherwise a `running` run is persisted and its id
  // returned immediately, with the loop already queued on the worker thread.
  TendRun start(const TreeId& tree, const UserId& caller, const std::string& prompt);

  // The catch-up read a returning phone makes, long after its socket died. Returns the run only
  // when `caller` owns it — a run that is absent and one that belongs to someone else are the same
  // nullopt, so the id can never be an oracle for another account's runs.
  std::optional<TendRun> runFor(const std::string& id, const UserId& caller);

private:
  TendRun refuse(const TreeId& tree, const UserId& caller, const std::string& prompt,
                 TendRefusal reason);
  bool overAllowance(const UserId& caller);
  void execute(TendRun run);
  std::uint64_t seqOf(const TreeId& tree, const UserId& caller);

  TendRunRepository& runs_;
  PlanAgent& agent_;
  ToolHost& tools_;
  Clock& clock_;
  TokenGenerator& tokens_;
  bool enabled_;
  trantor::EventLoopThreadPool workers_;
};

}
