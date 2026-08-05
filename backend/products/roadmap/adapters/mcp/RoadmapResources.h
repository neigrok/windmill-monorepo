#pragma once

#include "platform/adapters/mcp/McpServer.h"

#include <vector>

namespace wm {

// What the roadmap deployment answers `initialize` with: the server name, its version, and the
// standing brief every MCP client reads before its first call. Three composition roots mount these
// tools (windmill_server, windmill_mcp, windmill_mcp_http) and all three ask here, so the paragraph
// an agent connects to cannot differ by transport.
ServerInfo roadmapServerInfo();

// The MCP resources the roadmap deployment publishes on connect — today, the quickstart alone. The
// platform engine (McpServer) is content-neutral and takes this vector by injection; this is where the
// roadmap-flavored document lives. Everything it claims must be true of the shipped tools, and the
// self-check in ToolErrorContractTest pins each claim against the real tool catalog.
std::vector<McpResource> roadmapResources();

}
