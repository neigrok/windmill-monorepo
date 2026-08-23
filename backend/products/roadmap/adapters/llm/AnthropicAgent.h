#pragma once

#include "platform/adapters/llm/AnthropicClient.h"
#include "platform/ports/FailureReporter.h"
#include "products/roadmap/ports/PlanAgent.h"

#include <trantor/net/EventLoopThread.h>

#include <json/json.h>

#include <functional>
#include <memory>
#include <optional>
#include <string>

namespace wm {

// Renames the MCP tools/list array into the `tools` array the Messages API wants
// (`inputSchema` → `input_schema`).
Json::Value agentTools(const Json::Value& mcpTools);

Json::Value toolResultBlock(const std::string& toolUseId, const ToolResult& result);

// The read-only family is get_/list_/find_; an unrecognised name counts as a change.
bool mutatesTree(const std::string& toolName);

// `where` names the step, `detail` the diagnostic. Never carries user content.
using AgentReporter = std::function<void(const std::string& where, const std::string& detail)>;

// One blocking Messages API round-trip, or nullopt on any transport or parse failure.
using MessagesCall = ModelCall;

// The tool-use loop, pure but for the two seams it is handed (the model call and the tools).
// Runs until the model stops asking for tools or the iteration cap is hit; the cap is a FAILURE.
AgentOutcome driveAgent(const std::string& prompt, const TreeId& tree, const UserId& caller,
                        ToolHost& tools, const MessagesCall& call,
                        const std::function<void(const AgentStep&)>& onStep,
                        const AgentReporter& report);

// Hosts the agent against Anthropic's Messages API on a private event-loop thread, so the
// tending worker blocks on a future rather than parking a server request loop.
class AnthropicAgent : public PlanAgent {
public:
  // The reporter, the fuse and the sink are optional (null = do nothing).
  explicit AnthropicAgent(std::string apiKey, std::shared_ptr<FailureReporter> failures = nullptr,
                          std::shared_ptr<AiFuse> fuse = nullptr,
                          std::shared_ptr<UsageSink> usage = nullptr);

  bool configured() const override;
  AgentOutcome run(const std::string& prompt, const TreeId& tree, const UserId& caller,
                   ToolHost& tools,
                   const std::function<void(const AgentStep&)>& onStep) override;

private:
  // The reporter owns everything it needs: a run settles long after the caller may be gone.
  AgentReporter reporter() const;

  std::string apiKey_;
  std::shared_ptr<FailureReporter> failures_;
  std::shared_ptr<AiFuse> fuse_;
  std::shared_ptr<UsageSink> usage_;
  trantor::EventLoopThread loop_;
};

}
