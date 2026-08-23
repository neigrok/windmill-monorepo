#pragma once

#include "products/roadmap/domain/Ids.h"
#include "products/roadmap/domain/Tending.h"
#include "platform/ports/Clock.h"
#include "products/roadmap/ports/PlanAgent.h"
#include "platform/application/Entitlements.h"
#include "products/roadmap/ports/TendRunRepository.h"
#include "platform/ports/TokenGenerator.h"
#include "platform/ports/ToolHost.h"

#include <trantor/net/EventLoopThreadPool.h>

#include <cstdint>
#include <optional>
#include <string>

namespace wm {

// Starts and carries a tend run (domain/Tending.h). A run is a JOB, not a stream: `start` validates,
// persists, and hands the agent loop to a private worker thread, so the request returns while the
// loop carries on server-side. A phone that comes back reads the finished run off `TendRunRepository`.
//
// Runs execute on a small POOL of private trantor event-loop threads, never on a drogon request
// loop. An exception escaping a worker becomes a `failed` run, never a crash.
class TendingService {
public:
  TendingService(TendRunRepository& runs, PlanAgent& agent, ToolHost& tools, Clock& clock,
                 TokenGenerator& tokens, Entitlements& entitlements, bool enabled);

  // Validate → persist → hand off → return. A refusal is persisted as a `refused` run and returned
  // without ever starting work; otherwise a `running` run is persisted and its id returned
  // immediately. `email` is the second binding the plan lookup reads.
  TendRun start(const TreeId& tree, const UserId& caller, const std::string& email,
                const std::string& prompt);

  // Always available to a signed-in caller, even while tending is dark.
  TendingSummary summaryFor(const UserId& caller, const std::string& email);

  // Returns the run only when `caller` owns it — a run that is absent and one that belongs to
  // someone else are the same nullopt, so the id can never be an oracle for another account's runs.
  std::optional<TendRun> runFor(const std::string& id, const UserId& caller);

private:
  TendRun refuse(const TreeId& tree, const UserId& caller, const std::string& prompt,
                 TendRefusal reason);
  TendingAllowance allowanceAt(const UserId& caller, const std::string& email, std::uint64_t nowMs);
  void execute(TendRun run);
  std::uint64_t seqOf(const TreeId& tree, const UserId& caller);

  TendRunRepository& runs_;
  PlanAgent& agent_;
  ToolHost& tools_;
  Clock& clock_;
  TokenGenerator& tokens_;
  Entitlements& entitlements_;
  bool enabled_;
  trantor::EventLoopThreadPool workers_;
};

}
