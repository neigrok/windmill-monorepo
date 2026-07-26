#pragma once

#include "platform/domain/Ids.h"
#include "platform/ports/ToolHost.h"

#include <json/json.h>

#include <optional>
#include <string>

namespace wm {

// Identifies the server in the initialize handshake.
struct ServerInfo {
  std::string name;
  std::string version;
  std::string instructions;
};

// A transport-agnostic MCP engine (JSON-RPC 2.0). `handle` maps one parsed request to its
// reply, or to nothing for a notification. It owns no I/O: a transport (stdio today,
// Streamable HTTP later) parses a frame, hands it here, and ships whatever comes back.
class McpServer {
public:
  McpServer(ToolHost& tools, ServerInfo info);

  std::optional<Json::Value> handle(const Json::Value& message, const UserId& caller = UserId{});

private:
  ToolHost& tools_;
  ServerInfo info_;
};

}
