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

// Gym's half of the loop: what Ask IS, the log it opens with, and the bounds a question about
// training runs under. The loop itself lives in `platform/adapters/llm/AgentLoop.h`.

// The seed: the newest page of the log, welded to the lifter's first turn, exactly as
// `list_sessions` returns it. Exposed for the test that pins it.
Json::Value askOpeningMessages(const std::vector<AskTurn>& turns, const std::string& logDocument);

// One blocking Messages API round-trip: the request body in, the parsed reply out, or nullopt on any
// transport or parse failure. `metered` wraps whichever implementation is in use.
using AskCall = ModelCall;

// Read the log, then drive the tool loop until the model stops asking for tools or the cap is hit.
// The cap is a FAILURE, never a success.
AskAnswer driveAsk(const std::vector<AskTurn>& turns, const ToolCaller& caller, ToolHost& tools,
                   const AskCall& call, const AgentReport& report);

// Hosts Ask against Anthropic's Messages API. Owns a private event-loop thread carrying the outbound
// HTTPS calls, so the calling worker blocks on a future rather than driving a trantor loop from a
// thread that does not own it (see the marshalling note in the .cpp).
class AnthropicAsk : public AskAgent {
public:
  // The reporter is optional (null = report nowhere), and so are the fuse and the sink.
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
