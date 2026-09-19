#pragma once

#include "platform/domain/ToolScope.h"
#include "platform/ports/ToolHost.h"
#include "products/gym/domain/ReadReceipt.h"

#include <string>
#include <functional>
#include <vector>

namespace wm::gym {

// `answer` blocks until the loop settles — one vendor round trip per iteration on the calling
// thread; call it from AskService's worker, never from a request thread.

struct AskImage {
  std::string mediaType;
  std::string data;
};

struct AskControl {
  std::function<void(const std::string&)> text;
  std::function<bool()> continueRun;
};

struct AskTurn {
  bool fromLifter = true;  // false = an answer Ask gave earlier, echoed back for context
  std::string text;
  std::vector<AskImage> images;
};

struct AskAnswer {
  bool ok = false;
  std::string answer;   // what the lifter reads
  std::string error;    // set when ok is false; diagnostic, never shown raw
  std::vector<AskStep> steps;
  // Billed vendor round trips this run took; the day's ration is given back only when it is 0.
  int modelTurns = 0;
};

struct AskAgent {
  virtual ~AskAgent() = default;
  virtual bool configured() const = 0;
  virtual AskAnswer answer(const std::vector<AskTurn>& turns, const ToolCaller& caller,
                           ToolHost& tools) = 0;
  virtual AskAnswer answer(const std::vector<AskTurn>& turns, const ToolCaller& caller,
                           ToolHost& tools, const AskControl& control) {
    return answer(turns, caller, tools);
  }
};

}
