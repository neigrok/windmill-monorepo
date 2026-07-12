#include "adapters/mcp/RoadmapTools.h"

#include "application/ProgressService.h"
#include "application/RoomRegistry.h"
#include "domain/LooseGraph.h"
#include "ports/Clock.h"
#include "test/application/Fakes.h"
#include "test/testing.h"

using namespace wm;
using namespace wm::fake;

namespace {

// A strictly-increasing clock so every stamp is fresh and later edits win.
struct StepClock : Clock {
  std::uint64_t ms = 1000;
  std::uint64_t nowMs() override { return ms++; }
};

// A harness owning the fakes + wiring, seeded with one empty tree "t".
struct Harness {
  FakeTreeRepository trees;
  FakeOpLog ops;
  FakeBus bus;
  FakeProgressRepository progressRepo;
  StepClock clock;
  RoomRegistry registry{trees, ops, bus};
  ProgressService progress{progressRepo};
  RoadmapTools tools{registry, progress, clock, uid("agent")};

  Harness() { trees.byId["t"] = StoredTree{LooseGraph().exportState(), LegendState{}, "Test Roadmap", 0}; }

  ToolResult call(const char* name, Json::Value args) {
    args["treeId"] = "t";
    return tools.callTool(name, args);
  }
};

Json::Value with(const char* key, const char* value) {
  Json::Value args(Json::objectValue);
  args[key] = value;
  return args;
}

}

TEST(mcp_create_node_mints_a_slug_id_and_get_tree_shows_it) {
  Harness h;

  ToolResult created = h.call("create_node", with("label", "Renderer Core"));
  CHECK_FALSE(created.isError);
  CHECK(created.structured["applied"].asBool());
  CHECK_EQ(created.structured["id"].asString(), std::string("renderer-core"));
  CHECK(created.structured["diagnosticsClean"].asBool());

  ToolResult got = h.call("get_tree", Json::Value(Json::objectValue));
  CHECK_FALSE(got.isError);
  const Json::Value& nodes = got.structured["tree"]["nodes"];
  CHECK_EQ(nodes.size(), 1u);
  CHECK_EQ(nodes[0]["id"].asString(), std::string("renderer-core"));
  CHECK_EQ(nodes[0]["label"].asString(), std::string("Renderer Core"));
}

TEST(mcp_connecting_a_back_edge_surfaces_a_cycle_and_flags_it) {
  Harness h;

  Json::Value a(Json::objectValue);
  a["id"] = "a";
  a["label"] = "A";
  h.call("create_node", a);
  Json::Value b(Json::objectValue);
  b["id"] = "b";
  b["label"] = "B";
  h.call("create_node", b);

  Json::Value forward(Json::objectValue);
  forward["from"] = "a";
  forward["to"] = "b";
  ToolResult clean = h.call("connect", forward);
  CHECK(clean.structured["diagnosticsClean"].asBool());

  Json::Value back(Json::objectValue);
  back["from"] = "b";
  back["to"] = "a";
  ToolResult cyclic = h.call("connect", back);
  CHECK_FALSE(cyclic.structured["diagnosticsClean"].asBool());

  ToolResult diag = h.call("get_diagnostics", Json::Value(Json::objectValue));
  CHECK_FALSE(diag.isError);
  CHECK_FALSE(diag.structured["cycles"].empty());
}

TEST(mcp_delete_node_removes_it_from_the_document) {
  Harness h;
  Json::Value a(Json::objectValue);
  a["id"] = "a";
  a["label"] = "A";
  h.call("create_node", a);

  ToolResult deleted = h.call("delete_node", with("id", "a"));
  CHECK_FALSE(deleted.isError);
  CHECK(deleted.structured["applied"].asBool());

  ToolResult got = h.call("get_tree", Json::Value(Json::objectValue));
  CHECK_EQ(got.structured["tree"]["nodes"].size(), 0u);
}

