#pragma once

#include "products/journal/domain/Page.h"

#include <cstdint>
#include <string>

namespace wm {

// The daily nudge decision — a pure, first-match-wins gate pipeline with nothing to reach a clock,
// a database or a mailer. The slot time is the DEVICE's (materialised into slotInstantMs; the
// server never learns the rhythm). There is no lapsed/streak branch, and the mail is one fixed
// line, so a decision to send carries no copy to get wrong.

enum class NudgeOutcome { send, skip };
// Named NudgeSkipReason, not SkipReason: roadmap's Reminders.h declares its own wm::SkipReason and
// main.cpp includes both headers.
enum class NudgeSkipReason { none, alreadyWrote, paused, tooLate };

// How late, past the device's chosen instant, we stop bothering: six hours.
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

// Gates in order: paused -> tooLate -> alreadyWrote -> else send.
NudgeDecision decide(const NudgeCandidate& candidate);

}
