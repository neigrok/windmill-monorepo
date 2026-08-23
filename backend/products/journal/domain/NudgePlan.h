#pragma once

#include "products/journal/domain/Page.h"

#include <cstdint>
#include <string>

namespace wm {

enum class NudgeOutcome { send, skip };
// Not SkipReason: roadmap's Reminders.h declares its own wm::SkipReason and main.cpp includes both.
enum class NudgeSkipReason { none, alreadyWrote, paused, tooLate };

// How late past the device's chosen instant a nudge is still sent.
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

NudgeDecision decide(const NudgeCandidate& candidate);

}
