#pragma once

#include "platform/adapters/mcp/McpServer.h"

#include <string>
#include <vector>

namespace wm {

// Roadmap's paragraph in the `initialize` brief every MCP client reads before its first call.
// Only the paragraph: the server's name and version belong to the server. Every composition root
// asks here, so what an agent connects to cannot differ by transport.
std::string roadmapInstructions();

// The MCP resources the roadmap deployment publishes on connect. Everything they claim must be
// true of the shipped tools; ToolErrorContractTest pins each claim against the real catalog.
std::vector<McpResource> roadmapResources();

}
