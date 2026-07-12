#include "adapters/http/RateLimiter.h"
#include "adapters/mcp/McpHttpEndpoint.h"
#include "adapters/mcp/McpServer.h"
#include "adapters/mcp/RoadmapTools.h"
#include "adapters/postgres/PgOpLog.h"
#include "adapters/postgres/PgProgressRepository.h"
#include "adapters/postgres/PgTreeRepository.h"
#include "application/ProgressService.h"
#include "application/RoomRegistry.h"
#include "ports/Clock.h"
#include "ports/PresenceBus.h"

#include <drogon/drogon.h>

#include <chrono>
#include <cstdlib>
#include <memory>
#include <set>
#include <string>

namespace {
using namespace wm;

struct SystemClock : Clock {
  std::uint64_t nowMs() override {
    return std::chrono::duration_cast<std::chrono::milliseconds>(
               std::chrono::system_clock::now().time_since_epoch())
        .count();
  }
};

// One process, its own RoomRegistry against the shared Postgres — no live WS subscribers
// here, so op fanout is a no-op; durability (and web visibility on reload) is the database.
struct NullPresenceBus : PresenceBus {
  void broadcastOp(const TreeId&, const AppliedOp&) override {}
};

std::string env(const char* key, const std::string& fallback) {
  const char* value = std::getenv(key);
  return value ? std::string(value) : fallback;
}

// Strip any `user:password@` credentials before a connection string reaches a log line.
std::string redactDbUrl(const std::string& url) {
  const std::size_t scheme = url.find("://");
  const std::size_t at = url.find('@');
  if (scheme == std::string::npos || at == std::string::npos || at < scheme) return url;
  return url.substr(0, scheme + 3) + "***@" + url.substr(at + 1);
}

// Constant-time equality for the shared token, so a mismatch's position can't be timed.
bool secretEqual(const std::string& a, const std::string& b) {
  if (a.size() != b.size()) return false;
  unsigned char diff = 0;
  for (std::size_t i = 0; i < a.size(); ++i)
    diff |= static_cast<unsigned char>(a[i]) ^ static_cast<unsigned char>(b[i]);
  return diff == 0;
}
}

