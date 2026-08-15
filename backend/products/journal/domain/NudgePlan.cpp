#include "products/journal/domain/NudgePlan.h"

namespace wm {

NudgeDecision decide(const NudgeCandidate& candidate) {
  // First match wins, and there is no lapse branch: paused → tooLate → alreadyWrote → send.
  //
  // A pause is a request for silence, honoured before anything else could speak.
  if (candidate.paused) return {NudgeOutcome::skip, NudgeSkipReason::paused};
  // A knock that missed its moment by more than the bound is silence, not a late knock — the box
  // was down and firing now would land at whatever hour it came back.
  if (candidate.nowMs > candidate.slotInstantMs + kNudgeTooLateMs)
    return {NudgeOutcome::skip, NudgeSkipReason::tooLate};
  // Someone who already wrote today has nothing to be nudged toward.
  if (candidate.wroteToday) return {NudgeOutcome::skip, NudgeSkipReason::alreadyWrote};
  // A slot that arrived on time for a page not yet written — the one thing worth a knock.
  return {NudgeOutcome::send, NudgeSkipReason::none};
}

}
