#pragma once

#include "platform/adapters/llm/AnthropicClient.h"
#include "platform/ports/ToolHost.h"

#include <json/json.h>

#include <functional>
#include <string>
#include <vector>

namespace wm {

// TODO: point products/roadmap/adapters/llm/AnthropicAgent.cpp at this loop (it needs a per-tool callback).

// Translate the MCP tools/list array (`inputSchema`) into the Anthropic Messages `tools` array (`input_schema`).
Json::Value agentToolCatalog(const Json::Value& mcpTools);

// The text a ToolResult carries for the model to read; concatenates every text block it holds.
std::string agentToolText(const ToolResult& result);

// The `tool_result` block for one executed tool, under the matching tool_use id, with `is_error`
// set when the tool itself refused.
Json::Value agentToolResult(const std::string& toolUseId, const ToolResult& result);

// Move the single conversation cache breakpoint to the last block of the newest turn and clear the
// prior one, so exactly two breakpoints ride each request (system + here), under the four-per-request
// cap. A turn whose content is a bare string is promoted to one text block so the marker can sit on it.
void markAgentCachePoint(Json::Value& messages);

// Where a handled failure is announced: `where` names the step, `detail` the diagnostic. Never
// carries user content.
using AgentReport = std::function<void(const std::string& where, const std::string& detail)>;

// `system` is the cached prefix and must be byte-stable across the run — a single interpolated byte
// moves it and the cache never reads. `messages` is the seed conversation, oldest first.
struct AgentLoopSpec {
  std::string model;
  // low | medium | high | xhigh | max, or empty to leave the vendor's default; a model without the knob is not sent one.
  std::string effort;
  // max_tokens covers thinking AND the answer.
  int maxTokens = 8000;
  // Hitting the cap is a failure, never a success.
  int maxIterations = 6;
  std::string system;
  Json::Value messages{Json::arrayValue};
  // Whether a final turn carrying no text is a failure.
  bool answerRequired = true;
  std::string where = "agent.run";
};

// One tool the model reached for, in call order.
struct AgentLoopStep {
  std::string tool;
  bool failed = false;
};

// `ok` false always carries an error and never text. `modelTurns` counts the metered vendor round
// trips this run COMPLETED — a reply came back, so it was billed, whatever the loop made of it.
struct AgentLoopOutcome {
  bool ok = false;
  std::string text;
  std::string error;
  std::vector<AgentLoopStep> steps;
  int modelTurns = 0;
};

// Drive Anthropic's standard tool loop until the model stops asking for tools, fails, or the cap is hit.
AgentLoopOutcome driveAgentLoop(const AgentLoopSpec& spec, ToolHost& tools, const ToolCaller& caller,
                                const ModelCall& call, const AgentReport& report);

}
