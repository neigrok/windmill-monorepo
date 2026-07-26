#pragma once

#include "ports/FailureReporter.h"
#include "ports/PlanAgent.h"

#include <trantor/net/EventLoopThread.h>

#include <json/json.h>

#include <functional>
#include <memory>
#include <optional>
#include <string>

namespace wm {

// The pure, offline-testable parts of the tend loop live as free functions, so a test can
// exercise the translation, the tool_result shape, and the classification without a socket.

// Translate the MCP tools/list array — each tool carries a JSON-Schema `inputSchema` — into
// the `tools` array the Anthropic Messages API wants (`input_schema`). A faithful rename, not
// a second catalog: the MCP descriptors stay the single source of truth for the tool surface.
Json::Value agentTools(const Json::Value& mcpTools);

// The `tool_result` content block for one executed tool: the ToolResult's text carried under
// the matching tool_use id, with `is_error` set when the tool itself failed.
Json::Value toolResultBlock(const std::string& toolUseId, const ToolResult& result);

// Whether a tool in this catalog changes the tree. The read-only family is get_/list_/find_/
// describe_; everything else mutates. Conservative by construction — an unrecognised name is
// treated as a change, because reporting a half-built tree as done is the worst outcome here.
bool mutatesTree(const std::string& toolName);

// Where a handled failure is announced: `where` names the step, `detail` the diagnostic. Never
// carries user content — a sentence someone typed is theirs, not an error tracker's.
using AgentReporter = std::function<void(const std::string& where, const std::string& detail)>;

// One blocking Messages API round-trip: the request body in, the parsed reply out, or nullopt
// on any transport or parse failure. This is the seam that keeps the loop testable without a
// network — production sends it over HTTPS, a test answers it from a script.
using MessagesCall = std::function<std::optional<Json::Value>(const Json::Value& request)>;

// The tool-use loop, pure but for the two seams it is handed (the model call and the tools).
// Reads the tree, then drives Anthropic's standard loop until the model stops asking for tools
// or the 12-iteration cap is hit. The cap is a FAILURE, never a success — a half-built tree
// reported as done is the worst outcome available. Fires `onStep` as each tool lands (not
// batched), and reports every handled failure through `report`.
AgentOutcome driveAgent(const std::string& prompt, const TreeId& tree, const UserId& caller,
                        ToolHost& tools, const MessagesCall& call,
                        const std::function<void(const AgentStep&)>& onStep,
                        const AgentReporter& report);

// Hosts the agent against Anthropic's Messages API. Owns a private event-loop thread that
// carries the outbound HTTPS calls, so the tending worker's thread blocks on a future rather
// than parking a server request loop (see ports/PlanAgent.h — a run outlives its browser).
class AnthropicAgent : public PlanAgent {
public:
  // The reporter is optional (null = report nowhere), so tests and local runs stay silent while
  // production sees every upstream failure the client only ever hears as a quiet "failed".
  explicit AnthropicAgent(std::string apiKey, std::shared_ptr<FailureReporter> failures = nullptr);

  bool configured() const override;
  AgentOutcome run(const std::string& prompt, const TreeId& tree, const UserId& caller,
                   ToolHost& tools,
                   const std::function<void(const AgentStep&)>& onStep) override;

private:
  // Hands out a reporter that owns everything it needs. A run settles long after the caller may
  // be gone, so nothing it holds is allowed to reach back through the agent to get out.
  AgentReporter reporter() const;

  std::string apiKey_;
  std::shared_ptr<FailureReporter> failures_;
  trantor::EventLoopThread loop_;
};

}