TEST(mcp_set_progress_records_and_flags_unmet_prerequisites) {
  Harness h;
  Json::Value a(Json::objectValue);
  a["id"] = "a";
  a["label"] = "A";
  h.call("create_node", a);
  Json::Value b(Json::objectValue);
  b["id"] = "b";
  b["label"] = "B";
  b["parentId"] = "a";  // a unlocks b
  h.call("create_node", b);

  Json::Value markB(Json::objectValue);
  markB["nodeId"] = "b";
  markB["status"] = "complete";
  ToolResult early = h.call("set_progress", markB);
  CHECK_FALSE(early.isError);
  CHECK_FALSE(early.structured["prerequisitesMet"].asBool());

  Json::Value markA(Json::objectValue);
  markA["nodeId"] = "a";
  markA["status"] = "complete";
  h.call("set_progress", markA);
  ToolResult later = h.call("set_progress", markB);
  CHECK(later.structured["prerequisitesMet"].asBool());

  ToolResult progress = h.call("get_progress", Json::Value(Json::objectValue));
  CHECK_EQ(progress.structured["completed"].size(), 2u);
}

TEST(mcp_get_health_needs_a_valid_dag) {
  Harness h;
  Json::Value a(Json::objectValue);
  a["id"] = "a";
  a["label"] = "A";
  h.call("create_node", a);

  ToolResult healthy = h.call("get_health", Json::Value(Json::objectValue));
  CHECK_FALSE(healthy.isError);
  CHECK_EQ(healthy.structured["nodeCount"].asInt(), 1);

  Json::Value self(Json::objectValue);
  self["from"] = "a";
  self["to"] = "a";
  h.call("connect", self);  // a self-edge makes the graph invalid
  ToolResult broken = h.call("get_health", Json::Value(Json::objectValue));
  CHECK(broken.isError);
}

TEST(mcp_unknown_tool_and_missing_tree_id_are_errors) {
  Harness h;
  CHECK(h.call("frobnicate", Json::Value(Json::objectValue)).isError);
  CHECK(h.tools.callTool("get_tree", Json::Value(Json::objectValue)).isError);  // no treeId
  CHECK(h.tools.callTool("get_tree", with("treeId", "nope")).isError);          // unknown tree
}

TEST(mcp_add_kind_shows_in_legend_and_rejects_a_taken_hue) {
  Harness h;
  Json::Value k(Json::objectValue);
  k["id"] = "infra";
  k["hue"] = "sky";
  ToolResult added = h.call("add_kind", k);
  CHECK_FALSE(added.isError);
  CHECK(added.structured["applied"].asBool());

  ToolResult got = h.call("get_tree", Json::Value(Json::objectValue));
  const Json::Value& kinds = got.structured["tree"]["kinds"];
  CHECK_EQ(kinds.size(), 1u);
  CHECK_EQ(kinds[0]["id"].asString(), std::string("infra"));
  CHECK_EQ(kinds[0]["hue"].asString(), std::string("sky"));

  Json::Value dupe(Json::objectValue);
  dupe["id"] = "infra2";
  dupe["hue"] = "sky";  // same hue — must be rejected
  CHECK(h.call("add_kind", dupe).isError);
}

TEST(mcp_recolor_kind_repaints_nodes) {
  Harness h;
  Json::Value node(Json::objectValue);
  node["id"] = "a";
  node["label"] = "A";
  node["color"] = "olive";
  h.call("create_node", node);
  Json::Value k(Json::objectValue);
  k["id"] = "learn";
  k["hue"] = "olive";
  h.call("add_kind", k);

  Json::Value recolor(Json::objectValue);
  recolor["id"] = "learn";
  recolor["hue"] = "brick";
  CHECK_FALSE(h.call("recolor_kind", recolor).isError);

  ToolResult got = h.call("get_tree", Json::Value(Json::objectValue));
  CHECK_EQ(got.structured["tree"]["nodes"][0]["color"].asString(), std::string("brick"));
  CHECK_EQ(got.structured["tree"]["kinds"][0]["hue"].asString(), std::string("brick"));
}

TEST(mcp_remove_kind_rejected_while_a_node_wears_its_hue) {
  Harness h;
  Json::Value node(Json::objectValue);
  node["id"] = "a";
  node["label"] = "A";
  node["color"] = "sky";
  h.call("create_node", node);
  Json::Value k(Json::objectValue);
  k["id"] = "infra";
  k["hue"] = "sky";
  h.call("add_kind", k);

  CHECK(h.call("remove_kind", with("id", "infra")).isError);  // sky is in use
}
