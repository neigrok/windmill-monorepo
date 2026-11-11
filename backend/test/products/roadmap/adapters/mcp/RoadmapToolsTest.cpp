#include "test/products/roadmap/adapters/mcp/ToolsHarness.h"

#include "platform/adapters/mcp/CompositeToolHost.h"
#include "platform/application/WriteObservation.h"
#include "products/roadmap/adapters/mcp/ReadShape.h"
#include "products/roadmap/adapters/mcp/RoadmapToolCatalog.h"
#include "products/roadmap/application/ForkService.h"
#include "test/testing.h"

using namespace wm;
using namespace wm::fake;
using namespace wm::test;

namespace {

Json::Value everyNodeField() {
  return list({"id", "label", "icon", "color", "kind", "order", "prerequisites", "position", "status",
               "seedStatus", "state", "summary", "description", "links", "opens"});
}

std::vector<std::string> ids(const Json::Value& nodes) {
  std::vector<std::string> out;
  for (const Json::Value& node : nodes) out.push_back(node["id"].asString());
  return out;
}

std::vector<std::string> introduced(const Json::Value& receipt) {
  std::vector<std::string> out;
  for (const Json::Value& entry : receipt["introducedDiagnostics"]) out.push_back(entry.asString());
  return out;
}

struct FailingTreeRepository : FakeTreeRepository {
  std::optional<StoredTree> load(const TreeId&) override {
    throw std::runtime_error("connect host=db.internal port=5432 user=windmill password=hunter2: FATAL");
  }
};

}

TEST(mcp_create_node_mints_a_slug_id_and_get_tree_shows_it) {
  Harness h;

  ToolResult result = h.call("create_node", with("label", "Renderer Core"));
  CHECK_FALSE(result.isError);
  const Json::Value created = body(result);
  CHECK(created["applied"].asBool());
  CHECK_EQ(created["id"].asString(), std::string("renderer-core"));
  CHECK(created["diagnosticsClean"].asBool());

  ToolResult read = h.call("get_tree", Json::Value(Json::objectValue));
  CHECK_FALSE(read.isError);
  const Json::Value got = body(read);
  REQUIRE_EQ(got["tree"]["nodes"].size(), 1u);
  CHECK_EQ(got["tree"]["nodes"][0]["id"].asString(), std::string("renderer-core"));
  CHECK_EQ(got["tree"]["nodes"][0]["label"].asString(), std::string("Renderer Core"));
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
  CHECK(body(h.call("connect", forward))["diagnosticsClean"].asBool());

  Json::Value back(Json::objectValue);
  back["from"] = "b";
  back["to"] = "a";
  CHECK_FALSE(body(h.call("connect", back))["diagnosticsClean"].asBool());

  ToolResult diag = h.call("get_diagnostics", Json::Value(Json::objectValue));
  CHECK_FALSE(diag.isError);
  CHECK_FALSE(body(diag)["cycles"].empty());
}

TEST(mcp_delete_node_removes_it_from_the_document) {
  Harness h;
  Json::Value a(Json::objectValue);
  a["id"] = "a";
  a["label"] = "A";
  h.call("create_node", a);

  ToolResult deleted = h.call("delete_node", with("id", "a"));
  CHECK_FALSE(deleted.isError);
  CHECK(body(deleted)["applied"].asBool());

  CHECK_EQ(body(h.call("get_tree", Json::Value(Json::objectValue)))["tree"]["nodes"].size(), 0u);
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
  b["parentId"] = "a";
  h.call("create_node", b);

  Json::Value markB(Json::objectValue);
  markB["nodeId"] = "b";
  markB["status"] = "complete";
  ToolResult early = h.call("set_progress", markB);
  CHECK_FALSE(early.isError);
  CHECK_FALSE(body(early)["prerequisitesMet"].asBool());

  Json::Value markA(Json::objectValue);
  markA["nodeId"] = "a";
  markA["status"] = "complete";
  h.call("set_progress", markA);
  CHECK(body(h.call("set_progress", markB))["prerequisitesMet"].asBool());

  CHECK_EQ(body(h.call("get_progress", Json::Value(Json::objectValue)))["completed"].size(), 2u);

  REQUIRE_EQ(h.bus.progressBroadcasts.size(), 3u);
  const FakeBus::ProgressBroadcast& last = h.bus.progressBroadcasts.back();
  CHECK_EQ(last.user, h.caller.str());
  REQUIRE_EQ(last.marks.marks.size(), 1u);
  CHECK_EQ(last.marks.marks.begin()->first, nid("b"));
  CHECK(last.marks.marks.begin()->second.status == ProgressStatus::complete);
  CHECK(last.marks.marks.begin()->second.at.isSet());
}

TEST(mcp_get_health_needs_a_valid_dag) {
  Harness h;
  Json::Value a(Json::objectValue);
  a["id"] = "a";
  a["label"] = "A";
  h.call("create_node", a);

  ToolResult healthy = h.call("get_health", Json::Value(Json::objectValue));
  CHECK_FALSE(healthy.isError);
  CHECK_EQ(body(healthy)["nodeCount"].asInt(), 1);

  Json::Value self(Json::objectValue);
  self["from"] = "a";
  self["to"] = "a";
  h.call("connect", self);
  CHECK(h.call("get_health", Json::Value(Json::objectValue)).isError);
}

TEST(mcp_unknown_tool_and_missing_tree_id_are_errors) {
  Harness h;
  CHECK(h.call("frobnicate", Json::Value(Json::objectValue)).isError);
  CHECK(h.tools.callTool("get_tree", Json::Value(Json::objectValue), h.actor).isError);
  CHECK(h.tools.callTool("get_tree", with("treeId", "nope"), h.actor).isError);
}

TEST(mcp_add_kind_shows_in_legend_and_rejects_a_taken_hue) {
  Harness h;
  Json::Value k(Json::objectValue);
  k["id"] = "infra";
  k["hue"] = "sky";
  ToolResult added = h.call("add_kind", k);
  CHECK_FALSE(added.isError);
  CHECK(body(added)["applied"].asBool());

  const Json::Value got = body(h.call("get_tree", Json::Value(Json::objectValue)));
  REQUIRE_EQ(got["tree"]["kinds"].size(), 1u);
  CHECK_EQ(got["tree"]["kinds"][0]["id"].asString(), std::string("infra"));
  CHECK_EQ(got["tree"]["kinds"][0]["hue"].asString(), std::string("sky"));

  Json::Value dupe(Json::objectValue);
  dupe["id"] = "infra2";
  dupe["hue"] = "sky";
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

  const Json::Value got = body(h.call("get_tree", Json::Value(Json::objectValue)));
  CHECK_EQ(got["tree"]["nodes"][0]["color"].asString(), std::string("brick"));
  CHECK_EQ(got["tree"]["kinds"][0]["hue"].asString(), std::string("brick"));
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

  CHECK(h.call("remove_kind", with("id", "infra")).isError);
}

TEST(mcp_create_tree_plants_an_owned_roadmap_and_lists_it) {
  Harness h;
  ToolResult result = h.tools.callTool("create_tree", with("title", "Sailing"), h.actor);
  CHECK_FALSE(result.isError);
  std::string newId = body(result)["treeId"].asString();
  CHECK_FALSE(newId.empty());

  const Json::Value listed = body(h.tools.callTool("list_trees", Json::Value(Json::objectValue), h.actor));
  bool found = false;
  for (const Json::Value& row : listed["trees"])
    if (row["id"].asString() == newId) { found = true; CHECK_EQ(row["title"].asString(), std::string("Sailing")); }
  CHECK(found);
}

TEST(mcp_list_trees_returns_the_callers_owned_rows) {
  Harness h;
  h.trees.byId["t"].createdAt = 1'753'400'000'000;  // epoch ms
  h.trees.updatedAt["t"] = 1'753'900'000'000;
  h.call("create_node", with("label", "A"));
  h.call("create_node", with("label", "B"));

  ToolResult result = h.tools.callTool("list_trees", Json::Value(Json::objectValue), h.actor);
  CHECK_FALSE(result.isError);
  const Json::Value trees = body(result)["trees"];
  REQUIRE_EQ(trees.size(), 1u);
  CHECK_EQ(trees[0]["id"].asString(), std::string("t"));
  CHECK_EQ(trees[0]["title"].asString(), std::string("Test Roadmap"));
  CHECK_EQ(trees[0]["total"].asInt(), 2);
  CHECK_EQ(trees[0]["done"].asInt(), 0);
  CHECK_EQ(trees[0]["createdAt"].asInt64(), 1'753'400'000'000);
  CHECK_EQ(trees[0]["updatedAt"].asInt64(), 1'753'900'000'000);
}

TEST(mcp_list_trees_reports_zero_for_a_tree_with_no_recorded_planting) {
  Harness h;
  const Json::Value trees = body(h.tools.callTool("list_trees", Json::Value(Json::objectValue), h.actor))["trees"];
  REQUIRE_EQ(trees.size(), 1u);
  CHECK(trees[0].isMember("createdAt"));  // present and 0 — never missing, never null
  CHECK_EQ(trees[0]["createdAt"].asInt64(), 0);
}

TEST(mcp_delete_tree_soft_deletes_and_drops_it_from_the_list) {
  Harness h;
  ToolResult deleted = h.call("delete_tree", Json::Value(Json::objectValue));
  CHECK_FALSE(deleted.isError);
  CHECK(body(deleted)["deleted"].asBool());

  const Json::Value listed = body(h.tools.callTool("list_trees", Json::Value(Json::objectValue), h.actor));
  CHECK_EQ(listed["trees"].size(), 0u);
}

TEST(mcp_delete_tree_refuses_a_tree_you_dont_own_and_an_unknown_one) {
  Harness h;
  h.trees.byId["other"] = StoredTree{LooseGraph().exportState(), LegendState{}, {"Other", {}}, 0, uid("someone")};

  CHECK(h.tools.callTool("delete_tree", with("treeId", "other"), h.actor).isError);
  CHECK(h.tools.callTool("delete_tree", with("treeId", "ghost"), h.actor).isError);
}

TEST(mcp_create_node_wires_prerequisites_description_and_links) {
  Harness h;
  h.call("create_node", node("a", "A"));
  h.call("create_node", node("b", "B"));

  Json::Value c(Json::objectValue);
  c["id"] = "c";
  c["label"] = "C";
  Json::Value prereqs(Json::arrayValue);
  prereqs.append("a");
  prereqs.append("b");
  c["prerequisites"] = prereqs;
  c["description"] = "the payoff node";
  Json::Value links(Json::arrayValue);
  Json::Value link(Json::objectValue);
  link["url"] = "https://spec";
  link["label"] = "Spec";
  links.append(link);
  c["links"] = links;
  CHECK_FALSE(h.call("create_node", c).isError);

  Json::Value args(Json::objectValue);
  args["fields"] = list({"id", "prerequisites", "description", "links"});
  const Json::Value got = body(h.call("get_tree", args));
  const Json::Value* cNode = nullptr;
  for (const Json::Value& n : got["tree"]["nodes"]) if (n["id"].asString() == "c") cNode = &n;
  REQUIRE(cNode != nullptr);
  CHECK_EQ((*cNode)["prerequisites"].size(), 2u);
  CHECK_EQ((*cNode)["description"].asString(), std::string("the payoff node"));
  REQUIRE_EQ((*cNode)["links"].size(), 1u);
  CHECK_EQ((*cNode)["links"][0]["url"].asString(), std::string("https://spec"));
  CHECK_EQ((*cNode)["links"][0]["label"].asString(), std::string("Spec"));
}

TEST(mcp_annotate_node_sets_and_leaves_untouched_fields_alone) {
  Harness h;
  h.call("create_node", node("a", "A"));

  Json::Value describe(Json::objectValue);
  describe["id"] = "a";
  describe["description"] = "first pass";
  CHECK_FALSE(h.call("annotate_node", describe).isError);

  Json::Value linkOnly(Json::objectValue);
  linkOnly["id"] = "a";
  Json::Value links(Json::arrayValue);
  links.append("https://only-a-url");
  linkOnly["links"] = links;
  CHECK_FALSE(h.call("annotate_node", linkOnly).isError);

  Json::Value args(Json::objectValue);
  args["fields"] = list({"id", "description", "links"});
  const Json::Value a = body(h.call("get_tree", args))["tree"]["nodes"][0];
  CHECK_EQ(a["description"].asString(), std::string("first pass"));
  REQUIRE_EQ(a["links"].size(), 1u);
  CHECK_EQ(a["links"][0]["url"].asString(), std::string("https://only-a-url"));
}

TEST(mcp_add_kind_seeds_label_and_description_inline) {
  Harness h;
  Json::Value k(Json::objectValue);
  k["id"] = "infra";
  k["hue"] = "sky";
  k["label"] = "Infra";
  k["description"] = "platform work";
  CHECK_FALSE(h.call("add_kind", k).isError);

  Json::Value args(Json::objectValue);
  args["kindFields"] = list({"label", "description"});
  const Json::Value kind = body(h.call("get_tree", args))["tree"]["kinds"][0];
  CHECK_EQ(kind["label"].asString(), std::string("Infra"));
  CHECK_EQ(kind["description"].asString(), std::string("platform work"));
}

TEST(mcp_import_subgraph_bulk_upserts_and_reports_collisions) {
  Harness h;
  h.call("create_node", node("a", "Old A"));

  Json::Value nodeB = node("b", "B");
  Json::Value prereqs(Json::arrayValue);
  prereqs.append("a");
  nodeB["prerequisites"] = prereqs;
  Json::Value nodes(Json::arrayValue);
  nodes.append(node("a", "New A"));
  nodes.append(nodeB);
  Json::Value args(Json::objectValue);
  args["nodes"] = nodes;

  ToolResult result = h.call("import_subgraph", args);
  CHECK_FALSE(result.isError);
  const Json::Value imported = body(result);
  CHECK(imported["imported"].asBool());
  CHECK_EQ(imported["nodes"].asInt(), 2);
  CHECK_EQ(imported["edges"].asInt(), 1);
  CHECK_EQ(imported["newNodes"].asInt(), 1);
  REQUIRE_EQ(imported["nodeCollisions"].size(), 1u);
  CHECK_EQ(imported["nodeCollisions"][0].asString(), std::string("a"));
  CHECK(imported["diagnosticsClean"].asBool());

  const Json::Value got = body(h.call("get_tree", kNoArgs));
  CHECK_EQ(got["tree"]["nodes"].size(), 2u);
  for (const Json::Value& n : got["tree"]["nodes"]) {
    if (n["id"].asString() == "a") CHECK_EQ(n["label"].asString(), std::string("New A"));
    if (n["id"].asString() == "b") CHECK_EQ(n["prerequisites"][0].asString(), std::string("a"));
  }
}

TEST(mcp_import_subgraph_dry_run_reports_without_applying) {
  Harness h;
  h.call("create_node", node("a", "A"));

  Json::Value nodes(Json::arrayValue);
  nodes.append(node("a", "shadow"));
  nodes.append(node("c", "C"));
  Json::Value args(Json::objectValue);
  args["nodes"] = nodes;
  args["dryRun"] = true;

  ToolResult result = h.call("import_subgraph", args);
  CHECK_FALSE(result.isError);
  const Json::Value preview = body(result);
  CHECK(preview["dryRun"].asBool());
  CHECK_EQ(preview["edges"].asInt(), 0);
  CHECK_EQ(preview["newNodes"].asInt(), 1);
  CHECK_EQ(preview["nodeCollisions"].size(), 1u);
  CHECK_FALSE(preview.isMember("imported"));

  const Json::Value got = body(h.call("get_tree", kNoArgs));
  REQUIRE_EQ(got["tree"]["nodes"].size(), 1u);
  CHECK_EQ(got["tree"]["nodes"][0]["label"].asString(), std::string("A"));
}

TEST(mcp_import_subgraph_applies_carried_progress_order_safe) {
  Harness h;
  Json::Value nodeB = node("b", "B");
  Json::Value prereqs(Json::arrayValue);
  prereqs.append("a");
  nodeB["prerequisites"] = prereqs;
  Json::Value nodes(Json::arrayValue);
  nodes.append(node("a", "A"));
  nodes.append(nodeB);

  Json::Value progress(Json::arrayValue);
  progress.append(mark("b", "complete"));
  progress.append(mark("a", "complete"));

  Json::Value args(Json::objectValue);
  args["nodes"] = nodes;
  args["progress"] = progress;

  ToolResult result = h.call("import_subgraph", args);
  CHECK_FALSE(result.isError);
  const Json::Value imported = body(result);
  CHECK_EQ(imported["progress"].size(), 2u);
  CHECK_FALSE(imported.isMember("progressSkipped"));
  for (const Json::Value& row : imported["progress"])
    if (row["nodeId"].asString() == "b") CHECK(row["prerequisitesMet"].asBool());

  CHECK_EQ(body(h.call("get_progress", kNoArgs))["completed"].size(), 2u);
}

TEST(mcp_import_subgraph_past_the_node_ceiling_is_refused_and_writes_nothing) {
  Harness h;
  Json::Value nodes(Json::arrayValue);
  for (std::size_t i = 0; i <= kMaxNodes; ++i) nodes.append(node(("n" + std::to_string(i)).c_str(), "N"));
  Json::Value args(Json::objectValue);
  args["nodes"] = nodes;

  ToolResult result = h.call("import_subgraph", args);
  CHECK(result.isError);
  CHECK_EQ(message(result),
           std::string("import_subgraph: this tree would hold 10001 nodes, max 10000 — split it "
                       "across roadmaps, or delete what it has outgrown"));
  CHECK_EQ(body(h.call("get_tree", kNoArgs))["tree"]["nodes"].size(), 0u);
}

TEST(mcp_import_subgraph_dry_run_refuses_an_over_ceiling_graft_the_same_way) {
  Harness h;
  Json::Value nodes(Json::arrayValue);
  for (std::size_t i = 0; i <= kMaxNodes; ++i) nodes.append(node(("n" + std::to_string(i)).c_str(), "N"));
  Json::Value args(Json::objectValue);
  args["nodes"] = nodes;
  args["dryRun"] = true;

  ToolResult result = h.call("import_subgraph", args);
  CHECK(result.isError);
  CHECK_EQ(message(result),
           std::string("import_subgraph: this tree would hold 10001 nodes, max 10000 — split it "
                       "across roadmaps, or delete what it has outgrown"));
}

TEST(mcp_import_subgraph_counts_the_resulting_tree_so_an_upsert_still_lands) {
  Harness h;
  Json::Value nodes(Json::arrayValue);
  for (int i = 0; i < 40; ++i) nodes.append(node(("n" + std::to_string(i)).c_str(), "N"));
  Json::Value args(Json::objectValue);
  args["nodes"] = nodes;
  CHECK_FALSE(h.call("import_subgraph", args).isError);

  ToolResult again = h.call("import_subgraph", args);
  CHECK_FALSE(again.isError);
  CHECK_EQ(body(again)["newNodes"].asInt(), 0);
  CHECK_EQ(body(h.call("get_tree", kNoArgs))["tree"]["nodes"].size(), 40u);
}

TEST(mcp_import_subgraph_refuses_a_repeated_node_id_and_writes_nothing) {
  Harness h;
  Json::Value nodes(Json::arrayValue);
  nodes.append(node("a", "first"));
  nodes.append(node("b", "B"));
  nodes.append(node("a", "second"));
  Json::Value args(Json::objectValue);
  args["nodes"] = nodes;

  ToolResult result = h.call("import_subgraph", args);
  CHECK(result.isError);
  CHECK_EQ(message(result),
           std::string("import_subgraph: nodes[2].id \"a\" is already used by nodes[0] — an id names "
                       "one node per batch"));
  CHECK_EQ(body(h.call("get_tree", kNoArgs))["tree"]["nodes"].size(), 0u);
}

TEST(mcp_import_subgraph_refuses_a_repeated_kind_id) {
  Harness h;
  Json::Value first(Json::objectValue);
  first["id"] = "craft";
  first["hue"] = "olive";
  Json::Value second(Json::objectValue);
  second["id"] = "craft";
  second["hue"] = "sky";
  Json::Value kinds(Json::arrayValue);
  kinds.append(first);
  kinds.append(second);
  Json::Value args(Json::objectValue);
  args["nodes"] = Json::Value(Json::arrayValue);
  args["kinds"] = kinds;

  ToolResult result = h.call("import_subgraph", args);
  CHECK(result.isError);
  CHECK_EQ(message(result),
           std::string("import_subgraph: kinds[1].id \"craft\" is already used by kinds[0] — an id names "
                       "one kind per batch"));
}

TEST(mcp_import_subgraph_reports_carried_progress_that_named_no_node) {
  Harness h;
  Json::Value nodes(Json::arrayValue);
  nodes.append(node("a", "A"));
  Json::Value progress(Json::arrayValue);
  progress.append(mark("a", "complete"));
  progress.append(mark("ghost", "active"));
  Json::Value args(Json::objectValue);
  args["nodes"] = nodes;
  args["progress"] = progress;

  ToolResult result = h.call("import_subgraph", args);
  CHECK_FALSE(result.isError);
  const Json::Value imported = body(result);
  CHECK(imported["imported"].asBool());
  REQUIRE_EQ(imported["progress"].size(), 1u);
  CHECK_EQ(imported["progress"][0]["nodeId"].asString(), std::string("a"));
  REQUIRE_EQ(imported["progressSkipped"].size(), 1u);
  CHECK_EQ(imported["progressSkipped"][0].asString(), std::string("ghost"));
  CHECK_EQ(body(h.call("get_progress", kNoArgs))["completed"].size(), 1u);
}

TEST(mcp_import_subgraph_dry_run_previews_progress_that_would_skip) {
  Harness h;
  Json::Value nodes(Json::arrayValue);
  nodes.append(node("a", "A"));
  Json::Value progress(Json::arrayValue);
  progress.append(mark("a", "complete"));
  progress.append(mark("ghost", "active"));
  Json::Value args(Json::objectValue);
  args["nodes"] = nodes;
  args["progress"] = progress;
  args["dryRun"] = true;

  ToolResult result = h.call("import_subgraph", args);
  CHECK_FALSE(result.isError);
  const Json::Value preview = body(result);
  CHECK(preview["dryRun"].asBool());
  REQUIRE_EQ(preview["progressSkipped"].size(), 1u);
  CHECK_EQ(preview["progressSkipped"][0].asString(), std::string("ghost"));
  CHECK_FALSE(preview.isMember("progress"));
  CHECK_FALSE(preview.isMember("imported"));
  CHECK_EQ(body(h.call("get_progress", kNoArgs))["completed"].size(), 0u);
}

TEST(mcp_set_progress_bulk_is_order_safe_and_reports_each) {
  Harness h;
  h.call("create_node", node("a", "A"));
  Json::Value nodeB = node("b", "B");
  nodeB["parentId"] = "a";
  h.call("create_node", nodeB);

  Json::Value updates(Json::arrayValue);
  updates.append(mark("b", "complete"));
  updates.append(mark("a", "complete"));
  Json::Value args(Json::objectValue);
  args["updates"] = updates;

  ToolResult result = h.call("set_progress", args);
  CHECK_FALSE(result.isError);
  const Json::Value res = body(result);
  CHECK_EQ(res["results"].size(), 2u);
  for (const Json::Value& row : res["results"])
    if (row["nodeId"].asString() == "b") CHECK(row["prerequisitesMet"].asBool());
}

TEST(mcp_set_progress_rejects_an_unknown_node) {
  Harness h;
  CHECK(h.call("set_progress", mark("ghost", "complete")).isError);

  Json::Value updates(Json::arrayValue);
  updates.append(mark("ghost", "active"));
  Json::Value args(Json::objectValue);
  args["updates"] = updates;
  CHECK(h.call("set_progress", args).isError);
}

TEST(mcp_find_nodes_filters_by_color_kind_and_substring) {
  Harness h;
  Json::Value renderer = node("renderer", "WebGL2 Renderer");
  renderer["color"] = "sky";
  renderer["description"] = "hand-rolled GL";
  h.call("create_node", renderer);
  Json::Value camera = node("camera", "Pan & Zoom");
  camera["color"] = "sky";
  h.call("create_node", camera);
  Json::Value domain = node("domain", "DAG Domain");
  domain["color"] = "brick";
  h.call("create_node", domain);
  Json::Value kind(Json::objectValue);
  kind["id"] = "frontend";
  kind["hue"] = "sky";
  h.call("add_kind", kind);

  ToolResult result = h.call("find_nodes", with("color", "sky"));
  CHECK_FALSE(result.isError);
  const Json::Value byColor = body(result);
  CHECK_EQ(byColor["count"].asInt(), 2);
  CHECK_EQ(byColor["nodes"].size(), 2u);

  CHECK_EQ(body(h.call("find_nodes", with("kind", "frontend")))["count"].asInt(), 2);

  const Json::Value byQuery = body(h.call("find_nodes", with("query", "webgl")));
  CHECK_EQ(byQuery["count"].asInt(), 1);
  CHECK_EQ(byQuery["nodes"][0]["id"].asString(), std::string("renderer"));

  const Json::Value byDescription = body(h.call("find_nodes", with("query", "hand-rolled")));
  CHECK_EQ(byDescription["count"].asInt(), 1);
  CHECK_EQ(byDescription["nodes"][0]["id"].asString(), std::string("renderer"));

  Json::Value combined(Json::objectValue);
  combined["color"] = "sky";
  combined["query"] = "zoom";
  const Json::Value both = body(h.call("find_nodes", combined));
  CHECK_EQ(both["count"].asInt(), 1);
  CHECK_EQ(both["nodes"][0]["id"].asString(), std::string("camera"));

  CHECK(h.call("find_nodes", with("color", "chartreuse")).isError);
}

TEST(mcp_read_tools_deny_a_private_tree_you_dont_own) {
  Harness h;
  h.trees.byId["priv"] =
      StoredTree{LooseGraph().exportState(), LegendState{}, {"Theirs", {}}, 0, uid("someone"), Visibility::private_};

  const std::vector<const char*> reads = {"get_tree", "get_diagnostics", "get_health", "find_nodes"};
  for (const char* name : reads) {
    ToolResult denied = h.tools.callTool(name, with("treeId", "priv"), h.actor);
    ToolResult absent = h.tools.callTool(name, with("treeId", "nope"), h.actor);
    CHECK(denied.isError);
    CHECK(absent.isError);
    CHECK_EQ(message(denied), std::string(name) + ": no such tree \"priv\"");
    CHECK_EQ(message(absent), std::string(name) + ": no such tree \"nope\"");
  }

  const auto progArgs = [](const char* tree) {
    Json::Value a(Json::objectValue);
    a["treeId"] = tree; a["nodeId"] = "anything"; a["status"] = "complete";
    return a;
  };
  ToolResult progDenied = h.tools.callTool("set_progress", progArgs("priv"), h.actor);
  ToolResult progAbsent = h.tools.callTool("set_progress", progArgs("nope"), h.actor);
  CHECK(progDenied.isError);
  CHECK_EQ(message(progDenied), std::string("set_progress: no such tree \"priv\""));
  CHECK_EQ(message(progAbsent), std::string("set_progress: no such tree \"nope\""));
}

