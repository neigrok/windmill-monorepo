#include "products/gym/coach/TurnGate.h"

#include "platform/domain/sync/Identity.h"
#include "products/gym/coach/CoachWords.h"

#include <utility>

namespace wm::gym::coach {

TurnGate::TurnGate(const AbilityCatalog& catalog, Seat seat, std::string turnId)
    : catalog_(catalog), seat_(seat), turnId_(std::move(turnId)) {}

GateVerdict TurnGate::refuse(const char* code, const std::string& ability, const std::string& sentence) {
  ++refusals_[code];
  GateVerdict verdict;
  verdict.code = code;
  verdict.message = ability + ": " + sentence;
  return verdict;
}

GateVerdict TurnGate::admit(const std::string& name, const Json::Value& input, bool stopRequested) {
  const CoachWords& words = CoachWords::shipped();
  const Ability* ability = catalog_.find(name);
  if (!ability || ability->agent == AgentRule::withheld)
    return refuse(gate::notOffered, name, words.refusal(gate::notOffered));
  if (ability->seats == AbilitySeats::bound && seat_ != Seat::bound)
    return refuse(gate::seatRequired, name, words.refusal(gate::seatRequired));
  // The server sends no tool strict, so a model may echo what list_routines read; that is dropped, never refused.
  Json::Value stripped;
  const Json::Value& taken = withoutReadBack(ability->declaration, input, stripped);
  if (const auto broken = schemaViolation(ability->declaration.descriptor["inputSchema"], taken))
    return refuse(gate::invalidInput, name, *broken + ".");
  if (ability->agent == AgentRule::proposes && proposalsHeld_.contains(ability->target))
    return refuse(gate::oneProposal, name,
                  words.refusal(gate::oneProposal, ability->target == ProposalTarget::workout ? "workout" : "routine"));
  if (name == "save_note" && noteHeld_)
    return refuse(gate::oneNote, name, words.refusal(gate::oneNote));
  if (admitted_ >= kMaxAbilityCalls || (ability->cls == AbilityClass::add && adds_ >= kMaxAdds))
    return refuse(gate::volume, name, words.refusal(gate::volume));
  if (stopRequested) return refuse(gate::stopped, name, words.refusal(gate::stopped));

  ++admitted_;
  if (ability->cls == AbilityClass::add) ++adds_;
  if (ability->agent == AgentRule::proposes) proposalsHeld_.insert(ability->target);
  if (name == "save_note") noteHeld_ = true;
  GateVerdict verdict;
  verdict.admitted = true;
  verdict.ability = ability;
  verdict.input = taken;
  if (ability->mintsId()) verdict.input["id"] = sync::SeededId{turnId_, ++ordinal_}.text();
  return verdict;
}

// A phone refuses a call before it commits, so its refusal means nothing was written and the slot is free.
void TurnGate::settle(const Ability& ability, bool ok) {
  if (ok) return;
  if (ability.agent == AgentRule::proposes) proposalsHeld_.erase(ability.target);
  if (ability.name() == "save_note") noteHeld_ = false;
}

}
