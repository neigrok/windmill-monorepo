#include "products/journal/domain/NudgePlan.h"

namespace wm {

NudgeDecision decide(const NudgeCandidate& candidate) {
  if (candidate.paused) return {NudgeOutcome::skip, NudgeSkipReason::paused};
  if (candidate.nowMs > candidate.slotInstantMs + kNudgeTooLateMs)
    return {NudgeOutcome::skip, NudgeSkipReason::tooLate};
  if (candidate.wroteToday) return {NudgeOutcome::skip, NudgeSkipReason::alreadyWrote};
  return {NudgeOutcome::send, NudgeSkipReason::none};
}

}