TEST(mcp_an_infrastructure_failure_answers_generically_and_never_leaks_its_detail) {
  FailingTreeRepository trees;
  FakeOpLog ops;
  FakeBus bus;
  FakeProgressRepository progressRepo;
  StepClock clock;
  FakeTokens tokens;
  RoomRegistry registry{trees, ops, bus};
  ProgressService progress{progressRepo};
  TreeRegistry treeRegistry{trees, progressRepo, tokens, Hlc{1, 0, "genesis"}, registry, clock};
  const UserId caller = uid("agent");
  RoadmapTools tools{registry, progress, clock, treeRegistry, bus};

  Json::Value args(Json::objectValue);
  args["treeId"] = "t";
  const ToolResult result = tools.callTool("get_tree", args, ToolCaller{caller, ToolScope::everything()});
  CHECK(result.isError);
  CHECK_EQ(message(result), std::string("get_tree: that call failed inside the server. The outcome may be uncertain; "
                                        "read the affected records before retrying. The detail is in the server log."));
  CHECK_EQ(message(result).find("hunter2"), std::string::npos);
  CHECK_EQ(message(result).find("db.internal"), std::string::npos);
}

TEST(mcp_read_tools_allow_an_unlisted_tree_by_a_stranger) {
  Harness h;
  h.trees.byId["shared"] =
      StoredTree{LooseGraph().exportState(), LegendState{}, {"Shared", {}}, 0, uid("someone"), Visibility::unlisted};

  CHECK_FALSE(h.tools.callTool("get_tree", with("treeId", "shared"), h.actor).isError);
  CHECK_FALSE(h.tools.callTool("get_diagnostics", with("treeId", "shared"), h.actor).isError);
  CHECK_FALSE(h.tools.callTool("find_nodes", with("treeId", "shared"), h.actor).isError);
}

TEST(mcp_read_tools_allow_your_own_private_tree) {
  Harness h;
  CHECK_FALSE(h.call("get_tree", Json::Value(Json::objectValue)).isError);
  CHECK_FALSE(h.call("get_diagnostics", Json::Value(Json::objectValue)).isError);
}

TEST(mcp_write_tools_refuse_an_unowned_public_tree_and_never_take_it) {
  Harness h;
  h.trees.byId["demo"] = StoredTree{LooseGraph().exportState(), LegendState{},
                                    {"Learn to sail", {}}, 0, std::nullopt, Visibility::public_};
  const StoredTree before = h.trees.byId["demo"];

  Json::Value edit(Json::objectValue);
  edit["treeId"] = "demo";
  edit["label"] = "Mine now";
  Json::Value graft(Json::objectValue);
  graft["treeId"] = "demo";
  graft["nodes"] = Json::Value(Json::arrayValue);
  graft["nodes"].append(node("seized", "Seized"));
  Json::Value preview = graft;
  preview["dryRun"] = true;
  Json::Value sweep(Json::objectValue);
  sweep["treeId"] = "demo";

  Json::Value guide(Json::objectValue);
  guide["treeId"] = "demo";
  guide["guide"] = "Mine now";

  const std::vector<std::pair<const char*, Json::Value>> writes = {
      {"create_node", edit}, {"import_subgraph", graft}, {"import_subgraph", preview}, {"prune", sweep},
      {"describe_tree", guide}};
  for (const auto& [tool, args] : writes) {
    ToolResult refused = h.tools.callTool(tool, args, h.actor);
    CHECK(refused.isError);
    CHECK_EQ(message(refused),
             std::string(tool) + ": no account owns this tree, so it cannot be edited. You can "
                                 "still read it with get_tree, and copy it into a roadmap of your "
                                 "own with create_tree then import_subgraph.");
  }

  CHECK_FALSE(h.trees.byId["demo"].owner.has_value());
  CHECK(h.trees.byId["demo"] == before);
  CHECK(h.ops.byTree["demo"].empty());
  CHECK(h.bus.subgraphBroadcasts.empty());

  ToolResult read = h.tools.callTool("get_tree", with("treeId", "demo"), h.actor);
  CHECK_FALSE(read.isError);
  CHECK_EQ(body(read)["tree"]["nodes"].size(), 0u);
}

TEST(mcp_write_tools_refuse_an_unowned_unlisted_tree) {
  Harness h;
  h.trees.byId["orphan"] = StoredTree{LooseGraph().exportState(), LegendState{},
                                      {"Orphan", {}}, 0, std::nullopt, Visibility::unlisted};

  Json::Value edit(Json::objectValue);
  edit["treeId"] = "orphan";
  edit["label"] = "Mine now";
  ToolResult refused = h.tools.callTool("create_node", edit, h.actor);

  CHECK(refused.isError);
  CHECK_EQ(message(refused),
           std::string("create_node: no account owns this tree, so it cannot be edited. You can "
                       "still read it with get_tree, and copy it into a roadmap of your own with "
                       "create_tree then import_subgraph."));
  CHECK_FALSE(h.trees.byId["orphan"].owner.has_value());
}

TEST(mcp_a_tree_another_account_owns_is_still_refused_by_name) {
  Harness h;
  h.trees.byId["theirs"] = StoredTree{LooseGraph().exportState(), LegendState{},
                                      {"Theirs", {}}, 0, uid("someone-else"), Visibility::unlisted};

  Json::Value edit(Json::objectValue);
  edit["treeId"] = "theirs";
  edit["label"] = "Mine now";
  ToolResult refused = h.tools.callTool("create_node", edit, h.actor);

  CHECK(refused.isError);
  CHECK_EQ(message(refused), std::string("create_node: this tree belongs to another account. Call "
                                         "list_trees to see the roadmaps you own."));
}

TEST(mcp_the_owner_still_writes_their_own_tree) {
  Harness h;
  ToolResult created = h.call("create_node", node("keel", "Keel"));
  CHECK_FALSE(created.isError);
  CHECK(body(created)["applied"].asBool());
  CHECK_EQ(body(created)["id"].asString(), std::string("keel"));
  CHECK(h.trees.byId["t"].owner == std::optional<UserId>(h.caller));
}

TEST(mcp_prune_clears_dangling_edges_and_orphan_progress) {
  Harness h;
  h.call("create_node", node("a", "A"));
  h.call("create_node", node("b", "B"));
  Json::Value edge(Json::objectValue);
  edge["from"] = "a";
  edge["to"] = "b";
  h.call("connect", edge);
  Json::Value toGhost(Json::objectValue);
  toGhost["from"] = "a";
  toGhost["to"] = "ghost";
  h.call("connect", toGhost);

  h.call("set_progress", mark("a", "complete"));
  h.call("set_progress", mark("b", "complete"));
  h.call("delete_node", with("id", "b"));

  ToolResult result = h.call("prune", kNoArgs);
  CHECK_FALSE(result.isError);
  const Json::Value pruned = body(result);
  CHECK_EQ(pruned["prunedEdges"].asInt(), 2);
  CHECK_EQ(pruned["prunedProgress"].asInt(), 1);
  CHECK(pruned["diagnosticsClean"].asBool());

  CHECK(body(h.call("get_diagnostics", kNoArgs))["dangling"].empty());
  const Json::Value prog = body(h.call("get_progress", kNoArgs));
  CHECK_EQ(prog["completed"].size(), 1u);
  CHECK_FALSE(prog.isMember("inProgress"));
}

// --- The read projections (adapters/mcp/ReadShape.h) ---------------------------------------

TEST(mcp_find_nodes_answers_an_index_and_get_tree_the_shape) {
  Harness h;
  Json::Value a = node("a", "A");
  a["description"] = "four thousand bytes of prose live here";
  a["x"] = 12.0;
  a["y"] = 34.0;
  h.call("create_node", a);
  Json::Value k(Json::objectValue);
  k["id"] = "infra";
  k["hue"] = "sky";
  k["description"] = "the generator's sorting brief";
  h.call("add_kind", k);

  const Json::Value found = body(h.call("find_nodes", kNoArgs));
  CHECK_EQ(keys(found), (std::vector<std::string>{"count", "nodes"}));
  CHECK_EQ(keys(found["nodes"][0]), (std::vector<std::string>{"color", "id", "label"}));

  const Json::Value got = body(h.call("get_tree", kNoArgs));
  CHECK_EQ(keys(got), (std::vector<std::string>{"count", "seq", "tree"}));
  CHECK_EQ(keys(got["tree"]), (std::vector<std::string>{"guide", "id", "kinds", "nodes", "title"}));
  CHECK_EQ(keys(got["tree"]["nodes"][0]),
           (std::vector<std::string>{"color", "id", "label", "prerequisites"}));
  CHECK_EQ(keys(got["tree"]["kinds"][0]), (std::vector<std::string>{"hue", "id", "label"}));

  h.call("set_progress", mark("a", "complete"));
  h.call("set_progress", mark("a", "none"));
  const Json::Value progress = body(h.call("get_progress", kNoArgs));
  CHECK_EQ(keys(progress), (std::vector<std::string>{"completed", "outOfOrder"}));
}

TEST(mcp_fields_round_trips_every_field_of_a_node) {
  Harness h;
  Json::Value seed = node("b", "B");
  seed["icon"] = "anchor";
  seed["color"] = "plum";
  seed["order"] = "a0";
  seed["seedStatus"] = "active";
  seed["description"] = "the whole annotation";
  Json::Value position(Json::objectValue);
  position["x"] = 12.0;
  position["y"] = 34.0;
  seed["position"] = position;
  Json::Value prereqs(Json::arrayValue);
  prereqs.append("a");
  seed["prerequisites"] = prereqs;
  Json::Value link(Json::objectValue);
  link["url"] = "https://spec";
  link["label"] = "Spec";
  Json::Value links(Json::arrayValue);
  links.append(link);
  seed["links"] = links;
  seed["opens"] = "t";

  Json::Value nodes(Json::arrayValue);
  nodes.append(node("a", "A"));
  nodes.append(seed);
  Json::Value imported(Json::objectValue);
  imported["nodes"] = nodes;
  CHECK_FALSE(h.call("import_subgraph", imported).isError);

  Json::Value args(Json::objectValue);
  args["fields"] = everyNodeField();
  const Json::Value b = body(h.call("get_tree", args))["tree"]["nodes"][1];
  CHECK_EQ(keys(b), (std::vector<std::string>{"color", "description", "icon", "id", "label", "links",
                                              "opens", "order", "position", "prerequisites", "seedStatus",
                                              "state", "status", "summary"}));  // no kind wears plum
  CHECK_EQ(b["opens"], parse(R"({"treeId":"t","title":"Test Roadmap","state":"open"})"));
  CHECK_EQ(b["id"].asString(), std::string("b"));
  CHECK_EQ(b["label"].asString(), std::string("B"));
  CHECK_EQ(b["icon"].asString(), std::string("anchor"));
  CHECK_EQ(b["color"].asString(), std::string("plum"));
  CHECK_EQ(b["order"].asString(), std::string("a0"));
  REQUIRE_EQ(b["prerequisites"].size(), 1u);
  CHECK_EQ(b["prerequisites"][0].asString(), std::string("a"));
  CHECK_EQ(b["position"]["x"].asDouble(), 12.0);
  CHECK_EQ(b["position"]["y"].asDouble(), 34.0);
  CHECK_EQ(b["seedStatus"].asString(), std::string("none"));
  CHECK_EQ(b["status"].asString(), std::string("none"));
  CHECK_EQ(b["state"].asString(), std::string("locked"));
  CHECK_EQ(b["description"].asString(), std::string("the whole annotation"));
  CHECK_EQ(b["summary"].asString(), std::string("the whole annotation"));
  CHECK_EQ(b["links"][0]["url"].asString(), std::string("https://spec"));
  CHECK_EQ(b["links"][0]["label"].asString(), std::string("Spec"));

  Json::Value search(Json::objectValue);
  search["query"] = "whole annotation";
  search["fields"] = list({"id", "description"});
  const Json::Value match = body(h.call("find_nodes", search))["nodes"][0];
  CHECK_EQ(keys(match), (std::vector<std::string>{"description", "id"}));
  CHECK_EQ(match["description"].asString(), std::string("the whole annotation"));
}

TEST(mcp_summary_is_the_descriptions_opening_and_says_when_it_was_cut) {
  Harness h;
  std::string words;
  for (int i = 0; i < 60; ++i) words += "word" + std::to_string(i) + " ";
  Json::Value annotated = node("long", "Long");
  annotated["description"] = words;
  h.call("create_node", annotated);
  Json::Value terse = node("short", "Short");
  terse["description"] = "one line";
  h.call("create_node", terse);

  Json::Value args(Json::objectValue);
  args["fields"] = list({"id", "summary"});
  const Json::Value nodes = body(h.call("get_tree", args))["tree"]["nodes"];
  REQUIRE_EQ(nodes.size(), 2u);
  const std::string summary = nodes[0]["summary"].asString();
  const std::string ellipsis = "\u2026";
  CHECK(summary.size() <= 200 + ellipsis.size());
  CHECK_EQ(summary.substr(summary.size() - ellipsis.size()), ellipsis);
  CHECK_EQ(summary.back(), ellipsis.back());
  CHECK(summary.find(' ' + ellipsis) == std::string::npos);
  CHECK_EQ(words.rfind(summary.substr(0, summary.size() - ellipsis.size()), 0), 0u);
  CHECK_EQ(nodes[1]["summary"].asString(), std::string("one line"));
  CHECK_FALSE(nodes[1].isMember("description"));
}

TEST(mcp_summary_budget_is_200_code_points_not_bytes) {
  Harness h;
  std::string cjk;
  for (int i = 0; i < 260; ++i) cjk += "\u5b57";  // 260 characters of 字, 780 bytes, no word boundary
  Json::Value annotated = node("cjk", "CJK");
  annotated["description"] = cjk;
  h.call("create_node", annotated);
  std::string accented;
  for (int i = 0; i < 150; ++i) accented += "\u00e9 ";  // 300 characters, 450 bytes, a word every two
  Json::Value worded = node("worded", "Worded");
  worded["description"] = accented;
  h.call("create_node", worded);

  Json::Value args(Json::objectValue);
  args["fields"] = list({"id", "summary"});
  const Json::Value nodes = body(h.call("get_tree", args))["tree"]["nodes"];
  REQUIRE_EQ(nodes.size(), 2u);
  std::string wholeCharacters;
  for (int i = 0; i < 200; ++i) wholeCharacters += "\u5b57";
  CHECK_EQ(nodes[0]["summary"].asString(), wholeCharacters + "\u2026");
  CHECK_EQ(nodes[0]["summary"].asString().size(), 603u);
  std::string atAWord;
  for (int i = 0; i < 99; ++i) atAWord += "\u00e9 ";
  CHECK_EQ(nodes[1]["summary"].asString(), atAWord + "\u00e9\u2026");
}

TEST(mcp_summary_never_cuts_inside_a_grapheme) {
  Harness h;
  std::string accentAtTheEdge(199, 'a');
  accentAtTheEdge += "e\u0301 and more";  // e + combining acute is code points 200 and 201
  Json::Value accented = node("accent", "Accent");
  accented["description"] = accentAtTheEdge;
  h.call("create_node", accented);
  std::string familyAtTheEdge(196, 'a');
  familyAtTheEdge += "\U0001F468\u200D\U0001F469\u200D\U0001F467\u200D\U0001F466 and more";  // the cut lands mid-family
  Json::Value family = node("family", "Family");
  family["description"] = familyAtTheEdge;
  h.call("create_node", family);
  std::string ascii(300, 'a');
  Json::Value plain = node("plain", "Plain");
  plain["description"] = ascii;
  h.call("create_node", plain);

  Json::Value args(Json::objectValue);
  args["fields"] = list({"id", "summary"});
  const Json::Value nodes = body(h.call("get_tree", args))["tree"]["nodes"];
  REQUIRE_EQ(nodes.size(), 3u);
  CHECK_EQ(nodes[0]["summary"].asString(), std::string(199, 'a') + "\u2026");
  CHECK_EQ(nodes[1]["summary"].asString(), std::string(196, 'a') + "\u2026");
  CHECK_EQ(nodes[2]["summary"].asString(), std::string(200, 'a') + "\u2026");
}

TEST(mcp_get_progress_reaches_the_cleared_tombstones_through_fields) {
  Harness h;
  h.call("create_node", node("a", "A"));
  h.call("create_node", node("b", "B"));
  h.call("set_progress", mark("a", "complete"));
  h.call("set_progress", mark("b", "complete"));
  h.call("set_progress", mark("b", "none"));

  const Json::Value lean = body(h.call("get_progress", kNoArgs));
  CHECK_EQ(keys(lean), (std::vector<std::string>{"completed", "outOfOrder"}));
  REQUIRE_EQ(lean["completed"].size(), 1u);
  CHECK_EQ(lean["completed"][0].asString(), std::string("a"));

  Json::Value args(Json::objectValue);
  args["fields"] = list({"completed", "cleared"});
  const Json::Value whole = body(h.call("get_progress", args));
  CHECK_EQ(keys(whole), (std::vector<std::string>{"cleared", "completed"}));
  REQUIRE_EQ(whole["cleared"].size(), 1u);
  CHECK_EQ(whole["cleared"][0].asString(), std::string("b"));
}

TEST(mcp_an_unknown_field_names_it_and_the_legal_set) {
  Harness h;

  Json::Value args(Json::objectValue);
  args["fields"] = list({"id", "labl"});
  ToolResult misspelled = h.call("find_nodes", args);
  CHECK(misspelled.isError);
  CHECK_EQ(message(misspelled),
           std::string("find_nodes: fields[1] \"labl\" is not one of {id, label, icon, color, kind, order, "
                       "prerequisites, position, status, seedStatus, state, summary, description, links, opens}"));

  Json::Value kindArgs(Json::objectValue);
  kindArgs["kindFields"] = list({"color"});
  ToolResult wrongVocabulary = h.call("get_tree", kindArgs);
  CHECK(wrongVocabulary.isError);
  CHECK_EQ(message(wrongVocabulary),
           std::string("get_tree: kindFields[0] \"color\" is not one of {id, hue, label, description, "
                       "crossBranchExempt}"));

  Json::Value progressArgs(Json::objectValue);
  progressArgs["fields"] = list({"nodes"});
  ToolResult wrongProgress = h.call("get_progress", progressArgs);
  CHECK(wrongProgress.isError);
  CHECK_EQ(message(wrongProgress),
           std::string("get_progress: fields[0] \"nodes\" is not one of {completed, cleared, outOfOrder}"));
}

TEST(mcp_limit_and_cursor_walk_the_whole_set_exactly_once) {
  Harness h;
  const std::vector<const char*> ids = {"a", "b", "c", "d", "e"};
  for (const char* id : ids) h.call("create_node", node(id, id));

  std::vector<std::string> walked;
  std::string cursor;
  int pages = 0;
  while (true) {
    Json::Value args(Json::objectValue);
    args["limit"] = 2;
    if (!cursor.empty()) args["cursor"] = cursor;
    ToolResult result = h.call("find_nodes", args);
    CHECK_FALSE(result.isError);
    const Json::Value page = body(result);
    CHECK_EQ(page["count"].asInt(), 5);
    for (const Json::Value& n : page["nodes"]) walked.push_back(n["id"].asString());
    ++pages;
    if (!page.isMember("nextCursor")) break;
    cursor = page["nextCursor"].asString();
    CHECK_EQ(cursor, walked.back());
  }

  CHECK_EQ(pages, 3);  // 2 + 2 + 1
  CHECK_EQ(walked, (std::vector<std::string>{"a", "b", "c", "d", "e"}));

  Json::Value firstArgs(Json::objectValue);
  firstArgs["limit"] = 3;
  const Json::Value first = body(h.call("get_tree", firstArgs));
  CHECK_EQ(first["count"].asInt(), 5);
  CHECK_EQ(first["tree"]["nodes"].size(), 3u);
  CHECK_EQ(first["nextCursor"].asString(), std::string("c"));

  Json::Value restArgs(Json::objectValue);
  restArgs["limit"] = 3;
  restArgs["cursor"] = "c";
  const Json::Value rest = body(h.call("get_tree", restArgs));
  CHECK_EQ(rest["count"].asInt(), 5);
  REQUIRE_EQ(rest["tree"]["nodes"].size(), 2u);
  CHECK_FALSE(rest.isMember("nextCursor"));
  CHECK_EQ(rest["tree"]["nodes"][0]["id"].asString(), std::string("d"));
  CHECK_EQ(rest["tree"]["nodes"][1]["id"].asString(), std::string("e"));
}

TEST(mcp_a_limit_out_of_range_and_an_unknown_cursor_are_named_errors) {
  Harness h;
  h.call("create_node", node("a", "A"));

  Json::Value tooMany(Json::objectValue);
  tooMany["limit"] = 5000;
  ToolResult refused = h.call("find_nodes", tooMany);
  CHECK(refused.isError);
  CHECK_EQ(message(refused),
           std::string("find_nodes: argument \"limit\" must be a number between 1 and 1000, got 5000"));

  Json::Value zero(Json::objectValue);
  zero["limit"] = 0;
  CHECK(h.call("get_tree", zero).isError);

  Json::Value ghost(Json::objectValue);
  ghost["cursor"] = "vanished";
  ToolResult lost = h.call("find_nodes", ghost);
  CHECK(lost.isError);
  CHECK_EQ(message(lost),
           std::string("find_nodes: cursor \"vanished\" names no node in this result set. "
                       "Call again without a cursor to walk it from the start."));
}

// --- Reads that answer the question asked --------------------------------------------------

TEST(mcp_status_answers_the_callers_own_mark_on_every_node) {
  Harness h;
  for (const char* id : {"done", "doing", "untouched"}) h.call("create_node", node(id, id));
  h.call("set_progress", mark("done", "complete"));
  h.call("set_progress", mark("doing", "active"));

  Json::Value args(Json::objectValue);
  args["fields"] = list({"id", "status"});
  const Json::Value tree = body(h.call("get_tree", args))["tree"]["nodes"];
  CHECK_EQ(ids(tree), (std::vector<std::string>{"doing", "done", "untouched"}));
  CHECK_EQ(keys(tree[0]), (std::vector<std::string>{"id", "status"}));
  CHECK_EQ(tree[0]["status"].asString(), std::string("none"));
  CHECK_EQ(tree[1]["status"].asString(), std::string("complete"));
  CHECK_EQ(tree[2]["status"].asString(), std::string("none"));

  const Json::Value found = body(h.call("find_nodes", args))["nodes"];
  CHECK_EQ(ids(found), (std::vector<std::string>{"doing", "done", "untouched"}));
  CHECK_EQ(found[0]["status"].asString(), std::string("none"));
  CHECK_EQ(found[1]["status"].asString(), std::string("complete"));
  CHECK_EQ(found[2]["status"].asString(), std::string("none"));

  CHECK_EQ(keys(body(h.call("find_nodes", kNoArgs))["nodes"][0]),
           (std::vector<std::string>{"color", "id", "label"}));
  CHECK_EQ(keys(body(h.call("get_tree", kNoArgs))["tree"]["nodes"][0]),
           (std::vector<std::string>{"color", "id", "label", "prerequisites"}));
}

TEST(mcp_status_is_the_readers_own_mark_and_never_another_readers) {
  Harness h;
  h.trees.byId["open"] = StoredTree{LooseGraph().exportState(), LegendState{}, {"Shared", {}}, 0,
                                    h.caller, Visibility::unlisted};
  Json::Value planted = node("step", "Step");
  planted["treeId"] = "open";
  h.tools.callTool("create_node", planted, h.actor);
  Json::Value marked = mark("step", "complete");
  marked["treeId"] = "open";
  h.tools.callTool("set_progress", marked, h.actor);

  Json::Value args(Json::objectValue);
  args["treeId"] = "open";
  args["fields"] = list({"id", "status"});
  const Json::Value mine = body(h.tools.callTool("get_tree", args, h.actor))["tree"]["nodes"][0];
  CHECK_EQ(mine["status"].asString(), std::string("complete"));

  const Json::Value theirs =
      body(h.tools.callTool("get_tree", args, ToolCaller{uid("stranger"), ToolScope::everything()}))["tree"]["nodes"][0];
  CHECK_EQ(keys(theirs), (std::vector<std::string>{"id", "status"}));
  CHECK_EQ(theirs["id"].asString(), std::string("step"));
  CHECK_EQ(theirs["status"].asString(), std::string("none"));
}

TEST(mcp_state_is_the_cascade_the_tree_derives_from_the_callers_marks) {
  Harness h;
  Json::Value chain(Json::arrayValue);
  chain.append(node("a", "A"));
  Json::Value b = node("b", "B");
  b["prerequisites"] = list({"a"});
  chain.append(b);
  Json::Value c = node("c", "C");
  c["prerequisites"] = list({"b"});
  chain.append(c);
  Json::Value imported(Json::objectValue);
  imported["nodes"] = chain;
  CHECK_FALSE(h.call("import_subgraph", imported).isError);
  h.call("set_progress", mark("a", "complete"));

  Json::Value args(Json::objectValue);
  args["fields"] = list({"id", "state", "status"});
  Json::Value tree = body(h.call("get_tree", args))["tree"]["nodes"];
  CHECK_EQ(ids(tree), (std::vector<std::string>{"a", "b", "c"}));
  CHECK_EQ(keys(tree[0]), (std::vector<std::string>{"id", "state", "status"}));
  CHECK_EQ(tree[0]["state"].asString(), std::string("complete"));
  CHECK_EQ(tree[1]["state"].asString(), std::string("available"));
  CHECK_EQ(tree[1]["status"].asString(), std::string("none"));
  CHECK_EQ(tree[2]["state"].asString(), std::string("locked"));

  h.call("set_progress", mark("b", "active"));
  Json::Value found = body(h.call("find_nodes", args))["nodes"];
  CHECK_EQ(ids(found), (std::vector<std::string>{"a", "b", "c"}));
  CHECK_EQ(found[1]["state"].asString(), std::string("available"));
  CHECK_EQ(found[1]["status"].asString(), std::string("none"));
  CHECK_EQ(found[2]["state"].asString(), std::string("locked"));

  h.trees.byId["open"] = StoredTree{LooseGraph().exportState(), LegendState{}, {"Shared", {}}, 0,
                                    h.caller, Visibility::unlisted};
  imported["treeId"] = "open";
  CHECK_FALSE(h.tools.callTool("import_subgraph", imported, h.actor).isError);
  Json::Value anonymous(Json::objectValue);
  anonymous["treeId"] = "open";
  anonymous["fields"] = list({"id", "state"});
  tree = body(h.tools.callTool("get_tree", anonymous, ToolCaller{UserId{}, ToolScope::everything()}))["tree"]["nodes"];
  CHECK_EQ(keys(tree[0]), (std::vector<std::string>{"id", "state"}));
  CHECK_EQ(tree[0]["state"].asString(), std::string("available"));
  CHECK_EQ(tree[1]["state"].asString(), std::string("locked"));
  CHECK_EQ(tree[2]["state"].asString(), std::string("locked"));

  CHECK_EQ(keys(body(h.call("find_nodes", kNoArgs))["nodes"][0]),
           (std::vector<std::string>{"color", "id", "label"}));
  CHECK_EQ(keys(body(h.call("get_tree", kNoArgs))["tree"]["nodes"][0]),
           (std::vector<std::string>{"color", "id", "label", "prerequisites"}));
}

