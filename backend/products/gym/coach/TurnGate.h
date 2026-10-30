#pragma once

#include "products/gym/coach/AbilityCatalog.h"

#include <json/json.h>

#include <map>
#include <set>
#include <string>

// The gate (gym_coach.md §5): every ability call of a turn passes G-1..G-8, in order, before it
// reaches the tool host. A refused call goes back to the model as an error result carrying its
// code; an admitted call comes out with every record id the server minted (G-7).

namespace wm::gym::coach {

// The codes a refused call carries back to the model. G-6 is the spec's `coach-turn-volume`; the
// others name their rule.
namespace gate {
constexpr const char* notOffered = "not-offered";          // G-1
constexpr const char* seatRequired = "seat-required";      // G-2
constexpr const char* invalidInput = "invalid-input";      // G-3
constexpr const char* oneProposal = "one-proposal";        // G-4
constexpr const char* oneNote = "one-note";                // G-5
constexpr const char* volume = "coach-turn-volume";        // G-6
constexpr const char* stopped = "stopped";                 // G-8
}

struct GateVerdict {
  bool admitted = false;
  const Ability* ability = nullptr;  // the catalog entry an admitted call reaches
  std::string code;                  // refused: its code
  std::string message;               // refused: what the model reads
  Json::Value input;                 // admitted: the call's input, ids minted
};

class TurnGate {
public:
  TurnGate(const AbilityCatalog& catalog, Seat seat, std::string turnId);

  GateVerdict admit(const std::string& name, const Json::Value& input, bool stopRequested);
  // G-4 and G-5 count calls that SUCCEEDED: an admitted proposal (one per target) or note holds its slot until its
  // result says it failed, then the slot opens again.
  void settle(const Ability& ability, bool ok);

  int admittedCalls() const { return admitted_; }
  const std::map<std::string, int>& refusals() const { return refusals_; }

private:
  GateVerdict refuse(const char* code, std::string message);

  const AbilityCatalog& catalog_;
  Seat seat_;
  std::string turnId_;
  int admitted_ = 0;
  int adds_ = 0;
  int ordinal_ = 0;
  std::set<ProposalTarget> proposalsHeld_;
  bool noteHeld_ = false;
  std::map<std::string, int> refusals_;
};

}
