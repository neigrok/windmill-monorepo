#include "platform/adapters/clock/SystemClock.h"
#include "platform/adapters/crypto/OpenSslTokenGenerator.h"
#include "products/roadmap/adapters/json/TreeJson.h"
#include "platform/adapters/mcp/CompositeToolHost.h"
#include "platform/adapters/mcp/McpServer.h"
#include "products/roadmap/adapters/mcp/RoadmapResources.h"
#include "products/roadmap/adapters/mcp/RoadmapTools.h"
#include "platform/adapters/postgres/PgPool.h"
#include "products/roadmap/adapters/postgres/PgOpLog.h"
#include "products/roadmap/adapters/postgres/PgProgressRepository.h"
#include "products/roadmap/adapters/postgres/PgTreeRepository.h"
#include "products/roadmap/application/ProgressService.h"
#include "products/roadmap/application/RoomRegistry.h"
#include "products/roadmap/application/TreeRegistry.h"
#include "products/roadmap/ports/PresenceBus.h"

#include <cstdlib>
#include <iostream>
#include <string>

namespace {
using namespace wm;

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
  auto pool = std::make_shared<PgPool>(connString);
  const char* userEnv = std::getenv("WINDMILL_MCP_USER");
  UserId caller{userEnv ? std::string(userEnv) : std::string("dev")};

  PgTreeRepository trees(pool);
  PgProgressRepository progressRepo(pool);
  PgOpLog oplog(pool);
  NullPresenceBus bus;
  RoomRegistry registry(trees, oplog, bus);
  ProgressService progress(progressRepo);
  OpenSslTokenGenerator registryTokens;
  const Hlc genesis{1, 0, "genesis"};
  SystemClock clock;
  TreeRegistry treeRegistry(trees, progressRepo, registryTokens, genesis, registry, clock);

  RoadmapTools tools(registry, progress, clock, treeRegistry, bus);
  const std::vector<ToolModule> modules{{tools, roadmapInstructions()}};
  CompositeToolHost surface(modules);
  McpServer server(surface, windmillServerInfo(surface), roadmapResources());
  // stdio has no credential to narrow: the process IS the account, configured by env. Said out loud
  // here for the same reason it is said in main.cpp — the widest reach is never a default.
  const ToolCaller actor{caller, ToolScope::everything()};

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
    if (std::optional<Json::Value> response = server.handle(message, actor)) reply(*response);
  }
  return 0;
}