TEST(mcp_find_nodes_by_state_is_the_frontier_in_one_call) {
  Harness h;
  Json::Value chain(Json::arrayValue);
  chain.append(node("a", "A"));
  Json::Value b = node("b", "B");
  b["prerequisites"] = list({"a"});
  chain.append(b);
  Json::Value c = node("c", "C");
  c["prerequisites"] = list({"b"});
  chain.append(c);
  Json::Value imported(Json::objectValue);
  imported["nodes"] = chain;
  CHECK_FALSE(h.call("import_subgraph", imported).isError);
  h.call("set_progress", mark("a", "complete"));

  const Json::Value frontier = body(h.call("find_nodes", with("state", "available")));
  CHECK_EQ(keys(frontier), (std::vector<std::string>{"count", "nodes"}));
  CHECK_EQ(frontier["count"].asUInt64(), 1u);
  CHECK_EQ(ids(frontier["nodes"]), (std::vector<std::string>{"b"}));
  CHECK_EQ(keys(frontier["nodes"][0]), (std::vector<std::string>{"color", "id", "label"}));

  Json::Value both = with("state", "available");
  both["query"] = "c";
  CHECK_EQ(body(h.call("find_nodes", both))["count"].asUInt64(), 0u);
  CHECK_EQ(ids(body(h.call("find_nodes", with("state", "locked")))["nodes"]),
           (std::vector<std::string>{"c"}));

  const ToolResult bogus = h.call("find_nodes", with("state", "bogus"));
  CHECK(bogus.isError);
  CHECK_EQ(message(bogus),
           std::string("find_nodes: state \"bogus\" is not one of {locked, available, complete}"));
}

TEST(mcp_state_still_answers_on_an_untidy_tree) {
  Harness h;
  Json::Value dangling = node("waits-on-ghost", "Waits");
  dangling["prerequisites"] = list({"ghost"});
  CHECK_FALSE(body(h.call("create_node", dangling))["diagnosticsClean"].asBool());
  h.call("create_node", node("x", "X"));
  Json::Value y = node("y", "Y");
  y["prerequisites"] = list({"x"});
  h.call("create_node", y);
  Json::Value back(Json::objectValue);
  back["from"] = "y";
  back["to"] = "x";
  CHECK_FALSE(body(h.call("connect", back))["diagnosticsClean"].asBool());
  CHECK_FALSE(body(h.call("get_diagnostics", kNoArgs))["cycles"].empty());
  CHECK_FALSE(body(h.call("get_diagnostics", kNoArgs))["dangling"].empty());

  Json::Value args(Json::objectValue);
  args["fields"] = list({"id", "state"});
  const ToolResult read = h.call("get_tree", args);
  CHECK_FALSE(read.isError);
  const Json::Value nodes = body(read)["tree"]["nodes"];
  CHECK_EQ(ids(nodes), (std::vector<std::string>{"waits-on-ghost", "x", "y"}));
  CHECK_EQ(nodes[0]["state"].asString(), std::string("available"));
  CHECK_EQ(nodes[1]["state"].asString(), std::string("locked"));
  CHECK_EQ(nodes[2]["state"].asString(), std::string("locked"));
  CHECK_EQ(ids(body(h.call("find_nodes", with("state", "locked")))["nodes"]),
           (std::vector<std::string>{"x", "y"}));
}

TEST(mcp_seed_status_is_the_documents_baseline_beside_the_callers_mark) {
  Harness h;
  Json::Value seeded = node("shipped", "Shipped");
  seeded["seedStatus"] = "complete";
  Json::Value nodes(Json::arrayValue);
  nodes.append(seeded);
  Json::Value imported(Json::objectValue);
  imported["nodes"] = nodes;
  CHECK_FALSE(h.call("import_subgraph", imported).isError);

  Json::Value args(Json::objectValue);
  args["fields"] = list({"id", "status", "seedStatus"});
  const Json::Value unmarked = body(h.call("find_nodes", args))["nodes"][0];
  CHECK_EQ(keys(unmarked), (std::vector<std::string>{"id", "seedStatus", "status"}));
  CHECK_EQ(unmarked["seedStatus"].asString(), std::string("complete"));
  CHECK_EQ(unmarked["status"].asString(), std::string("none"));

  h.call("set_progress", mark("shipped", "active"));
  const Json::Value marked = body(h.call("find_nodes", args))["nodes"][0];
  CHECK_EQ(marked["seedStatus"].asString(), std::string("complete"));
  CHECK_EQ(marked["status"].asString(), std::string("none"));
}

TEST(mcp_a_query_matches_a_node_by_its_own_id_and_ranks_the_exact_one_first) {
  Harness h;
  h.call("create_node", node("alpha", "First"));
  h.call("create_node", node("alpha-two", "Second"));
  h.call("create_node", node("gamma", "Alpha rising"));
  h.call("create_node", node("pre-alpha", "Prelude"));
  Json::Value mention = node("delta", "Delta");
  mention["description"] = "supersedes alpha";
  h.call("create_node", mention);

  const Json::Value ranked = body(h.call("find_nodes", with("query", "alpha")));
  CHECK_EQ(ranked["count"].asInt(), 5);
  CHECK_EQ(ids(ranked["nodes"]),
           (std::vector<std::string>{"alpha", "alpha-two", "gamma", "pre-alpha", "delta"}));

  const Json::Value shouted = body(h.call("find_nodes", with("query", "ALPHA")));
  CHECK_EQ(ids(shouted["nodes"]),
           (std::vector<std::string>{"alpha", "alpha-two", "gamma", "pre-alpha", "delta"}));

  Json::Value paged(Json::objectValue);
  paged["query"] = "alpha";
  paged["limit"] = 2;
  const Json::Value first = body(h.call("find_nodes", paged));
  CHECK_EQ(first["count"].asInt(), 5);
  CHECK_EQ(ids(first["nodes"]), (std::vector<std::string>{"alpha", "alpha-two"}));
  CHECK_EQ(first["nextCursor"].asString(), std::string("alpha-two"));
  paged["cursor"] = first["nextCursor"].asString();
  CHECK_EQ(ids(body(h.call("find_nodes", paged))["nodes"]),
           (std::vector<std::string>{"gamma", "pre-alpha"}));

  CHECK_EQ(ids(body(h.call("find_nodes", kNoArgs))["nodes"]),
           (std::vector<std::string>{"alpha", "alpha-two", "delta", "gamma", "pre-alpha"}));
}

TEST(mcp_an_edit_says_whether_the_dirt_it_reports_is_its_own) {
  Harness h;
  h.call("create_node", node("a", "A"));
  h.call("create_node", node("b", "B"));

  Json::Value ghost(Json::objectValue);
  ghost["from"] = "a";
  ghost["to"] = "ghost";
  const Json::Value guilty = body(h.call("connect", ghost));
  CHECK_FALSE(guilty["diagnosticsClean"].asBool());
  CHECK_EQ(introduced(guilty), (std::vector<std::string>{"dangling edge \"a\" -> \"ghost\""}));

  Json::Value renamed(Json::objectValue);
  renamed["nodeId"] = "a";
  renamed["label"] = "A renamed";
  const Json::Value innocent = body(h.call("rename_node", renamed));
  CHECK_FALSE(innocent["diagnosticsClean"].asBool());
  CHECK_EQ(introduced(innocent), std::vector<std::string>{});

  const Json::Value pruned = body(h.call("prune", kNoArgs));
  CHECK(pruned["diagnosticsClean"].asBool());
  CHECK_EQ(introduced(pruned), std::vector<std::string>{});
}

TEST(mcp_an_edit_names_the_cycle_the_dangle_and_the_self_edge_it_introduced) {
  Harness h;
  h.call("create_node", node("a", "A"));
  h.call("create_node", node("b", "B"));
  Json::Value forward(Json::objectValue);
  forward["from"] = "a";
  forward["to"] = "b";
  CHECK_EQ(introduced(body(h.call("connect", forward))), std::vector<std::string>{});

  Json::Value back(Json::objectValue);
  back["from"] = "b";
  back["to"] = "a";
  CHECK_EQ(introduced(body(h.call("connect", back))),
           (std::vector<std::string>{"cycle among \"a\", \"b\""}));

  Json::Value loop(Json::objectValue);
  loop["from"] = "a";
  loop["to"] = "a";
  CHECK_EQ(introduced(body(h.call("connect", loop))),
           (std::vector<std::string>{"self-edge on \"a\""}));

  const Json::Value deleted = body(h.call("delete_node", with("nodeId", "b")));
  CHECK_EQ(introduced(deleted),
           (std::vector<std::string>{"dangling edge \"a\" -> \"b\"", "dangling edge \"b\" -> \"a\""}));

  Json::Value orphan = node("c", "C");
  Json::Value prereqs(Json::arrayValue);
  prereqs.append("nowhere");
  orphan["prerequisites"] = prereqs;
  Json::Value nodes(Json::arrayValue);
  nodes.append(orphan);
  Json::Value imported(Json::objectValue);
  imported["nodes"] = nodes;
  CHECK_EQ(introduced(body(h.call("import_subgraph", imported))),
           (std::vector<std::string>{"dangling edge \"nowhere\" -> \"c\""}));
}

// --- delete_node and disconnect: the two-form batch contract ------------------------------

namespace {

Json::Value edge(const char* from, const char* to) {
  Json::Value e(Json::objectValue);
  e["from"] = from;
  e["to"] = to;
  return e;
}

// a -> b -> c -> d, with the caller's marks a complete, b complete, c cleared.
void chain(Harness& h) {
  for (const char* id : {"a", "b", "c", "d"}) h.call("create_node", node(id, id));
  h.call("connect", edge("a", "b"));
  h.call("connect", edge("b", "c"));
  h.call("connect", edge("c", "d"));
  h.call("set_progress", mark("a", "complete"));
  h.call("set_progress", mark("b", "complete"));
  h.call("set_progress", mark("c", "active"));
}

Json::Value edgeList(std::vector<std::pair<const char*, const char*>> pairs) {
  Json::Value edges(Json::arrayValue);
  for (const auto& [from, to] : pairs) edges.append(edge(from, to));
  return edges;
}

Seq headOf(Harness& h) { return body(h.call("get_tree", kNoArgs))["seq"].asInt64(); }

}

TEST(mcp_delete_node_array_with_one_missing_id_applies_nothing_and_names_it) {
  Harness h;
  chain(h);
  const Seq before = headOf(h);

  Json::Value args(Json::objectValue);
  args["nodeIds"] = list({"b", "ghost", "c", "phantom"});
  args["prune"] = true;
  ToolResult refused = h.call("delete_node", args);
  CHECK(refused.isError);
  CHECK_EQ(message(refused),
           std::string("delete_node: no node in this tree is named \"ghost\", \"phantom\" — nothing was "
                       "deleted. Call get_tree with fields [\"id\",\"label\"] to list the ids this tree has."));

  CHECK_EQ(headOf(h), before);
  CHECK_EQ(ids(body(h.call("get_tree", kNoArgs))["tree"]["nodes"]),
           (std::vector<std::string>{"a", "b", "c", "d"}));
  CHECK(body(h.call("get_diagnostics", kNoArgs))["dangling"].empty());
  CHECK_EQ(body(h.call("get_progress", kNoArgs))["completed"].size(), 2u);

  // An id deleted earlier is as missing as one never seen.
  h.call("delete_node", with("nodeId", "d"));
  Json::Value again(Json::objectValue);
  again["nodeIds"] = list({"d"});
  CHECK_EQ(message(h.call("delete_node", again)),
           std::string("delete_node: no node in this tree is named \"d\" — nothing was deleted. Call "
                       "get_tree with fields [\"id\",\"label\"] to list the ids this tree has."));
}

TEST(mcp_delete_node_prune_drops_the_edges_it_dangles_and_the_callers_marks_in_one_seq) {
  Harness h;
  chain(h);
  h.call("connect", edge("a", "ghost"));  // dirt this delete did not make: it stays
  const Seq before = headOf(h);

  Json::Value args(Json::objectValue);
  args["nodeIds"] = list({"b", "c"});
  args["prune"] = true;
  ToolResult result = h.call("delete_node", args);
  CHECK_FALSE(result.isError);
  const Json::Value receipt = body(result);
  CHECK_EQ(keys(receipt), (std::vector<std::string>{"applied", "diagnosticsClean", "ids",
                                                    "introducedDiagnostics", "pruned", "seq"}));
  CHECK(receipt["applied"].asBool());
  CHECK_EQ(receipt["seq"].asInt64(), before + 1);
  CHECK_EQ(receipt["ids"], list({"b", "c"}));
  CHECK_EQ(receipt["pruned"]["edges"].asInt(), 3);
  CHECK_EQ(receipt["pruned"]["progress"].asInt(), 1);
  CHECK_FALSE(receipt["diagnosticsClean"].asBool());  // a -> ghost was there before
  CHECK_EQ(introduced(receipt), std::vector<std::string>{});

  CHECK_EQ(headOf(h), before + 1);
  CHECK_EQ(ids(body(h.call("get_tree", kNoArgs))["tree"]["nodes"]), (std::vector<std::string>{"a", "d"}));
  const Json::Value dangling = body(h.call("get_diagnostics", kNoArgs))["dangling"];
  REQUIRE_EQ(dangling.size(), 1u);
  CHECK_EQ(dangling[0]["from"].asString(), std::string("a"));
  CHECK_EQ(dangling[0]["to"].asString(), std::string("ghost"));
  const Json::Value progress = body(h.call("get_progress", kNoArgs));
  CHECK_EQ(progress["completed"], list({"a"}));
  CHECK_FALSE(progress.isMember("inProgress"));

  // Nothing left to prune once the delete carried its own cleanup; the tree's old dirt is prune's.
  const Json::Value swept = body(h.call("prune", kNoArgs));
  CHECK_EQ(swept["prunedEdges"].asInt(), 1);
  CHECK_EQ(swept["prunedProgress"].asInt(), 0);
}

TEST(mcp_delete_node_prune_on_a_clean_tree_leaves_it_clean) {
  Harness h;
  chain(h);
  Json::Value args(Json::objectValue);
  args["nodeId"] = "b";
  args["prune"] = true;
  const Json::Value receipt = body(h.call("delete_node", args));
  CHECK(receipt["diagnosticsClean"].asBool());
  CHECK_EQ(receipt["id"].asString(), std::string("b"));
  CHECK_EQ(receipt["ids"], list({"b"}));
  CHECK_EQ(receipt["pruned"]["edges"].asInt(), 2);
  CHECK_EQ(receipt["pruned"]["progress"].asInt(), 1);
  CHECK(body(h.call("get_diagnostics", kNoArgs))["dangling"].empty());
}

TEST(mcp_delete_node_without_prune_still_lists_the_edges_it_dangled) {
  Harness h;
  chain(h);
  const Seq before = headOf(h);
  const Json::Value receipt = body(h.call("delete_node", with("nodeId", "b")));
  CHECK_EQ(keys(receipt), (std::vector<std::string>{"applied", "diagnosticsClean", "id", "ids",
                                                    "introducedDiagnostics", "pruned", "seq"}));
  CHECK_EQ(receipt["id"].asString(), std::string("b"));
  CHECK_EQ(receipt["ids"], list({"b"}));
  CHECK_EQ(receipt["seq"].asInt64(), before + 1);
  CHECK_FALSE(receipt["diagnosticsClean"].asBool());
  CHECK_EQ(introduced(receipt),
           (std::vector<std::string>{"dangling edge \"a\" -> \"b\"", "dangling edge \"b\" -> \"c\""}));
  CHECK_EQ(receipt["pruned"]["edges"].asInt(), 0);
  CHECK_EQ(receipt["pruned"]["progress"].asInt(), 0);
  CHECK_EQ(body(h.call("get_progress", kNoArgs))["completed"].size(), 2u);  // the mark on b stays

  const Json::Value legacy = body(h.call("delete_node", with("id", "c")));
  CHECK(legacy["applied"].asBool());
  CHECK_EQ(legacy["id"].asString(), std::string("c"));
}

TEST(mcp_delete_node_refuses_neither_form_both_forms_and_a_malformed_batch) {
  Harness h;
  chain(h);
  const Seq before = headOf(h);

  Json::Value neither(Json::objectValue);
  neither["prune"] = true;
  CHECK_EQ(message(h.call("delete_node", neither)),
           std::string("delete_node: missing required argument \"nodeId\" (or a \"nodeIds\" list of 1 to 200 "
                       "ids). Call get_tree with fields [\"id\",\"label\"] to list the ids this tree has."));

  Json::Value both(Json::objectValue);
  both["nodeId"] = "a";
  both["nodeIds"] = list({"b"});
  CHECK_EQ(message(h.call("delete_node", both)),
           std::string("delete_node: pass a single \"nodeId\" or a \"nodeIds\" list, not both — one form "
                       "names what this call deletes."));

  Json::Value empty(Json::objectValue);
  empty["nodeIds"] = Json::Value(Json::arrayValue);
  CHECK_EQ(message(h.call("delete_node", empty)),
           std::string("delete_node: argument \"nodeIds\" is an empty list — pass at least one id to delete."));

  Json::Value repeated(Json::objectValue);
  repeated["nodeIds"] = list({"a", "b", "a"});
  CHECK_EQ(message(h.call("delete_node", repeated)),
           std::string("delete_node: nodeIds[2] \"a\" is already used by nodeIds[0] — an id names one node "
                       "per batch"));

  Json::Value tooMany(Json::objectValue);
  Json::Value many(Json::arrayValue);
  for (int i = 0; i < 201; ++i) many.append("n" + std::to_string(i));
  tooMany["nodeIds"] = many;
  CHECK_EQ(message(h.call("delete_node", tooMany)), std::string("delete_node: nodeIds has 201 items, max 200"));

  Json::Value notStrings(Json::objectValue);
  notStrings["nodeIds"] = "a";
  CHECK_EQ(message(h.call("delete_node", notStrings)),
           std::string("delete_node: argument \"nodeIds\" must be an array of strings, got string"));

  Json::Value badPrune(Json::objectValue);
  badPrune["nodeId"] = "a";
  badPrune["prune"] = "yes";
  CHECK_EQ(message(h.call("delete_node", badPrune)),
           std::string("delete_node: argument \"prune\" must be a boolean, got string"));

  CHECK_EQ(headOf(h), before);
  CHECK_EQ(ids(body(h.call("get_tree", kNoArgs))["tree"]["nodes"]),
           (std::vector<std::string>{"a", "b", "c", "d"}));
}

TEST(mcp_disconnect_batch_removes_every_edge_under_one_seq_and_counts_the_present_ones) {
  Harness h;
  chain(h);
  const Seq before = headOf(h);

  Json::Value args(Json::objectValue);
  args["edges"] = edgeList({{"a", "b"}, {"c", "d"}, {"x", "y"}});
  ToolResult result = h.call("disconnect", args);
  CHECK_FALSE(result.isError);
  const Json::Value receipt = body(result);
  CHECK_EQ(keys(receipt),
           (std::vector<std::string>{"applied", "diagnosticsClean", "introducedDiagnostics", "removed", "seq"}));
  CHECK(receipt["applied"].asBool());
  CHECK_EQ(receipt["seq"].asInt64(), before + 1);
  CHECK_EQ(receipt["removed"].asInt(), 2);
  CHECK(receipt["diagnosticsClean"].asBool());
  CHECK_EQ(introduced(receipt), std::vector<std::string>{});

  CHECK_EQ(headOf(h), before + 1);
  Json::Value shape(Json::objectValue);
  shape["fields"] = list({"id", "prerequisites"});
  const Json::Value nodes = body(h.call("get_tree", shape))["tree"]["nodes"];
  REQUIRE_EQ(nodes.size(), 4u);
  CHECK(nodes[0]["prerequisites"].empty());
  CHECK(nodes[1]["prerequisites"].empty());
  CHECK_EQ(nodes[2]["prerequisites"], list({"b"}));
  CHECK(nodes[3]["prerequisites"].empty());

  // The single form is the same contract with one edge, and an absent edge is a no-op there too:
  // nothing lands, so no seq is minted.
  const Json::Value single = body(h.call("disconnect", edge("b", "c")));
  CHECK_EQ(single["removed"].asInt(), 1);
  CHECK_EQ(single["seq"].asInt64(), before + 2);
  const Json::Value absent = body(h.call("disconnect", edge("b", "c")));
  CHECK(absent["applied"].asBool());
  CHECK_EQ(absent["removed"].asInt(), 0);
  CHECK_EQ(absent["seq"].asInt64(), before + 2);
}

TEST(mcp_disconnecting_an_edge_the_tree_never_held_plants_no_tombstone) {
  Harness h;
  chain(h);
  const Seq before = headOf(h);
  const std::size_t entries = h.registry.open(tid())->exportState().edges.size();
  CHECK_EQ(entries, 3u);

  Json::Value args(Json::objectValue);
  args["edges"] = edgeList({{"x", "y"}, {"a", "d"}, {"d", "a"}});
  const Json::Value receipt = body(h.call("disconnect", args));
  CHECK(receipt["applied"].asBool());
  CHECK_EQ(receipt["removed"].asInt(), 0);
  CHECK_EQ(receipt["seq"].asInt64(), before);
  CHECK_EQ(h.registry.open(tid())->exportState().edges.size(), entries);
  CHECK_EQ(h.ops.byTree["t"].size(), static_cast<std::size_t>(before));
  CHECK_EQ(h.bus.subgraphBroadcasts.size(), static_cast<std::size_t>(before));

  const Json::Value single = body(h.call("disconnect", edge("x", "y")));
  CHECK_EQ(single["removed"].asInt(), 0);
  CHECK_EQ(h.registry.open(tid())->exportState().edges.size(), entries);

  // A present edge among absent ones still lands, alone, as the one entry the frame touches.
  args["edges"] = edgeList({{"x", "y"}, {"a", "b"}});
  const Json::Value mixed = body(h.call("disconnect", args));
  CHECK_EQ(mixed["removed"].asInt(), 1);
  CHECK_EQ(mixed["seq"].asInt64(), before + 1);
  CHECK_EQ(h.registry.open(tid())->exportState().edges.size(), entries);
  CHECK_EQ(h.bus.subgraphBroadcasts.back().subgraph.graph.edges.size(), 1u);
}

TEST(mcp_disconnect_refuses_neither_form_both_forms_and_a_malformed_batch) {
  Harness h;
  chain(h);
  const Seq before = headOf(h);

  CHECK_EQ(message(h.call("disconnect", kNoArgs)),
           std::string("disconnect: missing required arguments \"from\" and \"to\" (or an \"edges\" list of "
                       "{from, to}, 1 to 500 edges). Call get_tree with fields [\"id\",\"prerequisites\"] to "
                       "list the edges this tree has."));

  Json::Value both = edge("a", "b");
  both["edges"] = edgeList({{"b", "c"}});
  CHECK_EQ(message(h.call("disconnect", both)),
           std::string("disconnect: pass a single \"from\"+\"to\" or an \"edges\" list, not both — one form "
                       "names what this call removes."));

  CHECK_EQ(message(h.call("disconnect", with("from", "a"))),
           std::string("disconnect: missing required argument \"to\""));

  Json::Value empty(Json::objectValue);
  empty["edges"] = Json::Value(Json::arrayValue);
  CHECK_EQ(message(h.call("disconnect", empty)),
           std::string("disconnect: argument \"edges\" is an empty list — pass at least one {from, to} to remove."));

  Json::Value halfRow(Json::objectValue);
  halfRow["edges"] = edgeList({{"a", "b"}});
  halfRow["edges"][0].removeMember("to");
  CHECK_EQ(message(h.call("disconnect", halfRow)),
           std::string("disconnect: missing required argument \"edges[0].to\""));

  Json::Value repeated(Json::objectValue);
  repeated["edges"] = edgeList({{"a", "b"}, {"b", "c"}, {"a", "b"}});
  CHECK_EQ(message(h.call("disconnect", repeated)),
           std::string("disconnect: edges[2] repeats edges[0] (\"a\" -> \"b\") — an edge is named once per batch"));

  Json::Value tooMany(Json::objectValue);
  Json::Value many(Json::arrayValue);
  for (int i = 0; i < 501; ++i) many.append(edge("a", ("n" + std::to_string(i)).c_str()));
  tooMany["edges"] = many;
  CHECK_EQ(message(h.call("disconnect", tooMany)), std::string("disconnect: edges has 501 items, max 500"));

  CHECK_EQ(headOf(h), before);
  CHECK_EQ(body(h.call("get_tree", kNoArgs))["tree"]["nodes"].size(), 4u);
}

