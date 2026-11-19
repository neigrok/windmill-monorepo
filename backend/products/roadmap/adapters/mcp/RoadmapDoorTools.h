#pragma once

#include "platform/ports/Clock.h"
#include "platform/ports/TokenGenerator.h"
#include "platform/ports/ToolHost.h"
#include "products/roadmap/application/RoadmapDoor.h"

#include <string>
#include <vector>

namespace wm {

// Roadmap's MCP tools on the sync engine (Roadmap on the sync engine §7): every write is a call of the door, the tree's
// edits planned by roadmap's domain in a room built from the tree scope's rows under its lock, and every read reads the
// typed tables through the read domain (domain/read/), so a step follows through absent steps (D-5). It declares
// RoadmapTools' catalog with an optional `requestId` on every write, and answers in its words. `main.cpp` registers it
// in place of RoadmapTools where ROADMAP_ENGINE_ENABLED serves roadmap's scopes.
class RoadmapDoorTools : public ToolHost {
public:
  RoadmapDoorTools(roadmap::RoadmapDoor& door, TokenGenerator& tokens, Clock& clock, std::string appOrigin);

  std::vector<ToolDeclaration> declareTools() const override;
  ToolResult callTool(const std::string& name, const Json::Value& arguments, const ToolCaller& caller) override;

private:
  ToolResult dispatch(const std::string& name, const Json::Value& arguments, const ToolCaller& caller);

  roadmap::RoadmapDoor& door_;
  TokenGenerator& tokens_;
  Clock& clock_;
  std::string appOrigin_;
};

}
