#pragma once

#include "platform/adapters/llm/AnthropicClient.h"
#include "platform/ports/FailureReporter.h"
#include "products/gym/ports/CoachAgent.h"

#include <trantor/net/EventLoopThread.h>

#include <json/json.h>

#include <functional>
#include <memory>
#include <optional>
#include <string>

namespace wm::gym {

// THIS IS THE SECOND TOOL LOOP IN THIS REPO AND IT IS NOT A COPY OF THE FIRST, though it is the same
// SHAPE: translate the MCP catalog, iterate, execute every tool_use, feed the results back, treat the
// cap as a failure. What roadmap's `driveAgent` holds that this cannot use is its port — `PlanAgent`
// takes a `TreeId` — and its bootstrap, which reads a whole tree with roadmap's field lists. What
// this holds that roadmap's does not is a CONVERSATION (the client sends the turns so far) and no
// edit counting at all, because the panel's catalog is read-only and there is nothing to count.
//
// So the two are deliberately siblings rather than one shared function. The honest note for whoever
// arrives third: the loop body below and `products/roadmap/adapters/llm/AnthropicAgent.cpp`'s differ
// only in their bootstrap, their finish, and this file's multi-turn seed. A THIRD consumer is what
// earns lifting `agentTools` / `toolResultBlock` / `markCachePoint` / a de-producted `drive` into
// `platform/adapters/llm/`; two is not enough evidence about what the shared shape actually is.

// Translate the MCP tools/list array — each tool carries a JSON-Schema `inputSchema` — into the
// `tools` array the Anthropic Messages API wants (`input_schema`). A faithful rename, not a second
// catalog: gym's declarations stay the single source of truth for what the panel may do.
Json::Value coachTools(const Json::Value& mcpTools);

// The `tool_result` content block for one executed tool, under the matching tool_use id, with
// `is_error` set when the tool itself refused — the model must see the tool failed, not us.
Json::Value coachToolResult(const std::string& toolUseId, const ToolResult& result);

// Where a handled failure is announced: `where` names the step, `detail` the diagnostic. Never
// carries the lifter's question or their log — those are theirs, not an error tracker's.
using CoachReporter = std::function<void(const std::string& where, const std::string& detail)>;

// One blocking Messages API round-trip: the request body in, the parsed reply out, or nullopt on any
// transport or parse failure. The seam that keeps the loop testable with no network — production
// sends it over HTTPS, a test answers it from a script, and `metered` wraps whichever one it is.
// This is `ModelCall` under gym's name: the loop above is roadmap's sibling, and metering is the one
// concern the two genuinely share, so it is the one thing lifted to the platform edge.
using CoachCall = ModelCall;

// The loop, pure but for the two seams it is handed. Reads the one workout under discussion, then
// drives Anthropic's standard tool loop until the model stops asking for tools or the iteration cap
// is hit. The cap is a FAILURE, never a success: an answer the model had not finished forming is a
// worse thing to print under a lifter's log than "the coach didn't answer".
CoachAnswer driveCoach(const SessionId& session, const std::vector<CoachTurn>& turns,
                       const ToolCaller& caller, ToolHost& tools, const CoachCall& call,
                       const CoachReporter& report);

// Hosts the panel against Anthropic's Messages API. Owns a private event-loop thread that carries the
// outbound HTTPS calls, so the calling worker blocks on a future rather than driving a trantor loop
// from a thread that does not own it (see the marshalling note in the .cpp — that race FATALs the
// whole process, intermittently).
class AnthropicCoach : public CoachAgent {
public:
  // The reporter is optional (null = report nowhere), so tests and local runs stay silent while
  // production sees every upstream failure the panel only ever says "didn't answer" about. The fuse
  // and the sink are optional the same way. Opus at six turns is the priciest call per question in
  // the brand, and the question is one tap on a phone.
  explicit AnthropicCoach(std::string apiKey, std::shared_ptr<FailureReporter> failures = nullptr,
                          std::shared_ptr<AiFuse> fuse = nullptr,
                          std::shared_ptr<UsageSink> usage = nullptr);

  bool configured() const override;
  CoachAnswer answer(const SessionId& session, const std::vector<CoachTurn>& turns,
                     const ToolCaller& caller, ToolHost& tools) override;

private:
  std::string apiKey_;
  std::shared_ptr<FailureReporter> failures_;
  std::shared_ptr<AiFuse> fuse_;
  std::shared_ptr<UsageSink> usage_;
  trantor::EventLoopThread loop_;
};

}
