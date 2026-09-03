#include "test/products/roadmap/adapters/mcp/ToolsHarness.h"

#include "platform/adapters/mcp/CompositeToolHost.h"
#include "products/roadmap/adapters/mcp/RoadmapToolCatalog.h"
#include "test/testing.h"

using namespace wm;
using namespace wm::fake;
using namespace wm::test;

namespace {

Json::Value everyNodeField() {
  return list({"id", "label", "icon", "color", "order", "prerequisites", "position", "status",
               "seedStatus", "state", "summary", "description", "links"});
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
  CHECK_EQ(message(result), std::string("get_tree: that call failed inside the server. Nothing was "
                                        "changed; the detail is in the server log."));
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

  const std::vector<std::pair<const char*, Json::Value>> writes = {
      {"create_node", edit}, {"import_subgraph", graft}, {"import_subgraph", preview}, {"prune", sweep}};
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
  h.call("set_progress", mark("b", "active"));
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
  CHECK(prog["inProgress"].empty());
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
  CHECK_EQ(keys(got["tree"]), (std::vector<std::string>{"id", "kinds", "nodes", "title"}));
  CHECK_EQ(keys(got["tree"]["nodes"][0]),
           (std::vector<std::string>{"color", "id", "label", "prerequisites"}));
  CHECK_EQ(keys(got["tree"]["kinds"][0]), (std::vector<std::string>{"hue", "id", "label"}));

  h.call("set_progress", mark("a", "complete"));
  h.call("set_progress", mark("a", "none"));
  const Json::Value progress = body(h.call("get_progress", kNoArgs));
  CHECK_EQ(keys(progress), (std::vector<std::string>{"completed", "inProgress"}));
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
                                              "order", "position", "prerequisites", "seedStatus",
                                              "state", "status", "summary"}));
  CHECK_EQ(b["id"].asString(), std::string("b"));
  CHECK_EQ(b["label"].asString(), std::string("B"));
  CHECK_EQ(b["icon"].asString(), std::string("anchor"));
  CHECK_EQ(b["color"].asString(), std::string("plum"));
  CHECK_EQ(b["order"].asString(), std::string("a0"));
  REQUIRE_EQ(b["prerequisites"].size(), 1u);
  CHECK_EQ(b["prerequisites"][0].asString(), std::string("a"));
  CHECK_EQ(b["position"]["x"].asDouble(), 12.0);
  CHECK_EQ(b["position"]["y"].asDouble(), 34.0);
  CHECK_EQ(b["seedStatus"].asString(), std::string("active"));
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

TEST(mcp_summary_never_cuts_inside_a_multibyte_character) {
  Harness h;
  std::string cjk;
  for (int i = 0; i < 120; ++i) cjk += "\u5b57";  // 360 bytes of 字
  Json::Value annotated = node("cjk", "CJK");
  annotated["description"] = cjk;
  h.call("create_node", annotated);

  Json::Value args(Json::objectValue);
  args["fields"] = list({"id", "summary"});
  const std::string summary = body(h.call("get_tree", args))["tree"]["nodes"][0]["summary"].asString();
  const std::string ellipsis = "\u2026";
  const std::string head = summary.substr(0, summary.size() - ellipsis.size());
  CHECK_EQ(summary.substr(summary.size() - ellipsis.size()), ellipsis);
  CHECK_EQ(head.size() % 3, 0u);
  CHECK_EQ(head.size(), 198u);                                // the last whole one under 200
  CHECK_EQ(cjk.rfind(head, 0), 0u);
}

TEST(mcp_get_progress_reaches_the_cleared_tombstones_through_fields) {
  Harness h;
  h.call("create_node", node("a", "A"));
  h.call("create_node", node("b", "B"));
  h.call("set_progress", mark("a", "complete"));
  h.call("set_progress", mark("b", "complete"));
  h.call("set_progress", mark("b", "none"));

  const Json::Value lean = body(h.call("get_progress", kNoArgs));
  CHECK_EQ(keys(lean), (std::vector<std::string>{"completed", "inProgress"}));
  REQUIRE_EQ(lean["completed"].size(), 1u);
  CHECK_EQ(lean["completed"][0].asString(), std::string("a"));

  Json::Value args(Json::objectValue);
  args["fields"] = list({"completed", "inProgress", "cleared"});
  const Json::Value whole = body(h.call("get_progress", args));
  CHECK_EQ(keys(whole), (std::vector<std::string>{"cleared", "completed", "inProgress"}));
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
           std::string("find_nodes: fields[1] \"labl\" is not one of {id, label, icon, color, order, "
                       "prerequisites, position, status, seedStatus, state, summary, description, links}"));

  Json::Value kindArgs(Json::objectValue);
  kindArgs["kindFields"] = list({"color"});
  ToolResult wrongVocabulary = h.call("get_tree", kindArgs);
  CHECK(wrongVocabulary.isError);
  CHECK_EQ(message(wrongVocabulary),
           std::string("get_tree: kindFields[0] \"color\" is not one of {id, hue, label, description}"));

  Json::Value progressArgs(Json::objectValue);
  progressArgs["fields"] = list({"nodes"});
  ToolResult wrongProgress = h.call("get_progress", progressArgs);
  CHECK(wrongProgress.isError);
  CHECK_EQ(message(wrongProgress),
           std::string("get_progress: fields[0] \"nodes\" is not one of {completed, inProgress, cleared}"));
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
  CHECK_EQ(tree[0]["status"].asString(), std::string("active"));
  CHECK_EQ(tree[1]["status"].asString(), std::string("complete"));
  CHECK_EQ(tree[2]["status"].asString(), std::string("none"));

  const Json::Value found = body(h.call("find_nodes", args))["nodes"];
  CHECK_EQ(ids(found), (std::vector<std::string>{"doing", "done", "untouched"}));
  CHECK_EQ(found[0]["status"].asString(), std::string("active"));
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
  CHECK_EQ(found[1]["state"].asString(), std::string("active"));
  CHECK_EQ(found[1]["status"].asString(), std::string("active"));
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
           std::string("find_nodes: state \"bogus\" is not one of {locked, available, active, complete}"));
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
  CHECK_EQ(marked["status"].asString(), std::string("active"));
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

TEST(mcp_import_subgraph_tombstones_nodes_edges_and_progress_in_one_seq) {
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
  CHECK_EQ(strings(body(h.call("get_progress", kNoArgs))["inProgress"]), (std::vector<std::string>{"b"}));
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
                       "description, icon, id, label, links, order, position, prerequisites, seedStatus."));
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
