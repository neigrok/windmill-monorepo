#pragma once

#include "platform/adapters/llm/AnthropicClient.h"
#include "platform/ports/ToolHost.h"

#include <json/json.h>

#include <functional>
#include <string>
#include <vector>

namespace wm {

// THE TOOL LOOP, ONCE, BESIDE THE TOOLHOST IT DRIVES.
//
// Two products had written this by hand — roadmap's tend and gym's panel — and the second one said in
// its own header that a third consumer would earn lifting it. W7 lifts it at the second instead, and
// the reason is the seam rather than the count: gym's Ask is the same loop pointed at a different
// catalog, and a loop that lives inside one product is a loop the next product copies. What stays in
// a product is the only two things that are actually its own — THE PROMPT and what it does with the
// answer. Nothing below knows what a tree or a training log is, and no domain code knows an Anthropic
// API exists.
//
// It is deliberately NOT the vendor edge: `ModelCall` (AnthropicClient.h) is the one round trip, and
// `metered` wraps whichever implementation of it a caller passes. So this file has no socket, no key
// and no clock, and a test drives the whole loop from a script.
//
// STILL A SIBLING TODAY: `products/roadmap/adapters/llm/AnthropicAgent.cpp` carries its own copy of
// everything here. Re-pointing it is a mechanical follow-up this wave did not have the territory to
// make (W7 §8), and it needs exactly one addition below — a per-tool callback, because a tend stamps
// each step somewhere a disconnected browser cannot take it, where an answer only ever reads them
// back at the end. That callback is not written until it has a caller.

// Translate the MCP tools/list array — each tool carries a JSON-Schema `inputSchema` — into the
// `tools` array the Anthropic Messages API wants (`input_schema`). A faithful rename, not a second
// catalog: the product's declarations stay the single source of truth for what a run may do.
Json::Value agentToolCatalog(const Json::Value& mcpTools);

// The text a ToolResult carries for the model to read. Our results emit a single text block; this
// concatenates defensively in case a tool ever emits more.
std::string agentToolText(const ToolResult& result);

// The `tool_result` content block for one executed tool, under the matching tool_use id, with
// `is_error` set when the tool itself refused — the model must see the tool failed, not us.
Json::Value agentToolResult(const std::string& toolUseId, const ToolResult& result);

// Move the single conversation cache breakpoint to the last block of the newest turn and clear the
// prior one, so exactly two breakpoints ride each request (system + here) — under the four-per-request
// cap however long the loop runs. A turn whose content is a bare string is promoted to one text block
// so the marker has somewhere to sit; the promotion is stable across iterations, so the bytes it
// caches never shift underneath the cache.
void markAgentCachePoint(Json::Value& messages);

// Where a handled failure is announced: `where` names the step, `detail` the diagnostic. Never
// carries user content — a sentence someone typed, or the sets they lifted, are theirs and not an
// error tracker's.
using AgentReport = std::function<void(const std::string& where, const std::string& detail)>;

// What one run IS, and every bound it runs under. The product fills this in; the loop reads it and
// nothing else.
//
// `system` is the cached prefix and must be byte-stable across the run — a single interpolated byte
// moves it and the cache silently never reads. Everything that varies per run belongs in `messages`,
// which is the seed conversation, oldest first, including whatever document the product read before
// starting (welded to the FIRST turn, so the growing prefix stays cacheable).
struct AgentLoopSpec {
  std::string model;
  // low | medium | high | xhigh | max, or empty to leave the vendor's default. The only honest way to
  // spend less on a reasoning model; a model without the knob simply is not sent one.
  std::string effort;
  // max_tokens covers thinking AND the answer, so it is sized for the loop rather than for the
  // paragraph a person reads.
  int maxTokens = 8000;
  // Hitting the cap is a FAILURE, never a success — half an answer is a different answer, and a
  // half-built tree reported as done is the worst outcome a loop has.
  int maxIterations = 6;
  std::string system;
  Json::Value messages{Json::arrayValue};
  // Whether a final turn carrying no text is a failure. An ANSWER that says nothing is not an answer;
  // a receipt for work that was already done may legitimately be empty.
  bool answerRequired = true;
  // What a report calls this step, so one error tracker can tell two products' loops apart.
  std::string where = "agent.run";
};

// One tool the model reached for, in call order. Not telemetry: gym draws these under the answer,
// because a model that reads your log through the same doors you do should show which doors.
struct AgentLoopStep {
  std::string tool;
  bool failed = false;
};

// What the run produced: the final turn's text, the tools it took to get there, or the one diagnostic
// that says why there is no answer. `ok` false always carries an error and never text.
struct AgentLoopOutcome {
  bool ok = false;
  std::string text;
  std::string error;
  std::vector<AgentLoopStep> steps;
};

// Drive Anthropic's standard tool loop until the model stops asking for tools, fails, or the cap is
// hit. Pure but for the two seams it is handed: the model call and the tools.
AgentLoopOutcome driveAgentLoop(const AgentLoopSpec& spec, ToolHost& tools, const ToolCaller& caller,
                                const ModelCall& call, const AgentReport& report);

}
