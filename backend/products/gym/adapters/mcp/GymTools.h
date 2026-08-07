#pragma once

#include "platform/ports/ToolHost.h"
#include "products/gym/application/LogService.h"

#include <string>

namespace wm::gym {

// The training log exposed over MCP — the surface behind the permission gate, and the second door
// onto the very same application core the phone and the web talk to. Every tool goes through
// LogService and none of them touches the repository: the service owns the two-phase
// load → rule → persist shape, the lazy auto-close, and the write-then-resolve idempotency, and a
// tool that reached past it would be a second copy of rules that exist once.
//
// Two rules make this safe to hand to a model. Every call acts AS the caller — the UserId the
// transport authenticated — so every read and write is owner-scoped exactly as the HTTP handlers
// are, and an agent is never an admin. And the grant was settled above, by CompositeToolHost, which
// is why nothing here asks what a credential may do: by the time a name reaches this class its level
// has been approved, and everything left is an ownership question, which is the only one the core
// knows how to ask.
class GymTools : public ToolHost {
public:
  // `appBaseUrl` is where this deployment answers HTTP, and it is here for one thing: a minted
  // share is a token, and a token is only useful to a coach as a URL. Gym composes that URL because
  // gym owns the route it points at (routes.cpp) — a caller that pasted the path together would be
  // the second place that had to know it.
  GymTools(LogService& log, std::string appBaseUrl);

  std::vector<ToolDeclaration> declareTools() const override;
  ToolResult callTool(const std::string& name, const Json::Value& arguments,
                      const ToolCaller& caller) override;

private:
  // The tool itself, over the account alone. callTool wraps it so every failure — refused, or thrown
  // out of a parse or a repository — reaches the agent naming the tool it came from, exactly once.
  ToolResult dispatch(const std::string& name, const Json::Value& arguments, const UserId& caller);

  LogService& log_;
  std::string appBaseUrl_;
};

}