TEST(mcp_delete_node_and_disconnect_publish_both_forms_in_their_schemas) {
  Harness h;
  const Json::Value catalog = h.tools.listTools(h.actor);

  const Json::Value* del = nullptr;
  const Json::Value* dis = nullptr;
  for (const Json::Value& tool : catalog) {
    if (tool["name"].asString() == "delete_node") del = &tool;
    if (tool["name"].asString() == "disconnect") dis = &tool;
  }
  REQUIRE(del != nullptr);
  REQUIRE(dis != nullptr);

  const Json::Value& deleteSchema = (*del)["inputSchema"];
  CHECK_EQ(deleteSchema["required"], list({"treeId"}));
  CHECK_EQ(deleteSchema["properties"]["nodeId"]["type"].asString(), std::string("string"));
  CHECK(deleteSchema["properties"]["id"]["deprecated"].asBool());
  CHECK_EQ(deleteSchema["properties"]["nodeIds"]["type"].asString(), std::string("array"));
  CHECK_EQ(deleteSchema["properties"]["nodeIds"]["items"]["type"].asString(), std::string("string"));
  CHECK_EQ(deleteSchema["properties"]["nodeIds"]["minItems"].asInt(), 1);
  CHECK_EQ(deleteSchema["properties"]["nodeIds"]["maxItems"].asInt(), 200);
  CHECK_EQ(deleteSchema["properties"]["prune"]["type"].asString(), std::string("boolean"));
  CHECK(deleteSchema["additionalProperties"].isBool());
  CHECK_FALSE(deleteSchema["additionalProperties"].asBool());

  const Json::Value& disconnectSchema = (*dis)["inputSchema"];
  CHECK_EQ(disconnectSchema["required"], list({"treeId"}));
  const Json::Value& edges = disconnectSchema["properties"]["edges"];
  CHECK_EQ(edges["type"].asString(), std::string("array"));
  CHECK_EQ(edges["minItems"].asInt(), 1);
  CHECK_EQ(edges["maxItems"].asInt(), 500);
  CHECK_EQ(edges["items"]["type"].asString(), std::string("object"));
  CHECK_EQ(edges["items"]["required"], list({"from", "to"}));
  CHECK(edges["items"]["additionalProperties"].isBool());
  CHECK_FALSE(edges["items"]["additionalProperties"].asBool());
  CHECK_EQ(edges["items"]["properties"]["from"]["type"].asString(), std::string("string"));
  CHECK_EQ(edges["items"]["properties"]["to"]["type"].asString(), std::string("string"));
}

namespace {

Json::Value nodeWith(const char* id, std::vector<const char*> prerequisites) {
  Json::Value n = node(id, id);
  n["prerequisites"] = list(std::move(prerequisites));
  return n;
}

Json::Value importOf(std::vector<Json::Value> nodes) {
  Json::Value args(Json::objectValue);
  args["nodes"] = Json::Value(Json::arrayValue);
  for (const Json::Value& n : nodes) args["nodes"].append(n);
  return args;
}

const Json::Value* nodeNamed(const Json::Value& tree, const char* id) {
  for (const Json::Value& n : tree["tree"]["nodes"])
    if (n["id"].asString() == id) return &n;
  return nullptr;
}

std::vector<std::string> strings(const Json::Value& array) {
  std::vector<std::string> out;
  for (const Json::Value& v : array) out.push_back(v.asString());
  return out;
}

// a, b, c present; n hangs off a and c.
void seedFan(Harness& h) {
  h.call("create_node", node("a", "A"));
  h.call("create_node", node("b", "B"));
  h.call("create_node", node("c", "C"));
  CHECK_FALSE(h.call("import_subgraph", importOf({nodeWith("n", {"a", "c"})})).isError);
}

}

TEST(mcp_import_subgraph_merge_keeps_the_edge_the_batch_left_out_and_reports_it) {
  Harness h;
  seedFan(h);

  ToolResult result = h.call("import_subgraph", importOf({nodeWith("n", {"a", "b"})}));
  CHECK_FALSE(result.isError);
  const Json::Value receipt = body(result);
  CHECK_EQ(receipt["prerequisiteMode"].asString(), std::string("merge"));
  REQUIRE_EQ(receipt["keptEdges"].size(), 1u);
  CHECK_EQ(receipt["keptEdges"][0]["from"].asString(), std::string("c"));
  CHECK_EQ(receipt["keptEdges"][0]["to"].asString(), std::string("n"));
  CHECK_EQ(receipt["keptEdgeCount"].asUInt64(), 1u);
  CHECK_FALSE(receipt.isMember("removedEdges"));
  CHECK_EQ(receipt["tombstoned"]["nodes"].asUInt64(), 0u);
  CHECK_EQ(receipt["tombstoned"]["edges"].asUInt64(), 0u);
  CHECK_EQ(receipt["edges"].asInt(), 2);

  const Json::Value got = body(h.call("get_tree", kNoArgs));
  REQUIRE(nodeNamed(got, "n") != nullptr);
  CHECK_EQ(strings((*nodeNamed(got, "n"))["prerequisites"]), (std::vector<std::string>{"a", "b", "c"}));
}

TEST(mcp_import_subgraph_replace_drops_the_unnamed_edge_and_a_later_merge_re_adds_it) {
  Harness h;
  seedFan(h);

  Json::Value args = importOf({nodeWith("n", {"a", "b"})});
  args["prerequisiteMode"] = "replace";
  ToolResult result = h.call("import_subgraph", args);
  CHECK_FALSE(result.isError);
  const Json::Value receipt = body(result);
  CHECK_EQ(receipt["prerequisiteMode"].asString(), std::string("replace"));
  CHECK_EQ(receipt["keptEdges"].size(), 0u);
  CHECK_EQ(receipt["keptEdgeCount"].asUInt64(), 0u);
  CHECK_EQ(receipt["removedEdges"].asUInt64(), 1u);
  CHECK(receipt["diagnosticsClean"].asBool());

  Json::Value got = body(h.call("get_tree", kNoArgs));
  REQUIRE(nodeNamed(got, "n") != nullptr);
  CHECK_EQ(strings((*nodeNamed(got, "n"))["prerequisites"]), (std::vector<std::string>{"a", "b"}));

  CHECK_FALSE(h.call("import_subgraph", importOf({nodeWith("n", {"c"})})).isError);
  got = body(h.call("get_tree", kNoArgs));
  CHECK_EQ(strings((*nodeNamed(got, "n"))["prerequisites"]), (std::vector<std::string>{"a", "b", "c"}));
}

TEST(mcp_import_subgraph_replace_on_a_revived_id_removes_the_edges_its_delete_left_behind) {
  Harness h;
  seedFan(h);
  CHECK_FALSE(h.call("delete_node", with("nodeId", "n")).isError);  // no prune: a->n, c->n stay present
  CHECK(nodeNamed(body(h.call("get_tree", kNoArgs)), "n") == nullptr);

  Json::Value preview = importOf({nodeWith("n", {"b"})});
  preview["dryRun"] = true;
  Json::Value receipt = body(h.call("import_subgraph", preview));
  CHECK_EQ(receipt["nodeCollisions"].size(), 0u);  // not present, so not a collision — but not new to the tree either
  REQUIRE_EQ(receipt["keptEdges"].size(), 2u);
  CHECK_EQ(receipt["keptEdges"][0]["from"].asString(), std::string("a"));
  CHECK_EQ(receipt["keptEdges"][1]["from"].asString(), std::string("c"));
  CHECK_EQ(receipt["keptEdgeCount"].asUInt64(), 2u);

  Json::Value args = importOf({nodeWith("n", {"b"})});
  args["prerequisiteMode"] = "replace";
  ToolResult result = h.call("import_subgraph", args);
  CHECK_FALSE(result.isError);
  receipt = body(result);
  CHECK_EQ(receipt["keptEdgeCount"].asUInt64(), 0u);
  CHECK_EQ(receipt["removedEdges"].asUInt64(), 2u);
  CHECK(receipt["diagnosticsClean"].asBool());

  const Json::Value got = body(h.call("get_tree", kNoArgs));
  REQUIRE(nodeNamed(got, "n") != nullptr);
  CHECK_EQ(strings((*nodeNamed(got, "n"))["prerequisites"]), (std::vector<std::string>{"b"}));
}

TEST(mcp_import_subgraph_keeps_every_field_a_re_sent_node_leaves_out) {
  Harness h;
  CHECK_FALSE(h.call("import_subgraph", parse(R"({"nodes":[{"id":"ask","label":"Ask AI"},
    {"id":"review","label":"Backend review","icon":"magnifier","color":"sky","order":"a0","position":{"x":3,"y":4},
     "seedStatus":"complete","description":"Read the diff.","links":[{"url":"https://windmill.works/review","label":"guide"}]}]})")).isError);
  const Json::Value read = parse(R"({"nodeIds":["review"],"fields":["id","label","icon","color","order",
    "prerequisites","position","seedStatus","description","links"]})");

  const ToolResult result = h.call("import_subgraph", parse(R"({"nodes":[{"id":"review","prerequisites":["ask"]}]})"));
  CHECK_FALSE(result.isError);
  CHECK_EQ(body(result), parse(R"({"nodes":1,"edges":1,"kinds":0,"nodeCollisions":["review"],"kindCollisions":[],
    "newNodes":0,"newKinds":0,"prerequisiteMode":"merge","keptEdges":[],"keptEdgeCount":0,
    "tombstoned":{"nodes":0,"edges":0},"graphApplied":true,"progressApplied":true,"imported":true,"seq":2,
    "diagnosticsClean":true,"introducedDiagnostics":[]})"));
  CHECK_EQ(body(h.call("get_nodes", read)), parse(R"({"treeId":"t","seq":2,"nodes":[
    {"id":"review","label":"Backend review","icon":"magnifier","color":"sky","order":"a0","prerequisites":["ask"],
     "position":{"x":3.0,"y":4.0},"seedStatus":"complete","description":"Read the diff.",
     "links":[{"url":"https://windmill.works/review","label":"guide"}]}],"missingNodeIds":[]})"));
}

TEST(mcp_import_subgraph_applies_every_field_a_re_sent_node_carries_and_an_empty_one_clears_it) {
  Harness h;
  CHECK_FALSE(h.call("import_subgraph", parse(R"({"nodes":[{"id":"ask","label":"Ask AI"},
    {"id":"review","label":"Backend review","icon":"magnifier","color":"sky","order":"a0","position":{"x":3,"y":4},
     "seedStatus":"complete","description":"Read the diff.","links":[{"url":"https://windmill.works/review","label":"guide"}]}]})")).isError);
  const Json::Value read = parse(R"({"nodeIds":["review"],"fields":["id","label","icon","color","order",
    "prerequisites","position","seedStatus","description","links"]})");

  const ToolResult result = h.call("import_subgraph", parse(R"({"nodes":[{"id":"review","label":"Review the backend",
    "icon":"","color":"plum","order":"","position":{"x":9,"y":10},"seedStatus":"none","description":"","links":[]}]})"));
  CHECK_FALSE(result.isError);
  CHECK_EQ(body(result), parse(R"({"nodes":1,"edges":0,"kinds":0,"nodeCollisions":["review"],"kindCollisions":[],
    "newNodes":0,"newKinds":0,"prerequisiteMode":"merge","keptEdges":[],"keptEdgeCount":0,
    "tombstoned":{"nodes":0,"edges":0},"graphApplied":true,"progressApplied":true,"imported":true,"seq":2,
    "diagnosticsClean":true,"introducedDiagnostics":[]})"));
  CHECK_EQ(body(h.call("get_nodes", read)), parse(R"({"treeId":"t","seq":2,"nodes":[
    {"id":"review","label":"Review the backend","icon":"","color":"plum","prerequisites":[],
     "position":{"x":9.0,"y":10.0},"seedStatus":"none"}],"missingNodeIds":[]})"));
}

TEST(mcp_import_subgraph_lands_a_new_node_with_the_defaults_for_what_it_leaves_out) {
  Harness h;
  const ToolResult result = h.call("import_subgraph", parse(R"({"nodes":[{"id":"fresh"}]})"));
  CHECK_FALSE(result.isError);
  CHECK_EQ(body(result), parse(R"({"nodes":1,"edges":0,"kinds":0,"nodeCollisions":[],"kindCollisions":[],
    "newNodes":1,"newKinds":0,"prerequisiteMode":"merge","keptEdges":[],"keptEdgeCount":0,
    "tombstoned":{"nodes":0,"edges":0},"graphApplied":true,"progressApplied":true,"imported":true,"seq":1,
    "diagnosticsClean":true,"introducedDiagnostics":[]})"));
  CHECK_EQ(body(h.call("get_nodes", parse(R"({"nodeIds":["fresh"],"fields":["id","label","icon","color","order",
    "prerequisites","position","seedStatus","description","links"]})"))),
           parse(R"({"treeId":"t","seq":1,"nodes":[{"id":"fresh","label":"","icon":"","color":"terracotta",
    "prerequisites":[]}],"missingNodeIds":[]})"));
}

TEST(mcp_import_subgraph_replace_swaps_a_re_sent_nodes_prerequisites_and_keeps_the_fields_it_leaves_out) {
  Harness h;
  CHECK_FALSE(h.call("import_subgraph", parse(R"({"nodes":[{"id":"ask","label":"Ask AI"},
    {"id":"review","label":"Backend review","icon":"magnifier","color":"sky","order":"a0","position":{"x":3,"y":4},
     "seedStatus":"complete","description":"Read the diff.","links":[{"url":"https://windmill.works/review","label":"guide"}]}]})")).isError);
  const Json::Value read = parse(R"({"nodeIds":["review"],"fields":["id","label","icon","color","order",
    "prerequisites","position","seedStatus","description","links"]})");
  CHECK_FALSE(h.call("import_subgraph", parse(R"({"nodes":[{"id":"review","prerequisites":["ask"]}]})")).isError);

  const ToolResult result = h.call("import_subgraph", parse(R"({"nodes":[{"id":"plan","label":"Plan"},
    {"id":"review","prerequisites":["plan"]}],"prerequisiteMode":"replace"})"));
  CHECK_FALSE(result.isError);
  CHECK_EQ(body(result), parse(R"({"nodes":2,"edges":1,"kinds":0,"nodeCollisions":["review"],"kindCollisions":[],
    "newNodes":1,"newKinds":0,"prerequisiteMode":"replace","keptEdges":[],"keptEdgeCount":0,"removedEdges":1,
    "tombstoned":{"nodes":0,"edges":0},"graphApplied":true,"progressApplied":true,"imported":true,"seq":3,
    "diagnosticsClean":true,"introducedDiagnostics":[]})"));
  CHECK_EQ(body(h.call("get_nodes", read)), parse(R"({"treeId":"t","seq":3,"nodes":[
    {"id":"review","label":"Backend review","icon":"magnifier","color":"sky","order":"a0","prerequisites":["plan"],
     "position":{"x":3.0,"y":4.0},"seedStatus":"complete","description":"Read the diff.",
     "links":[{"url":"https://windmill.works/review","label":"guide"}]}],"missingNodeIds":[]})"));
}

TEST(mcp_import_subgraph_revives_a_deleted_node_with_the_fields_it_leaves_out) {
  Harness h;
  CHECK_FALSE(h.call("import_subgraph", parse(R"({"nodes":[{"id":"ask","label":"Ask AI"},
    {"id":"review","label":"Backend review","icon":"magnifier","color":"sky","order":"a0","position":{"x":3,"y":4},
     "seedStatus":"complete","description":"Read the diff.","links":[{"url":"https://windmill.works/review","label":"guide"}]}]})")).isError);
  const Json::Value read = parse(R"({"nodeIds":["review"],"fields":["id","label","icon","color","order",
    "prerequisites","position","seedStatus","description","links"]})");
  CHECK_FALSE(h.call("delete_node", with("nodeId", "review")).isError);

  const ToolResult result = h.call("import_subgraph", parse(R"({"nodes":[{"id":"review"}]})"));
  CHECK_FALSE(result.isError);
  CHECK_EQ(body(result), parse(R"({"nodes":1,"edges":0,"kinds":0,"nodeCollisions":[],"kindCollisions":[],
    "newNodes":1,"newKinds":0,"prerequisiteMode":"merge","keptEdges":[],"keptEdgeCount":0,
    "tombstoned":{"nodes":0,"edges":0},"graphApplied":true,"progressApplied":true,"imported":true,"seq":3,
    "diagnosticsClean":true,"introducedDiagnostics":[]})"));
  CHECK_EQ(body(h.call("get_nodes", read)), parse(R"({"treeId":"t","seq":3,"nodes":[
    {"id":"review","label":"Backend review","icon":"magnifier","color":"sky","order":"a0","prerequisites":[],
     "position":{"x":3.0,"y":4.0},"seedStatus":"complete","description":"Read the diff.",
     "links":[{"url":"https://windmill.works/review","label":"guide"}]}],"missingNodeIds":[]})"));
}

TEST(mcp_import_subgraph_dry_run_of_a_field_less_node_previews_the_collision_and_changes_nothing) {
  Harness h;
  CHECK_FALSE(h.call("import_subgraph", parse(R"({"nodes":[{"id":"ask","label":"Ask AI"},
    {"id":"review","label":"Backend review","icon":"magnifier","color":"sky","order":"a0","position":{"x":3,"y":4},
     "seedStatus":"complete","description":"Read the diff.","links":[{"url":"https://windmill.works/review","label":"guide"}]}]})")).isError);
  const Json::Value read = parse(R"({"nodeIds":["review"],"fields":["id","label","icon","color","order",
    "prerequisites","position","seedStatus","description","links"]})");

  const ToolResult result = h.call("import_subgraph", parse(R"({"nodes":[{"id":"review","prerequisites":["ask"]}],
    "dryRun":true})"));
  CHECK_FALSE(result.isError);
  CHECK_EQ(body(result), parse(R"({"nodes":1,"edges":1,"kinds":0,"nodeCollisions":["review"],"kindCollisions":[],
    "newNodes":0,"newKinds":0,"prerequisiteMode":"merge","keptEdges":[],"keptEdgeCount":0,
    "tombstoned":{"nodes":0,"edges":0},"dryRun":true,"tombstone":[]})"));
  CHECK_EQ(body(h.call("get_nodes", read)), parse(R"({"treeId":"t","seq":1,"nodes":[
    {"id":"review","label":"Backend review","icon":"magnifier","color":"sky","order":"a0","prerequisites":[],
     "position":{"x":3.0,"y":4.0},"seedStatus":"complete","description":"Read the diff.",
     "links":[{"url":"https://windmill.works/review","label":"guide"}]}],"missingNodeIds":[]})"));
}

TEST(mcp_import_subgraph_tombstone_needs_the_delete_grant_the_way_delete_node_does) {
  Harness h;
  seedFan(h);
  CompositeToolHost gate(std::vector<ToolModule>{{h.tools, ""}});
  const ToolCaller writer{h.caller, parseToolScope("roadmap:read roadmap:write")};
  const ToolCaller deleter{h.caller, parseToolScope("roadmap:read roadmap:write roadmap:delete")};

  Json::Value del = with("nodeId", "n");
  del["treeId"] = "t";
  CHECK_EQ(message(gate.callTool("delete_node", del, writer)),
           std::string("delete_node: this connection was not granted roadmap:delete, so it cannot run this "
                       "tool. Reconnect and approve that level."));

  Json::Value tombstone = importOf({});
  tombstone["treeId"] = "t";
  tombstone["tombstone"] = list({"n"});
  const std::size_t saves = h.trees.savedNodeCounts.size();
  const ToolResult refused = gate.callTool("import_subgraph", tombstone, writer);
  CHECK(refused.isError);
  CHECK_EQ(message(refused),
           std::string("import_subgraph: this connection was not granted roadmap:delete, so it cannot run "
                       "this tool. Reconnect and approve that level."));
  CHECK_EQ(h.trees.savedNodeCounts.size(), saves);
  CHECK(nodeNamed(body(h.call("get_tree", kNoArgs)), "n") != nullptr);

  Json::Value plain = importOf({nodeWith("x", {"a"})});
  plain["treeId"] = "t";
  const ToolResult imported = gate.callTool("import_subgraph", plain, writer);
  CHECK_FALSE(imported.isError);
  CHECK(body(imported)["imported"].asBool());

  const ToolResult deleted = gate.callTool("import_subgraph", tombstone, deleter);
  CHECK_FALSE(deleted.isError);
  CHECK_EQ(body(deleted)["tombstoned"]["nodes"].asUInt64(), 1u);
  const Json::Value got = body(h.call("get_tree", kNoArgs));
  CHECK(nodeNamed(got, "n") == nullptr);
  CHECK(nodeNamed(got, "x") != nullptr);
}

namespace {
struct ThrowingProgressRepository : FakeProgressRepository {
  bool armed = false;
  bool setStatus(const TreeId& tree, const UserId& user, const NodeId& node, ProgressStatus status,
                 bool outOfOrder, const Hlc& at, std::uint64_t receivedAtMs) override {
    if (armed) throw std::runtime_error("connect host=db.internal user=windmill password=hunter2: FATAL");
    return FakeProgressRepository::setStatus(tree, user, node, status, outOfOrder, at, receivedAtMs);
  }
  std::vector<bool> setStatuses(const TreeId& tree, const UserId& user,
                                 const std::vector<ProgressUpdate>& updates,
                                 std::uint64_t receivedAtMs) override {
    if (armed) throw std::runtime_error("progress transaction failed");
    return FakeProgressRepository::setStatuses(tree, user, updates, receivedAtMs);
  }
};
}

TEST(mcp_import_subgraph_answers_the_landed_graft_when_clearing_the_tombstoned_marks_throws) {
  FakeTreeRepository trees;
  FakeOpLog ops;
  FakeBus bus;
  ThrowingProgressRepository progressRepo;
  StepClock clock;
  FakeTokens tokens;
  RoomRegistry registry{trees, ops, bus};
  ProgressService progress{progressRepo};
  TreeRegistry treeRegistry{trees, progressRepo, tokens, Hlc{1, 0, "genesis"}, registry, clock};
  const UserId caller = uid("agent");
  RoadmapTools tools{registry, progress, clock, treeRegistry, bus};
  trees.byId["t"] = StoredTree{LooseGraph().exportState(), LegendState{}, {"Test Roadmap", {}}, 0, caller};
  auto call = [&](const char* name, Json::Value args) {
    args["treeId"] = "t";
    return tools.callTool(name, args, ToolCaller{caller, ToolScope::everything()});
  };
  CHECK_FALSE(call("create_node", node("n", "N")).isError);
  CHECK_FALSE(call("set_progress", mark("n", "complete")).isError);
  progressRepo.armed = true;

  Json::Value args = importOf({});
  args["tombstone"] = list({"n"});
  const std::size_t saves = trees.savedNodeCounts.size();
  const ToolResult result = call("import_subgraph", args);
  CHECK_FALSE(result.isError);
  const Json::Value receipt = body(result);
  CHECK(receipt["imported"].asBool());
  CHECK(receipt["graphApplied"].asBool());
  CHECK_FALSE(receipt["progressApplied"].asBool());
  CHECK_EQ(receipt["tombstoned"]["nodes"].asUInt64(), 1u);
  CHECK_EQ(trees.savedNodeCounts.size(), saves + 1);
  CHECK_FALSE(registry.open(TreeId{"t"})->hasNode(NodeId{"n"}));
  // The mark on the deleted node did not clear; the graft stands, and a retry says so.
  CHECK_EQ(strings(body(call("get_progress", kNoArgs))["completed"]), (std::vector<std::string>{"n"}));
  progressRepo.armed = false;
  const ToolResult again = call("import_subgraph", args);
  CHECK(again.isError);
  CHECK(message(again).find("which this tree does not hold") != std::string::npos);
}

TEST(mcp_import_subgraph_caps_kept_edges_at_fifty_and_counts_the_rest) {
  Harness h;
  std::vector<std::string> names;
  for (int i = 0; i < 60; ++i) names.push_back("p" + std::to_string(i));
  std::vector<Json::Value> fan;
  std::vector<const char*> parents;
  for (const std::string& name : names) {
    fan.push_back(node(name.c_str(), name.c_str()));
    parents.push_back(name.c_str());
  }
  fan.push_back(nodeWith("n", parents));
  CHECK_FALSE(h.call("import_subgraph", importOf(fan)).isError);

  const Json::Value receipt = body(h.call("import_subgraph", importOf({nodeWith("n", {})})));
  REQUIRE_EQ(receipt["keptEdges"].size(), 51u);
  CHECK(receipt["keptEdges"][49].isObject());
  CHECK_EQ(receipt["keptEdges"][50].asString(),
           std::string("and 10 more — re-send with prerequisiteMode \"replace\" to drop every edge the "
                       "batch does not name"));
  CHECK_EQ(receipt["keptEdgeCount"].asUInt64(), 60u);
}

TEST(mcp_import_subgraph_tombstones_nodes_and_edges_in_one_seq_and_clears_progress_after_the_graft) {
  Harness h;
  h.call("create_node", node("a", "A"));
  CHECK_FALSE(h.call("import_subgraph", importOf({nodeWith("n", {"a"}), nodeWith("b", {"n"})})).isError);
  CHECK_FALSE(h.call("set_progress", mark("n", "complete")).isError);
  CHECK_FALSE(h.call("set_progress", mark("a", "complete")).isError);
  const Json::Int64 before = body(h.call("get_tree", kNoArgs))["seq"].asInt64();

  Json::Value args = importOf({});
  args["tombstone"] = list({"n"});
  ToolResult result = h.call("import_subgraph", args);
  CHECK_FALSE(result.isError);
  const Json::Value receipt = body(result);
  CHECK(receipt["imported"].asBool());
  CHECK_EQ(receipt["seq"].asInt64(), before + 1);
  CHECK_EQ(receipt["tombstoned"]["nodes"].asUInt64(), 1u);
  CHECK_EQ(receipt["tombstoned"]["edges"].asUInt64(), 2u);
  CHECK(receipt["diagnosticsClean"].asBool());
  CHECK_EQ(receipt["introducedDiagnostics"].size(), 0u);

  const Json::Value got = body(h.call("get_tree", kNoArgs));
  CHECK_EQ(got["seq"].asInt64(), before + 1);
  CHECK_EQ(ids(got["tree"]["nodes"]), (std::vector<std::string>{"a", "b"}));
  CHECK_EQ((*nodeNamed(got, "b"))["prerequisites"].size(), 0u);
  CHECK_EQ(body(h.call("get_diagnostics", kNoArgs))["dangling"].size(), 0u);
  CHECK_EQ(strings(body(h.call("get_progress", kNoArgs))["completed"]), (std::vector<std::string>{"a"}));
}

