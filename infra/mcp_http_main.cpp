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
}

int main() {
  using namespace wm;

  const std::string connString = env("DATABASE_URL", "postgresql://localhost/windmill");
  const UserId caller{env("WINDMILL_MCP_USER", "dev")};
  const std::string host = env("WINDMILL_MCP_HOST", "0.0.0.0");
  const int port = std::atoi(env("PORT", "8090").c_str());
  const int threads = std::atoi(env("WINDMILL_MCP_THREADS", "8").c_str());
  const std::string path = env("WINDMILL_MCP_PATH", "/mcp");
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

  LOG_INFO << "windmill-mcp-http listening on " << host << ":" << port << path
           << " (db=" << connString << ", user=" << caller.str() << ")";
  app.addListener(host, port).setThreadNum(threads).run();
  return 0;
}
