#include "adapters/mcp/RoadmapTools.h"

#include "application/ProgressService.h"
#include "application/RoomRegistry.h"
#include "domain/LooseGraph.h"
#include "ports/Clock.h"
#include "test/application/AuthFakes.h"
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
  FakeTokens tokens;
  RoomRegistry registry{trees, ops, bus};
  ProgressService progress{progressRepo};
  TreeRegistry treeRegistry{trees, progressRepo, tokens, Hlc{1, 0, "genesis"}};
  UserId caller = uid("agent");
  RoadmapTools tools{registry, progress, clock, treeRegistry, bus};

  Harness() {
    trees.byId["t"] = StoredTree{LooseGraph().exportState(), LegendState{}, "Test Roadmap", 0, caller};
  }

  ToolResult call(const char* name, Json::Value args) {
    args["treeId"] = "t";
    return tools.callTool(name, args, caller);
  }
};

Json::Value with(const char* key, const char* value) {
  Json::Value args(Json::objectValue);
  args[key] = value;
  return args;
}

Json::Value node(const char* id, const char* label) {
  Json::Value n(Json::objectValue);
  n["id"] = id;
  n["label"] = label;
  return n;
}

Json::Value mark(const char* nodeId, const char* status) {
  Json::Value m(Json::objectValue);
  m["nodeId"] = nodeId;
  m["status"] = status;
  return m;
}

const Json::Value kNoArgs(Json::objectValue);

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

  // Each set_progress echoes to the caller's live web sessions — here three marks (b, a, b).
  CHECK_EQ(h.bus.progressBroadcasts.size(), 3u);
  const FakeBus::ProgressBroadcast& last = h.bus.progressBroadcasts.back();
  CHECK_EQ(last.node, std::string("b"));
  CHECK_EQ(last.user, h.caller.str());
  CHECK(last.status == ProgressStatus::complete);
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
  CHECK(h.tools.callTool("get_tree", Json::Value(Json::objectValue), h.caller).isError);  // no treeId
  CHECK(h.tools.callTool("get_tree", with("treeId", "nope"), h.caller).isError);          // unknown tree
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

TEST(mcp_create_tree_plants_an_owned_roadmap_and_lists_it) {
  Harness h;
  ToolResult created = h.tools.callTool("create_tree", with("title", "Sailing"), h.caller);
  CHECK_FALSE(created.isError);
  std::string newId = created.structured["treeId"].asString();
  CHECK_FALSE(newId.empty());

  ToolResult listed = h.tools.callTool("list_trees", Json::Value(Json::objectValue), h.caller);
  bool found = false;
  for (const Json::Value& row : listed.structured["trees"])
    if (row["id"].asString() == newId) { found = true; CHECK_EQ(row["title"].asString(), std::string("Sailing")); }
  CHECK(found);
}

TEST(mcp_list_trees_returns_the_callers_owned_rows) {
  Harness h;  // "t" is owned by the caller
  h.call("create_node", with("label", "A"));
  h.call("create_node", with("label", "B"));

  ToolResult listed = h.tools.callTool("list_trees", Json::Value(Json::objectValue), h.caller);
  CHECK_FALSE(listed.isError);
  const Json::Value& trees = listed.structured["trees"];
  CHECK_EQ(trees.size(), 1u);
  CHECK_EQ(trees[0]["id"].asString(), std::string("t"));
  CHECK_EQ(trees[0]["title"].asString(), std::string("Test Roadmap"));
  CHECK_EQ(trees[0]["total"].asInt(), 2);
  CHECK_EQ(trees[0]["done"].asInt(), 0);
}

TEST(mcp_delete_tree_soft_deletes_and_drops_it_from_the_list) {
  Harness h;
  ToolResult deleted = h.call("delete_tree", Json::Value(Json::objectValue));  // caller owns "t"
  CHECK_FALSE(deleted.isError);
  CHECK(deleted.structured["deleted"].asBool());

  ToolResult listed = h.tools.callTool("list_trees", Json::Value(Json::objectValue), h.caller);
  CHECK_EQ(listed.structured["trees"].size(), 0u);
}

