#pragma once

#include "adapters/mcp/RoadmapTools.h"

#include "adapters/json/TreeJson.h"
#include "application/ProgressService.h"
#include "application/RoomRegistry.h"
#include "domain/LooseGraph.h"
#include "ports/Clock.h"
#include "test/application/AuthFakes.h"
#include "test/application/Fakes.h"

#include <string>
#include <vector>

namespace wm::test {

// A strictly-increasing clock so every stamp is fresh and later edits win.
struct StepClock : Clock {
  std::uint64_t ms = 1000;
  std::uint64_t nowMs() override { return ms++; }
};

// A harness owning the fakes + wiring, seeded with one empty tree "t".
struct Harness {
  fake::FakeTreeRepository trees;
  fake::FakeOpLog ops;
  fake::FakeBus bus;
  fake::FakeProgressRepository progressRepo;
  StepClock clock;
  fake::FakeTokens tokens;
  RoomRegistry registry{trees, ops, bus};
  ProgressService progress{progressRepo};
  TreeRegistry treeRegistry{trees, progressRepo, tokens, Hlc{1, 0, "genesis"}, registry, clock};
  UserId caller = fake::uid("agent");
  RoadmapTools tools{registry, progress, clock, treeRegistry, bus};

  Harness() {
    trees.byId["t"] =
        StoredTree{LooseGraph().exportState(), LegendState{}, {"Test Roadmap", {}}, 0, caller};
  }

  ToolResult call(const char* name, Json::Value args) {
    args["treeId"] = "t";
    return tools.callTool(name, args, caller);
  }
};

// Every successful result speaks through content[0].text — the one channel every MCP client
// reads. structuredContent is not sent (no tool declares an outputSchema), so these tests read
// exactly the bytes an agent reads.
inline Json::Value body(const ToolResult& result) { return parse(result.content[0]["text"].asString()); }

inline std::string message(const ToolResult& result) { return result.content[0]["text"].asString(); }

inline std::vector<std::string> keys(const Json::Value& value) { return value.getMemberNames(); }

inline Json::Value with(const char* key, const char* value) {
  Json::Value args(Json::objectValue);
  args[key] = value;
  return args;
}

inline Json::Value node(const char* id, const char* label) {
  Json::Value n(Json::objectValue);
  n["id"] = id;
  n["label"] = label;
  return n;
}

inline Json::Value mark(const char* nodeId, const char* status) {
  Json::Value m(Json::objectValue);
  m["nodeId"] = nodeId;
  m["status"] = status;
  return m;
}

inline Json::Value list(std::vector<const char*> values) {
  Json::Value array(Json::arrayValue);
  for (const char* value : values) array.append(value);
  return array;
}

inline const Json::Value kNoArgs(Json::objectValue);

}