TEST(mcp_import_subgraph_refuses_a_tombstone_it_cannot_honour_and_applies_nothing) {
  Harness h;
  h.call("create_node", node("a", "A"));

  Json::Value strangers = importOf({node("x", "X")});
  strangers["tombstone"] = list({"ghost", "a", "phantom"});
  ToolResult refused = h.call("import_subgraph", strangers);
  CHECK(refused.isError);
  CHECK_EQ(message(refused),
           std::string("import_subgraph: tombstone names \"ghost\", \"phantom\", which this tree does not "
                       "hold. Call get_tree with fields [\"id\",\"label\"] to list the ids this tree has."));
  CHECK_EQ(ids(body(h.call("get_tree", kNoArgs))["tree"]["nodes"]), (std::vector<std::string>{"a"}));

  Json::Value both = importOf({node("a", "A2"), node("x", "X")});
  both["tombstone"] = list({"a", "x"});
  refused = h.call("import_subgraph", both);
  CHECK(refused.isError);
  CHECK_EQ(message(refused),
           std::string("import_subgraph: tombstone names \"a\", \"x\", which nodes[] also carries — an id "
                       "is upserted or tombstoned, never both"));
  CHECK_EQ(ids(body(h.call("get_tree", kNoArgs))["tree"]["nodes"]), (std::vector<std::string>{"a"}));

  Json::Value hanging = importOf({nodeWith("x", {"a"})});
  hanging["tombstone"] = list({"a"});
  refused = h.call("import_subgraph", hanging);
  CHECK(refused.isError);
  CHECK_EQ(message(refused),
           std::string("import_subgraph: nodes[0].prerequisites names \"a\", which tombstone deletes in "
                       "this same call — drop it from one of them"));
  CHECK_EQ(ids(body(h.call("get_tree", kNoArgs))["tree"]["nodes"]), (std::vector<std::string>{"a"}));

  Json::Value tooMany = importOf({});
  tooMany["tombstone"] = Json::Value(Json::arrayValue);
  for (std::size_t i = 0; i <= kMaxTombstones; ++i) tooMany["tombstone"].append("t" + std::to_string(i));
  refused = h.call("import_subgraph", tooMany);
  CHECK(refused.isError);
  CHECK_EQ(message(refused), std::string("import_subgraph: tombstone has 501 items, max 500"));

  Json::Value misspelled = importOf({});
  misspelled["prerequisiteMode"] = "overwrite";
  refused = h.call("import_subgraph", misspelled);
  CHECK(refused.isError);
  CHECK_EQ(message(refused),
           std::string("import_subgraph: prerequisiteMode \"overwrite\" is not one of {merge, replace}"));
}

TEST(mcp_import_subgraph_dry_run_echoes_the_tombstones_and_kept_edges_and_changes_nothing) {
  Harness h;
  seedFan(h);
  CHECK_FALSE(h.call("set_progress", mark("b", "active")).isError);

  Json::Value args = importOf({nodeWith("n", {"a"})});
  args["tombstone"] = list({"b"});
  args["dryRun"] = true;
  args["progress"] = Json::Value(Json::arrayValue);
  args["progress"].append(mark("b", "complete"));
  ToolResult result = h.call("import_subgraph", args);
  CHECK_FALSE(result.isError);
  const Json::Value preview = body(result);
  CHECK(preview["dryRun"].asBool());
  CHECK_FALSE(preview.isMember("imported"));
  CHECK_EQ(strings(preview["tombstone"]), (std::vector<std::string>{"b"}));
  CHECK_EQ(preview["tombstoned"]["nodes"].asUInt64(), 1u);
  CHECK_EQ(preview["tombstoned"]["edges"].asUInt64(), 0u);
  REQUIRE_EQ(preview["keptEdges"].size(), 1u);
  CHECK_EQ(preview["keptEdges"][0]["from"].asString(), std::string("c"));
  CHECK_EQ(preview["keptEdgeCount"].asUInt64(), 1u);
  CHECK_EQ(strings(preview["progressSkipped"]), (std::vector<std::string>{"b"}));

  const Json::Value got = body(h.call("get_tree", kNoArgs));
  CHECK_EQ(ids(got["tree"]["nodes"]), (std::vector<std::string>{"a", "b", "c", "n"}));
  CHECK_EQ(strings((*nodeNamed(got, "n"))["prerequisites"]), (std::vector<std::string>{"a", "c"}));
  CHECK_EQ(strings(body(h.call("get_progress", kNoArgs))["completed"]), (std::vector<std::string>{}));
}

TEST(mcp_import_subgraph_behind_the_gate_refuses_a_nested_key_by_its_path) {
  Harness h;
  CompositeToolHost gate(std::vector<ToolModule>{{h.tools, ""}});

  Json::Value stray = node("x", "X");
  stray["deleted"] = true;
  Json::Value args = importOf({node("w", "W"), stray});
  args["treeId"] = "t";
  const ToolResult refused = gate.callTool("import_subgraph", args, h.actor);
  CHECK(refused.isError);
  CHECK_EQ(message(refused),
           std::string("import_subgraph: unknown argument \"nodes[1].deleted\". nodes[1] takes: color, "
                       "description, icon, id, label, links, opens, order, position, prerequisites, seedStatus."));
  CHECK_EQ(body(h.call("get_tree", kNoArgs))["tree"]["nodes"].size(), 0u);

  Json::Value deeper = node("x", "X");
  deeper["position"] = Json::Value(Json::objectValue);
  deeper["position"]["x"] = 1;
  deeper["position"]["z"] = 2;
  Json::Value deep = importOf({deeper});
  deep["treeId"] = "t";
  CHECK_EQ(message(gate.callTool("import_subgraph", deep, h.actor)),
           std::string("import_subgraph: unknown argument \"nodes[0].position.z\". nodes[0].position "
                       "takes: x, y."));
}

TEST(mcp_import_subgraph_takes_no_title_and_never_touches_the_trees) {
  Harness h;
  CompositeToolHost gate(std::vector<ToolModule>{{h.tools, ""}});
  const Json::Value titled = parse(R"({"treeId":"t","title":"Renamed","nodes":[{"id":"a","label":"A"}]})");
  CHECK_EQ(message(gate.callTool("import_subgraph", titled, h.actor)),
           std::string("import_subgraph: unknown argument \"title\". This tool takes: dryRun, kinds, nodes, "
                       "prerequisiteMode, progress, tombstone, treeId."));
  CHECK_EQ(body(h.call("get_tree", kNoArgs))["tree"]["nodes"].size(), 0u);

  CHECK_FALSE(h.call("import_subgraph", titled).isError);
  CHECK_EQ(body(h.call("get_tree", kNoArgs)),
           parse(R"({"count":1,"seq":1,"tree":{"guide":{"text":"","yours":true},"id":"t","kinds":[],
             "nodes":[{"id":"a","label":"A","color":"terracotta","prerequisites":[]}],"title":"Test Roadmap"}})"));
}

namespace {
Json::Value kindArgs(const char* id, const char* hue) {
  Json::Value k(Json::objectValue);
  k["id"] = id;
  k["hue"] = hue;
  return k;
}

Json::Value coloredNode(const char* id, const char* color, std::vector<const char*> prerequisites) {
  Json::Value n = node(id, id);
  n["color"] = color;
  if (!prerequisites.empty()) n["prerequisites"] = list(prerequisites);
  return n;
}

// a(sky) -> b(sky), a -> c(plum), c -> d(plum), b -> d: d's trunk parent is c, so b -> d joins two
// colour-derived branches and is the one cross-branch edge.
void plantTwoBranches(Harness& h) {
  h.call("add_kind", kindArgs("build", "sky"));
  Json::Value review = kindArgs("review", "plum");
  review["description"] = "looking back";
  h.call("add_kind", review);
  h.call("create_node", coloredNode("a", "sky", {}));
  h.call("create_node", coloredNode("b", "sky", {"a"}));
  h.call("create_node", coloredNode("c", "plum", {"a"}));
  h.call("create_node", coloredNode("d", "plum", {"c", "b"}));
}

Json::Value exemptions(Harness& h) {
  Json::Value args(Json::objectValue);
  args["kindFields"] = list({"id", "crossBranchExempt"});
  return body(h.call("get_tree", args))["tree"]["kinds"];
}

}

TEST(mcp_include_edges_lists_every_live_edge_and_none_of_the_tombstoned) {
  Harness h;
  h.call("create_node", node("a", "A"));
  h.call("create_node", coloredNode("b", "sky", {"a"}));
  h.call("create_node", coloredNode("c", "sky", {"a", "b"}));
  h.call("create_node", coloredNode("d", "sky", {"c"}));
  CHECK_FALSE(h.call("disconnect", edge("a", "c")).isError);  // tombstoned edge
  CHECK_FALSE(h.call("delete_node", with("nodeId", "d")).isError);  // tombstoned node takes c -> d with it

  Json::Value expected(Json::arrayValue);
  expected.append(edge("a", "b"));
  expected.append(edge("b", "c"));

  CHECK_FALSE(body(h.call("get_tree", kNoArgs)).isMember("edges"));

  Json::Value args(Json::objectValue);
  args["includeEdges"] = true;
  args["limit"] = 1;
  const Json::Value firstPage = body(h.call("get_tree", args));
  CHECK_EQ(keys(firstPage), (std::vector<std::string>{"count", "edges", "nextCursor", "seq", "tree"}));
  CHECK_EQ(firstPage["tree"]["nodes"].size(), 1u);
  CHECK_EQ(dump(firstPage["edges"]), dump(expected));

  args["cursor"] = firstPage["nextCursor"].asString();
  const Json::Value secondPage = body(h.call("get_tree", args));
  CHECK_EQ(dump(secondPage["edges"]), dump(expected));  // the whole list on every page

  args["includeEdges"] = "yes";
  CHECK_EQ(message(h.call("get_tree", args)),
           std::string("get_tree: argument \"includeEdges\" must be a boolean, got string"));
}

TEST(mcp_include_edges_is_gated_by_the_edge_count_alone_never_by_nodes) {
  Harness h;
  Json::Value nodes(Json::arrayValue);
  for (int i = 0; i < 1501; ++i) {
    const std::string id = "n" + std::to_string(i);
    nodes.append(node(id.c_str(), id.c_str()));
  }
  Json::Value imported(Json::objectValue);
  imported["nodes"] = nodes;
  CHECK_FALSE(h.call("import_subgraph", imported).isError);

  Json::Value args(Json::objectValue);
  args["includeEdges"] = true;
  args["limit"] = 1;
  const Json::Value out = body(h.call("get_tree", args));
  CHECK_EQ(keys(out), (std::vector<std::string>{"count", "edges", "nextCursor", "seq", "tree"}));
  CHECK_EQ(out["count"].asUInt64(), 1501u);
  CHECK(out["edges"].isArray());
  CHECK_EQ(out["edges"].size(), 0u);
}

TEST(mcp_kind_joins_a_nodes_color_to_the_legend_and_is_omitted_when_no_kind_wears_it) {
  Harness h;
  h.call("add_kind", kindArgs("frontend", "sky"));
  h.call("create_node", coloredNode("a", "sky", {}));
  h.call("create_node", coloredNode("b", "brick", {}));

  Json::Value args(Json::objectValue);
  args["fields"] = list({"id", "kind"});
  const Json::Value nodes = body(h.call("get_tree", args))["tree"]["nodes"];
  REQUIRE_EQ(nodes.size(), 2u);
  CHECK_EQ(keys(nodes[0]), (std::vector<std::string>{"id", "kind"}));
  CHECK_EQ(nodes[0]["kind"].asString(), std::string("frontend"));
  CHECK_EQ(keys(nodes[1]), (std::vector<std::string>{"id"}));

  args["query"] = "b";
  const Json::Value unclaimed = body(h.call("find_nodes", args))["nodes"];
  REQUIRE_EQ(unclaimed.size(), 1u);
  CHECK_EQ(keys(unclaimed[0]), (std::vector<std::string>{"id"}));
  args["query"] = "a";
  const Json::Value claimed = body(h.call("find_nodes", args))["nodes"];
  REQUIRE_EQ(claimed.size(), 1u);
  CHECK_EQ(claimed[0]["kind"].asString(), std::string("frontend"));
}

TEST(mcp_describe_kind_flips_the_exemption_and_get_health_skips_those_edges) {
  Harness h;
  plantTwoBranches(h);

  Json::Value coupled = body(h.call("get_health", kNoArgs));
  CHECK_EQ(keys(coupled), (std::vector<std::string>{"avgInDegree", "crossBranch", "crossBranchExempt",
                                                     "edgeCount", "nodeCount", "redundant", "score"}));
  CHECK_EQ(coupled["edgeCount"].asInt(), 4);
  CHECK_EQ(coupled["crossBranch"].asInt(), 1);
  CHECK_EQ(coupled["crossBranchExempt"].asInt(), 0);
  CHECK_EQ(coupled["score"].asInt(), 85);
  Json::Value before = exemptions(h);
  CHECK_EQ(dump(before), std::string("[{\"crossBranchExempt\":false,\"id\":\"build\"},"
                                     "{\"crossBranchExempt\":false,\"id\":\"review\"}]"));

  Json::Value flip(Json::objectValue);
  flip["id"] = "review";
  flip["crossBranchExempt"] = true;
  CHECK_FALSE(h.call("describe_kind", flip).isError);
  Json::Value exempt = body(h.call("get_health", kNoArgs));
  CHECK_EQ(exempt["crossBranch"].asInt(), 0);
  CHECK_EQ(exempt["crossBranchExempt"].asInt(), 1);
  CHECK_EQ(exempt["score"].asInt(), 100);
  CHECK_EQ(dump(exemptions(h)), std::string("[{\"crossBranchExempt\":false,\"id\":\"build\"},"
                                            "{\"crossBranchExempt\":true,\"id\":\"review\"}]"));

  Json::Value described(Json::objectValue);
  described["kindFields"] = list({"id", "description"});
  CHECK_EQ(body(h.call("get_tree", described))["tree"]["kinds"][1]["description"].asString(),
           std::string("looking back"));  // the flag write left the description alone

  // Either endpoint: the sky side of b -> d is enough once build is the exempt kind instead.
  flip["crossBranchExempt"] = false;
  CHECK_FALSE(h.call("describe_kind", flip).isError);
  flip["id"] = "build";
  flip["crossBranchExempt"] = true;
  CHECK_FALSE(h.call("describe_kind", flip).isError);
  Json::Value otherSide = body(h.call("get_health", kNoArgs));
  CHECK_EQ(otherSide["crossBranch"].asInt(), 0);
  CHECK_EQ(otherSide["crossBranchExempt"].asInt(), 1);

  CHECK_EQ(message(h.call("describe_kind", with("id", "build"))),
           std::string("describe_kind: nothing to set — pass \"description\", \"crossBranchExempt\", or both."));
  flip["crossBranchExempt"] = "yes";
  CHECK_EQ(message(h.call("describe_kind", flip)),
           std::string("describe_kind: argument \"crossBranchExempt\" must be a boolean, got string"));
}

TEST(mcp_add_kind_seeds_the_exemption_inline_and_import_subgraph_round_trips_it) {
  Harness h;
  Json::Value drill = kindArgs("drill", "gold");
  drill["crossBranchExempt"] = true;
  CHECK_FALSE(h.call("add_kind", drill).isError);
  CHECK_EQ(dump(exemptions(h)), std::string("[{\"crossBranchExempt\":true,\"id\":\"drill\"}]"));

  Json::Value wrong = kindArgs("x", "sky");
  wrong["crossBranchExempt"] = "yes";
  CHECK_EQ(message(h.call("add_kind", wrong)),
           std::string("add_kind: argument \"crossBranchExempt\" must be a boolean, got string"));

  Json::Value kinds(Json::arrayValue);
  Json::Value drillAgain = kindArgs("drill", "gold");
  drillAgain["crossBranchExempt"] = false;
  kinds.append(drillAgain);
  Json::Value review = kindArgs("review", "plum");
  review["crossBranchExempt"] = true;
  kinds.append(review);
  Json::Value imported(Json::objectValue);
  imported["nodes"] = Json::Value(Json::arrayValue);
  imported["kinds"] = kinds;
  CHECK_FALSE(h.call("import_subgraph", imported).isError);
  CHECK_EQ(dump(exemptions(h)), std::string("[{\"crossBranchExempt\":false,\"id\":\"drill\"},"
                                            "{\"crossBranchExempt\":true,\"id\":\"review\"}]"));

  imported["kinds"][1]["crossBranchExempt"] = "yes";
  CHECK_EQ(message(h.call("import_subgraph", imported)),
           std::string("import_subgraph: argument \"kinds[1].crossBranchExempt\" must be a boolean, got string"));
}

namespace {

// A tree of `nodes` nodes where each node's prerequisites are the `fanIn` before it, seeded straight
// into the repository: the shapes that decide whether one reply lists the edges.
void seedLadder(Harness& h, int nodes, int fanIn) {
  TreeData data;
  data.id = tid();
  data.title = "Ladder";
  for (int i = 0; i < nodes; ++i) {
    NodeSpec node;
    node.id = nid(("n" + std::to_string(i)).c_str());
    node.label = node.id.str();
    node.icon = "icon";
    for (int back = 1; back <= fanIn && i - back >= 0; ++back) node.prerequisites.push_back(nid(("n" + std::to_string(i - back)).c_str()));
    data.nodes.push_back(std::move(node));
  }
  h.trees.byId["t"] = StoredTree{LooseGraph(data, Hlc{1, 0, "seed"}).exportState(), LegendState{},
                                 {"Ladder", {}}, 0, h.caller};
}

}

TEST(mcp_get_tree_lists_edges_up_to_the_edge_count_alone_and_says_the_count_past_it) {
  Harness within;
  seedLadder(within, 1000, 4);  // 3990 edges: past the closure budget's nodes×edges, within the listing's
  Json::Value args(Json::objectValue);
  args["includeEdges"] = true;
  args["limit"] = 1;
  const Json::Value listed = body(within.call("get_tree", args));
  CHECK_EQ(listed["count"].asUInt64(), 1000u);
  CHECK_FALSE(listed.isMember("edgesOmitted"));
  CHECK_EQ(listed["edges"].size(), 3990u);

  Harness past;
  seedLadder(past, 1000, 7);  // 6972 edges
  const Json::Value omitted = body(past.call("get_tree", args));
  CHECK_FALSE(omitted.isMember("edges"));
  CHECK_EQ(omitted["edgesOmitted"].asString(),
           std::string("this tree holds 6972 live edges, past the 6000 one reply lists — page get_tree with "
                       "fields [\"id\", \"prerequisites\"] instead."));
}

TEST(mcp_annotate_node_sets_and_clears_the_icon_and_the_empty_icon_smell_follows) {
  Harness h;
  h.call("create_node", node("a", "A"));

  auto smells = [&] {
    std::vector<std::string> out;
    const Json::Value report = body(h.call("get_diagnostics", kNoArgs));
    for (const Json::Value& smell : report["smells"])
      out.push_back(smell["node"].asString() + ":" + smell["kind"].asString());
    return out;
  };
  auto icon = [&] {
    Json::Value args(Json::objectValue);
    args["fields"] = list({"id", "icon"});
    return body(h.call("get_tree", args))["tree"]["nodes"][0]["icon"].asString();
  };
  CHECK_EQ(smells(), (std::vector<std::string>{"a:empty-icon"}));

  Json::Value set(Json::objectValue);
  set["nodeId"] = "a";
  set["icon"] = "star";
  const ToolResult setResult = h.call("annotate_node", set);
  CHECK_FALSE(setResult.isError);
  CHECK(body(setResult)["applied"].asBool());
  CHECK_EQ(icon(), std::string("star"));
  CHECK_EQ(smells(), (std::vector<std::string>{}));

  Json::Value clear(Json::objectValue);
  clear["nodeId"] = "a";
  clear["icon"] = "";
  CHECK_FALSE(h.call("annotate_node", clear).isError);
  CHECK_EQ(icon(), std::string(""));
  CHECK_EQ(smells(), (std::vector<std::string>{"a:empty-icon"}));

  Json::Value over(Json::objectValue);
  over["nodeId"] = "a";
  over["icon"] = std::string(65, 'i');
  CHECK_EQ(message(h.call("annotate_node", over)),
           std::string("annotate_node: icon would be 65 characters, 1 over the 64 cap"));
}

TEST(mcp_annotate_node_appends_to_the_description_and_refuses_both_forms_at_once) {
  Harness h;
  h.call("create_node", node("a", "A"));
  auto description = [&] {
    Json::Value args(Json::objectValue);
    args["fields"] = list({"id", "description"});
    return body(h.call("get_tree", args))["tree"]["nodes"][0]["description"].asString();
  };

  Json::Value first(Json::objectValue);
  first["nodeId"] = "a";
  first["appendDescription"] = "first entry";
  CHECK_FALSE(h.call("annotate_node", first).isError);
  CHECK_EQ(description(), std::string("first entry"));

  Json::Value second(Json::objectValue);
  second["nodeId"] = "a";
  second["appendDescription"] = "second entry";
  CHECK_FALSE(h.call("annotate_node", second).isError);
  CHECK_EQ(description(), std::string("first entry\n\nsecond entry"));

  Json::Value both(Json::objectValue);
  both["nodeId"] = "a";
  both["description"] = "one";
  both["appendDescription"] = "two";
  const ToolResult refused = h.call("annotate_node", both);
  CHECK(refused.isError);
  CHECK_EQ(message(refused),
           std::string("annotate_node: \"description\" and \"appendDescription\" are both given — pass one: "
                       "description replaces the body, appendDescription joins onto it."));
  CHECK_EQ(description(), std::string("first entry\n\nsecond entry"));

  Json::Value nothing(Json::objectValue);
  nothing["nodeId"] = "a";
  CHECK_EQ(message(h.call("annotate_node", nothing)),
           std::string("annotate_node: nothing to set — pass at least one of \"description\", "
                       "\"appendDescription\", \"icon\", \"links\", \"opens\"."));

  Json::Value tail(Json::objectValue);
  tail["nodeId"] = "a";
  tail["appendDescription"] = std::string(16000 - 25 + 1, 'y');  // the body is 25 characters and the blank line 2
  CHECK_EQ(message(h.call("annotate_node", tail)),
           std::string("annotate_node: description would be 16003 characters, 3 over the 16000 cap"));
  CHECK_EQ(description(), std::string("first entry\n\nsecond entry"));

  Json::Value fits(Json::objectValue);
  fits["nodeId"] = "a";
  fits["appendDescription"] = std::string(16000 - 25 - 2, 'y');
  CHECK_FALSE(h.call("annotate_node", fits).isError);
  CHECK_EQ(description().size(), 16000u);
}

namespace {

Json::Value markArgs(const char* nodeId, const char* status) {
  Json::Value m(Json::objectValue);
  m["nodeId"] = nodeId;
  m["status"] = status;
  return m;
}

// a -> b, unmarked.
void chainAB(Harness& h) {
  h.call("create_node", node("a", "A"));
  Json::Value b = node("b", "B");
  b["parentId"] = "a";
  h.call("create_node", b);
}

const Json::Value* kindNamed(const Json::Value& kinds, const char* id) {
  for (const Json::Value& k : kinds)
    if (k["id"].asString() == id) return &k;
  return nullptr;
}

}

// The word rides the mark: the receipt answers it, get_progress lists it, the status projection
// shows it, the mirror echo carries it, and the next mark without it takes it away.
TEST(mcp_set_progress_out_of_order_is_acknowledged_kept_and_shown) {
  Harness h;
  chainAB(h);

  Json::Value meant = markArgs("b", "complete");
  meant["outOfOrder"] = true;
  ToolResult receipt = h.call("set_progress", meant);
  CHECK_FALSE(receipt.isError);
  CHECK_EQ(keys(body(receipt)), (std::vector<std::string>{"acknowledged", "nodeId", "prerequisitesMet", "status"}));
  CHECK_FALSE(body(receipt)["prerequisitesMet"].asBool());
  CHECK(body(receipt)["acknowledged"].asBool());
  CHECK_EQ(body(receipt)["status"].asString(), std::string("complete"));

  Json::Value overlay = body(h.call("get_progress", kNoArgs));
  CHECK_EQ(keys(overlay), (std::vector<std::string>{"completed", "outOfOrder"}));
  REQUIRE_EQ(overlay["outOfOrder"].size(), 1u);
  CHECK_EQ(overlay["outOfOrder"][0].asString(), std::string("b"));
  REQUIRE_EQ(overlay["completed"].size(), 1u);

  Json::Value read(Json::objectValue);
  read["fields"] = list({"id", "status"});
  const Json::Value nodes = body(h.call("get_tree", read))["tree"]["nodes"];
  REQUIRE_EQ(nodes.size(), 2u);
  for (const Json::Value& n : nodes) {
    if (n["id"].asString() == "b") {
      CHECK_EQ(n["status"].asString(), std::string("complete"));
      CHECK(n["outOfOrder"].asBool());
    } else {
      CHECK_EQ(n["status"].asString(), std::string("none"));
      CHECK_FALSE(n.isMember("outOfOrder"));
    }
  }

  REQUIRE_EQ(h.bus.progressBroadcasts.size(), 1u);
  CHECK(h.bus.progressBroadcasts.back().marks.marks.at(nid("b")).outOfOrder);

  ToolResult plain = h.call("set_progress", markArgs("b", "complete"));
  CHECK_EQ(keys(body(plain)), (std::vector<std::string>{"nodeId", "prerequisitesMet", "status"}));
  CHECK_FALSE(body(plain)["prerequisitesMet"].asBool());
  CHECK_EQ(body(h.call("get_progress", kNoArgs))["outOfOrder"].size(), 0u);
  CHECK_FALSE(h.bus.progressBroadcasts.back().marks.marks.at(nid("b")).outOfOrder);
}

TEST(mcp_set_progress_bulk_carries_out_of_order_per_update) {
  Harness h;
  chainAB(h);

  Json::Value late = markArgs("b", "complete");
  late["outOfOrder"] = true;
  Json::Value updates(Json::arrayValue);
  updates.append(late);
  updates.append(markArgs("a", "complete"));
  Json::Value args(Json::objectValue);
  args["updates"] = updates;

  ToolResult receipt = h.call("set_progress", args);
  CHECK_FALSE(receipt.isError);
  const Json::Value results = body(receipt)["results"];
  REQUIRE_EQ(results.size(), 2u);
  // Judged against the committed batch, b's prerequisite IS met — the word is still echoed, since it was given.
  CHECK_EQ(keys(results[0]), (std::vector<std::string>{"acknowledged", "nodeId", "prerequisitesMet", "status"}));
  CHECK(results[0]["prerequisitesMet"].asBool());
  CHECK(results[0]["acknowledged"].asBool());
  CHECK_EQ(keys(results[1]), (std::vector<std::string>{"nodeId", "prerequisitesMet", "status"}));

  Json::Value overlay = body(h.call("get_progress", kNoArgs));
  CHECK_EQ(overlay["completed"].size(), 2u);
  REQUIRE_EQ(overlay["outOfOrder"].size(), 1u);
  CHECK_EQ(overlay["outOfOrder"][0].asString(), std::string("b"));
}