TEST(mcp_delete_tree_refuses_a_tree_you_dont_own_and_an_unknown_one) {
  Harness h;
  h.trees.byId["other"] = StoredTree{LooseGraph().exportState(), LegendState{}, "Other", 0, uid("someone")};

  CHECK(h.tools.callTool("delete_tree", with("treeId", "other"), h.caller).isError);  // not the owner
  CHECK(h.tools.callTool("delete_tree", with("treeId", "ghost"), h.caller).isError);  // no such tree
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

  ToolResult got = h.call("get_tree", kNoArgs);
  const Json::Value& nodes = got.structured["tree"]["nodes"];
  const Json::Value* cNode = nullptr;
  for (const Json::Value& n : nodes) if (n["id"].asString() == "c") cNode = &n;
  CHECK(cNode != nullptr);
  CHECK_EQ((*cNode)["prerequisites"].size(), 2u);
  CHECK_EQ((*cNode)["description"].asString(), std::string("the payoff node"));
  CHECK_EQ((*cNode)["links"].size(), 1u);
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
  links.append("https://only-a-url");  // a bare-string link is accepted
  linkOnly["links"] = links;
  CHECK_FALSE(h.call("annotate_node", linkOnly).isError);

  ToolResult got = h.call("get_tree", kNoArgs);
  const Json::Value& a = got.structured["tree"]["nodes"][0];
  CHECK_EQ(a["description"].asString(), std::string("first pass"));  // survived the links-only update
  CHECK_EQ(a["links"].size(), 1u);
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

  ToolResult got = h.call("get_tree", kNoArgs);
  const Json::Value& kind = got.structured["tree"]["kinds"][0];
  CHECK_EQ(kind["label"].asString(), std::string("Infra"));
  CHECK_EQ(kind["description"].asString(), std::string("platform work"));
}

