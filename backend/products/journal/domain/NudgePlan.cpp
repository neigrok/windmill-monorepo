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

NudgeArming::NudgeArming(bool enabled, const std::string& allowlistCsv) : enabled(enabled) {
  std::size_t start = 0;
  while (start <= allowlistCsv.size()) {
    const std::size_t comma = allowlistCsv.find(',', start);
    std::string id = allowlistCsv.substr(start, comma - start);
    // A uuid pasted from a console arrives with stray spacing; the id it is compared against never
    // does, so meet it trimmed.
    id.erase(0, id.find_first_not_of(" \t\r\n"));
    const std::size_t end = id.find_last_not_of(" \t\r\n");
    if (end != std::string::npos) id.resize(end + 1);
    if (!id.empty()) allowlist.insert(id);
    if (comma == std::string::npos) break;
    start = comma + 1;
  }
}

bool NudgeArming::allows(const UserId& user) const {
  // Feature off ⇒ nobody. On + empty list ⇒ everybody (the fleet is armed). On + list ⇒ only the
  // named — the dark-launch cohort while the rest of the fleet stays dark.
  return enabled && (allowlist.empty() || allowlist.count(user.str()) > 0);
}

}
