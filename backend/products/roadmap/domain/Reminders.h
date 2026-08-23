#pragma once

#include "products/roadmap/domain/Ids.h"
#include "products/roadmap/domain/Tree.h"

#include <cstdint>
#include <string>
#include <vector>

namespace wm {

// The weekly reminder, decided as a PURE function of one user's loaded facts — no clock, no
// database, no mailer. The sweep records the decision verbatim in the ledger.

enum class ReminderOutcome { send, skip };

// `loadFailed` is stamped by the sweep when the facts could not be read at all, so a turn that
// threw still claims its week; `decide` never returns it.
enum class SkipReason { none, tooLate, recentlyActive, inGrace, noReadySteps, loadFailed };

// One step the email may name. `color` is rendered to a fixed hex beside the row, never to user text.
struct ReadyStep {
  NodeId id;
  std::string label;
  NodeColor color = NodeColor::terracotta;
};

// `ready` is already DERIVED by UnlockRules::derive, so this file never re-decides what
// "available" means.
struct TreeReadiness {
  TreeId id;
  std::string title;
  std::uint64_t lastActivityAtMs = 0;
  int total = 0;
  int done = 0;
  std::vector<ReadyStep> ready;
};

// `slotDate` is the LOCAL date of this week's slot and doubles as the ledger's week key;
// `slotInstantMs` is that slot as a UTC instant.
struct ReminderCandidate {
  UserId user;
  std::string slotDate;
  std::uint64_t slotInstantMs = 0;
  std::uint64_t lastActiveAtMs = 0;       // 0 = never seen
  std::uint64_t accountCreatedAtMs = 0;   // when this person signed up; 0 = unknown
  std::vector<TreeReadiness> trees;
};

// No URLs — a base URL is deployment config and never enters the decision. A skipped week fills in
// `readyCount` and nothing else, counted before the gates rather than after them.
struct ReminderContent {
  TreeId treeId;
  std::string treeTitle;
  int total = 0;
  int done = 0;
  int readyCount = 0;            // ready steps in the featured tree, not just the named ones
  std::vector<ReadyStep> steps;  // at most kMaxSteps, in the order the tree gave them
  int otherReadyTrees = 0;
};

struct ReminderDecision {
  ReminderOutcome outcome = ReminderOutcome::skip;
  SkipReason reason = SkipReason::none;
  ReminderContent content;
};

// How many ready steps the mail names before it stops listing and starts counting.
inline constexpr int kMaxSteps = 3;
// Past this much lateness the slot is abandoned rather than served.
inline constexpr std::uint64_t kMaxLatenessMs = 6ull * 60 * 60 * 1000;
// Someone who was just here does not need to be told their tree is waiting.
inline constexpr std::uint64_t kActiveWindowMs = 3ull * 24 * 60 * 60 * 1000;
// The new-account grace, measured on the ACCOUNT's age, not its trees'.
inline constexpr std::uint64_t kGraceMs = 7ull * 24 * 60 * 60 * 1000;
// 1 = Monday .. 7 = Sunday; the minute is counted from local midnight and is confined to
// 08:00–11:00, which dodges DST's nonexistent and ambiguous local times by construction.
inline constexpr int kDefaultSlotDow = 2;
inline constexpr int kDefaultSlotMinute = 9 * 60;
inline constexpr int kEarliestSlotMinute = 8 * 60;
inline constexpr int kLatestSlotMinute = 11 * 60;
// The ceiling on one sweep; with a 15-minute tick, also the fleet's send rate.
inline constexpr int kSweepBatch = 200;

// The whole rule, top to bottom, first match wins.
ReminderDecision decide(const ReminderCandidate& candidate, std::uint64_t nowMs);

// The ledger's `reason` vocabulary. A send reads "ok"; 'load-failed', 'held' and 'send-failed' are
// stamped by the sweep and never returned here.
const char* skipReasonName(SkipReason reason);

// Each is empty when it has nothing to say, and the template then renders nothing.
std::string readyPhrase(int readySteps);
std::string remainderPhrase(int readySteps);
std::string otherTreesPhrase(int otherReadyTrees);

}