TEST(mcp_import_subgraph_bulk_upserts_and_reports_collisions) {
  Harness h;
  h.call("create_node", node("a", "Old A"));  // will collide with the import

  Json::Value nodeB = node("b", "B");
  Json::Value prereqs(Json::arrayValue);
  prereqs.append("a");
  nodeB["prerequisites"] = prereqs;
  Json::Value nodes(Json::arrayValue);
  nodes.append(node("a", "New A"));
  nodes.append(nodeB);
  Json::Value args(Json::objectValue);
  args["nodes"] = nodes;

  ToolResult imported = h.call("import_subgraph", args);
  CHECK_FALSE(imported.isError);
  CHECK(imported.structured["imported"].asBool());
  CHECK_EQ(imported.structured["nodes"].asInt(), 2);
  CHECK_EQ(imported.structured["newNodes"].asInt(), 1);
  CHECK_EQ(imported.structured["nodeCollisions"].size(), 1u);
  CHECK_EQ(imported.structured["nodeCollisions"][0].asString(), std::string("a"));
  CHECK(imported.structured["diagnosticsClean"].asBool());

  ToolResult got = h.call("get_tree", kNoArgs);
  const Json::Value& nodesOut = got.structured["tree"]["nodes"];
  CHECK_EQ(nodesOut.size(), 2u);
  for (const Json::Value& n : nodesOut) {
    if (n["id"].asString() == "a") CHECK_EQ(n["label"].asString(), std::string("New A"));  // upserted
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

  ToolResult preview = h.call("import_subgraph", args);
  CHECK_FALSE(preview.isError);
  CHECK(preview.structured["dryRun"].asBool());
  CHECK_EQ(preview.structured["newNodes"].asInt(), 1);
  CHECK_EQ(preview.structured["nodeCollisions"].size(), 1u);
  CHECK_FALSE(preview.structured.isMember("imported"));

  ToolResult got = h.call("get_tree", kNoArgs);  // nothing changed
  CHECK_EQ(got.structured["tree"]["nodes"].size(), 1u);
  CHECK_EQ(got.structured["tree"]["nodes"][0]["label"].asString(), std::string("A"));
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
  progress.append(mark("b", "complete"));  // b listed before its prerequisite a
  progress.append(mark("a", "complete"));

  Json::Value args(Json::objectValue);
  args["nodes"] = nodes;
  args["progress"] = progress;

  ToolResult imported = h.call("import_subgraph", args);
  CHECK_FALSE(imported.isError);
  CHECK_EQ(imported.structured["progress"].size(), 2u);
  for (const Json::Value& row : imported.structured["progress"])
    if (row["nodeId"].asString() == "b") CHECK(row["prerequisitesMet"].asBool());  // judged on final state

  ToolResult prog = h.call("get_progress", kNoArgs);
  CHECK_EQ(prog.structured["completed"].size(), 2u);
}

TEST(mcp_set_progress_bulk_is_order_safe_and_reports_each) {
  Harness h;
  h.call("create_node", node("a", "A"));
  Json::Value nodeB = node("b", "B");
  nodeB["parentId"] = "a";
  h.call("create_node", nodeB);

  Json::Value updates(Json::arrayValue);
  updates.append(mark("b", "complete"));  // out of dependency order
  updates.append(mark("a", "complete"));
  Json::Value args(Json::objectValue);
  args["updates"] = updates;

  ToolResult res = h.call("set_progress", args);
  CHECK_FALSE(res.isError);
  CHECK_EQ(res.structured["results"].size(), 2u);
  for (const Json::Value& row : res.structured["results"])
    if (row["nodeId"].asString() == "b") CHECK(row["prerequisitesMet"].asBool());  // §9: not misreported false
}

TEST(mcp_set_progress_rejects_an_unknown_node) {
  Harness h;
  CHECK(h.call("set_progress", mark("ghost", "complete")).isError);  // no orphan overlay row is born

  Json::Value updates(Json::arrayValue);
  updates.append(mark("ghost", "active"));
  Json::Value args(Json::objectValue);
  args["updates"] = updates;
  CHECK(h.call("set_progress", args).isError);  // the batch form rejects it too
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

  ToolResult byColor = h.call("find_nodes", with("color", "sky"));
  CHECK_FALSE(byColor.isError);
  CHECK_EQ(byColor.structured["count"].asInt(), 2);
  CHECK_EQ(byColor.structured["nodes"].size(), 2u);

  ToolResult byKind = h.call("find_nodes", with("kind", "frontend"));  // frontend → sky
  CHECK_EQ(byKind.structured["count"].asInt(), 2);

  ToolResult byQuery = h.call("find_nodes", with("query", "webgl"));  // case-insensitive over label
  CHECK_EQ(byQuery.structured["count"].asInt(), 1);
  CHECK_EQ(byQuery.structured["nodes"][0]["id"].asString(), std::string("renderer"));

  ToolResult byDescription = h.call("find_nodes", with("query", "hand-rolled"));
  CHECK_EQ(byDescription.structured["count"].asInt(), 1);
  CHECK_EQ(byDescription.structured["nodes"][0]["id"].asString(), std::string("renderer"));

  Json::Value combined(Json::objectValue);
  combined["color"] = "sky";
  combined["query"] = "zoom";
  ToolResult both = h.call("find_nodes", combined);  // AND: sky and matches "zoom"
  CHECK_EQ(both.structured["count"].asInt(), 1);
  CHECK_EQ(both.structured["nodes"][0]["id"].asString(), std::string("camera"));

  CHECK(h.call("find_nodes", with("color", "chartreuse")).isError);  // unknown color rejected
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
  toGhost["to"] = "ghost";  // an edge to a node that does not exist
  h.call("connect", toGhost);

  h.call("set_progress", mark("a", "complete"));
  h.call("set_progress", mark("b", "active"));
  h.call("delete_node", with("id", "b"));  // b's overlay row and the a->b edge are now orphaned

  ToolResult pruned = h.call("prune", kNoArgs);
  CHECK_FALSE(pruned.isError);
  CHECK_EQ(pruned.structured["prunedEdges"].asInt(), 2);     // a->ghost dangling + a->b (b tombstoned)
  CHECK_EQ(pruned.structured["prunedProgress"].asInt(), 1);  // b's orphaned overlay row
  CHECK(pruned.structured["diagnosticsClean"].asBool());

  ToolResult diag = h.call("get_diagnostics", kNoArgs);
  CHECK(diag.structured["dangling"].empty());
  ToolResult prog = h.call("get_progress", kNoArgs);
  CHECK_EQ(prog.structured["completed"].size(), 1u);  // a remains; b's row gone
  CHECK(prog.structured["inProgress"].empty());
}
