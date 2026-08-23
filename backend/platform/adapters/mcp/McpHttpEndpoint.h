#pragma once

#include "platform/adapters/mcp/McpServer.h"
#include "platform/application/OAuthService.h"
#include "platform/domain/Ids.h"

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

class McpKeyService;

using McpHttpCallback = std::function<void(const drogon::HttpResponsePtr&)>;

// Parse a comma-separated allow-list (e.g. WINDMILL_MCP_ALLOWED_ORIGINS), trimming spaces.
std::set<std::string> parseOriginList(const std::string& csv);

// How the endpoint authenticates a request into a caller. `oauth` validates a per-user OAuth
// access token bound to `resource`; `mcpKeys` validates a per-user personal API key;
// `fallbackToken` is a shared bearer acting as `fallbackUser`, and with none configured requests
// run unauthenticated as `fallbackUser`. `resourceMetadataUrl` is advertised in the 401
// WWW-Authenticate challenge. `fallbackScope` is what the two credential-less doors carry; it has
// no default, so a root that omits it gets a caller who can do nothing.
struct McpAuth {
  OAuthService* oauth = nullptr;
  std::string resource;
  std::string resourceMetadataUrl;
  std::string fallbackToken;
  UserId fallbackUser;
  McpKeyService* mcpKeys = nullptr;
  ToolScope fallbackScope;
};

// The MCP Streamable-HTTP transport (spec 2025-06-18). POST carries one JSON-RPC message: a
// request gets its response, a notification/response gets 202, and `initialize` mints the session
// id returned in Mcp-Session-Id and required on every later call. GET is 405; DELETE ends a
// session. The Origin header is validated to block DNS-rebinding.
class McpHttpEndpoint {
public:
  McpHttpEndpoint(McpServer& server, std::set<std::string> allowedOrigins, McpAuth auth = {});

  void handlePost(const drogon::HttpRequestPtr& request, McpHttpCallback&& callback);
  void handleGet(const drogon::HttpRequestPtr& request, McpHttpCallback&& callback);
  void handleDelete(const drogon::HttpRequestPtr& request, McpHttpCallback&& callback);

private:
  std::string openSession();
  // The caller a request authenticates as — the account and the grant its credential carries — or
  // nullopt when auth is configured but no valid token is presented (→ a 401 challenge). When no auth
  // is configured, always the fallback.
  std::optional<ToolCaller> resolveCaller(const drogon::HttpRequestPtr& request) const;

  McpServer& server_;
  std::set<std::string> allowedOrigins_;
  McpAuth auth_;
  mutable std::mutex mutex_;
  std::map<std::string, std::chrono::steady_clock::time_point> sessions_;  // id -> sliding expiry
};

}
