#pragma once

#include "platform/ports/ToolHost.h"
#include "products/gym/coach/AbilityCatalog.h"
#include "products/gym/coach/Turn.h"
#include "products/gym/coach/TurnGate.h"

#include <chrono>
#include <map>
#include <string>
#include <vector>

// A phone turn's tool host (gym_coach.md D-7, §4.3): the gate in front, the phone's replica
// executor behind, reached as one `calls` batch per model round over the turn's stream. By ruling
// R2 the share abilities of a `bound` seat run on the server executor instead, and their results
// join the batch's in call order.

namespace wm::gym::coach {

class PhoneToolHost : public ToolHost {
public:
  // `server` is the server executor (GymTools); null when the seat has no account to run it as.
  PhoneToolHost(const AbilityCatalog& catalog, Turn& turn, ToolHost* server,
                std::chrono::milliseconds resultTimeout = kCallResultTimeout);

  std::vector<ToolDeclaration> declareTools() const override;
  ToolResult callTool(const std::string& name, const Json::Value& arguments, const ToolCaller& caller) override;
  std::vector<ToolResult> callTools(const std::vector<ToolCall>& calls, const ToolCaller& caller) override;

  // A batch went unanswered for CALL_RESULT_TIMEOUT: the turn ends `interrupted` (§4.3).
  bool interrupted() const { return interrupted_; }
  const std::map<std::string, int>& callsByName() const { return callsByName_; }
  const std::map<std::string, int>& refusalsByCode() const { return gate_.refusals(); }
  int batches() const { return batches_; }

private:
  const AbilityCatalog& catalog_;
  Turn& turn_;
  ToolHost* server_;
  std::chrono::milliseconds resultTimeout_;
  TurnGate gate_;
  bool interrupted_ = false;
  int batches_ = 0;
  std::map<std::string, int> callsByName_;
};

}
