#pragma once

#include "platform/adapters/mcp/McpServer.h"
#include "products/roadmap/application/ProgressService.h"
#include "products/roadmap/application/RoomRegistry.h"
#include "products/roadmap/application/TreeRegistry.h"
#include "products/roadmap/domain/Ids.h"
#include "platform/ports/Clock.h"
#include "products/roadmap/ports/PresenceBus.h"

namespace wm {

// The Windmill roadmap surface exposed over MCP. Reads (tree, diagnostics, health,
// progress) and edits (the Class A/B commands + progress) drive the very same application
// core an HTTP or socket client would: edits route through the tree's room — merged,
// sequenced, logged, persisted — so an agent's changes are first-class ops, visible to
// every collaborator on their next load. HLC stamps come from the room's own clock (fed
// wall time from the injected Clock), the single stamp domain a socket edit also uses.
class RoadmapTools : public ToolHost {
public:
  RoadmapTools(RoomRegistry& registry, ProgressService& progress, Clock& clock, TreeRegistry& treeRegistry,
               PresenceBus& bus);

  Json::Value listTools() const override;
  ToolResult callTool(const std::string& name, const Json::Value& arguments, const UserId& caller) override;

private:
  // The tool itself. callTool wraps it so every failure — refused, thrown, or raised deeper in
  // the core — reaches the agent naming the tool it came from, exactly once.
  ToolResult dispatch(const std::string& name, const Json::Value& arguments, const UserId& caller);


  RoomRegistry& registry_;
  ProgressService& progress_;
  Clock& clock_;                // wall time for the room's HLC (the room mints, this feeds it)
  TreeRegistry& treeRegistry_;  // the caller's roadmap list + delete, repo-direct (no room)
  PresenceBus& bus_;            // to echo a progress change to the caller's live web sessions
};

}
