#include "products/gym/coach/TurnGate.h"

#include "platform/domain/sync/Identity.h"

#include <utility>

namespace wm::gym::coach {

TurnGate::TurnGate(const AbilityCatalog& catalog, Seat seat, std::string turnId)
    : catalog_(catalog), seat_(seat), turnId_(std::move(turnId)) {}

GateVerdict TurnGate::refuse(const char* code, std::string message) {
  ++refusals_[code];
  GateVerdict verdict;
  verdict.code = code;
  verdict.message = std::move(message);
  return verdict;
}

GateVerdict TurnGate::admit(const std::string& name, const Json::Value& input, bool stopRequested) {
  const Ability* ability = catalog_.find(name);
  if (!ability || ability->agent == AgentRule::withheld)
    return refuse(gate::notOffered, name + ": not an ability Coach may run — use the tools declared for this conversation.");
  if (ability->seats == AbilitySeats::bound && seat_ != Seat::bound)
    return refuse(gate::seatRequired, name + ": needs a signed-in account; tell the lifter to sign in for this.");
  if (const auto broken = schemaViolation(ability->declaration.descriptor["inputSchema"], input))
    return refuse(gate::invalidInput, name + ": " + *broken + ".");
  if (ability->agent == AgentRule::proposes && proposalHeld_)
    return refuse(gate::oneProposal, name + ": you already wrote a proposal this turn; fold both into one document.");
  if (name == "save_note" && noteHeld_)
    return refuse(gate::oneNote, name + ": one note per answer; this answer already saved one.");
  if (admitted_ >= kMaxAbilityCalls || (ability->cls == AbilityClass::add && adds_ >= kMaxAdds))
    return refuse(gate::volume, name + ": this answer has used its ability calls; answer the lifter with what you have.");
  if (stopRequested) return refuse(gate::stopped, name + ": Coach was stopped before this action.");

  ++admitted_;
  if (ability->cls == AbilityClass::add) ++adds_;
  if (ability->agent == AgentRule::proposes) proposalHeld_ = true;
  if (name == "save_note") noteHeld_ = true;
  GateVerdict verdict;
  verdict.admitted = true;
  verdict.ability = ability;
  verdict.input = input;
  if (ability->mintsId()) verdict.input["id"] = sync::SeededId{turnId_, ++ordinal_}.text();
  return verdict;
}

// A phone refuses a call before it commits, so its refusal means nothing was written and the slot is free.
void TurnGate::settle(const Ability& ability, bool ok) {
  if (ok) return;
  if (ability.agent == AgentRule::proposes) proposalHeld_ = false;
  if (ability.name() == "save_note") noteHeld_ = false;
}

}
