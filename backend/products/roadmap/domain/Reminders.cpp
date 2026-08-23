#include "products/roadmap/domain/Reminders.h"

#include <algorithm>

namespace wm {

namespace {

// A stamp ahead of `now` reads as no time passed at all: unsigned subtraction would wrap it into
// an eternity.
std::uint64_t elapsed(std::uint64_t nowMs, std::uint64_t sinceMs) {
  return nowMs > sinceMs ? nowMs - sinceMs : 0;
}

// A withheld week still carries how much was waiting for the person we chose not to write to.
ReminderDecision skipped(SkipReason reason, int readyCount) {
  ReminderDecision decision;
  decision.outcome = ReminderOutcome::skip;
  decision.reason = reason;
  decision.content.readyCount = readyCount;
  return decision;
}

// The most recent activity sorts greatest. Ties fall to the smaller id so the choice never wobbles.
bool earlier(const TreeReadiness* a, const TreeReadiness* b) {
  if (a->lastActivityAtMs != b->lastActivityAtMs) return a->lastActivityAtMs < b->lastActivityAtMs;
  return b->id < a->id;
}

}

ReminderDecision decide(const ReminderCandidate& candidate, std::uint64_t nowMs) {
  // Counted BEFORE any gate, so the ledger records it even for a week we held back.
  std::vector<const TreeReadiness*> waiting;
  for (const TreeReadiness& tree : candidate.trees)
    if (!tree.ready.empty()) waiting.push_back(&tree);
  const TreeReadiness* featured =
      waiting.empty() ? nullptr : *std::max_element(waiting.begin(), waiting.end(), earlier);
  const int readyCount = featured ? static_cast<int>(featured->ready.size()) : 0;

  // Then the gates, first match wins.
  if (elapsed(nowMs, candidate.slotInstantMs) > kMaxLatenessMs)
    return skipped(SkipReason::tooLate, readyCount);
  // Someone who has been here this week already knows what is waiting.
  if (candidate.lastActiveAtMs != 0 && elapsed(nowMs, candidate.lastActiveAtMs) < kActiveWindowMs)
    return skipped(SkipReason::recentlyActive, readyCount);
  // The new-account grace, measured on the account's own age. An unknown birthday is not grace.
  if (candidate.accountCreatedAtMs != 0 &&
      elapsed(nowMs, candidate.accountCreatedAtMs) < kGraceMs)
    return skipped(SkipReason::inGrace, readyCount);
  // The footer's promise, enforced: no ready step anywhere means no mail this week.
  if (!featured) return skipped(SkipReason::noReadySteps, 0);

  ReminderDecision decision;
  decision.outcome = ReminderOutcome::send;
  decision.reason = SkipReason::none;
  decision.content.treeId = featured->id;
  decision.content.treeTitle = featured->title;
  decision.content.total = featured->total;
  decision.content.done = featured->done;
  decision.content.readyCount = readyCount;
  const std::size_t named = std::min<std::size_t>(kMaxSteps, featured->ready.size());
  decision.content.steps.assign(featured->ready.begin(), featured->ready.begin() + named);
  decision.content.otherReadyTrees = static_cast<int>(waiting.size()) - 1;
  return decision;
}

const char* skipReasonName(SkipReason reason) {
  switch (reason) {
    case SkipReason::none:           return "ok";
    case SkipReason::tooLate:        return "too-late";
    case SkipReason::recentlyActive: return "recently-active";
    case SkipReason::inGrace:        return "in-grace";
    case SkipReason::noReadySteps:   return "no-ready-steps";
    case SkipReason::loadFailed:     return "load-failed";
  }
  return "ok";
}

// The server owns every plural: the templates have no logic.
std::string readyPhrase(int readySteps) {
  return std::to_string(readySteps) + (readySteps == 1 ? " step" : " steps");
}

std::string remainderPhrase(int readySteps) {
  const int remaining = readySteps - kMaxSteps;
  if (remaining <= 0) return "";
  return "…and " + std::to_string(remaining) + " more on this tree";
}

// The unit is named out loud: this counts TREES, not steps.
std::string otherTreesPhrase(int otherReadyTrees) {
  if (otherReadyTrees <= 0) return "";
  if (otherReadyTrees == 1) return "1 other tree has steps ready";
  return std::to_string(otherReadyTrees) + " other trees have steps ready";
}

}
