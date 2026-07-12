#include "adapters/json/TreeJson.h"
#include "adapters/mcp/McpServer.h"
#include "adapters/mcp/RoadmapTools.h"
#include "adapters/postgres/PgOpLog.h"
#include "adapters/postgres/PgProgressRepository.h"
#include "adapters/postgres/PgTreeRepository.h"
#include "application/ProgressService.h"
#include "application/RoomRegistry.h"
#include "application/TreeRegistry.h"
#include "ports/Clock.h"
#include "ports/PresenceBus.h"

#include <chrono>
#include <cstdlib>
#include <iostream>
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

// No live subscribers in the MCP process. Durability is the shared Postgres — the web
// server picks up an agent's edits on its next room load / reconnect replay — so op
// fanout is a no-op here.
struct NullPresenceBus : PresenceBus {
  void broadcastOp(const TreeId&, const AppliedOp&) override {}
};

// Strip any `user:password@` credentials before a connection string reaches a log line.
std::string redactDbUrl(const std::string& url) {
  const std::size_t scheme = url.find("://");
  const std::size_t at = url.find('@');
  if (scheme == std::string::npos || at == std::string::npos || at < scheme) return url;
  return url.substr(0, scheme + 3) + "***@" + url.substr(at + 1);
}

void reply(const Json::Value& frame) { std::cout << dump(frame) << "\n" << std::flush; }

Json::Value parseError() {
  Json::Value error(Json::objectValue);
  error["code"] = -32700;
  error["message"] = "parse error";
  Json::Value frame(Json::objectValue);
  frame["jsonrpc"] = "2.0";
  frame["id"] = Json::nullValue;
  frame["error"] = error;
  return frame;
}
}

int main() {
  using namespace wm;

  const char* url = std::getenv("DATABASE_URL");
  std::string connString = url ? url : "postgresql://localhost/windmill";
  const char* userEnv = std::getenv("WINDMILL_MCP_USER");
  UserId caller{userEnv ? std::string(userEnv) : std::string("dev")};

  PgTreeRepository trees(connString);
  PgProgressRepository progressRepo(connString);
  PgOpLog oplog(connString);
  NullPresenceBus bus;
  RoomRegistry registry(trees, oplog, bus);
  ProgressService progress(progressRepo);
  TreeRegistry treeRegistry(trees, progressRepo);
  SystemClock clock;

  RoadmapTools tools(registry, progress, clock, treeRegistry);
  ServerInfo info{
      "windmill", "0.1.0",
      "Windmill roadmaps are RPG-style skill trees: nodes are skills/milestones, and a "
      "prerequisite edge points from a required node to the node it unlocks. Use get_tree and "
      "get_diagnostics to inspect, the edit tools (create_node, connect, …) to author, and "
      "set_progress to mark a node active or complete. Edits are never rejected — a cycle or a "
      "detached node is surfaced by get_diagnostics, not refused."};
  McpServer server(tools, std::move(info));

  // stdout is the protocol channel — everything else goes to stderr.
  std::cerr << "windmill-mcp ready (stdio; db=" << redactDbUrl(connString) << ", user=" << caller.str() << ")\n";

  std::string line;
  while (std::getline(std::cin, line)) {
    if (line.empty()) continue;
    Json::Value message = parse(line);
    if (!message.isObject()) {
      reply(parseError());
      continue;
    }
    if (std::optional<Json::Value> response = server.handle(message, caller)) reply(*response);
  }
  return 0;
}
