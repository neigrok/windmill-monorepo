#pragma once

#include "domain/Ids.h"

#include <json/json.h>

#include <optional>
#include <string>

namespace wm {

// The result of one tool invocation, in MCP's `tools/call` shape. `content` is the array
// of blocks the model reads (we emit a single text block); `structured` mirrors it as
// machine-readable JSON (structuredContent), null when absent. `isError` marks a
// tool-level failure — reported inside the result so the model sees it, not as a
// JSON-RPC transport error.
struct ToolResult {
  Json::Value content{Json::arrayValue};
  Json::Value structured{Json::nullValue};
  bool isError = false;

  static ToolResult text(const std::string& body);
  static ToolResult json(const Json::Value& value);  // text = compact dump, structured = value
  static ToolResult failure(const std::string& message);
};

// The catalog and executor of the server's tools — the one seam the protocol engine
// drives. RoadmapTools is the production implementation; tests substitute a fake.
struct ToolHost {
  virtual ~ToolHost() = default;
  virtual Json::Value listTools() const = 0;  // the `tools/list` "tools" array
  // `caller` is the authenticated account the transport resolved for this request (an OAuth
  // token's user over HTTP, the configured user over stdio) — every edit acts as them.
  virtual ToolResult callTool(const std::string& name, const Json::Value& arguments, const UserId& caller) = 0;
};

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
