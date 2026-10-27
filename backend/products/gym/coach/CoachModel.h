#pragma once

#include "platform/adapters/llm/AnthropicClient.h"
#include "products/gym/coach/Turn.h"

#include <functional>
#include <string>

// The vendor edge of a turn (gym_coach.md §4.2, §7.1): one metered model call per round, admitted
// against the seat's USD allowance before dispatch and settled after. Tests substitute a scripted
// model; the server wires the Anthropic one.

namespace wm::gym::coach {

struct CoachModel {
  virtual ~CoachModel() = default;
  virtual bool configured() const = 0;
  // The call a turn's loop invokes once per round. `text` receives the visible text of the reply
  // in flight, whole so far; `continueRun` is asked while it streams; `refused` names the code of
  // a round the allowance, the fuse or the vendor refused, and the loop then ends the turn on it.
  virtual ModelCall open(const TurnPrincipal& principal, const std::string& turnId,
                         std::function<void(const std::string&)> text, std::function<bool()> continueRun,
                         std::function<void(const std::string&)> refused) = 0;
};

}
