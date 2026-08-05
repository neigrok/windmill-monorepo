#include "products/journal/domain/NudgePlan.h"

#include <algorithm>
#include <cctype>

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
    // A uuid pasted from a console arrives with stray spacing and any casing; the id it is compared
    // against is always lowercase, so meet it there. Trimming alone — which this parser did until
    // this wave — makes an uppercase id on the list match nobody, silently, in the one direction an
    // operator cannot see: they name an account, believe it armed, and it never hears a thing.
    id.erase(0, id.find_first_not_of(" \t\r\n"));
    const std::size_t end = id.find_last_not_of(" \t\r\n");
    if (end != std::string::npos) id.resize(end + 1);
    std::transform(id.begin(), id.end(), id.begin(), [](unsigned char c) { return std::tolower(c); });
    if (!id.empty()) allowlist.insert(id);
    if (comma == std::string::npos) break;
    start = comma + 1;
  }
}

// Off ⇒ nobody. On ⇒ only the named, and AN EMPTY ALLOWLIST IS NOBODY. That is the decision, and
// `.env.example` and deploy/docker-compose.yml state it in the same words; if you change it, change
// it in all three or the operator reads one and gets another.
//
// Why nobody, for a channel that is already opt-in: the opt-in is DOWNSTREAM of this answer, not
// independent of it. Journal shows its nudge panel only to a caller this gate allows — the web
// surface gates the door on the `armed` field NudgeApi reports from here — so "they asked for it"
// can never be true of anyone we refuse. This gate is the whole distance between dark and launched.
//
// Two consequences settle it. Empty-means-nobody makes the two variables order-independent —
// neither alone reaches anyone, so there is no way to arm the fleet by forgetting the second one,
// and mail is the one mistake that cannot be walked back. And a dark-launch gate is scaffolding:
// the way it ends is being deleted, not being set to "everybody", so its resting state should not
// double as its terminal state.
bool NudgeArming::allows(const UserId& user) const {
  if (!enabled) return false;
  std::string id = user.str();
  std::transform(id.begin(), id.end(), id.begin(), [](unsigned char c) { return std::tolower(c); });
  return allowlist.count(id) > 0;
}

}
