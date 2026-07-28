#pragma once

#include "platform/adapters/mcp/McpServer.h"

#include <vector>

namespace wm {

// The MCP resources the roadmap deployment publishes on connect — today, the quickstart alone. The
// platform engine (McpServer) is content-neutral and takes this vector by injection; this is where the
// roadmap-flavored document lives. Everything it claims must be true of the shipped tools, and the
// self-check in ToolErrorContractTest pins each claim against the real tool catalog.
std::vector<McpResource> roadmapResources();

}