TEST(mcp_set_progress_refuses_out_of_order_off_a_completion_and_records_nothing) {
  Harness h;
  chainAB(h);

  Json::Value active = markArgs("b", "active");
  active["outOfOrder"] = true;
  CHECK_EQ(message(h.call("set_progress", active)),
           std::string("set_progress: argument \"outOfOrder\" acknowledges completing a node before its "
                       "prerequisites, so it rides status \"complete\" only, got \"none\""));

  Json::Value typed = markArgs("b", "complete");
  typed["outOfOrder"] = "yes";
  CHECK_EQ(message(h.call("set_progress", typed)),
           std::string("set_progress: argument \"outOfOrder\" must be a boolean, got string"));

  Json::Value cleared = markArgs("a", "none");
  cleared["outOfOrder"] = true;
  Json::Value updates(Json::arrayValue);
  updates.append(markArgs("b", "complete"));
  updates.append(cleared);
  Json::Value bulk(Json::objectValue);
  bulk["updates"] = updates;
  CHECK_EQ(message(h.call("set_progress", bulk)),
           std::string("set_progress: argument \"updates[1].outOfOrder\" acknowledges completing a node before "
                       "its prerequisites, so it rides status \"complete\" only, got \"none\""));

  // A false word is just a completion.
  Json::Value plain = markArgs("b", "complete");
  plain["outOfOrder"] = false;
  CHECK_EQ(keys(body(h.call("set_progress", plain))), (std::vector<std::string>{"nodeId", "prerequisitesMet", "status"}));

  Json::Value overlay = body(h.call("get_progress", kNoArgs));
  CHECK_EQ(overlay["completed"].size(), 1u);
  CHECK_EQ(overlay["outOfOrder"].size(), 0u);
  CHECK_EQ(h.bus.progressBroadcasts.size(), 1u);
}

// A re-sent kind changes only in the fields the batch sends; a new kind without them gets the defaults.
// Rank is never on the wire, so a re-sent kind keeps its place and the frame every replica joins
// stamps its rank unset; new kinds land after the last one, in batch order rather than id order.
TEST(mcp_import_subgraph_keeps_the_legend_order_on_a_colliding_kind_and_appends_a_new_one) {
  Harness h;
  CHECK_FALSE(h.call("add_kind", kindArgs("a", "gold")).isError);
  CHECK_FALSE(h.call("add_kind", kindArgs("b", "sky")).isError);
  CHECK_FALSE(h.call("add_kind", kindArgs("c", "plum")).isError);

  Json::Value kinds(Json::arrayValue);
  kinds.append(kindArgs("c", "plum"));
  Json::Value args(Json::objectValue);
  args["nodes"] = Json::Value(Json::arrayValue);
  args["kinds"] = kinds;
  CHECK_FALSE(h.call("import_subgraph", args).isError);

  Json::Value legend = body(h.call("get_tree", Json::Value(Json::objectValue)))["tree"]["kinds"];
  REQUIRE_EQ(legend.size(), 3u);
  CHECK_EQ(legend[0]["id"].asString(), std::string("a"));
  CHECK_EQ(legend[1]["id"].asString(), std::string("b"));
  CHECK_EQ(legend[2]["id"].asString(), std::string("c"));

  const Subgraph& frame = h.bus.subgraphBroadcasts.back().subgraph;
  REQUIRE_EQ(frame.legend.kinds.size(), 1u);
  CHECK_EQ(frame.legend.kinds[0].id, KindId{"c"});
  CHECK(frame.legend.kinds[0].hueAt.isSet());
  CHECK_FALSE(frame.legend.kinds[0].rankAt.isSet());

  Json::Value more(Json::arrayValue);
  more.append(kindArgs("b", "sky"));
  more.append(kindArgs("y", "olive"));
  more.append(kindArgs("x", "terracotta"));
  args["kinds"] = more;
  CHECK_FALSE(h.call("import_subgraph", args).isError);
  legend = body(h.call("get_tree", Json::Value(Json::objectValue)))["tree"]["kinds"];
  REQUIRE_EQ(legend.size(), 5u);
  CHECK_EQ(legend[0]["id"].asString(), std::string("a"));
  CHECK_EQ(legend[1]["id"].asString(), std::string("b"));
  CHECK_EQ(legend[2]["id"].asString(), std::string("c"));
  CHECK_EQ(legend[3]["id"].asString(), std::string("y"));
  CHECK_EQ(legend[4]["id"].asString(), std::string("x"));
}

// The description and the field doc say the same thing about outOfOrder: it is the subset of
// completed whose set_progress carried the flag, met prerequisites or not.
TEST(mcp_get_progress_describes_out_of_order_as_the_marks_that_carried_the_flag) {
  Harness h;
  for (const ToolDeclaration& tool : h.tools.declareTools()) {
    if (tool.name() != "get_progress") continue;
    CHECK_EQ(tool.descriptor["description"].asString(),
             std::string("The caller's private progress overlay for a roadmap: the node ids that are "
                         "completed, and outOfOrder — the subset of completed whose "
                         "set_progress carried outOfOrder:true. Per-user, separate from the shared "
                         "structure."));
    const std::string fields = tool.descriptor["inputSchema"]["properties"]["fields"]["description"].asString();
    CHECK(fields.find("the subset of `completed` whose set_progress carried outOfOrder:true") != std::string::npos);
    return;
  }
  CHECK(false);
}

TEST(mcp_import_subgraph_keeps_a_colliding_kinds_omitted_fields_and_defaults_a_new_kinds) {
  Harness h;
  Json::Value drill = kindArgs("drill", "gold");
  drill["label"] = "Drill";
  drill["description"] = "Daily drills";
  drill["crossBranchExempt"] = true;
  CHECK_FALSE(h.call("add_kind", drill).isError);

  Json::Value kinds(Json::arrayValue);
  kinds.append(kindArgs("drill", "gold"));
  kinds.append(kindArgs("read", "sky"));
  Json::Value args(Json::objectValue);
  args["nodes"] = Json::Value(Json::arrayValue);
  args["kinds"] = kinds;
  ToolResult result = h.call("import_subgraph", args);
  CHECK_FALSE(result.isError);
  const Json::Value receipt = body(result);
  CHECK_EQ(receipt["kinds"].asInt(), 2);
  CHECK_EQ(receipt["newKinds"].asInt(), 1);
  REQUIRE_EQ(receipt["kindCollisions"].size(), 1u);
  CHECK_EQ(receipt["kindCollisions"][0].asString(), std::string("drill"));

  Json::Value read(Json::objectValue);
  read["kindFields"] = list({"id", "hue", "label", "description", "crossBranchExempt"});
  Json::Value legend = body(h.call("get_tree", read))["tree"]["kinds"];
  REQUIRE_EQ(legend.size(), 2u);
  const Json::Value* kept = kindNamed(legend, "drill");
  REQUIRE(kept != nullptr);
  CHECK_EQ((*kept)["hue"].asString(), std::string("gold"));
  CHECK_EQ((*kept)["label"].asString(), std::string("Drill"));
  CHECK_EQ((*kept)["description"].asString(), std::string("Daily drills"));
  CHECK((*kept)["crossBranchExempt"].asBool());
  const Json::Value* fresh = kindNamed(legend, "read");
  REQUIRE(fresh != nullptr);
  CHECK_EQ((*fresh)["hue"].asString(), std::string("sky"));
  CHECK_EQ((*fresh)["label"].asString(), std::string(""));
  CHECK_EQ((*fresh)["description"].asString(), std::string(""));
  CHECK_FALSE((*fresh)["crossBranchExempt"].asBool());

  // Sent, a field replaces — an empty string and a false included.
  Json::Value spelled = kindArgs("drill", "gold");
  spelled["label"] = "Drills";
  spelled["description"] = "";
  spelled["crossBranchExempt"] = false;
  Json::Value again(Json::arrayValue);
  again.append(spelled);
  args["kinds"] = again;
  CHECK_FALSE(h.call("import_subgraph", args).isError);
  legend = body(h.call("get_tree", read))["tree"]["kinds"];
  const Json::Value* replaced = kindNamed(legend, "drill");
  REQUIRE(replaced != nullptr);
  CHECK_EQ((*replaced)["label"].asString(), std::string("Drills"));
  CHECK_EQ((*replaced)["description"].asString(), std::string(""));
  CHECK_FALSE((*replaced)["crossBranchExempt"].asBool());
}

namespace {

Json::Value describedImport(int nodes, const std::string& description) {
  Json::Value args(Json::objectValue);
  Json::Value array(Json::arrayValue);
  for (int i = 0; i < nodes; ++i) {
    Json::Value n = node(("n" + std::to_string(i)).c_str(), "N");
    n["description"] = description;
    array.append(n);
  }
  args["nodes"] = array;
  return args;
}

std::string grinsOf(int count) {
  std::string out;
  for (int i = 0; i < count; ++i) out += "\xF0\x9F\x98\x80";
  return out;
}

}

// The lattice is saved before the reply, so a row that fails to land after it is the log's
// problem: the caller is told the truth — applied — and the row lands with the next write.
TEST(mcp_a_write_whose_op_row_fails_to_land_still_answers_applied_and_the_row_lands_next_time) {
  Harness h;
  h.ops.failNextAppends = 1;
  ToolResult first = h.call("create_node", node("a", "A"));
  CHECK_FALSE(first.isError);
  CHECK(body(first)["applied"].asBool());
  CHECK_EQ(body(first)["seq"].asInt64(), 1);
  CHECK_EQ(h.trees.byId["t"].head, static_cast<Seq>(1));
  CHECK_EQ(LooseGraph(h.trees.byId["t"].state).presentNodeIds().size(), 1u);
  CHECK(h.ops.byTree["t"].empty());
  CHECK_EQ(h.bus.subgraphBroadcasts.size(), 1u);

  ToolResult second = h.call("create_node", node("b", "B"));
  CHECK_FALSE(second.isError);
  CHECK_EQ(body(second)["seq"].asInt64(), 2);
  REQUIRE_EQ(h.ops.byTree["t"].size(), 2u);
  CHECK_EQ(h.ops.byTree["t"][0].seq, static_cast<Seq>(1));
  CHECK_EQ(h.ops.byTree["t"][1].seq, static_cast<Seq>(2));
}

// Sixteen thousand four-byte characters serialize as twelve bytes each, so a page of them is held
// to a byte budget as well as a node limit: the reply says pageBytes when the budget ended it, and
// the cursor walks the rest as usual. ASCII of the same character count never reaches the budget.
TEST(mcp_a_page_carrying_descriptions_ends_at_the_byte_budget_and_says_so) {
  Harness h;
  CHECK_FALSE(h.call("import_subgraph", describedImport(30, grinsOf(16000))).isError);

  Json::Value args(Json::objectValue);
  args["fields"] = list({"id", "description"});
  args["limit"] = 1000;
  Json::Value page = body(h.call("get_tree", args));
  CHECK_EQ(page["count"].asUInt64(), 30u);
  const std::size_t onPage = page["tree"]["nodes"].size();
  CHECK(onPage < 30u);
  CHECK(onPage >= 20u);  // 4 MB / 192 KB per node
  CHECK(page["pageBytes"].asUInt64() > kPageByteBudget);
  CHECK_EQ(page["nextCursor"].asString(), page["tree"]["nodes"][static_cast<Json::ArrayIndex>(onPage - 1)]["id"].asString());
  CHECK_EQ(page["tree"]["nodes"][0]["description"].asString(), grinsOf(16000));

  std::size_t walked = onPage;
  while (page.isMember("nextCursor")) {
    args["cursor"] = page["nextCursor"];
    page = body(h.call("get_tree", args));
    walked += page["tree"]["nodes"].size();
  }
  CHECK_EQ(walked, 30u);

  // find_nodes shares the page, and a page without `description` is bounded by `limit` alone.
  Json::Value find(Json::objectValue);
  find["fields"] = list({"id", "description"});
  find["limit"] = 1000;
  Json::Value found = body(h.call("find_nodes", find));
  CHECK_EQ(found["nodes"].size(), onPage);
  CHECK(found.isMember("pageBytes"));
  CHECK(found.isMember("nextCursor"));
  Json::Value summaries(Json::objectValue);
  summaries["fields"] = list({"id", "summary"});
  summaries["limit"] = 1000;
  Json::Value light = body(h.call("get_tree", summaries));
  CHECK_EQ(light["tree"]["nodes"].size(), 30u);
  CHECK_FALSE(light.isMember("pageBytes"));
  CHECK_FALSE(light.isMember("nextCursor"));

  Harness ascii;
  CHECK_FALSE(ascii.call("import_subgraph", describedImport(30, std::string(16000, 'd'))).isError);
  args.removeMember("cursor");
  Json::Value whole = body(ascii.call("get_tree", args));
  CHECK_EQ(whole["tree"]["nodes"].size(), 30u);
  CHECK_FALSE(whole.isMember("pageBytes"));
  CHECK_FALSE(whole.isMember("nextCursor"));
}

// One call's description text is bounded as a whole: the graft is one frame every subscriber
// receives entire, so the cap is on the batch, and the refusal names the size.
TEST(mcp_import_subgraph_refuses_more_description_text_than_one_call_may_carry) {
  Harness h;
  ToolResult refused = h.call("import_subgraph", describedImport(400, std::string(16000, 'd')));  // 6400000 bytes
  CHECK(refused.isError);
  CHECK_EQ(message(refused),
           std::string("import_subgraph: nodes carries 6400000 bytes of description text, 108544 over the "
                       "6291456-byte cap one call may carry — split the import"));
  CHECK_EQ(body(h.call("get_tree", kNoArgs))["count"].asUInt64(), 0u);
  CHECK(h.bus.subgraphBroadcasts.empty());

  ToolResult landed = h.call("import_subgraph", describedImport(393, std::string(16000, 'd')));  // 6288000 bytes
  CHECK_FALSE(landed.isError);
  CHECK_EQ(body(h.call("get_tree", kNoArgs))["count"].asUInt64(), 393u);
}

TEST(mcp_patch_nodes_is_one_edit_preserves_omissions_and_retries_as_noop) {
  Harness h;
  Json::Value a = node("a", "A");
  a["icon"] = "star";
  a["description"] = "Keep this";
  h.call("create_node", a);
  h.call("create_node", node("b", "B"));
  Json::Value args = parse(R"({"updates":[{"nodeId":"a","label":"New A"},{"nodeId":"b","description":"New B","position":{"x":7,"y":8}}],"expectedSeq":2})");
  const ToolResult result = h.call("patch_nodes", args);
  CHECK_FALSE(result.isError);
  CHECK_EQ(body(result), parse(R"({"treeId":"t","applied":true,"dryRun":false,"seq":3,"changedNodeIds":["a","b"],"unchangedNodeIds":[],"diagnosticsClean":true,"introducedDiagnostics":[]})"));
  CHECK_EQ(result.structured, body(result));
  REQUIRE_EQ(h.bus.subgraphBroadcasts.size(), 3u);
  REQUIRE_EQ(h.ops.byTree["t"].size(), 3u);
  CHECK(std::holds_alternative<Batch>(h.ops.byTree["t"].back().command));
  Json::Value read = parse(R"({"nodeIds":["b","missing","a"],"fields":["id","label","icon","description","position"]})");
  CHECK_EQ(body(h.call("get_nodes", read)), parse(R"({"treeId":"t","seq":3,"nodes":[{"id":"b","label":"B","icon":"","description":"New B","position":{"x":7.0,"y":8.0}},{"id":"a","label":"New A","icon":"star","description":"Keep this"}],"missingNodeIds":["missing"]})"));
  const ToolResult conflict = h.call("patch_nodes", args);
  CHECK(conflict.isError);
  CHECK_EQ(message(conflict), std::string("patch_nodes: expectedSeq conflict: requested 2, current seq is 3. Nothing changed; read get_nodes or get_tree and retry with the current seq."));
  args.removeMember("expectedSeq");
  CHECK_EQ(body(h.call("patch_nodes", args)), parse(R"({"treeId":"t","applied":true,"dryRun":false,"seq":3,"changedNodeIds":[],"unchangedNodeIds":["a","b"],"diagnosticsClean":true,"introducedDiagnostics":[]})"));
  CHECK_EQ(h.bus.subgraphBroadcasts.size(), 3u);
  CHECK_EQ(h.ops.byTree["t"].size(), 3u);
}

TEST(mcp_patch_nodes_refuses_the_whole_batch_and_dry_run_changes_nothing) {
  Harness h;
  h.call("create_node", node("a", "A"));
  h.call("create_node", node("b", "B"));
  const Json::Value before = body(h.call("get_tree", kNoArgs));
  for (const char* json : {
      R"({"updates":[{"nodeId":"a","label":"New"},{"nodeId":"missing","label":"Bad"}]})",
      R"({"updates":[{"nodeId":"a","label":"New"},{"nodeId":"a","label":"Duplicate"}]})",
      R"({"updates":[{"nodeId":"a","label":"New"},{"nodeId":"b","position":{"x":1}}]})",
      R"({"updates":[{"nodeId":"a","label":"New"},{"nodeId":"b","description":null}]})",
      R"({"updates":[{"nodeId":"a","label":"New"},{"nodeId":"b","opens":null}]})",
      R"({"updates":[{"nodeId":"a","label":"New"},{"nodeId":"b"}]})",
      R"({"updates":[]})"}) {
    CHECK(h.call("patch_nodes", parse(json)).isError);
    CHECK_EQ(body(h.call("get_tree", kNoArgs)), before);
  }
  CHECK_EQ(message(h.call("patch_nodes", parse(R"({"updates":[{"nodeId":"b","description":null}]})"))),
           std::string("patch_nodes: missing required argument \"updates[0].description\""));
  CHECK_EQ(message(h.call("patch_nodes", parse(R"({"updates":[{"nodeId":"b","opens":null}]})"))),
           std::string("patch_nodes: missing required argument \"updates[0].opens\""));
  CHECK_EQ(body(h.call("patch_nodes", parse(R"({"updates":[{"nodeId":"a","description":""}],"dryRun":true,"expectedSeq":2})"))),
           parse(R"({"treeId":"t","applied":false,"dryRun":true,"seq":2,"changedNodeIds":[],"unchangedNodeIds":["a"]})"));
  CHECK_EQ(body(h.call("get_tree", kNoArgs)), before);
  CHECK_EQ(h.bus.subgraphBroadcasts.size(), 2u);
}

TEST(mcp_change_edges_is_atomic_and_reports_cycles_and_noop_retries) {
  Harness h;
  h.call("create_node", node("a", "A"));
  h.call("create_node", node("b", "B"));
  h.call("connect", parse(R"({"from":"a","to":"b"})"));
  const Json::Value args = parse(R"({"add":[{"from":"b","to":"a"}],"remove":[{"from":"missing","to":"a"}],"expectedSeq":3})");
  CHECK_EQ(body(h.call("change_edges", args)), parse(R"({"treeId":"t","applied":true,"dryRun":false,"seq":4,"addedEdges":[{"from":"b","to":"a"}],"removedEdges":[],"unchangedEdges":1,"diagnosticsClean":false,"introducedDiagnostics":["cycle among \"a\", \"b\""]})"));
  Json::Value retry = args;
  retry.removeMember("expectedSeq");
  CHECK_EQ(body(h.call("change_edges", retry)), parse(R"({"treeId":"t","applied":true,"dryRun":false,"seq":4,"addedEdges":[],"removedEdges":[],"unchangedEdges":2,"diagnosticsClean":false,"introducedDiagnostics":[]})"));
  const Json::Value before = body(h.call("get_tree", kNoArgs));
  for (const char* json : {
      R"({"remove":[{"from":"a","to":"b"}],"add":[{"from":"missing","to":"a"}]})",
      R"({"remove":[{"from":"a","to":"b"}],"add":[{"from":"a","to":"b"}]})",
      R"({"add":[{"from":"a","to":"b"},{"from":"a","to":"b"}]})",
      R"({"add":[],"remove":[]})"}) {
    CHECK(h.call("change_edges", parse(json)).isError);
    CHECK_EQ(body(h.call("get_tree", kNoArgs)), before);
  }
  CHECK_EQ(h.bus.subgraphBroadcasts.size(), 4u);
}

TEST(mcp_get_nodes_is_bounded_and_private_and_uses_exact_ids) {
  Harness h;
  CHECK_FALSE(h.call("import_subgraph", describedImport(20, std::string(16000, 'd'))).isError);
  Json::Value args(Json::objectValue);
  args["nodeIds"] = Json::Value(Json::arrayValue);
  for (int i = 0; i < 20; ++i) args["nodeIds"].append("n" + std::to_string(i));
  args["fields"] = list({"id", "description"});
  CHECK_EQ(message(h.call("get_nodes", args)), std::string("get_nodes: response exceeds the 262144-byte limit; retry with fewer nodeIds or fewer fields (summary instead of description). No nodes were omitted silently."));
  args["fields"] = list({"id"});
  const ToolResult light = h.call("get_nodes", args);
  CHECK_FALSE(light.isError);
  CHECK_EQ(body(light)["nodes"].size(), 20u);
  CHECK_EQ(light.structured, body(light));
  args["nodeIds"].append("n0");
  CHECK_EQ(message(h.call("get_nodes", args)), std::string("get_nodes: nodeIds repeats \"n0\""));
  h.registry.open(TreeId{"t"})->setVisibility(Visibility::private_);
  h.caller = uid("other");
  CHECK_EQ(message(h.call("get_nodes", parse(R"({"nodeIds":["n0"]})"))), std::string("get_nodes: no such tree \"t\""));
  CHECK_EQ(message(h.call("patch_nodes", parse(R"({"updates":[{"nodeId":"n0","label":"No"}]})"))), std::string("patch_nodes: no such tree \"t\""));
  CHECK_EQ(message(h.call("change_edges", parse(R"({"add":[{"from":"n0","to":"n1"}]})"))), std::string("change_edges: no such tree \"t\""));
}

TEST(mcp_legacy_progress_aliases_clear_without_completing_prerequisites) {
  Harness h;
  h.call("create_node", node("a", "A"));
  h.call("create_node", node("b", "B"));
  h.call("connect", edge("a", "b"));
  h.call("set_progress", mark("a", "complete"));
  CHECK_FALSE(h.call("set_progress", mark("a", "active")).isError);
  CHECK_FALSE(h.call("set_progress", mark("b", "inProgress")).isError);

  Json::Value args(Json::objectValue);
  args["fields"] = list({"completed", "cleared", "outOfOrder"});
  CHECK_EQ(body(h.call("get_progress", args)),
           parse(R"({"completed":[],"cleared":["a","b"],"outOfOrder":[]})"));
  args["fields"] = list({"id", "state"});
  CHECK_EQ(body(h.call("get_tree", args))["tree"]["nodes"],
           parse(R"([{"id":"a","state":"available"},{"id":"b","state":"locked"}])"));
}

TEST(mcp_a_guide_set_through_describe_tree_rides_every_page_of_get_tree) {
  Harness h;
  for (const char* id : {"a", "b", "c", "d", "e"}) h.call("create_node", node(id, id));
  const std::size_t opRows = h.ops.byTree["t"].size();

  const ToolResult described = h.call("describe_tree", with("guide", "Work the trunk first; leaves can wait."));
  CHECK_FALSE(described.isError);
  CHECK_EQ(body(described), parse(R"({"applied":true,"seq":6})"));
  CHECK_EQ(h.trees.byId["t"].guide.value, std::string("Work the trunk first; leaves can wait."));
  CHECK_EQ(h.ops.byTree["t"].size(), opRows);
  REQUIRE(h.bus.subgraphBroadcasts.back().subgraph.guide.has_value());
  CHECK_EQ(h.bus.subgraphBroadcasts.back().subgraph.guide->value,
           std::string("Work the trunk first; leaves can wait."));

  std::vector<std::string> walked;
  std::string cursor;
  int pages = 0;
  while (true) {
    Json::Value args(Json::objectValue);
    args["limit"] = 2;
    if (!cursor.empty()) args["cursor"] = cursor;
    const Json::Value page = body(h.call("get_tree", args));
    CHECK_EQ(page["tree"]["guide"], parse(R"({"text":"Work the trunk first; leaves can wait.","yours":true})"));
    CHECK_EQ(page["seq"].asInt(), 6);
    for (const Json::Value& n : page["tree"]["nodes"]) walked.push_back(n["id"].asString());
    ++pages;
    if (!page.isMember("nextCursor")) break;
    cursor = page["nextCursor"].asString();
  }
  CHECK_EQ(pages, 3);
  CHECK_EQ(walked, (std::vector<std::string>{"a", "b", "c", "d", "e"}));

  CHECK_EQ(body(h.call("describe_tree", with("guide", ""))), parse(R"({"applied":true,"seq":7})"));
  CHECK_EQ(body(h.call("get_tree", kNoArgs))["tree"]["guide"], parse(R"({"text":"","yours":true})"));
  CHECK_EQ(h.ops.byTree["t"].size(), opRows);
}

TEST(mcp_no_read_but_get_tree_carries_the_guide) {
  Harness h;
  h.call("create_node", node("a", "A"));
  CHECK_FALSE(h.call("describe_tree", with("guide", "Rig first, then sail.")).isError);

  std::vector<std::string> reads;
  for (const ToolDeclaration& tool : roadmapToolCatalog()) {
    if (tool.access != Access::read || tool.name() == "get_tree") continue;
    reads.push_back(tool.name());
    Json::Value args(Json::objectValue);
    if (tool.name() == "get_nodes") args["nodeIds"] = list({"a"});
    if (tool.name() == "get_nodes" || tool.name() == "find_nodes") args["fields"] = everyNodeField();
    const ToolResult read = h.call(tool.name().c_str(), args);
    CHECK_FALSE(read.isError);
    CHECK_EQ(message(read).find("Rig first"), std::string::npos);
    CHECK_EQ(message(read).find("guide"), std::string::npos);
  }
  CHECK_EQ(reads, (std::vector<std::string>{"get_nodes", "list_trees", "get_diagnostics", "get_health",
                                            "get_progress", "find_nodes"}));

  Json::Value everything(Json::objectValue);
  everything["fields"] = everyNodeField();
  CHECK_EQ(keys(body(h.call("find_nodes", everything))), (std::vector<std::string>{"count", "nodes"}));
  everything["nodeIds"] = list({"a"});
  CHECK_EQ(keys(body(h.call("get_nodes", everything))),
           (std::vector<std::string>{"missingNodeIds", "nodes", "seq", "treeId"}));
}

TEST(mcp_a_second_account_reads_an_unlisted_trees_guide_as_not_theirs_and_cannot_set_it) {
  Harness h;
  h.trees.byId["t"].visibility = Visibility::unlisted;
  h.call("create_node", node("a", "A"));
  CHECK_FALSE(h.call("describe_tree", with("guide", "Rig first, then sail.")).isError);
  const StoredTree before = h.trees.byId["t"];
  const std::size_t broadcasts = h.bus.subgraphBroadcasts.size();

  h.caller = uid("stranger");
  CHECK_EQ(body(h.call("get_tree", kNoArgs))["tree"]["guide"],
           parse(R"({"text":"Rig first, then sail.","yours":false})"));

  const ToolResult refused = h.call("describe_tree", with("guide", "Mine now"));
  CHECK(refused.isError);
  CHECK_EQ(message(refused), std::string("describe_tree: this tree belongs to another account. Call "
                                         "list_trees to see the roadmaps you own."));
  CHECK_EQ(message(h.call("create_node", node("b", "B"))),
           std::string("create_node: this tree belongs to another account. Call list_trees to see the "
                       "roadmaps you own."));
  CHECK(h.trees.byId["t"] == before);
  CHECK_EQ(h.bus.subgraphBroadcasts.size(), broadcasts);
}

