#include "products/roadmap/domain/Reminders.h"

#include <algorithm>
#include <cctype>

namespace wm {

namespace {

// Every window below is a "how long since", and every stamp can in principle arrive from the
// future (a clock that stepped back, a hand-written asOf). Unsigned subtraction would wrap that
// into an eternity, so a stamp ahead of now simply reads as no time passed at all.
std::uint64_t elapsed(std::uint64_t nowMs, std::uint64_t sinceMs) {
  return nowMs > sinceMs ? nowMs - sinceMs : 0;
}

// A withheld week still carries the one number that makes the ledger worth reading: how much was
// waiting for the person we chose not to write to.
ReminderDecision skipped(SkipReason reason, int readyCount) {
  ReminderDecision decision;
  decision.outcome = ReminderOutcome::skip;
  decision.reason = reason;
  decision.content.readyCount = readyCount;
  return decision;
}

// The featured tree is the one the person was working in most recently, among those that
// actually have something ready — so the LATEST sorts greatest. Ties fall to the smaller id so
// the choice never wobbles between two sweeps of the same unchanged account.
bool earlier(const TreeReadiness* a, const TreeReadiness* b) {
  if (a->lastActivityAtMs != b->lastActivityAtMs) return a->lastActivityAtMs < b->lastActivityAtMs;
  return b->id < a->id;
}

}

ReminderDecision decide(const ReminderCandidate& candidate, std::uint64_t nowMs) {
  // First, what is actually waiting. Counted BEFORE any gate, because the ledger's sharpest
  // question is about the people we held back despite having something to tell them.
  std::vector<const TreeReadiness*> waiting;
  for (const TreeReadiness& tree : candidate.trees)
    if (!tree.ready.empty()) waiting.push_back(&tree);
  const TreeReadiness* featured =
      waiting.empty() ? nullptr : *std::max_element(waiting.begin(), waiting.end(), earlier);
  const int readyCount = featured ? static_cast<int>(featured->ready.size()) : 0;

  // Then the gates, first match wins.
  //
  // The box was down through the slot and is only now catching up. Serving a stale slot would
  // mail everyone at whatever hour the process came back, so the week is abandoned instead.
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

  // And finally the mail itself.
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

// The server owns every plural: the templates have no logic, so "1 steps are ready" is a bug only
// this file can prevent.
std::string readyPhrase(int readySteps) {
  return std::to_string(readySteps) + (readySteps == 1 ? " step" : " steps");
}

std::string remainderPhrase(int readySteps) {
  const int remaining = readySteps - kMaxSteps;
  if (remaining <= 0) return "";
  return "…and " + std::to_string(remaining) + " more on this tree";
}

// The unit is named out loud. The old wording counted TREES and read as steps, which is the one
// way a quiet line at the bottom of an email can be actively misleading.
std::string otherTreesPhrase(int otherReadyTrees) {
  if (otherReadyTrees <= 0) return "";
  if (otherReadyTrees == 1) return "1 other tree has steps ready";
  return std::to_string(otherReadyTrees) + " other trees have steps ready";
}

ReminderArming::ReminderArming(bool enabled, const std::string& allowlistCsv) : enabled(enabled) {
  std::size_t start = 0;
  while (start <= allowlistCsv.size()) {
    const std::size_t comma = allowlistCsv.find(',', start);
    std::string id = allowlistCsv.substr(start, comma - start);
    // A uuid pasted from a console arrives with stray spacing and any casing; the column it is
    // compared against is always lowercase, so meet it there.
    id.erase(0, id.find_first_not_of(" \t\r\n"));
    const std::size_t end = id.find_last_not_of(" \t\r\n");
    if (end != std::string::npos) id.resize(end + 1);
    std::transform(id.begin(), id.end(), id.begin(), [](unsigned char c) { return std::tolower(c); });
    if (!id.empty()) allowlist.insert(id);
    if (comma == std::string::npos) break;
    start = comma + 1;
  }
}

bool ReminderArming::allows(const UserId& user) const {
  if (!enabled) return false;
  std::string id = user.str();
  std::transform(id.begin(), id.end(), id.begin(), [](unsigned char c) { return std::tolower(c); });
  return allowlist.count(id) > 0;
}

}
