#pragma once

#include "adapters/mcp/McpServer.h"

#include <drogon/HttpRequest.h>
#include <drogon/HttpResponse.h>

#include <chrono>
#include <functional>
#include <map>
#include <mutex>
#include <set>
#include <string>

namespace wm {

using McpHttpCallback = std::function<void(const drogon::HttpResponsePtr&)>;

// Parse a comma-separated allow-list (e.g. WINDMILL_MCP_ALLOWED_ORIGINS), trimming spaces.
std::set<std::string> parseOriginList(const std::string& csv);

// The MCP Streamable-HTTP transport (spec 2025-06-18): one endpoint, three verbs.
//   POST   — the request body is a single JSON-RPC message; a request gets its JSON-RPC
//            response, a notification/response gets 202. `initialize` mints a session id
//            returned in the Mcp-Session-Id header and required on every later call.
//   GET    — would open a server→client SSE stream; we have none, so 405.
//   DELETE — ends a session.
// The Origin header is validated to block DNS-rebinding. This class is pure transport —
// framing, sessions, and headers — over the transport-agnostic McpServer engine.
class McpHttpEndpoint {
public:
  McpHttpEndpoint(McpServer& server, std::set<std::string> allowedOrigins);

  void handlePost(const drogon::HttpRequestPtr& request, McpHttpCallback&& callback);
  void handleGet(const drogon::HttpRequestPtr& request, McpHttpCallback&& callback);
  void handleDelete(const drogon::HttpRequestPtr& request, McpHttpCallback&& callback);

private:
  std::string openSession();

  McpServer& server_;
  std::set<std::string> allowedOrigins_;
  mutable std::mutex mutex_;
  std::map<std::string, std::chrono::steady_clock::time_point> sessions_;  // id -> sliding expiry
};

}
