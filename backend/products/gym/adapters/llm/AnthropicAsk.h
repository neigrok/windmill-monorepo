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

// The notes and the newest page of the log, welded to the lifter's first turn in that order, exactly
// as `list_notes` and `list_sessions` return them. Never in the system prompt: that is the cached
// prefix, and one interpolated byte would move it on every request.
Json::Value askOpeningMessages(const std::vector<AskTurn>& turns, const std::string& notesDocument,
                               const std::string& logDocument);

// One blocking Messages API round-trip: request body in, parsed reply out, nullopt on any transport
// or parse failure.
using AskCall = ModelCall;

// Reads the log and the notes, then drives the tool loop until the model stops asking for tools or
// the cap is hit. The cap is a failure, never a success. The notes read is the first step of every
// answer; the log read is accounted for by the read receipt instead.
AskAnswer driveAsk(const std::vector<AskTurn>& turns, const ToolCaller& caller, ToolHost& tools,
                   const AskCall& call, const AgentReport& report);

// Owns a private event-loop thread carrying the outbound HTTPS calls; the calling worker blocks on a
// future rather than driving a trantor loop it does not own.
class AnthropicAsk : public AskAgent {
public:
  // Reporter, fuse and sink are all optional; null reports nowhere.
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
