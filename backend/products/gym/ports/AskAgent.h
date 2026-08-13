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

// One turn of the conversation, as the LOOP sees it. Since W11 the server keeps the thread
// (`domain/Thread.h`) and assembles this vector from what it stored, rather than taking a history
// off the wire — W7 did the latter and said so, and the owner reversed it because a conversation
// about your bench plateau is worth more in six weeks than it was that evening. This shape stays the
// vendor loop's, carrying no instants and no ids: what a thread IS lives in the domain, and what the
// model is shown is a projection of it.
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
