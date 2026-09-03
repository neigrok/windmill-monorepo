#pragma once

#include "platform/adapters/mcp/McpServer.h"
#include "products/roadmap/application/ProgressService.h"
#include "products/roadmap/application/RoomRegistry.h"
#include "products/roadmap/application/TreeRegistry.h"
#include "products/roadmap/domain/Ids.h"
#include "platform/ports/Clock.h"
#include "products/roadmap/ports/PresenceBus.h"

namespace wm {

// The roadmap surface exposed over MCP. An edit routes through the tree's room, and its HLC
// stamp comes from the room's own clock — the same stamp domain a socket edit uses.
class RoadmapTools : public ToolHost {
public:
  RoadmapTools(RoomRegistry& registry, ProgressService& progress, Clock& clock, TreeRegistry& treeRegistry,
               PresenceBus& bus);

  std::vector<ToolDeclaration> declareTools() const override;
  ToolResult callTool(const std::string& name, const Json::Value& arguments, const ToolCaller& caller) override;

private:
  // A tool's own level is settled above by CompositeToolHost, so nearly everything here is an
  // ownership question; the scope rides along for the one argument that needs a level beyond the
  // tool's own (import_subgraph's tombstone). callTool wraps it so every failure names its tool.
  ToolResult dispatch(const std::string& name, const Json::Value& arguments, const ToolCaller& caller);


  RoomRegistry& registry_;
  ProgressService& progress_;
  Clock& clock_;
  TreeRegistry& treeRegistry_;
  PresenceBus& bus_;
};

}