TEST(mcp_describe_tree_holds_5000_code_points_of_any_width_and_names_the_bound_when_it_refuses) {
  Harness h;
  std::string wide;  // 5000 three-byte characters: 15000 bytes
  for (std::size_t i = 0; i < kMaxGuideChars; ++i) wide += "\xE5\xAD\x97";

  CHECK_FALSE(h.call("describe_tree", with("guide", wide.c_str())).isError);
  CHECK_EQ(body(h.call("get_tree", kNoArgs))["tree"]["guide"]["text"].asString(), wide);

  const ToolResult over = h.call("describe_tree", with("guide", (wide + "\xE5\xAD\x97").c_str()));
  CHECK(over.isError);
  CHECK_EQ(message(over), std::string("describe_tree: guide is 5001 characters, 1 over the 5000 cap"));
  Json::Value number(Json::objectValue);
  number["guide"] = 42;
  CHECK_EQ(message(h.call("describe_tree", number)),
           std::string("describe_tree: argument \"guide\" must be a string, got number. A guide is plain "
                       "text of at most 5000 characters; \"\" clears it."));
  CHECK_EQ(message(h.call("describe_tree", kNoArgs)),
           std::string("describe_tree: missing required argument \"guide\". A guide is plain text of at "
                       "most 5000 characters; \"\" clears it."));
  CHECK_EQ(message(h.call("describe_tree", with("guide", "\xE5\xAD"))),
           std::string("describe_tree: guide is not valid UTF-8"));
  CHECK_EQ(h.trees.byId["t"].guide.value, wide);

  const Json::Value catalog = h.tools.listTools(h.actor);
  const Json::Value* declared = nullptr;
  for (const Json::Value& tool : catalog)
    if (tool["name"].asString() == "describe_tree") declared = &tool;
  REQUIRE(declared != nullptr);
  const Json::Value& schema = (*declared)["inputSchema"];
  CHECK_EQ(schema["properties"]["guide"]["type"].asString(), std::string("string"));
  CHECK_EQ(schema["properties"]["guide"]["maxLength"].asUInt64(), static_cast<Json::UInt64>(5000));
  CHECK_EQ(schema["required"], list({"treeId", "guide"}));
}

TEST(mcp_a_tree_with_no_guide_answers_an_empty_text_and_says_whose_it_is) {
  Harness h;
  CHECK_EQ(body(h.call("get_tree", kNoArgs))["tree"]["guide"], parse(R"({"text":"","yours":true})"));

  h.registry.open(TreeId{"t"})->setVisibility(Visibility::public_);
  h.caller = UserId{""};
  CHECK_EQ(body(h.call("get_tree", kNoArgs))["tree"]["guide"], parse(R"({"text":"","yours":false})"));
}

TEST(mcp_describe_tree_logs_one_line_per_call_and_no_line_or_refusal_carries_the_guide) {
  Harness h;
  CompositeToolHost gate(std::vector<ToolModule>{{h.tools, ""}});
  std::vector<WriteCompletion> lines;
  installWriteSink([&](const WriteCompletion& line) { lines.push_back(line); });

  Json::Value args(Json::objectValue);
  args["treeId"] = "t";
  args["guide"] = "Private compass: sail at dawn.";
  const ToolResult landed = gate.callTool("roadmap_describe_tree", args, h.actor);
  args["guide"] = "Private compass: " + std::string(kMaxGuideChars, 'x');
  const ToolResult over = gate.callTool("roadmap_describe_tree", args, h.actor);
  args["treeId"] = "nope";
  args["guide"] = "Private compass: sail at dawn.";
  const ToolResult absent = gate.callTool("describe_tree", args, h.actor);
  installWriteSink({});

  CHECK_FALSE(landed.isError);
  CHECK_EQ(message(over), std::string("describe_tree: guide is 5017 characters, 17 over the 5000 cap"));
  CHECK_EQ(message(absent), std::string("describe_tree: no such tree \"nope\""));
  REQUIRE_EQ(lines.size(), 3u);
  const std::vector<std::string> outcomes = {"ok", "refused", "refused"};
  for (std::size_t i = 0; i < lines.size(); ++i) {
    CHECK_EQ(lines[i].operation, std::string("mcp.roadmap_describe_tree"));
    CHECK_EQ(lines[i].product, std::string("roadmap"));
    CHECK_EQ(lines[i].door, std::string("mcp"));
    CHECK_EQ(lines[i].outcome, outcomes[i]);
    CHECK_EQ(writeCompletionJson(lines[i]).find("compass"), std::string::npos);
  }
}

TEST(mcp_describe_tree_on_a_tree_whose_row_went_away_answers_as_every_write_does_for_an_absent_tree) {
  Harness h;
  CHECK_FALSE(h.call("describe_tree", with("guide", "Rig first, then sail.")).isError);
  REQUIRE(h.registry.isOpen(TreeId{"t"}));
  h.trees.deletedIds.insert("t");  // soft-deleted outside this registry, its row kept

  const ToolResult refused = h.call("describe_tree", with("guide", "A ghost's guide"));
  CHECK(refused.isError);
  CHECK_EQ(message(refused), std::string("describe_tree: no such tree \"t\""));
  CHECK_FALSE(h.registry.isOpen(TreeId{"t"}));
  CHECK_EQ(h.trees.byId["t"].guide.value, std::string("Rig first, then sail."));
  CHECK_EQ(message(h.call("create_node", node("a", "A"))), std::string("create_node: no such tree \"t\""));
  CHECK_EQ(message(h.call("get_tree", kNoArgs)), std::string("get_tree: no such tree \"t\""));
}

TEST(mcp_describe_tree_refuses_a_guide_carrying_a_nul_with_the_admissions_sentence) {
  Harness h;
  CHECK_FALSE(h.call("describe_tree", with("guide", "Rig first, then sail.")).isError);
  const std::size_t broadcasts = h.bus.subgraphBroadcasts.size();

  Json::Value args(Json::objectValue);
  args["guide"] = std::string("Rig first\0then sail.", 20);
  const ToolResult refused = h.call("describe_tree", args);
  CHECK(refused.isError);
  CHECK_EQ(message(refused), std::string("describe_tree: the guide contains a NUL character"));
  CHECK_EQ(h.trees.byId["t"].guide.value, std::string("Rig first, then sail."));
  CHECK_EQ(h.bus.subgraphBroadcasts.size(), broadcasts);
  CHECK_EQ(body(h.call("get_tree", kNoArgs))["tree"]["guide"],
           parse(R"({"text":"Rig first, then sail.","yours":true})"));
}

// A fork of someone else's tree copies its guide as its author's words: the new owner reads them as
// not theirs until they write a guide of their own, through any door, and the mark outlives the room.
TEST(mcp_a_forks_copied_guide_is_not_yours_until_its_owner_writes_one_through_any_door) {
  Harness h;
  ForkService forks{h.registry, h.trees, h.tokens, h.clock};
  h.trees.byId["t"].visibility = Visibility::public_;
  CHECK_FALSE(h.call("describe_tree", with("guide", "Delete what you do not need.")).isError);
  const UserId forker = uid("forker");
  const auto guideOf = [&](const std::string& tree) {
    return body(h.tools.callTool("get_tree", with("treeId", tree.c_str()), ToolCaller{forker, ToolScope::everything()}))["tree"]["guide"];
  };
  const auto forkOf = [&](const char* id) {
    REQUIRE(forks.fork(TreeId{"t"}, id, "", forker).outcome == ForkService::Outcome::forked);
    CHECK_EQ(guideOf(id), parse(R"({"text":"Delete what you do not need.","yours":false})"));
    h.registry.evict(TreeId{id});
    CHECK_EQ(guideOf(id), parse(R"({"text":"Delete what you do not need.","yours":false})"));
  };

  forkOf("t_mcp");
  Json::Value mcp(Json::objectValue);
  mcp["treeId"] = "t_mcp";
  mcp["guide"] = "Prune with care.";
  CHECK_FALSE(h.tools.callTool("describe_tree", mcp, ToolCaller{forker, ToolScope::everything()}).isError);

  forkOf("t_rest");
  CHECK(std::holds_alternative<Seq>(h.treeRegistry.setGuide(TreeId{"t_rest"}, forker, "Prune with care.")));

  forkOf("t_socket");
  {
    std::lock_guard<std::mutex> strand(h.registry.strandFor(TreeId{"t_socket"}));
    Subgraph frame;
    frame.treeId = TreeId{"t_socket"};
    frame.frameId = "f-guide";
    frame.actor = "r_forker";
    frame.guide = Lww<std::string>{"Prune with care.", Hlc{h.clock.ms + 1000, 0, "r_forker"}};
    REQUIRE(h.registry.open(TreeId{"t_socket"})->joinSubgraph(frame, forker).has_value());
    REQUIRE(h.registry.persist(TreeId{"t_socket"}));
  }

  for (const char* fork : {"t_mcp", "t_rest", "t_socket"}) {
    CHECK_EQ(guideOf(fork), parse(R"({"text":"Prune with care.","yours":true})"));
    h.registry.evict(TreeId{fork});
    CHECK_EQ(guideOf(fork), parse(R"({"text":"Prune with care.","yours":true})"));
  }
  CHECK_EQ(body(h.call("get_tree", kNoArgs))["tree"]["guide"],
           parse(R"({"text":"Delete what you do not need.","yours":true})"));
}

TEST(mcp_describe_tree_stores_a_guide_of_only_whitespace_as_no_guide_and_keeps_a_real_guides_spaces) {
  Harness h;
  CHECK_EQ(body(h.call("describe_tree", with("guide", " \n\t\r "))), parse(R"({"applied":true,"seq":1})"));
  CHECK_EQ(h.trees.byId["t"].guide.value, std::string(""));
  CHECK_EQ(body(h.call("get_tree", kNoArgs))["tree"]["guide"], parse(R"({"text":"","yours":true})"));

  CHECK_FALSE(h.call("describe_tree", with("guide", "  Rig first, then sail.\n")).isError);
  CHECK_EQ(h.trees.byId["t"].guide.value, std::string("  Rig first, then sail.\n"));
}

TEST(mcp_describe_tree_names_the_guide_a_plain_text_note) {
  Harness h;
  for (const Json::Value& tool : h.tools.listTools(h.actor))
    if (tool["name"].asString() == "describe_tree")
      CHECK(tool["description"].asString().rfind("Set a roadmap's guide: one plain-text note on what the tree is", 0) == 0);
}

// Forking your own tree copies your own words, so the copy stays yours; forking someone else's tree, or
// your own fork whose guide is still its source author's, copies words that are not.
TEST(mcp_forking_your_own_tree_keeps_its_guide_yours_and_anyone_elses_does_not) {
  Harness h;
  ForkService forks{h.registry, h.trees, h.tokens, h.clock};
  h.trees.byId["t"].visibility = Visibility::public_;
  CHECK_FALSE(h.call("describe_tree", with("guide", "Rig first, then sail.")).isError);
  const auto guideOf = [&](const char* tree, const UserId& reader) {
    return body(h.tools.callTool("get_tree", with("treeId", tree), ToolCaller{reader, ToolScope::everything()}))["tree"]["guide"];
  };

  REQUIRE(forks.fork(TreeId{"t"}, "t_mine", "", h.caller).outcome == ForkService::Outcome::forked);
  CHECK_EQ(guideOf("t_mine", h.caller), parse(R"({"text":"Rig first, then sail.","yours":true})"));
  CHECK_FALSE(h.trees.byId["t_mine"].guideInherited);

  const UserId stranger = uid("stranger");
  REQUIRE(forks.fork(TreeId{"t"}, "t_theirs", "", stranger).outcome == ForkService::Outcome::forked);
  CHECK_EQ(guideOf("t_theirs", stranger), parse(R"({"text":"Rig first, then sail.","yours":false})"));

  REQUIRE(forks.fork(TreeId{"t_theirs"}, "t_theirs_again", "", stranger).outcome == ForkService::Outcome::forked);
  CHECK_EQ(guideOf("t_theirs_again", stranger), parse(R"({"text":"Rig first, then sail.","yours":false})"));
}

// A node points at another tree of its owner's through any of the four write tools, and the three
// reads answer that tree's id and title when asked for the field.
TEST(mcp_a_node_opens_a_tree_through_each_write_tool_and_every_read_answers_its_id_and_title) {
  Harness h;
  h.trees.byId["t_sub"] = StoredTree{LooseGraph().exportState(), LegendState{}, {"Deep dive", {}}, 0, h.caller};

  CHECK_FALSE(h.call("create_node", parse(R"({"id":"a","label":"A","opens":"t_sub"})")).isError);
  CHECK_FALSE(h.call("create_node", parse(R"({"id":"b","label":"B"})")).isError);
  CHECK_FALSE(h.call("annotate_node", parse(R"({"nodeId":"b","opens":"t_sub"})")).isError);
  CHECK_FALSE(h.call("create_node", parse(R"({"id":"c","label":"C","opens":""})")).isError);
  CHECK_EQ(body(h.call("patch_nodes", parse(R"({"updates":[{"nodeId":"c","opens":"t_sub"}]})"))),
           parse(R"({"treeId":"t","applied":true,"dryRun":false,"seq":5,"changedNodeIds":["c"],"unchangedNodeIds":[],"diagnosticsClean":true,"introducedDiagnostics":[]})"));
  CHECK_FALSE(h.call("import_subgraph", parse(R"({"nodes":[{"id":"d","label":"D","opens":"t_sub"},{"id":"e","label":"E"}]})")).isError);

  const Json::Value expected = parse(
      R"([{"id":"a","opens":{"treeId":"t_sub","title":"Deep dive","state":"open"}},{"id":"b","opens":{"treeId":"t_sub","title":"Deep dive","state":"open"}},
          {"id":"c","opens":{"treeId":"t_sub","title":"Deep dive","state":"open"}},{"id":"d","opens":{"treeId":"t_sub","title":"Deep dive","state":"open"}},
          {"id":"e"}])");
  CHECK_EQ(body(h.call("get_tree", parse(R"({"fields":["id","opens"]})")))["tree"]["nodes"], expected);
  Json::Value batch = parse(R"({"treeId":"t","seq":6,"missingNodeIds":[]})");
  batch["nodes"] = expected;
  CHECK_EQ(body(h.call("get_nodes", parse(R"({"nodeIds":["a","b","c","d","e"],"fields":["id","opens"]})"))), batch);
  CHECK_EQ(body(h.call("find_nodes", parse(R"({"fields":["id","opens"]})")))["nodes"], expected);
  CHECK_EQ(body(h.call("get_tree", kNoArgs))["tree"]["nodes"][0],
           parse(R"({"id":"a","label":"A","color":"terracotta","prerequisites":[]})"));
  std::map<std::string, std::string> stored;
  for (const NodeStateEntry& node : h.trees.byId["t"].state.nodes) stored[node.id.str()] = node.opens.str();
  CHECK_EQ(stored, (std::map<std::string, std::string>{
                       {"a", "t_sub"}, {"b", "t_sub"}, {"c", "t_sub"}, {"d", "t_sub"}, {"e", ""}}));
}

TEST(mcp_annotate_node_and_patch_nodes_clear_the_tree_a_node_opens_with_an_empty_string) {
  Harness h;
  h.trees.byId["t_sub"] = StoredTree{LooseGraph().exportState(), LegendState{}, {"Deep dive", {}}, 0, h.caller};
  CHECK_FALSE(h.call("create_node", parse(R"({"id":"a","label":"A","opens":"t_sub"})")).isError);
  CHECK_FALSE(h.call("create_node", parse(R"({"id":"b","label":"B","opens":"t_sub"})")).isError);
  CHECK_FALSE(h.call("create_node", parse(R"({"id":"c","label":"C","opens":"t_sub"})")).isError);

  CHECK_FALSE(h.call("annotate_node", parse(R"({"nodeId":"a","opens":""})")).isError);
  CHECK_EQ(body(h.call("patch_nodes", parse(R"({"updates":[{"nodeId":"b","opens":""},{"nodeId":"c","opens":"t_sub"}]})"))),
           parse(R"({"treeId":"t","applied":true,"dryRun":false,"seq":5,"changedNodeIds":["b"],"unchangedNodeIds":["c"],"diagnosticsClean":true,"introducedDiagnostics":[]})"));
  CHECK_FALSE(h.call("annotate_node", parse(R"({"nodeId":"c","description":"a note","opens":null})")).isError);

  CHECK_EQ(body(h.call("get_tree", parse(R"({"fields":["id","opens"]})")))["tree"]["nodes"],
           parse(R"([{"id":"a"},{"id":"b"},{"id":"c","opens":{"treeId":"t_sub","title":"Deep dive","state":"open"}}])"));
}

TEST(mcp_an_import_that_re_sends_a_node_without_opens_keeps_its_tree_and_an_empty_one_clears_it) {
  Harness h;
  h.trees.byId["t_sub"] = StoredTree{LooseGraph().exportState(), LegendState{}, {"Deep dive", {}}, 0, h.caller};
  CHECK_FALSE(h.call("import_subgraph", parse(R"({"nodes":[{"id":"a","label":"A","opens":"t_sub"}]})")).isError);

  CHECK_FALSE(h.call("import_subgraph", parse(R"({"nodes":[{"id":"a","label":"Renamed"}]})")).isError);
  CHECK_FALSE(h.call("import_subgraph", parse(R"({"nodes":[{"id":"a","opens":null}]})")).isError);
  CHECK_EQ(body(h.call("get_tree", parse(R"({"fields":["id","label","opens"]})")))["tree"]["nodes"],
           parse(R"([{"id":"a","label":"Renamed","opens":{"treeId":"t_sub","title":"Deep dive","state":"open"}}])"));

  CHECK_FALSE(h.call("import_subgraph", parse(R"({"nodes":[{"id":"a","opens":""}]})")).isError);
  CHECK_EQ(body(h.call("get_tree", parse(R"({"fields":["id","label","opens"]})")))["tree"]["nodes"],
           parse(R"([{"id":"a","label":"Renamed"}])"));
}

// A tree id is the read capability of an unlisted tree, so a pointer at a tree that is not there and
// one at somebody else's tree are refused in the same words, and nothing is written.
TEST(mcp_a_tree_that_is_not_the_callers_cannot_be_opened_and_absent_reads_exactly_as_someone_elses) {
  Harness h;
  h.trees.byId["t_sub"] = StoredTree{LooseGraph().exportState(), LegendState{}, {"Deep dive", {}}, 0, h.caller};
  h.trees.byId["t_theirs"] = StoredTree{LooseGraph().exportState(), LegendState{}, {"Their plans", {}}, 0,
                                        uid("someone-else"), Visibility::public_};
  h.trees.byId["t_nobodys"] = StoredTree{LooseGraph().exportState(), LegendState{}, {"Demo", {}}, 0, std::nullopt,
                                         Visibility::public_};
  h.trees.byId["t_gone"] = StoredTree{LooseGraph().exportState(), LegendState{}, {"Retired", {}}, 0, h.caller};
  h.trees.softDelete(TreeId{"t_gone"});
  CHECK_FALSE(h.call("create_node", parse(R"({"id":"a","label":"A","opens":"t_sub"})")).isError);
  CHECK_FALSE(h.call("create_node", parse(R"({"id":"b","label":"B"})")).isError);
  const StoredTree before = h.trees.byId["t"];
  const Json::Value document = body(h.call("get_tree", parse(R"({"fields":["id","label","opens"]})")));

  const auto refusal = [](const std::string& tool, const std::string& path, const std::string& target) {
    return tool + ": " + path + " names \"" + target +
           "\", which is not a tree of yours — a node opens only a tree you own: list_trees lists them, and "
           "someone else's tree is copied into one of yours first, with create_tree then import_subgraph";
  };
  for (const std::string target : {"t_absent", "t_theirs", "t_nobodys", "t_gone"}) {
    CHECK_EQ(message(h.call("create_node", parse(R"({"id":"c","label":"C","opens":")" + target + R"("})"))),
             refusal("create_node", "opens", target));
    CHECK_EQ(message(h.call("annotate_node", parse(R"({"nodeId":"a","description":"kept out","opens":")" + target + R"("})"))),
             refusal("annotate_node", "opens", target));
    for (const std::string dryRun : {"false", "true"}) {
      CHECK_EQ(message(h.call("patch_nodes", parse(R"({"updates":[{"nodeId":"a","label":"Kept out"},{"nodeId":"b","opens":")" +
                                                   target + R"("}],"dryRun":)" + dryRun + "}"))),
               refusal("patch_nodes", "updates[1].opens", target));
      CHECK_EQ(message(h.call("import_subgraph",
                              parse(R"({"nodes":[{"id":"n0","opens":"t_sub"},{"id":"n1"},{"id":"n2","opens":")" + target +
                                    R"("}],"dryRun":)" + dryRun + "}"))),
               refusal("import_subgraph", "nodes[2].opens", target));
    }
  }

  CHECK(h.trees.byId["t"] == before);
  CHECK_EQ(body(h.call("get_tree", parse(R"({"fields":["id","label","opens"]})"))), document);
  CHECK_EQ(document["seq"].asInt64(), 2);
  CHECK_EQ(h.bus.subgraphBroadcasts.size(), 2u);
  CHECK_EQ(h.ops.byTree["t"].size(), 2u);
}

TEST(mcp_a_node_may_open_the_tree_it_is_in) {
  Harness h;
  CHECK_FALSE(h.call("create_node", parse(R"({"id":"a","label":"A","opens":"t"})")).isError);
  CHECK_EQ(body(h.call("get_tree", parse(R"({"fields":["id","opens"]})")))["tree"]["nodes"],
           parse(R"([{"id":"a","opens":{"treeId":"t","title":"Test Roadmap","state":"open"}}])"));
}

// The pointer and the opened tree's title go to the tree's writer alone: a tree id is the read
// capability of an unlisted tree and a title is its owner's words.
TEST(mcp_no_read_answers_the_tree_a_node_opens_to_a_caller_who_cannot_write_the_tree) {
  Harness h;
  h.trees.byId["t"].visibility = Visibility::public_;
  h.trees.byId["t_secret_sub"] =
      StoredTree{LooseGraph().exportState(), LegendState{}, {"Secret plans", {}}, 0, h.caller, Visibility::unlisted};
  CHECK_FALSE(h.call("create_node", parse(R"({"id":"a","label":"A","opens":"t_secret_sub"})")).isError);
  const std::size_t readsAfterTheWrite = h.trees.titleReads.size();

  for (const UserId& reader : {uid("stranger"), UserId{}}) {
    const ToolCaller caller{reader, ToolScope::everything()};
    const ToolResult tree = h.tools.callTool("get_tree", parse(R"({"treeId":"t","fields":["id","opens"]})"), caller);
    CHECK_EQ(body(tree)["tree"]["nodes"], parse(R"([{"id":"a"}])"));
    const ToolResult nodes =
        h.tools.callTool("get_nodes", parse(R"({"treeId":"t","nodeIds":["a"],"fields":["id","opens"]})"), caller);
    CHECK_EQ(body(nodes), parse(R"({"treeId":"t","seq":1,"nodes":[{"id":"a"}],"missingNodeIds":[]})"));
    const ToolResult found = h.tools.callTool("find_nodes", parse(R"({"treeId":"t","fields":["id","opens"]})"), caller);
    CHECK_EQ(body(found), parse(R"({"count":1,"nodes":[{"id":"a"}]})"));
    for (const ToolResult& reply : {tree, nodes, found}) {
      CHECK_EQ(message(reply).find("t_secret_sub"), std::string::npos);
      CHECK_EQ(message(reply).find("Secret plans"), std::string::npos);
    }
  }
  CHECK_EQ(h.trees.titleReads.size(), readsAfterTheWrite);
  CHECK(h.trees.openedReads.empty());

  CHECK_EQ(body(h.call("get_tree", parse(R"({"fields":["id","opens"]})")))["tree"]["nodes"],
           parse(R"([{"id":"a","opens":{"treeId":"t_secret_sub","title":"Secret plans","state":"open"}}])"));
}

// The room holds a pointer to nothing but its length, so one may name a tree its owner does not own:
// the read answers it to nobody.
TEST(mcp_a_pointer_at_a_tree_the_owner_does_not_own_or_that_was_deleted_reads_back_as_no_key) {
  Harness h;
  h.trees.byId["t_sub"] = StoredTree{LooseGraph().exportState(), LegendState{}, {"Deep dive", {}}, 0, h.caller};
  h.trees.byId["t_theirs"] = StoredTree{LooseGraph().exportState(), LegendState{}, {"Their plans", {}}, 0,
                                        uid("someone-else"), Visibility::public_};
  CHECK_FALSE(h.call("create_node", parse(R"({"id":"a","label":"A","opens":"t_sub"})")).isError);
  CHECK_FALSE(h.call("create_node", parse(R"({"id":"b","label":"B"})")).isError);
  AnnotateNode planted{NodeId{"b"}};
  planted.opens = TreeId{"t_theirs"};
  h.registry.open(TreeId{"t"})->applyCommand(planted, h.clock.nowMs(), h.caller);

  CHECK_EQ(body(h.call("get_tree", parse(R"({"fields":["id","opens"]})")))["tree"]["nodes"],
           parse(R"([{"id":"a","opens":{"treeId":"t_sub","title":"Deep dive","state":"open"}},{"id":"b"}])"));

  h.trees.softDelete(TreeId{"t_sub"});
  CHECK_EQ(body(h.call("get_tree", parse(R"({"fields":["id","opens"]})")))["tree"]["nodes"],
           parse(R"([{"id":"a"},{"id":"b"}])"));
  CHECK_EQ(body(h.call("get_nodes", parse(R"({"nodeIds":["a","b"],"fields":["id","opens"]})"))),
           parse(R"({"treeId":"t","seq":3,"nodes":[{"id":"a"},{"id":"b"}],"missingNodeIds":[]})"));
  CHECK_EQ(body(h.call("find_nodes", parse(R"({"fields":["id","opens"]})"))),
           parse(R"({"count":2,"nodes":[{"id":"a"},{"id":"b"}]})"));
}

