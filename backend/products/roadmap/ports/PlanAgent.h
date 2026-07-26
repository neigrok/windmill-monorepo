#pragma once

#include "products/roadmap/domain/Ids.h"
#include "platform/ports/ToolHost.h"

#include <functional>
#include <string>

namespace wm {

// The agent loop: a sentence and a tree in, a sequence of tool calls out, until the model
// stops asking for tools. It is the head and the mouth; ToolHost is the hands, and those
// already exist — the same 27 tools an external MCP client drives, executed as the same
// caller, through the same rooms and the same op log. Hosting the agent means running this
// loop against them ourselves.
//
// `run` BLOCKS until the loop settles. It is called from the tending worker's own thread,
// never from a request loop — the HTTP handler that starts a run has already answered by
// then (see domain/Tending.h on why a run outlives its browser).

struct AgentStep {
  std::string tool;      // the tool the model asked for
  bool changedTree = false;
  bool failed = false;
  std::string note;      // one line for the ledger, already human-readable
};

struct AgentOutcome {
  bool ok = false;
  std::string summary;   // the receipt: "Added 3 steps under Backend"
  std::string detail;    // the why, on demand
  std::string error;     // set when ok is false; diagnostic, never shown raw to a reader
  int edits = 0;
};

struct PlanAgent {
  virtual ~PlanAgent() = default;
  virtual bool configured() const = 0;

  // `onStep` fires as each tool call lands, so the caller can stamp progress somewhere durable
  // rather than holding it in memory that a disconnect would take with it.
  virtual AgentOutcome run(const std::string& prompt, const TreeId& tree, const UserId& caller,
                           ToolHost& tools,
                           const std::function<void(const AgentStep&)>& onStep) = 0;
};

}
