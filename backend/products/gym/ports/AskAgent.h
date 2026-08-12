#pragma once

#include "platform/domain/ToolScope.h"
#include "platform/ports/ToolHost.h"

#include <string>
#include <vector>

namespace wm::gym {

// ASK'S HEAD AND MOUTH. ToolHost is its hands, and those already exist — the same seventeen tools an
// agent drives over MCP, executed as the same account, through the same LogService. Putting a chat in
// front of them is running that loop against them ourselves, which is the whole design: one system,
// two doors (ARCHITECTURE §0), never a second way for a model to reach this log.
//
// `answer` BLOCKS until the loop settles — a vendor round trip per iteration on the calling thread.
// It is called from AskService's own worker, never from a request loop, because parking one of the
// four handler threads for a minute is how a training log stops answering for everybody.

// One turn of the conversation. THE SERVER KEEPS NONE OF THIS: the client sends the turns so far on
// every ask, so there is no conversation table, no id to leak, and nothing to garbage-collect. A v1
// that stored the thread would be a second store of a lifter's words with its own delete story.
struct AskTurn {
  bool fromLifter = true;  // false = an answer Ask gave earlier, echoed back for context
  std::string text;
};

// One tool the model reached for, in call order. This is not telemetry — it is drawn under the
// answer. The product's whole stance is that a model reads your log through the same doors you do,
// and a chat that hid the calls would be a chatbot claiming to know things.
struct AskStep {
  std::string tool;
  bool failed = false;
};

struct AskAnswer {
  bool ok = false;
  std::string answer;   // what the lifter reads
  std::string error;    // set when ok is false; diagnostic, never shown raw
  std::vector<AskStep> steps;
  // WHAT THE RUN COST, and it is here because `ok` does not say. A run that hit the iteration cap
  // failed after eight paid vendor turns; a run whose upstream was dead failed after none. The day's
  // ration is given back for the second and not the first — otherwise the cap a lifter is TOLD about
  // never bites on the most expensive runs there are (AskService::ask).
  int modelTurns = 0;
};

struct AskAgent {
  virtual ~AskAgent() = default;
  virtual bool configured() const = 0;
  virtual AskAnswer answer(const std::vector<AskTurn>& turns, const ToolCaller& caller,
                           ToolHost& tools) = 0;
};

}
