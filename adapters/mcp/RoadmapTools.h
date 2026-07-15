#pragma once

#include "adapters/mcp/McpServer.h"
#include "application/ProgressService.h"
#include "application/RoomRegistry.h"
#include "application/TreeRegistry.h"
#include "domain/Ids.h"
#include "ports/Clock.h"
#include "ports/PresenceBus.h"

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
  RoomRegistry& registry_;
  ProgressService& progress_;
  Clock& clock_;                // wall time for the room's HLC (the room mints, this feeds it)
  TreeRegistry& treeRegistry_;  // the caller's roadmap list + delete, repo-direct (no room)
  PresenceBus& bus_;            // to echo a progress change to the caller's live web sessions
};

}
