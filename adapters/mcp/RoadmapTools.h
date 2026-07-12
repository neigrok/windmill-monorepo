#pragma once

#include "adapters/mcp/McpServer.h"
#include "application/ProgressService.h"
#include "application/RoomRegistry.h"
#include "application/TreeRegistry.h"
#include "domain/Ids.h"
#include "ports/Clock.h"

#include <cstdint>
#include <mutex>

namespace wm {

// The Windmill roadmap surface exposed over MCP. Reads (tree, diagnostics, health,
// progress) and edits (the Class A/B commands + progress) drive the very same application
// core an HTTP or socket client would: edits route through the tree's room — merged,
// sequenced, logged, persisted — so an agent's changes are first-class ops, visible to
// every collaborator on their next load. HLC stamps come from an injected Clock, so the
// tie-break counter and tests stay deterministic.
class RoadmapTools : public ToolHost {
public:
  RoadmapTools(RoomRegistry& registry, ProgressService& progress, Clock& clock, TreeRegistry& treeRegistry);

  Json::Value listTools() const override;
  ToolResult callTool(const std::string& name, const Json::Value& arguments, const UserId& caller) override;

private:
  Hlc nextStamp(const UserId& caller);  // wall-clock ms + a per-ms counter, stamped by the caller

  RoomRegistry& registry_;
  ProgressService& progress_;
  Clock& clock_;
  TreeRegistry& treeRegistry_;  // the caller's roadmap list + delete, repo-direct (no room)
  std::mutex stampMutex_;  // one HLC stream shared across concurrent HTTP worker threads
  std::uint64_t lastMs_ = 0;
  std::uint32_t counter_ = 0;
};

}
