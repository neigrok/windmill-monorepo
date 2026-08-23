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

// Translate the MCP tools/list array into the `tools` array the Anthropic Messages API wants
// (`inputSchema` → `input_schema`). A rename, never a second catalog.
Json::Value agentTools(const Json::Value& mcpTools);

// The `tool_result` content block for one executed tool: the ToolResult's text carried under
// the matching tool_use id, with `is_error` set when the tool itself failed.
Json::Value toolResultBlock(const std::string& toolUseId, const ToolResult& result);

// Whether a tool in this catalog changes the tree. The read-only family is get_/list_/find_/
// describe_; an unrecognised name counts as a change.
bool mutatesTree(const std::string& toolName);

// Where a handled failure is announced: `where` names the step, `detail` the diagnostic. Never
// carries user content — a sentence someone typed is theirs, not an error tracker's.
using AgentReporter = std::function<void(const std::string& where, const std::string& detail)>;

// One blocking Messages API round-trip: the request body in, the parsed reply out, or nullopt
// on any transport or parse failure. `metered` wraps whichever implementation is injected, so
// the loop's spend is counted without the loop knowing.
using MessagesCall = ModelCall;

// The tool-use loop, pure but for the two seams it is handed (the model call and the tools).
// Runs until the model stops asking for tools or the 12-iteration cap is hit; the cap is a
// FAILURE, never a success. Fires `onStep` as each tool lands, and reports handled failures
// through `report`.
AgentOutcome driveAgent(const std::string& prompt, const TreeId& tree, const UserId& caller,
                        ToolHost& tools, const MessagesCall& call,
                        const std::function<void(const AgentStep&)>& onStep,
                        const AgentReporter& report);

// Hosts the agent against Anthropic's Messages API. Owns a private event-loop thread that
// carries the outbound HTTPS calls, so the tending worker blocks on a future rather than parking
// a server request loop.
class AnthropicAgent : public PlanAgent {
public:
  // The reporter, the fuse and the sink are all optional (null = do nothing), so tests and local
  // runs stay silent.
  explicit AnthropicAgent(std::string apiKey, std::shared_ptr<FailureReporter> failures = nullptr,
                          std::shared_ptr<AiFuse> fuse = nullptr,
                          std::shared_ptr<UsageSink> usage = nullptr);

  bool configured() const override;
  AgentOutcome run(const std::string& prompt, const TreeId& tree, const UserId& caller,
                   ToolHost& tools,
                   const std::function<void(const AgentStep&)>& onStep) override;

private:
  // The reporter owns everything it needs: a run settles long after the caller may be gone, so
  // nothing it holds may reach back through the agent.
  AgentReporter reporter() const;

  std::string apiKey_;
  std::shared_ptr<FailureReporter> failures_;
  std::shared_ptr<AiFuse> fuse_;
  std::shared_ptr<UsageSink> usage_;
  trantor::EventLoopThread loop_;
};

}
