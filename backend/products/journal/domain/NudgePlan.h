#pragma once

#include "products/journal/domain/Page.h"

#include <cstdint>
#include <set>
#include <string>

namespace wm {

// The daily nudge decision — a pure, first-match-wins gate pipeline with nothing to reach a clock,
// a database or a mailer. It mirrors roadmap's Reminders::decide, adapted to Journal: the slot time
// is the DEVICE's (materialised into slotInstantMs; the server never learns the rhythm), and the
// only facts are "did they already write today?" and "are they paused right now?". Note what is
// ABSENT: there is no lapsed/streak branch — the engine never nudges about a gap (canon §7), and
// the mail is one fixed line, so a decision to send carries no copy to get wrong.

enum class NudgeOutcome { send, skip };
// Named NudgeSkipReason, not SkipReason: roadmap's Reminders.h has its own wm::SkipReason, and the
// composition root (main.cpp) includes both this header and Reminders.h, so the two enums would
// collide there without the distinct name.
enum class NudgeSkipReason { none, alreadyWrote, paused, tooLate };

// How late, past the device's chosen instant, we stop bothering: a nudge that missed its moment by
// this much is silence, not a late knock. (Six hours, the reminder engine's tooLate bound.)
constexpr std::uint64_t kNudgeTooLateMs = 6ULL * 60 * 60 * 1000;

struct NudgeCandidate {
  UserId user;
  LocalDate slotDay;              // the LOCAL day the instant belongs to — the skip/dedup key
  std::uint64_t slotInstantMs;    // the device-materialised knock time
  std::uint64_t nowMs;
  bool wroteToday;                // a page already exists for slotDay
  bool paused;                    // paused_until is in the future
};

struct NudgeDecision {
  NudgeOutcome outcome;
  NudgeSkipReason reason;
};

// Gates in order: paused → tooLate → alreadyWrote → else send. Never congratulates, never scolds.
NudgeDecision decide(const NudgeCandidate& candidate);

// The dark-launch gate, checked at SEND time (never at decide time, so a held send is still a
// recorded decision): send only to users on the allowlist while the fleet is dark. Constructed from
// the same (enabled, comma-separated ids) shape the reminder wave uses.
struct NudgeArming {
  bool enabled = false;
  std::set<std::string> allowlist;

  NudgeArming() = default;
  NudgeArming(bool enabled, const std::string& allowlistCsv);
  bool allows(const UserId& user) const;
};

}