int main() {
  using namespace wm;

  const std::string connString = env("DATABASE_URL", "postgresql://localhost/windmill");
  const UserId caller{env("WINDMILL_MCP_USER", "dev")};
  const std::string host = env("WINDMILL_MCP_HOST", "0.0.0.0");
  const int port = std::atoi(env("PORT", "8090").c_str());
  const int threads = std::atoi(env("WINDMILL_MCP_THREADS", "8").c_str());
  const std::string path = env("WINDMILL_MCP_PATH", "/mcp");
  const std::string mcpToken = env("WINDMILL_MCP_TOKEN", "");  // shared bearer; empty leaves /mcp open
  const std::set<std::string> origins = parseOriginList(env("WINDMILL_MCP_ALLOWED_ORIGINS", ""));

  auto trees = std::make_shared<PgTreeRepository>(connString);
  auto progressRepo = std::make_shared<PgProgressRepository>(connString);
  auto oplog = std::make_shared<PgOpLog>(connString);
  auto bus = std::make_shared<NullPresenceBus>();
  auto registry = std::make_shared<RoomRegistry>(*trees, *oplog, *bus);
  auto progress = std::make_shared<ProgressService>(*progressRepo);
  auto clock = std::make_shared<SystemClock>();
  auto tools = std::make_shared<RoadmapTools>(*registry, *progress, *clock, caller);

  ServerInfo info{
      "windmill", "0.1.0",
      "Windmill roadmaps are RPG-style skill trees: nodes are skills/milestones, and a "
      "prerequisite edge points from a required node to the node it unlocks. Use get_tree and "
      "get_diagnostics to inspect, the edit tools (create_node, connect, …) to author, and "
      "set_progress to mark a node active or complete. Edits are never rejected — a cycle or a "
      "detached node is surfaced by get_diagnostics, not refused."};
  auto server = std::make_shared<McpServer>(*tools, std::move(info));
  auto endpoint = std::make_shared<McpHttpEndpoint>(*server, origins);

  auto& app = drogon::app();

  // The public MCP surface is gated before routing: a per-client rate ceiling keyed on
  // Caddy's X-Forwarded-For, then a shared bearer token on the MCP path itself (when one is
  // configured). Health checks (/healthz) and CORS preflight skip both.
  auto mcpLimiter = std::make_shared<RateLimiter>(20.0, 40.0);  // ~20 req/s/client, burst 40
  app.registerPreRoutingAdvice(
      [mcpLimiter, mcpToken, path](const drogon::HttpRequestPtr& req) -> drogon::HttpResponsePtr {
        if (req->method() == drogon::Options) return nullptr;
        const std::string ip = clientIp(req);
        if (!ip.empty() && !mcpLimiter->allow(ip)) {
          auto resp = drogon::HttpResponse::newHttpResponse();
          resp->setStatusCode(drogon::k429TooManyRequests);
          resp->setBody("rate limited");
          return resp;
        }
        if (!mcpToken.empty() && req->path() == path) {
          const std::string authorization = req->getHeader("authorization");
          const std::string presented =
              authorization.rfind("Bearer ", 0) == 0 ? authorization.substr(7) : "";
          if (!secretEqual(presented, mcpToken)) {
            auto resp = drogon::HttpResponse::newHttpResponse();
            resp->setStatusCode(drogon::k401Unauthorized);
            resp->setBody("unauthorized");
            return resp;
          }
        }
        return nullptr;
      });

  // CORS for browser-based MCP clients: reflect an allowed Origin and expose the session id.
  app.registerPostHandlingAdvice(
      [origins](const drogon::HttpRequestPtr& request, const drogon::HttpResponsePtr& response) {
        const std::string origin = request->getHeader("Origin");
        if (origin.empty()) return;
        if (!origins.count("*") && !origins.count(origin)) return;
        response->addHeader("Access-Control-Allow-Origin", origins.count("*") ? "*" : origin);
        response->addHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");
        response->addHeader("Vary", "Origin");
      });

  app.registerHandler(
      path,
      [endpoint](const drogon::HttpRequestPtr& req, McpHttpCallback&& cb) {
        endpoint->handlePost(req, std::move(cb));
      },
      {drogon::Post});
  app.registerHandler(
      path,
      [endpoint](const drogon::HttpRequestPtr& req, McpHttpCallback&& cb) {
        endpoint->handleGet(req, std::move(cb));
      },
      {drogon::Get});
  app.registerHandler(
      path,
      [endpoint](const drogon::HttpRequestPtr& req, McpHttpCallback&& cb) {
        endpoint->handleDelete(req, std::move(cb));
      },
      {drogon::Delete});
  app.registerHandler(
      path,
      [](const drogon::HttpRequestPtr&, McpHttpCallback&& cb) {
        auto response = drogon::HttpResponse::newHttpResponse();
        response->setStatusCode(drogon::k204NoContent);
        response->addHeader("Access-Control-Allow-Methods", "POST, GET, DELETE, OPTIONS");
        response->addHeader("Access-Control-Allow-Headers",
                            "content-type, mcp-session-id, mcp-protocol-version, authorization");
        response->addHeader("Access-Control-Max-Age", "86400");
        cb(response);
      },
      {drogon::Options});

  app.registerHandler(
      "/healthz",
      [](const drogon::HttpRequestPtr&, McpHttpCallback&& cb) {
        auto response = drogon::HttpResponse::newHttpResponse();
        response->setStatusCode(drogon::k200OK);
        response->setBody("ok");
        cb(response);
      },
      {drogon::Get});

  if (mcpToken.empty())
    LOG_WARN << "WINDMILL_MCP_TOKEN unset — " << path << " is unauthenticated; set it to gate the tools";
  LOG_INFO << "windmill-mcp-http listening on " << host << ":" << port << path
           << " (db=" << redactDbUrl(connString) << ", user=" << caller.str()
           << ", auth=" << (mcpToken.empty() ? "open" : "bearer") << ")";
  app.setClientMaxBodySize(2 * 1024 * 1024);
  app.setClientMaxMemoryBodySize(1 * 1024 * 1024);
  app.setMaxConnectionNum(20000);
  app.addListener(host, port).setThreadNum(threads).run();
  return 0;
}
