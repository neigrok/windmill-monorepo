#pragma once

#include "products/roadmap/adapters/mcp/RoadmapDoorTools.h"
#include "products/roadmap/application/RoadmapDoor.h"

#include "platform/domain/sync/Jcs.h"
#include "test/platform/adapters/mcp/OutputSchema.h"
#include "test/platform/application/sync/SyncWorld.h"
#include "test/products/roadmap/adapters/mcp/ToolsHarness.h"

#include <cstdio>
#include <string>

namespace wm::test {

// Tokens whose digests are 16 hexadecimal digits, as a roadmap id is minted from: the first is ...0001.
struct HexTokens : TokenGenerator {
  int counter = 0;
  MintedToken mint() override {
    char digest[17];
    std::snprintf(digest, sizeof digest, "%016x", ++counter);
    return {"s" + std::to_string(counter), digest};
  }
  std::string mintCode() override { return std::to_string(100000 + ++counter); }
  std::string digestOf(const std::string& secret) override { return secret; }
  std::string s256Challenge(const std::string& verifier) override { return "c:" + verifier; }
};

// Roadmap's tools through the door, over the engine's store in `World` bound to roadmap's registry — in memory, or over
// Postgres (PgSyncWorld) — : accounts A and B, and A's roadmap "Test Roadmap", created as create_tree creates one but
// with no legend, so a session starts where the rooms' harness does.
template <typename World>
struct DoorOver {
  BlockingThread::Mark blocking;
  World world{sync::test::WorldProduct::roadmap};
  StepClock clock;
  HexTokens tokens;
  roadmap::RoadmapDoor door{world.catalog(), world.store(), world.feed, world.clock(), clock, world.failures};
  RoadmapDoorTools tools{door, tokens, clock, "https://app.example"};
  UserId caller;
  UserId reader;
  std::string tree;

  DoorOver() {
    world.seed(sync::parseJson(R"({"epoch":"ep-1","clock":{"ms":0,"counter":0},"accounts":{"A":{"name":"Ann"},"B":{"name":"Bo"}}})"));
    caller = world.account("A");
    reader = world.account("B");
    tree = plant(caller, "Test Roadmap");
  }

  // A roadmap of `owner`'s titled `title`, with no legend: its record, then its title.
  std::string plant(const UserId& owner, const std::string& title) {
    const Json::Value created = tools.callTool("create_tree", titled(title), ToolCaller{owner, ToolScope::everything()}).payload;
    const std::string id = created["treeId"].asString();
    Json::Value kinds(Json::arrayValue);
    for (const Json::Value& kind : created["kinds"]) kinds.append(kind["id"]);
    for (const Json::Value& kind : kinds) {
      Json::Value args(Json::objectValue);
      args["treeId"] = id;
      args["id"] = kind;
      tools.callTool("remove_kind", args, ToolCaller{owner, ToolScope::everything()});
    }
    return id;
  }

  static Json::Value titled(const std::string& title) {
    Json::Value args(Json::objectValue);
    args["title"] = title;
    return args;
  }

  // A call on the harness's roadmap, as the rooms' harness makes one, held to the tool's outputSchema.
  ToolResult call(const char* name, Json::Value args) {
    if (!args.isMember("treeId")) args["treeId"] = tree;
    ToolResult result = tools.callTool(name, args, ToolCaller{caller, ToolScope::everything()});
    checkStructuredContent(tools, name, result, __FILE__, __LINE__);
    return result;
  }

  ToolResult as(const UserId& who, const char* name, Json::Value args) {
    if (!args.isMember("treeId")) args["treeId"] = tree;
    return tools.callTool(name, args, ToolCaller{who, ToolScope::everything()});
  }

  // The tree scope's sequence number as the engine holds it.
  Seq seqOf(const std::string& id) {
    return door.read([&](sync::SyncTxn& txn) { return door.rows().tree(txn, id, std::nullopt).seq(); });
  }
};

using DoorHarness = DoorOver<sync::test::FakeWorld>;

}
