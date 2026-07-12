#pragma once

#include "adapters/mcp/McpServer.h"
#include "application/OAuthService.h"
#include "domain/Ids.h"

#include <drogon/HttpRequest.h>
#include <drogon/HttpResponse.h>

#include <chrono>
#include <functional>
#include <map>
#include <mutex>
#include <optional>
#include <set>
#include <string>

namespace wm {

using McpHttpCallback = std::function<void(const drogon::HttpResponsePtr&)>;

// Parse a comma-separated allow-list (e.g. WINDMILL_MCP_ALLOWED_ORIGINS), trimming spaces.
std::set<std::string> parseOriginList(const std::string& csv);

// How the endpoint authenticates a request into a caller. `oauth` (when set) validates a
// per-user OAuth access token bound to `resource`; `fallbackToken` is an optional shared
// bearer that acts as `fallbackUser` (CI/agents). With neither configured, requests run
// unauthenticated as `fallbackUser` (local/stdio-style, and the tests). `resourceMetadataUrl`
// is advertised in the 401 WWW-Authenticate challenge.
struct McpAuth {
  OAuthService* oauth = nullptr;
  std::string resource;
  std::string resourceMetadataUrl;
  std::string fallbackToken;
  UserId fallbackUser;
};

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
  McpHttpEndpoint(McpServer& server, std::set<std::string> allowedOrigins, McpAuth auth = {});

  void handlePost(const drogon::HttpRequestPtr& request, McpHttpCallback&& callback);
  void handleGet(const drogon::HttpRequestPtr& request, McpHttpCallback&& callback);
  void handleDelete(const drogon::HttpRequestPtr& request, McpHttpCallback&& callback);

private:
  std::string openSession();
  // The caller a request authenticates as, or nullopt when auth is configured but no valid
  // token is presented (→ a 401 challenge). When no auth is configured, always the fallback.
  std::optional<UserId> resolveCaller(const drogon::HttpRequestPtr& request) const;

  McpServer& server_;
  std::set<std::string> allowedOrigins_;
  McpAuth auth_;
  mutable std::mutex mutex_;
  std::map<std::string, std::chrono::steady_clock::time_point> sessions_;  // id -> sliding expiry
};

}
