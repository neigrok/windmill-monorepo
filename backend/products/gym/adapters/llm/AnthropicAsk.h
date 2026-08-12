#pragma once

#include "platform/adapters/llm/AgentLoop.h"
#include "platform/adapters/llm/AnthropicClient.h"
#include "platform/ports/FailureReporter.h"
#include "products/gym/ports/AskAgent.h"

#include <trantor/net/EventLoopThread.h>

#include <json/json.h>

#include <memory>
#include <string>
#include <vector>

namespace wm::gym {

// GYM'S HALF OF THE LOOP, AND IT IS ONLY TWO THINGS: the prompt, and what the answer is made of.
// The loop itself lives in `platform/adapters/llm/AgentLoop.h` — lifted there in W7 because roadmap's
// tend had written it once already and Ask would have been the second copy. What is left here is the
// part that is genuinely gym's: what Ask IS, the log it opens with, and the bounds a question about
// training runs under.

// The seed: the newest page of the log, welded to the lifter's first turn, exactly as `list_sessions`
// returns it. Exposed for the test that pins it — an Ask that opened on nothing would spend its first
// iteration asking for what every question needs.
Json::Value askOpeningMessages(const std::vector<AskTurn>& turns, const std::string& logDocument);

// One blocking Messages API round-trip: the request body in, the parsed reply out, or nullopt on any
// transport or parse failure. The seam that keeps the loop testable with no network — production
// sends it over HTTPS, a test answers it from a script, and `metered` wraps whichever one it is.
using AskCall = ModelCall;

// Read the log, then drive the tool loop until the model stops asking for tools or the cap is hit.
// The cap is a FAILURE, never a success: an answer the model had not finished forming is a worse
// thing to print under a lifter's log than "Ask didn't answer".
AskAnswer driveAsk(const std::vector<AskTurn>& turns, const ToolCaller& caller, ToolHost& tools,
                   const AskCall& call, const AgentReport& report);

// Hosts Ask against Anthropic's Messages API. Owns a private event-loop thread that carries the
// outbound HTTPS calls, so the calling worker blocks on a future rather than driving a trantor loop
// from a thread that does not own it (see the marshalling note in the .cpp — that race FATALs the
// whole process, intermittently).
class AnthropicAsk : public AskAgent {
public:
  // The reporter is optional (null = report nowhere), so tests and local runs stay silent while
  // production sees every upstream failure Ask only ever says "didn't answer" about. The fuse and the
  // sink are optional the same way. Opus at eight turns is the priciest call per question in the
  // brand, and the question is one tap on a phone.
  explicit AnthropicAsk(std::string apiKey, std::shared_ptr<FailureReporter> failures = nullptr,
                        std::shared_ptr<AiFuse> fuse = nullptr,
                        std::shared_ptr<UsageSink> usage = nullptr);

  bool configured() const override;
  AskAnswer answer(const std::vector<AskTurn>& turns, const ToolCaller& caller,
                   ToolHost& tools) override;

private:
  std::string apiKey_;
  std::shared_ptr<FailureReporter> failures_;
  std::shared_ptr<AiFuse> fuse_;
  std::shared_ptr<UsageSink> usage_;
  trantor::EventLoopThread loop_;
};

}
