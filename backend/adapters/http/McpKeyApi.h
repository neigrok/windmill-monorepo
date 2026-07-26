#pragma once

#include "adapters/http/Caller.h"
#include "application/AuthService.h"
#include "application/McpKeyService.h"

#include <drogon/HttpRequest.h>
#include <drogon/HttpResponse.h>

#include <functional>
#include <memory>
#include <string>

namespace wm {

using HttpCallback = std::function<void(const drogon::HttpResponsePtr&)>;

// The REST surface for personal MCP API keys (settings). Browser-session auth via the shared
// callerOf trust boundary; an anonymous caller gets a 401. The minted secret is returned exactly
// once, on create — list and every read after carry only the key's metadata, never the token.
class McpKeyApi {
public:
  McpKeyApi(std::shared_ptr<AuthService> auth, std::shared_ptr<McpKeyService> keys);

  void createKey(const drogon::HttpRequestPtr& req, HttpCallback&& callback);  // POST   /v1/mcp-keys
  void listKeys(const drogon::HttpRequestPtr& req, HttpCallback&& callback);   // GET    /v1/mcp-keys
  void revokeKey(const drogon::HttpRequestPtr& req, HttpCallback&& callback,   // DELETE /v1/mcp-keys/{id}
                 const std::string& id);

private:
  std::shared_ptr<AuthService> auth_;
  std::shared_ptr<McpKeyService> service_;
};

}
