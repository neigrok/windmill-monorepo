#pragma once

#include "domain/Ids.h"
#include "domain/Tree.h"

#include <cstdint>
#include <set>
#include <string>
#include <vector>

namespace wm {

// The weekly reminder, decided as a PURE function of one user's loaded facts. Nothing here
// reaches for a clock, a database or a mailer: `decide` takes everything it needs and answers
// with a decision the sweep records verbatim in the ledger. That is what makes the guardrail
// metric a GROUP BY over one table rather than an analytics project — every user who reaches
// the decision point leaves exactly one honest row a week, whether or not a mail went out.
//
// The promise the shipped footer already makes ("You get this once a week, only while a tree
// has steps ready") is the specification. Where a rule could be read two ways, the reading
// that keeps that sentence literally true is the right one.

enum class ReminderOutcome { send, skip };

// `loadFailed` is the one reason `decide` can never reach: it is stamped by the sweep when the
// facts could not be read at all. It exists so that a turn which threw still claims its week —
// a user whose load keeps failing would otherwise keep the oldest pointer in the fleet, sort
// first in every batch, and eventually crowd everyone else out of it.
enum class SkipReason { none, tooLate, recentlyActive, inGrace, noReadySteps, loadFailed };

// One step the email may name: the id the deep link points at, its label, and the hue it
// wears in the tree — rendered to a fixed hex beside the row, never to user text.
struct ReadyStep {
  NodeId id;
  std::string label;
  NodeColor color = NodeColor::terracotta;
};

// One of the caller's trees as the decision sees it. `ready` is already DERIVED — by
// UnlockRules::derive, the very code the UI runs — so this file never re-decides what
// "available" means and the mail can never promise a step the app doesn't show.
struct TreeReadiness {
  TreeId id;
  std::string title;
  std::uint64_t lastActivityAtMs = 0;
  int total = 0;
  int done = 0;
  std::vector<ReadyStep> ready;
};

// Everything decide() is allowed to look at, loaded for ONE user. `slotDate` is the LOCAL date
// of this week's slot (Postgres resolved it; C++ never converts a timezone) and doubles as the
// ledger's week key; `slotInstantMs` is that same slot as a UTC instant.
struct ReminderCandidate {
  UserId user;
  std::string slotDate;
  std::uint64_t slotInstantMs = 0;
  std::uint64_t lastActiveAtMs = 0;       // 0 = never seen
  std::uint64_t accountCreatedAtMs = 0;   // when this person signed up; 0 = unknown
  std::vector<TreeReadiness> trees;
};

// What a sent reminder says: one featured tree, a few of its ready steps, and the count of the
// OTHER trees also waiting. No URLs — a base URL is deployment config and never enters the
// decision. A skipped week fills in `readyCount` and nothing else: the ledger's most useful
// question is "how many people who DID have steps ready did we hold back, and why", and it can
// only answer that if the count is taken before the gates rather than after them.
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
// Past this much lateness the slot is abandoned rather than served: the box was down, and
// losing one reminder beats mailing the whole fleet at 9pm local.
inline constexpr std::uint64_t kMaxLatenessMs = 6ull * 60 * 60 * 1000;
// Someone who was just here does not need to be told their tree is waiting.
inline constexpr std::uint64_t kActiveWindowMs = 3ull * 24 * 60 * 60 * 1000;
// The new-account grace: nothing is mailed until the ACCOUNT is a week old. It measures the
// person's age here, not their trees' — a long-time user who starts a fresh plan is not new, and
// deleting an old tree must not hand anyone a second first week.
inline constexpr std::uint64_t kGraceMs = 7ull * 24 * 60 * 60 * 1000;
// Everyone gets Tuesday 09:00 local until someone asks for a choice. 1 = Monday .. 7 = Sunday;
// the minute is counted from local midnight and is confined to 08:00–11:00, which is how DST's
// nonexistent and ambiguous local times (2–3am) are dodged by construction rather than handled.
inline constexpr int kDefaultSlotDow = 2;
inline constexpr int kDefaultSlotMinute = 9 * 60;
inline constexpr int kEarliestSlotMinute = 8 * 60;
inline constexpr int kLatestSlotMinute = 11 * 60;
// The ceiling on one sweep. The tick is 15 minutes, so this is also the fleet's send rate —
// the reminder path bypasses the magic-link limiter entirely, and this is what replaces it.
inline constexpr int kSweepBatch = 200;

// The whole rule, top to bottom, first match wins.
ReminderDecision decide(const ReminderCandidate& candidate, std::uint64_t nowMs);

// The ledger's `reason` vocabulary. A send reads "ok". 'load-failed' is stamped when decide() was
// never reached at all, and 'held' / 'send-failed' after the claim — none of the three is a
// decision this function can arrive at.
const char* skipReasonName(SkipReason reason);

// The mail's three counted sentences, worded HERE rather than in the vendor adapter, so the
// mailer only binds finished strings and every product sentence stays reachable from a test.
// Each of them is empty when it has nothing to say, and the template simply renders nothing.
//
//   readyPhrase(4)      -> "4 steps"                        (the subject line's count)
//   remainderPhrase(5)  -> "…and 2 more on this tree"       (kMaxSteps of them were named)
//   otherTreesPhrase(2) -> "2 other trees have steps ready"  (TREES, and it says so)
std::string readyPhrase(int readySteps);
std::string remainderPhrase(int readySteps);
std::string otherTreesPhrase(int otherReadyTrees);

// The dark-launch gate. Never consulted at DECIDE time, so the ledger keeps recording honest
// weeks while nobody can receive anything; consulted at SEND time, and again at the settings door,
// so nobody the engine cannot reach is shown a switch or allowed to flip one. Disabled and an
// empty allowlist both mean "nobody" — the owner runs the whole engine against their own account
// first. `enabled` is the FEATURE's state and `allows` is one person's: answering the second
// question with the first is the whole of how a dark rollout starts advertising itself.
struct ReminderArming {
  ReminderArming() = default;
  ReminderArming(bool enabled, const std::string& allowlistCsv);

  bool allows(const UserId& user) const;

  bool enabled = false;
  std::set<std::string> allowlist;
};

}