// The opened trees are asked after once for a whole call, and a reply follows them only when the
// field is asked for, in a read of its own.
TEST(mcp_the_trees_a_call_opens_are_read_once_and_a_reply_follows_them_only_when_asked_for_opens) {
  Harness h;
  h.trees.byId["t_sub"] = StoredTree{LooseGraph().exportState(), LegendState{}, {"Deep dive", {}}, 0, h.caller};
  h.trees.byId["t_other"] = StoredTree{LooseGraph().exportState(), LegendState{}, {"Side quest", {}}, 0, h.caller};

  CHECK_FALSE(h.call("import_subgraph",
                     parse(R"({"nodes":[{"id":"a","opens":"t_sub"},{"id":"b","opens":"t_other"},{"id":"c","opens":"t_sub"},{"id":"d"}]})"))
                  .isError);
  CHECK_EQ(h.trees.titleReads, (std::vector<std::set<TreeId>>{{TreeId{"t_other"}, TreeId{"t_sub"}}}));
  CHECK_FALSE(h.call("patch_nodes", parse(R"({"updates":[{"nodeId":"a","opens":"t_other"},{"nodeId":"d","opens":"t_sub"},{"nodeId":"b","label":"B"}]})")).isError);
  CHECK_EQ(h.trees.titleReads.size(), 2u);
  CHECK_FALSE(h.call("create_node", parse(R"({"id":"e","label":"E"})")).isError);
  CHECK_FALSE(h.call("annotate_node", parse(R"({"nodeId":"e","opens":""})")).isError);
  CHECK_EQ(h.trees.titleReads.size(), 2u);

  CHECK_FALSE(h.call("get_tree", kNoArgs).isError);
  CHECK_FALSE(h.call("find_nodes", kNoArgs).isError);
  CHECK_FALSE(h.call("get_nodes", parse(R"({"nodeIds":["a"],"fields":["id","label","description"]})")).isError);
  CHECK_EQ(h.trees.titleReads.size(), 2u);
  CHECK(h.trees.openedReads.empty());
  CHECK_FALSE(h.call("get_tree", parse(R"({"fields":["id","opens"]})")).isError);
  CHECK_EQ(h.trees.titleReads.size(), 2u);
  CHECK_EQ(h.trees.openedReads, (std::vector<std::set<TreeId>>{{TreeId{"t_other"}, TreeId{"t_sub"}}}));
}

// A title is read off the stored row: a rename that reached the row is what the read answers.
TEST(mcp_opens_answers_the_opened_trees_stored_title) {
  Harness h;
  h.trees.byId["t_sub"] = StoredTree{LooseGraph().exportState(), LegendState{}, {"Deep dive", {}}, 0, h.caller};
  CHECK_FALSE(h.call("create_node", parse(R"({"id":"a","label":"A","opens":"t_sub"})")).isError);
  REQUIRE(h.registry.open(TreeId{"t_sub"}) != nullptr);

  CHECK(h.treeRegistry.rename(TreeId{"t_sub"}, h.caller, "Deeper dive") == TreeRegistry::Renaming::renamed);

  CHECK_EQ(body(h.call("get_tree", parse(R"({"fields":["id","opens"]})")))["tree"]["nodes"],
           parse(R"([{"id":"a","opens":{"treeId":"t_sub","title":"Deeper dive","state":"open"}}])"));
}

// A created node opens the tree its call names and no other: an id a deleted node held brings back
// none of that node's pointer, in the reply or in the stored row.
TEST(mcp_create_node_on_a_deleted_id_opens_nothing_when_opens_is_absent) {
  Harness h;
  h.trees.byId["t_sub"] = StoredTree{LooseGraph().exportState(), LegendState{}, {"Deep dive", {}}, 0, h.caller};
  CHECK_FALSE(h.call("create_node", parse(R"({"id":"a","label":"A","opens":"t_sub"})")).isError);
  CHECK_FALSE(h.call("delete_node", parse(R"({"nodeId":"a"})")).isError);
  CHECK_EQ(body(h.call("get_tree", parse(R"({"fields":["id","opens"]})")))["tree"]["nodes"], parse("[]"));

  CHECK_FALSE(h.call("create_node", parse(R"({"id":"a","label":"A again"})")).isError);

  CHECK_EQ(body(h.call("get_tree", parse(R"({"fields":["id","label","opens"]})")))["tree"]["nodes"],
           parse(R"([{"id":"a","label":"A again"}])"));
  REQUIRE_EQ(h.trees.byId["t"].state.nodes.size(), 1u);
  CHECK_EQ(h.trees.byId["t"].state.nodes[0].opens, TreeId{});
}

TEST(mcp_create_node_on_a_deleted_id_opens_nothing_when_opens_is_the_empty_string) {
  Harness h;
  h.trees.byId["t_sub"] = StoredTree{LooseGraph().exportState(), LegendState{}, {"Deep dive", {}}, 0, h.caller};
  CHECK_FALSE(h.call("create_node", parse(R"({"id":"a","label":"A","opens":"t_sub"})")).isError);
  CHECK_FALSE(h.call("delete_node", parse(R"({"nodeId":"a"})")).isError);

  CHECK_FALSE(h.call("create_node", parse(R"({"id":"a","label":"A again","opens":""})")).isError);

  CHECK_EQ(body(h.call("get_tree", parse(R"({"fields":["id","label","opens"]})")))["tree"]["nodes"],
           parse(R"([{"id":"a","label":"A again"}])"));
  REQUIRE_EQ(h.trees.byId["t"].state.nodes.size(), 1u);
  CHECK_EQ(h.trees.byId["t"].state.nodes[0].opens, TreeId{});
}

TEST(mcp_create_node_minting_the_id_of_a_deleted_node_opens_nothing) {
  Harness h;
  h.trees.byId["t_sub"] = StoredTree{LooseGraph().exportState(), LegendState{}, {"Deep dive", {}}, 0, h.caller};
  CHECK_FALSE(h.call("create_node", parse(R"({"label":"Renderer Core","opens":"t_sub"})")).isError);
  CHECK_FALSE(h.call("delete_node", parse(R"({"nodeId":"renderer-core"})")).isError);

  const ToolResult again = h.call("create_node", parse(R"({"label":"Renderer Core"})"));

  CHECK_EQ(body(again)["id"].asString(), std::string("renderer-core"));
  CHECK_EQ(body(h.call("get_tree", parse(R"({"fields":["id","opens"]})")))["tree"]["nodes"],
           parse(R"([{"id":"renderer-core"}])"));
}

TEST(mcp_create_node_on_a_present_id_leaves_it_opening_only_the_tree_the_call_names) {
  Harness h;
  h.trees.byId["t_sub"] = StoredTree{LooseGraph().exportState(), LegendState{}, {"Deep dive", {}}, 0, h.caller};
  h.trees.byId["t_other"] = StoredTree{LooseGraph().exportState(), LegendState{}, {"Side quest", {}}, 0, h.caller};
  CHECK_FALSE(h.call("create_node", parse(R"({"id":"a","label":"A","opens":"t_sub"})")).isError);
  CHECK_FALSE(h.call("create_node", parse(R"({"id":"b","label":"B","opens":"t_sub"})")).isError);
  CHECK_FALSE(h.call("create_node", parse(R"({"id":"c","label":"C","opens":"t_sub"})")).isError);

  CHECK_FALSE(h.call("create_node", parse(R"({"id":"a","label":"A2"})")).isError);
  CHECK_FALSE(h.call("create_node", parse(R"({"id":"b","label":"B2","opens":""})")).isError);
  CHECK_FALSE(h.call("create_node", parse(R"({"id":"c","label":"C2","opens":"t_other"})")).isError);

  CHECK_EQ(body(h.call("get_tree", parse(R"({"fields":["id","label","opens"]})")))["tree"]["nodes"],
           parse(R"([{"id":"a","label":"A2"},{"id":"b","label":"B2"},
                     {"id":"c","label":"C2","opens":{"treeId":"t_other","title":"Side quest","state":"open"}}])"));
}

// The write line tells a pointer at a tree that is not the caller's from every other refusal, in one
// code for an absent tree, someone else's and a deleted one.
TEST(mcp_a_pointer_at_a_tree_that_is_not_the_callers_completes_as_opens_not_yours) {
  Harness h;
  h.trees.byId["t_theirs"] = StoredTree{LooseGraph().exportState(), LegendState{}, {"Their plans", {}}, 0,
                                        uid("someone-else"), Visibility::public_};
  h.trees.byId["t_gone"] = StoredTree{LooseGraph().exportState(), LegendState{}, {"Retired", {}}, 0, h.caller};
  h.trees.softDelete(TreeId{"t_gone"});
  CHECK_FALSE(h.call("create_node", parse(R"({"id":"a","label":"A"})")).isError);
  CompositeToolHost gate(std::vector<ToolModule>{{h.tools, ""}});
  std::vector<WriteCompletion> completions;
  installWriteSink([&](const WriteCompletion& completion) { completions.push_back(completion); });

  std::vector<std::string> expected;
  for (const std::string target : {"t_absent", "t_theirs", "t_gone"}) {
    const std::vector<std::pair<const char*, std::string>> calls = {
        {"roadmap_create_node", R"({"treeId":"t","label":"B","opens":")" + target + R"("})"},
        {"roadmap_annotate_node", R"({"treeId":"t","nodeId":"a","opens":")" + target + R"("})"},
        {"roadmap_patch_nodes", R"({"treeId":"t","updates":[{"nodeId":"a","opens":")" + target + R"("}],"dryRun":true})"},
        {"roadmap_import_subgraph", R"({"treeId":"t","nodes":[{"id":"a","opens":")" + target + R"("}]})"}};
    for (const auto& [tool, arguments] : calls) {
      const ToolResult refused = gate.callTool(tool, parse(arguments), h.actor);
      CHECK(refused.isError);
      CHECK_EQ(refused.outcomeCode, std::string("opens-not-yours"));
      expected.push_back(std::string("mcp.") + tool + " opens-not-yours");
    }
  }
  CHECK(gate.callTool("roadmap_annotate_node", parse(R"({"treeId":"t","nodeId":"a","opens":7})"), h.actor).isError);
  expected.push_back("mcp.roadmap_annotate_node refused");
  CHECK(gate.callTool("roadmap_annotate_node", parse(R"({"treeId":"t","nodeId":"a","open":"t"})"), h.actor).isError);
  expected.push_back("mcp.roadmap_annotate_node invalid-arguments");
  CHECK_FALSE(gate.callTool("roadmap_annotate_node", parse(R"({"treeId":"t","nodeId":"a","opens":"t"})"), h.actor).isError);
  expected.push_back("mcp.roadmap_annotate_node ok");
  installWriteSink({});

  std::vector<std::string> observed;
  for (const WriteCompletion& completion : completions)
    if (completion.operation.rfind("mcp.", 0) == 0) observed.push_back(completion.operation + " " + completion.outcome);
  CHECK_EQ(observed, expected);
}

// For the owner a node that opens a tree follows it: complete exactly when the tree is, whatever
// mark it holds, and every state, filter and count reads that one completed set.
TEST(mcp_a_node_that_opens_a_tree_is_complete_when_the_tree_is_and_the_last_mark_unlocks_its_dependant) {
  Harness h;
  h.trees.byId["t_sub"] = StoredTree{LooseGraph().exportState(), LegendState{}, {"Deep dive", {}}, 0, h.caller};
  const auto sub = [&](const char* tool, const char* arguments) {
    Json::Value args = parse(arguments);
    args["treeId"] = "t_sub";
    return h.tools.callTool(tool, args, h.actor);
  };
  const auto counts = [&] {
    std::map<std::string, std::string> doneOfTotal;
    const Json::Value listed = body(h.tools.callTool("list_trees", kNoArgs, h.actor));
    for (const Json::Value& row : listed["trees"])
      doneOfTotal[row["id"].asString()] = std::to_string(row["done"].asInt()) + "/" + std::to_string(row["total"].asInt());
    return doneOfTotal;
  };
  CHECK_FALSE(sub("import_subgraph", R"({"nodes":[{"id":"s1","label":"S1"},{"id":"s2","label":"S2"}]})").isError);
  CHECK_FALSE(h.call("import_subgraph", parse(R"({"nodes":[{"id":"idea","label":"Idea","opens":"t_sub"},
                                                            {"id":"next","label":"Next","prerequisites":["idea"]}]})")).isError);
  CHECK_FALSE(sub("set_progress", R"({"nodeId":"s1","status":"complete"})").isError);
  CHECK_FALSE(h.call("set_progress", parse(R"({"nodeId":"idea","status":"complete"})")).isError);

  const Json::Value open = parse(
      R"([{"id":"idea","status":"complete","state":"available","opens":{"treeId":"t_sub","title":"Deep dive","state":"open"}},
          {"id":"next","status":"none","state":"locked"}])");
  CHECK_EQ(body(h.call("get_tree", parse(R"({"fields":["id","status","state","opens"]})")))["tree"]["nodes"], open);
  CHECK_EQ(body(h.call("get_nodes", parse(R"({"nodeIds":["idea","next"],"fields":["id","status","state","opens"]})")))["nodes"], open);
  CHECK_EQ(body(h.call("find_nodes", parse(R"({"state":"available","fields":["id","state"]})"))),
           parse(R"({"count":1,"nodes":[{"id":"idea","state":"available"}]})"));
  CHECK_EQ(body(h.call("find_nodes", parse(R"({"state":"complete"})"))), parse(R"({"count":0,"nodes":[]})"));
  CHECK_EQ(body(h.call("get_progress", kNoArgs)), parse(R"({"completed":["idea"],"outOfOrder":[]})"));
  CHECK(counts() == (std::map<std::string, std::string>{{"t", "0/2"}, {"t_sub", "1/2"}}));

  CHECK_FALSE(sub("set_progress", R"({"nodeId":"s2","status":"complete"})").isError);
  CHECK_FALSE(h.call("set_progress", parse(R"({"nodeId":"idea","status":"none"})")).isError);

  const Json::Value complete = parse(
      R"([{"id":"idea","status":"none","state":"complete","opens":{"treeId":"t_sub","title":"Deep dive","state":"complete"}},
          {"id":"next","status":"none","state":"available"}])");
  CHECK_EQ(body(h.call("get_tree", parse(R"({"fields":["id","status","state","opens"]})")))["tree"]["nodes"], complete);
  CHECK_EQ(body(h.call("get_nodes", parse(R"({"nodeIds":["idea","next"],"fields":["id","status","state","opens"]})")))["nodes"], complete);
  CHECK_EQ(body(h.call("find_nodes", parse(R"({"state":"available","fields":["id","state"]})"))),
           parse(R"({"count":1,"nodes":[{"id":"next","state":"available"}]})"));
  CHECK_EQ(body(h.call("find_nodes", parse(R"({"state":"complete","fields":["id","opens"]})"))),
           parse(R"({"count":1,"nodes":[{"id":"idea","opens":{"treeId":"t_sub","title":"Deep dive","state":"complete"}}]})"));
  CHECK_EQ(body(h.call("get_progress", kNoArgs)), parse(R"({"completed":[],"outOfOrder":[]})"));
  CHECK(counts() == (std::map<std::string, std::string>{{"t", "1/2"}, {"t_sub", "2/2"}}));
}

// Completeness passes up a chain of trees: the top node waits on the middle tree, which waits on the leaf.
TEST(mcp_a_node_follows_a_tree_that_itself_waits_on_a_tree_it_opens) {
  Harness h;
  h.trees.byId["t_mid"] = StoredTree{LooseGraph().exportState(), LegendState{}, {"Middle", {}}, 0, h.caller};
  h.trees.byId["t_leaf"] = StoredTree{LooseGraph().exportState(), LegendState{}, {"Leaf", {}}, 0, h.caller};
  const auto in = [&](const char* tree, const char* tool, const char* arguments) {
    Json::Value args = parse(arguments);
    args["treeId"] = tree;
    return h.tools.callTool(tool, args, h.actor);
  };
  const auto counts = [&] {
    std::map<std::string, std::string> doneOfTotal;
    const Json::Value listed = body(h.tools.callTool("list_trees", kNoArgs, h.actor));
    for (const Json::Value& row : listed["trees"])
      doneOfTotal[row["id"].asString()] = std::to_string(row["done"].asInt()) + "/" + std::to_string(row["total"].asInt());
    return doneOfTotal;
  };
  CHECK_FALSE(in("t_leaf", "create_node", R"({"id":"l","label":"L"})").isError);
  CHECK_FALSE(in("t_mid", "import_subgraph", R"({"nodes":[{"id":"deeper","label":"Deeper","opens":"t_leaf"},{"id":"m","label":"M"}]})").isError);
  CHECK_FALSE(in("t", "create_node", R"({"id":"idea","label":"Idea","opens":"t_mid"})").isError);
  CHECK_FALSE(in("t_mid", "set_progress", R"({"updates":[{"nodeId":"m","status":"complete"},{"nodeId":"deeper","status":"complete"}]})").isError);

  CHECK_EQ(body(in("t", "get_tree", R"({"fields":["id","state","opens"]})"))["tree"]["nodes"],
           parse(R"([{"id":"idea","state":"available","opens":{"treeId":"t_mid","title":"Middle","state":"open"}}])"));
  CHECK_EQ(body(in("t_mid", "get_tree", R"({"fields":["id","state","opens"]})"))["tree"]["nodes"],
           parse(R"([{"id":"deeper","state":"available","opens":{"treeId":"t_leaf","title":"Leaf","state":"open"}},
                     {"id":"m","state":"complete"}])"));
  CHECK(counts() == (std::map<std::string, std::string>{{"t", "0/1"}, {"t_leaf", "0/1"}, {"t_mid", "1/2"}}));

  CHECK_FALSE(in("t_leaf", "set_progress", R"({"nodeId":"l","status":"complete"})").isError);

  CHECK_EQ(body(in("t", "get_tree", R"({"fields":["id","state","opens"]})"))["tree"]["nodes"],
           parse(R"([{"id":"idea","state":"complete","opens":{"treeId":"t_mid","title":"Middle","state":"complete"}}])"));
  CHECK_EQ(body(in("t_mid", "find_nodes", R"({"state":"complete","fields":["id","opens"]})")),
           parse(R"({"count":2,"nodes":[{"id":"deeper","opens":{"treeId":"t_leaf","title":"Leaf","state":"complete"}},{"id":"m"}]})"));
  CHECK(counts() == (std::map<std::string, std::string>{{"t", "1/1"}, {"t_leaf", "1/1"}, {"t_mid", "2/2"}}));
}

// A reader who cannot write the tree is told nothing of a pointer: the node is an ordinary one whose
// state follows their own mark, whatever the opened tree has come to, and no read is made for them.
TEST(mcp_a_reader_who_cannot_write_the_tree_reads_an_ordinary_node_that_follows_their_own_mark) {
  Harness h;
  h.trees.byId["t"].visibility = Visibility::public_;
  h.trees.byId["t_sub"] = StoredTree{LooseGraph().exportState(), LegendState{}, {"Deep dive", {}}, 0, h.caller};
  const ToolCaller stranger{uid("stranger"), ToolScope::everything()};
  const ToolCaller signedOut{UserId{}, ToolScope::everything()};
  std::vector<std::string> repliesToOthers;
  const auto read = [&](const ToolCaller& reader, const char* tool, const char* arguments) {
    Json::Value args = parse(arguments);
    args["treeId"] = "t";
    const ToolResult reply = h.tools.callTool(tool, args, reader);
    if (reader.user != h.caller) repliesToOthers.push_back(message(reply));
    return body(reply);
  };
  CHECK_FALSE(h.tools.callTool("create_node", parse(R"({"treeId":"t_sub","id":"s","label":"S"})"), h.actor).isError);
  CHECK_FALSE(h.call("import_subgraph", parse(R"({"nodes":[{"id":"idea","label":"Idea","opens":"t_sub"},
                                                            {"id":"next","label":"Next","prerequisites":["idea"]}]})")).isError);
  CHECK_FALSE(h.tools.callTool("set_progress", parse(R"({"treeId":"t","nodeId":"idea","status":"complete"})"), stranger).isError);

  const char* everything = R"({"fields":["id","status","state","opens"]})";
  const Json::Value marked = parse(R"([{"id":"idea","status":"complete","state":"complete"},{"id":"next","status":"none","state":"available"}])");
  const Json::Value unmarked = parse(R"([{"id":"idea","status":"none","state":"available"},{"id":"next","status":"none","state":"locked"}])");
  CHECK_EQ(read(stranger, "get_tree", everything)["tree"]["nodes"], marked);
  CHECK_EQ(read(stranger, "get_nodes", R"({"nodeIds":["idea","next"],"fields":["id","status","state","opens"]})")["nodes"], marked);
  CHECK_EQ(read(stranger, "find_nodes", R"({"state":"complete","fields":["id","opens"]})"), parse(R"({"count":1,"nodes":[{"id":"idea"}]})"));
  CHECK_EQ(read(signedOut, "get_tree", everything)["tree"]["nodes"], unmarked);
  CHECK_EQ(read(signedOut, "find_nodes", R"({"state":"available","fields":["id","opens"]})"), parse(R"({"count":1,"nodes":[{"id":"idea"}]})"));
  CHECK(h.trees.openedReads.empty());
  CHECK_EQ(read(h.actor, "get_tree", everything)["tree"]["nodes"],
           parse(R"([{"id":"idea","status":"none","state":"available","opens":{"treeId":"t_sub","title":"Deep dive","state":"open"}},
                     {"id":"next","status":"none","state":"locked"}])"));

  CHECK_FALSE(h.tools.callTool("set_progress", parse(R"({"treeId":"t_sub","nodeId":"s","status":"complete"})"), h.actor).isError);
  CHECK_FALSE(h.tools.callTool("set_progress", parse(R"({"treeId":"t","nodeId":"idea","status":"none"})"), stranger).isError);
  const std::size_t readsForTheOwner = h.trees.openedReads.size();

  CHECK_EQ(read(stranger, "get_tree", everything)["tree"]["nodes"], unmarked);
  CHECK_EQ(read(stranger, "find_nodes", R"({"state":"complete","fields":["id","opens"]})"), parse(R"({"count":0,"nodes":[]})"));
  CHECK_EQ(read(signedOut, "get_tree", everything)["tree"]["nodes"], unmarked);
  CHECK_EQ(read(signedOut, "get_nodes", R"({"nodeIds":["idea","next"],"fields":["id","status","state","opens"]})")["nodes"], unmarked);
  CHECK_EQ(h.trees.openedReads.size(), readsForTheOwner);
  CHECK_EQ(read(h.actor, "get_tree", everything)["tree"]["nodes"],
           parse(R"([{"id":"idea","status":"none","state":"complete","opens":{"treeId":"t_sub","title":"Deep dive","state":"complete"}},
                     {"id":"next","status":"none","state":"available"}])"));

  REQUIRE_EQ(repliesToOthers.size(), 9u);
  for (const std::string& reply : repliesToOthers) {
    CHECK_EQ(reply.find("t_sub"), std::string::npos);
    CHECK_EQ(reply.find("Deep dive"), std::string::npos);
    CHECK_EQ(reply.find("opens"), std::string::npos);
  }
}

// Following costs one read of the stored rows per reply, and nothing where it cannot change the
// answer: a tree that holds no pointer, fields that ask for neither state nor opens, a reader who
// cannot write the tree, and the registry list, which already holds every tree.
TEST(mcp_a_reply_follows_pointers_in_one_read_and_reads_nothing_where_following_changes_nothing) {
  Harness h;
  h.trees.byId["t"].visibility = Visibility::public_;
  h.trees.byId["t_sub"] = StoredTree{LooseGraph().exportState(), LegendState{}, {"Deep dive", {}}, 0, h.caller};
  h.trees.byId["t_other"] = StoredTree{LooseGraph().exportState(), LegendState{}, {"Side quest", {}}, 0, h.caller};
  CHECK_FALSE(h.call("import_subgraph", parse(R"({"nodes":[{"id":"a","label":"A"},{"id":"b","label":"B"},{"id":"c","label":"C"}]})")).isError);

  CHECK_FALSE(h.call("get_tree", parse(R"({"fields":["id","state","opens"]})")).isError);
  CHECK_FALSE(h.call("get_nodes", parse(R"({"nodeIds":["a"],"fields":["id","state","opens"]})")).isError);
  CHECK_FALSE(h.call("find_nodes", parse(R"({"state":"available","fields":["id","state","opens"]})")).isError);
  CHECK(h.trees.openedReads.empty());

  CHECK_FALSE(h.call("patch_nodes", parse(R"({"updates":[{"nodeId":"a","opens":"t_sub"},{"nodeId":"b","opens":"t_other"},{"nodeId":"c","opens":"t_sub"}]})")).isError);
  CHECK_FALSE(h.call("get_tree", kNoArgs).isError);
  CHECK_FALSE(h.call("get_tree", parse(R"({"fields":["id","status","summary","kind"]})")).isError);
  CHECK_FALSE(h.call("get_nodes", parse(R"({"nodeIds":["a"],"fields":["id","label","status"]})")).isError);
  CHECK_FALSE(h.call("find_nodes", parse(R"({"query":"a"})")).isError);
  CHECK_FALSE(h.call("get_progress", kNoArgs).isError);
  CHECK_FALSE(h.tools.callTool("list_trees", kNoArgs, h.actor).isError);
  CHECK(h.trees.openedReads.empty());

  for (const UserId& reader : {uid("stranger"), UserId{}}) {
    const ToolCaller caller{reader, ToolScope::everything()};
    CHECK_FALSE(h.tools.callTool("get_tree", parse(R"({"treeId":"t","fields":["id","state","opens"]})"), caller).isError);
    CHECK_FALSE(h.tools.callTool("get_nodes", parse(R"({"treeId":"t","nodeIds":["a"],"fields":["id","state","opens"]})"), caller).isError);
    CHECK_FALSE(h.tools.callTool("find_nodes", parse(R"({"treeId":"t","state":"available","fields":["id","state","opens"]})"), caller).isError);
  }
  CHECK(h.trees.openedReads.empty());

  const std::set<TreeId> opened{TreeId{"t_other"}, TreeId{"t_sub"}};
  CHECK_FALSE(h.call("get_tree", parse(R"({"fields":["id","state","opens"]})")).isError);
  CHECK_EQ(h.trees.openedReads, (std::vector<std::set<TreeId>>{opened}));
  CHECK_FALSE(h.call("get_nodes", parse(R"({"nodeIds":["a","b","c"],"fields":["id","state"]})")).isError);
  CHECK_EQ(h.trees.openedReads, (std::vector<std::set<TreeId>>{opened, opened}));
  CHECK_FALSE(h.call("find_nodes", parse(R"({"state":"available"})")).isError);
  CHECK_EQ(h.trees.openedReads, (std::vector<std::set<TreeId>>{opened, opened, opened}));
}
