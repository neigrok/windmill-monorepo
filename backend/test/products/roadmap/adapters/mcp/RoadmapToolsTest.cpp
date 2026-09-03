#include "test/products/roadmap/adapters/mcp/ToolsHarness.h"

#include "platform/adapters/mcp/CompositeToolHost.h"
#include "products/roadmap/adapters/mcp/RoadmapToolCatalog.h"
#include "test/testing.h"

using namespace wm;
using namespace wm::fake;
using namespace wm::test;

namespace {

Json::Value everyNodeField() {
  return list({"id", "label", "icon", "color", "kind", "order", "prerequisites", "position", "status",
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
                                              "state", "status", "summary"}));  // no kind wears plum
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
           std::string("find_nodes: fields[1] \"labl\" is not one of {id, label, icon, color, kind, order, "
                       "prerequisites, position, status, seedStatus, state, summary, description, links}"));

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

// --- delete_node and disconnect: the two-form batch contract ------------------------------

namespace {

Json::Value edge(const char* from, const char* to) {
  Json::Value e(Json::objectValue);
  e["from"] = from;
  e["to"] = to;
  return e;
}

// a -> b -> c -> d, with the caller's marks a complete, b complete, c active.
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
  CHECK_EQ(receipt["pruned"]["progress"].asInt(), 2);
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
  CHECK(progress["inProgress"].empty());

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
                 const Hlc& at, std::uint64_t receivedAtMs) override {
    if (armed) throw std::runtime_error("connect host=db.internal user=windmill password=hunter2: FATAL");
    return FakeProgressRepository::setStatus(tree, user, node, status, at, receivedAtMs);
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
