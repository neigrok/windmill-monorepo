#pragma once

#include "platform/domain/ToolScope.h"
#include "platform/ports/ToolHost.h"
#include "products/gym/domain/Training.h"

#include <string>
#include <vector>

namespace wm::gym {

// The panel's head and mouth. ToolHost is its hands, and those already exist — the same fifteen
// tools an agent drives over MCP, executed as the same account, through the same LogService. Putting
// a panel in front of them is running this loop against them ourselves, which is the whole design:
// one system, two doors (ARCHITECTURE §0), never a second way for a model to reach this log.
//
// `answer` BLOCKS until the loop settles — a vendor round trip per iteration on the calling thread.
// It is called from CoachService's own worker, never from a request loop, because parking one of the
// four handler threads for a minute is how a training log stops answering for everybody.

// One turn of the panel's conversation. The SERVER KEEPS NONE OF THIS: the client sends the turns so
// far on every ask, so there is no conversation table, no id to leak, and nothing to garbage-collect.
// A v1 that stored the thread would be a second store of a lifter's words with its own delete story.
struct CoachTurn {
  bool fromLifter = true;  // false = a reply this panel gave earlier, echoed back for context
  std::string text;
};

// One tool the model reached for, in call order. This is not telemetry — it is drawn on the panel.
// The product's whole stance is that a model reads your log through the same doors you do, and a
// panel that hid the calls would be a chatbot claiming to know things.
struct CoachStep {
  std::string tool;
  bool failed = false;
};

struct CoachAnswer {
  bool ok = false;
  std::string answer;   // what the lifter reads
  std::string error;    // set when ok is false; diagnostic, never shown raw
  std::vector<CoachStep> steps;
};

struct CoachAgent {
  virtual ~CoachAgent() = default;
  virtual bool configured() const = 0;
  virtual CoachAnswer answer(const SessionId& session, const std::vector<CoachTurn>& turns,
                             const ToolCaller& caller, ToolHost& tools) = 0;
};

}
