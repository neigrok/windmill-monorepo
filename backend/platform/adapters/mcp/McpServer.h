#pragma once

#include "platform/domain/Ids.h"
#include "platform/ports/ToolHost.h"

#include <json/json.h>

#include <optional>
#include <string>
#include <vector>

namespace wm {

// Identifies the server in the initialize handshake.
struct ServerInfo {
  std::string name;
  std::string version;
  std::string instructions;
};

// An MCP resource: a document a client may read on connect, addressed by uri. The struct is the
// neutral wire shape; the CONTENT is a product's to supply, and may be empty.
struct McpResource {
  std::string uri;
  std::string name;
  std::string title;
  std::string description;
  std::string mimeType;
  std::string text;
};

// A transport-agnostic MCP engine (JSON-RPC 2.0). `handle` maps one parsed request to its reply, or
// to nothing for a notification. It owns no I/O.
class McpServer {
public:
  McpServer(ToolHost& tools, ServerInfo info, std::vector<McpResource> resources = {});

  // `caller` is the transport's resolved credential — the account AND its grant. It has no default.
  std::optional<Json::Value> handle(const Json::Value& message, const ToolCaller& caller);

private:
  ToolHost& tools_;
  ServerInfo info_;
  std::vector<McpResource> resources_;   // published under resources/list; product-supplied, may be empty
};

}
