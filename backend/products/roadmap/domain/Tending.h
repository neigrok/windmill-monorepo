#pragma once

#include "products/roadmap/domain/Ids.h"

#include <cstdint>
#include <string>
#include <vector>

namespace wm {

// One sentence someone told their tree, and what became of it.
//
// A tend run is a JOB, not a stream: the browser starts one and is free to leave. The run's state
// lives in Postgres, and the agent's edits land through the tree's room and into the op log
// exactly as a person's do, so nothing about a run depends on the client staying connected.
enum class TendStatus {
  running,   // the loop is working; edits may already be landing
  done,      // finished cleanly, `summary` is the receipt
  failed,    // upstream error, timeout, or a tool that would not settle
  refused,   // never started: not enabled, rate limited, or over allowance
};

inline const char* tendStatusName(TendStatus status) {
  switch (status) {
    case TendStatus::running: return "running";
    case TendStatus::done:    return "done";
    case TendStatus::failed:  return "failed";
    case TendStatus::refused: return "refused";
  }
  return "failed";
}

// Why a run never started; `none` is the ordinary case where the run did start. `outOfAllowance`
// is the published monthly RUNS promise; `outOfBudget` is our own dollar fuse behind it. Two
// ceilings measuring two different things, and both are kept.
enum class TendRefusal { none, notEnabled, rateLimited, outOfAllowance, outOfBudget, treeTooLarge, promptEmpty, promptTooLong };

inline const char* tendRefusalName(TendRefusal refusal) {
  switch (refusal) {
    case TendRefusal::none:           return "";
    case TendRefusal::notEnabled:     return "not-enabled";
    case TendRefusal::rateLimited:    return "rate-limited";
    case TendRefusal::outOfAllowance: return "out-of-allowance";
    case TendRefusal::outOfBudget:    return "out-of-budget";
    case TendRefusal::treeTooLarge:   return "tree-too-large";
    case TendRefusal::promptEmpty:    return "prompt-empty";
    case TendRefusal::promptTooLong:  return "prompt-too-long";
  }
  return "";
}

struct TendRun {
  std::string id;
  TreeId tree;
  UserId user;
  std::string prompt;
  TendStatus status = TendStatus::running;
  TendRefusal refusal = TendRefusal::none;
  std::string summary;   // the receipt line: "Added 3 steps under Backend"
  std::string detail;    // the "why", shown only when the receipt is tapped
  int edits = 0;         // tool calls that changed something — 0 means the tree is untouched
  std::vector<std::string> createdNodeIds;  // the steps this run planted — exactly what its Undo reverts
  // The run's footprint in the tree's op log: every op it wrote falls in (seqFrom, seqTo]. This is
  // what makes one sentence one undo.
  std::uint64_t seqFrom = 0;
  std::uint64_t seqTo = 0;
  std::uint64_t startedAtMs = 0;
  std::uint64_t finishedAtMs = 0;
};

// The prompt cap: a sentence rather than a document — pasting a document is what paste-import is for.
constexpr std::size_t kMaxTendPromptBytes = 2000;

// Tending is the one metered thing in Windmill: a plan grants a monthly allowance of runs, and
// everything else is free. A run that never started (a refusal) costs nothing, so only started
// runs spend the allowance (TendRunRepository::countForUser excludes refusals).
enum class Plan { free, pro };

constexpr int kFreeMonthlyTendings = 30;
constexpr int kProMonthlyTendings = 300;

inline int monthlyLimitFor(Plan plan) {
  return plan == Plan::pro ? kProMonthlyTendings : kFreeMonthlyTendings;
}

// This month's tending budget for one account. Pure — the service loads `used` and the plan, then
// reads `allows()`.
struct TendingAllowance {
  Plan plan = Plan::free;
  int limit = kFreeMonthlyTendings;
  int used = 0;

  int remaining() const { return limit > used ? limit - used : 0; }
  bool allows() const { return used < limit; }
};

// What the meter + receipts ledger read (GET /v1/tending). `enabled` is the one signal the client
// gates the composer on; `resetAtMs` is the next calendar month's start.
struct TendingSummary {
  bool enabled = false;
  TendingAllowance allowance;
  std::uint64_t resetAtMs = 0;
  std::vector<TendRun> recent;
};

// The UTC calendar-month the allowance counts within. `monthStartMsUtc` is the window's floor (the
// `sinceMs` the count reads from); `nextMonthStartMsUtc` is the reset instant.
std::uint64_t monthStartMsUtc(std::uint64_t nowMs);
std::uint64_t nextMonthStartMsUtc(std::uint64_t nowMs);

}
