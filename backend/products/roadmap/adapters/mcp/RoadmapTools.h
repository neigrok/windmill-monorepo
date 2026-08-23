#pragma once

#include "platform/adapters/mcp/McpServer.h"
#include "products/roadmap/application/ProgressService.h"
#include "products/roadmap/application/RoomRegistry.h"
#include "products/roadmap/application/TreeRegistry.h"
#include "products/roadmap/domain/Ids.h"
#include "platform/ports/Clock.h"
#include "products/roadmap/ports/PresenceBus.h"

namespace wm {

// The roadmap surface exposed over MCP. Reads and edits drive the same application core an HTTP
// or socket client would: an edit routes through the tree's room, and its HLC stamp comes from
// the room's own clock — the single stamp domain a socket edit also uses.
class RoadmapTools : public ToolHost {
public:
  RoadmapTools(RoomRegistry& registry, ProgressService& progress, Clock& clock, TreeRegistry& treeRegistry,
               PresenceBus& bus);

  std::vector<ToolDeclaration> declareTools() const override;
  ToolResult callTool(const std::string& name, const Json::Value& arguments, const ToolCaller& caller) override;

private:
  // The tool itself, over the account alone: the grant is settled above by CompositeToolHost, so
  // everything below is an ownership question. callTool wraps it so every failure names its tool.
  ToolResult dispatch(const std::string& name, const Json::Value& arguments, const UserId& caller);


  RoomRegistry& registry_;
  ProgressService& progress_;
  Clock& clock_;                // wall time for the room's HLC (the room mints, this feeds it)
  TreeRegistry& treeRegistry_;  // the caller's roadmap list + delete, repo-direct (no room)
  PresenceBus& bus_;            // to echo a progress change to the caller's live web sessions
};

}
