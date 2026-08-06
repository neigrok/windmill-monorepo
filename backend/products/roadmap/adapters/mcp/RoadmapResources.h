#pragma once

#include "platform/adapters/mcp/McpServer.h"

#include <string>
#include <vector>

namespace wm {

// Roadmap's paragraph in the `initialize` brief every MCP client reads before its first call. Only
// the paragraph: the server's name and version belong to the SERVER, which speaks for however many
// products are connected, and windmillServerInfo frames this. Three composition roots mount these
// tools (windmill_server, windmill_mcp, windmill_mcp_http) and all three ask here, so what an agent
// connects to cannot differ by transport.
std::string roadmapInstructions();

// The MCP resources the roadmap deployment publishes on connect — today, the quickstart alone. The
// platform engine (McpServer) is content-neutral and takes this vector by injection; this is where the
// roadmap-flavored document lives. Everything it claims must be true of the shipped tools, and the
// self-check in ToolErrorContractTest pins each claim against the real tool catalog.
std::vector<McpResource> roadmapResources();

}
