#include "adapters/mcp/RoadmapTools.h"

#include "adapters/json/TreeJson.h"
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
  TreeRegistry treeRegistry{trees, progressRepo, tokens, Hlc{1, 0, "genesis"}, registry, clock};
  UserId caller = uid("agent");
  RoadmapTools tools{registry, progress, clock, treeRegistry, bus};

  Harness() {
    trees.byId["t"] = StoredTree{LooseGraph().exportState(), LegendState{}, {"Test Roadmap", {}}, 0, caller};
  }

  ToolResult call(const char* name, Json::Value args) {
    args["treeId"] = "t";
    return tools.callTool(name, args, caller);
  }
};

// Every successful result speaks through content[0].text — the one channel every MCP client
// reads. structuredContent is not sent (no tool declares an outputSchema), so these tests read
// exactly the bytes an agent reads.
Json::Value body(const ToolResult& result) {
  return parse(result.content[0]["text"].asString());
}

std::string message(const ToolResult& result) {
  return result.content[0]["text"].asString();
}

std::vector<std::string> keys(const Json::Value& value) {
  return value.getMemberNames();
}

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

Json::Value list(std::vector<const char*> values) {
  Json::Value array(Json::arrayValue);
  for (const char* value : values) array.append(value);
  return array;
}

// A `fields` request for the whole node vocabulary — what a caller asks for when it wants the
// document shape the browser gets.
Json::Value everyNodeField() {
  return list({"id", "label", "icon", "color", "order", "prerequisites", "position", "status",
               "description", "links"});
}

const Json::Value kNoArgs(Json::objectValue);

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
  CHECK_EQ(got["tree"]["nodes"].size(), 1u);
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
  b["parentId"] = "a";  // a unlocks b
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
  CHECK_EQ(body(healthy)["nodeCount"].asInt(), 1);

  Json::Value self(Json::objectValue);
  self["from"] = "a";
  self["to"] = "a";
  h.call("connect", self);  // a self-edge makes the graph invalid
  CHECK(h.call("get_health", Json::Value(Json::objectValue)).isError);
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
  CHECK(body(added)["applied"].asBool());

  const Json::Value got = body(h.call("get_tree", Json::Value(Json::objectValue)));
  CHECK_EQ(got["tree"]["kinds"].size(), 1u);
  CHECK_EQ(got["tree"]["kinds"][0]["id"].asString(), std::string("infra"));
  CHECK_EQ(got["tree"]["kinds"][0]["hue"].asString(), std::string("sky"));

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

  CHECK(h.call("remove_kind", with("id", "infra")).isError);  // sky is in use
}

TEST(mcp_create_tree_plants_an_owned_roadmap_and_lists_it) {
  Harness h;
  ToolResult result = h.tools.callTool("create_tree", with("title", "Sailing"), h.caller);
  CHECK_FALSE(result.isError);
  std::string newId = body(result)["treeId"].asString();
  CHECK_FALSE(newId.empty());

  const Json::Value listed = body(h.tools.callTool("list_trees", Json::Value(Json::objectValue), h.caller));
  bool found = false;
  for (const Json::Value& row : listed["trees"])
    if (row["id"].asString() == newId) { found = true; CHECK_EQ(row["title"].asString(), std::string("Sailing")); }
  CHECK(found);
}

TEST(mcp_list_trees_returns_the_callers_owned_rows) {
  Harness h;  // "t" is owned by the caller
  h.trees.byId["t"].createdAt = 1'753'400'000'000;  // planted; epoch ms, exactly like updatedAt
  h.trees.updatedAt["t"] = 1'753'900'000'000;
  h.call("create_node", with("label", "A"));
  h.call("create_node", with("label", "B"));

  ToolResult result = h.tools.callTool("list_trees", Json::Value(Json::objectValue), h.caller);
  CHECK_FALSE(result.isError);
  const Json::Value trees = body(result)["trees"];
  CHECK_EQ(trees.size(), 1u);
  CHECK_EQ(trees[0]["id"].asString(), std::string("t"));
  CHECK_EQ(trees[0]["title"].asString(), std::string("Test Roadmap"));
  CHECK_EQ(trees[0]["total"].asInt(), 2);
  CHECK_EQ(trees[0]["done"].asInt(), 0);
  CHECK_EQ(trees[0]["createdAt"].asInt64(), 1'753'400'000'000);
  CHECK_EQ(trees[0]["updatedAt"].asInt64(), 1'753'900'000'000);
}

TEST(mcp_list_trees_reports_zero_for_a_tree_with_no_recorded_planting) {
  Harness h;  // "t" is seeded without a createdAt
  const Json::Value trees = body(h.tools.callTool("list_trees", Json::Value(Json::objectValue), h.caller))["trees"];
  CHECK_EQ(trees.size(), 1u);
  CHECK(trees[0].isMember("createdAt"));  // present and 0 — never a missing key, never null
  CHECK_EQ(trees[0]["createdAt"].asInt64(), 0);
}

TEST(mcp_delete_tree_soft_deletes_and_drops_it_from_the_list) {
  Harness h;
  ToolResult deleted = h.call("delete_tree", Json::Value(Json::objectValue));  // caller owns "t"
  CHECK_FALSE(deleted.isError);
  CHECK(body(deleted)["deleted"].asBool());

  const Json::Value listed = body(h.tools.callTool("list_trees", Json::Value(Json::objectValue), h.caller));
  CHECK_EQ(listed["trees"].size(), 0u);
}

TEST(mcp_delete_tree_refuses_a_tree_you_dont_own_and_an_unknown_one) {
  Harness h;
  h.trees.byId["other"] = StoredTree{LooseGraph().exportState(), LegendState{}, {"Other", {}}, 0, uid("someone")};

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

  Json::Value args(Json::objectValue);  // the annotation is one `fields` away, never in the default
  args["fields"] = list({"id", "prerequisites", "description", "links"});
  const Json::Value got = body(h.call("get_tree", args));
  const Json::Value* cNode = nullptr;
  for (const Json::Value& n : got["tree"]["nodes"]) if (n["id"].asString() == "c") cNode = &n;
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

  Json::Value args(Json::objectValue);
  args["fields"] = list({"id", "description", "links"});
  const Json::Value a = body(h.call("get_tree", args))["tree"]["nodes"][0];
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

  Json::Value args(Json::objectValue);  // a kind's brief is one `kindFields` away
  args["kindFields"] = list({"label", "description"});
  const Json::Value kind = body(h.call("get_tree", args))["tree"]["kinds"][0];
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

  ToolResult result = h.call("import_subgraph", args);
  CHECK_FALSE(result.isError);
  const Json::Value imported = body(result);
  CHECK(imported["imported"].asBool());
  CHECK_EQ(imported["nodes"].asInt(), 2);
  CHECK_EQ(imported["newNodes"].asInt(), 1);
  CHECK_EQ(imported["nodeCollisions"].size(), 1u);
  CHECK_EQ(imported["nodeCollisions"][0].asString(), std::string("a"));
  CHECK(imported["diagnosticsClean"].asBool());

  const Json::Value got = body(h.call("get_tree", kNoArgs));
  CHECK_EQ(got["tree"]["nodes"].size(), 2u);
  for (const Json::Value& n : got["tree"]["nodes"]) {
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

  ToolResult result = h.call("import_subgraph", args);
  CHECK_FALSE(result.isError);
  const Json::Value preview = body(result);
  CHECK(preview["dryRun"].asBool());
  CHECK_EQ(preview["newNodes"].asInt(), 1);
  CHECK_EQ(preview["nodeCollisions"].size(), 1u);
  CHECK_FALSE(preview.isMember("imported"));

  const Json::Value got = body(h.call("get_tree", kNoArgs));  // nothing changed
  CHECK_EQ(got["tree"]["nodes"].size(), 1u);
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
  progress.append(mark("b", "complete"));  // b listed before its prerequisite a
  progress.append(mark("a", "complete"));

  Json::Value args(Json::objectValue);
  args["nodes"] = nodes;
  args["progress"] = progress;

  ToolResult result = h.call("import_subgraph", args);
  CHECK_FALSE(result.isError);
  const Json::Value imported = body(result);
  CHECK_EQ(imported["progress"].size(), 2u);
  for (const Json::Value& row : imported["progress"])
    if (row["nodeId"].asString() == "b") CHECK(row["prerequisitesMet"].asBool());  // judged on final state

  CHECK_EQ(body(h.call("get_progress", kNoArgs))["completed"].size(), 2u);
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

  ToolResult result = h.call("set_progress", args);
  CHECK_FALSE(result.isError);
  const Json::Value res = body(result);
  CHECK_EQ(res["results"].size(), 2u);
  for (const Json::Value& row : res["results"])
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

  ToolResult result = h.call("find_nodes", with("color", "sky"));
  CHECK_FALSE(result.isError);
  const Json::Value byColor = body(result);
  CHECK_EQ(byColor["count"].asInt(), 2);
  CHECK_EQ(byColor["nodes"].size(), 2u);

  CHECK_EQ(body(h.call("find_nodes", with("kind", "frontend")))["count"].asInt(), 2);  // frontend → sky

  const Json::Value byQuery = body(h.call("find_nodes", with("query", "webgl")));  // case-insensitive
  CHECK_EQ(byQuery["count"].asInt(), 1);
  CHECK_EQ(byQuery["nodes"][0]["id"].asString(), std::string("renderer"));

  const Json::Value byDescription = body(h.call("find_nodes", with("query", "hand-rolled")));
  CHECK_EQ(byDescription["count"].asInt(), 1);
  CHECK_EQ(byDescription["nodes"][0]["id"].asString(), std::string("renderer"));

  Json::Value combined(Json::objectValue);
  combined["color"] = "sky";
  combined["query"] = "zoom";
  const Json::Value both = body(h.call("find_nodes", combined));  // AND: sky and matches "zoom"
  CHECK_EQ(both["count"].asInt(), 1);
  CHECK_EQ(both["nodes"][0]["id"].asString(), std::string("camera"));

  CHECK(h.call("find_nodes", with("color", "chartreuse")).isError);  // unknown color rejected
}

TEST(mcp_read_tools_deny_a_private_tree_you_dont_own) {
  Harness h;  // "t" is the caller's own (private) tree
  h.trees.byId["priv"] =
      StoredTree{LooseGraph().exportState(), LegendState{}, {"Theirs", {}}, 0, uid("someone"), Visibility::private_};

  // Every read tool denies a private tree the caller can't read with the EXACT message an
  // absent tree returns — byte-identical, so the id is no existence oracle on this surface.
  const std::vector<const char*> reads = {"get_tree", "get_diagnostics", "get_health", "find_nodes"};
  for (const char* name : reads) {
    ToolResult denied = h.tools.callTool(name, with("treeId", "priv"), h.caller);
    ToolResult absent = h.tools.callTool(name, with("treeId", "nope"), h.caller);
    CHECK(denied.isError);
    CHECK(absent.isError);
    CHECK_EQ(message(denied), std::string("no such tree \"priv\""));
    CHECK_EQ(message(absent), std::string("no such tree \"nope\""));
  }

  // set_progress must not become a node-id/prerequisite oracle on that same private tree:
  // it denies exactly as absent does (per-user overlay or not, private stays owner-only).
  const auto progArgs = [](const char* tree) {
    Json::Value a(Json::objectValue);
    a["treeId"] = tree; a["nodeId"] = "anything"; a["status"] = "complete";
    return a;
  };
  ToolResult progDenied = h.tools.callTool("set_progress", progArgs("priv"), h.caller);
  ToolResult progAbsent = h.tools.callTool("set_progress", progArgs("nope"), h.caller);
  CHECK(progDenied.isError);
  CHECK_EQ(message(progDenied), std::string("no such tree \"priv\""));
  CHECK_EQ(message(progAbsent), std::string("no such tree \"nope\""));
}

TEST(mcp_read_tools_allow_an_unlisted_tree_by_a_stranger) {
  Harness h;
  h.trees.byId["shared"] =
      StoredTree{LooseGraph().exportState(), LegendState{}, {"Shared", {}}, 0, uid("someone"), Visibility::unlisted};

  CHECK_FALSE(h.tools.callTool("get_tree", with("treeId", "shared"), h.caller).isError);
  CHECK_FALSE(h.tools.callTool("get_diagnostics", with("treeId", "shared"), h.caller).isError);
  CHECK_FALSE(h.tools.callTool("find_nodes", with("treeId", "shared"), h.caller).isError);
}

TEST(mcp_read_tools_allow_your_own_private_tree) {
  Harness h;  // "t" is owned by the caller and private by default
  CHECK_FALSE(h.call("get_tree", Json::Value(Json::objectValue)).isError);
  CHECK_FALSE(h.call("get_diagnostics", Json::Value(Json::objectValue)).isError);
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

  ToolResult result = h.call("prune", kNoArgs);
  CHECK_FALSE(result.isError);
  const Json::Value pruned = body(result);
  CHECK_EQ(pruned["prunedEdges"].asInt(), 2);     // a->ghost dangling + a->b (b tombstoned)
  CHECK_EQ(pruned["prunedProgress"].asInt(), 1);  // b's orphaned overlay row
  CHECK(pruned["diagnosticsClean"].asBool());

  CHECK(body(h.call("get_diagnostics", kNoArgs))["dangling"].empty());
  const Json::Value prog = body(h.call("get_progress", kNoArgs));
  CHECK_EQ(prog["completed"].size(), 1u);  // a remains; b's row gone
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

  // find_nodes is an index: the ids you edit by, the label and hue you recognise them by.
  const Json::Value found = body(h.call("find_nodes", kNoArgs));
  CHECK_EQ(keys(found), (std::vector<std::string>{"count", "nodes"}));  // no nextCursor on a last page
  CHECK_EQ(keys(found["nodes"][0]), (std::vector<std::string>{"color", "id", "label"}));

  // get_tree is the shape: what exists and what unlocks what — no layout, icon or status seed.
  const Json::Value got = body(h.call("get_tree", kNoArgs));
  CHECK_EQ(keys(got), (std::vector<std::string>{"count", "seq", "tree"}));
  CHECK_EQ(keys(got["tree"]), (std::vector<std::string>{"id", "kinds", "nodes", "title"}));
  CHECK_EQ(keys(got["tree"]["nodes"][0]),
           (std::vector<std::string>{"color", "id", "label", "prerequisites"}));
  CHECK_EQ(keys(got["tree"]["kinds"][0]), (std::vector<std::string>{"hue", "id", "label"}));

  // get_progress drops the `cleared` tombstones a browser reconciles against.
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
  seed["status"] = "active";
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
                                              "order", "position", "prerequisites", "status"}));
  CHECK_EQ(b["id"].asString(), std::string("b"));
  CHECK_EQ(b["label"].asString(), std::string("B"));
  CHECK_EQ(b["icon"].asString(), std::string("anchor"));
  CHECK_EQ(b["color"].asString(), std::string("plum"));
  CHECK_EQ(b["order"].asString(), std::string("a0"));
  CHECK_EQ(b["prerequisites"].size(), 1u);
  CHECK_EQ(b["prerequisites"][0].asString(), std::string("a"));
  CHECK_EQ(b["position"]["x"].asDouble(), 12.0);
  CHECK_EQ(b["position"]["y"].asDouble(), 34.0);
  CHECK_EQ(b["status"].asString(), std::string("active"));
  CHECK_EQ(b["description"].asString(), std::string("the whole annotation"));
  CHECK_EQ(b["links"][0]["url"].asString(), std::string("https://spec"));
  CHECK_EQ(b["links"][0]["label"].asString(), std::string("Spec"));

  // find_nodes spells `fields` identically, over the same vocabulary.
  Json::Value search(Json::objectValue);
  search["query"] = "whole annotation";
  search["fields"] = list({"id", "description"});
  const Json::Value match = body(h.call("find_nodes", search))["nodes"][0];
  CHECK_EQ(keys(match), (std::vector<std::string>{"description", "id"}));
  CHECK_EQ(match["description"].asString(), std::string("the whole annotation"));
}

TEST(mcp_get_progress_reaches_the_cleared_tombstones_through_fields) {
  Harness h;
  h.call("create_node", node("a", "A"));
  h.call("create_node", node("b", "B"));
  h.call("set_progress", mark("a", "complete"));
  h.call("set_progress", mark("b", "complete"));
  h.call("set_progress", mark("b", "none"));  // b is cleared, not merely unmarked

  const Json::Value lean = body(h.call("get_progress", kNoArgs));
  CHECK_EQ(keys(lean), (std::vector<std::string>{"completed", "inProgress"}));
  CHECK_EQ(lean["completed"].size(), 1u);
  CHECK_EQ(lean["completed"][0].asString(), std::string("a"));

  Json::Value args(Json::objectValue);
  args["fields"] = list({"completed", "inProgress", "cleared"});
  const Json::Value whole = body(h.call("get_progress", args));
  CHECK_EQ(keys(whole), (std::vector<std::string>{"cleared", "completed", "inProgress"}));
  CHECK_EQ(whole["cleared"].size(), 1u);
  CHECK_EQ(whole["cleared"][0].asString(), std::string("b"));
}

TEST(mcp_an_unknown_field_names_it_and_the_legal_set) {
  Harness h;

  Json::Value args(Json::objectValue);
  args["fields"] = list({"id", "labl"});
  ToolResult misspelled = h.call("find_nodes", args);
  CHECK(misspelled.isError);
  CHECK_EQ(message(misspelled),
           std::string("unknown field: labl; legal fields: id, label, icon, color, order, "
                       "prerequisites, position, status, description, links"));

  // Each shape refuses against ITS OWN vocabulary — the legend's and the overlay's differ.
  Json::Value kindArgs(Json::objectValue);
  kindArgs["kindFields"] = list({"color"});
  ToolResult wrongVocabulary = h.call("get_tree", kindArgs);
  CHECK(wrongVocabulary.isError);
  CHECK_EQ(message(wrongVocabulary),
           std::string("unknown field: color; legal fields: id, hue, label, description"));

  Json::Value progressArgs(Json::objectValue);
  progressArgs["fields"] = list({"nodes"});
  ToolResult wrongProgress = h.call("get_progress", progressArgs);
  CHECK(wrongProgress.isError);
  CHECK_EQ(message(wrongProgress),
           std::string("unknown field: nodes; legal fields: completed, inProgress, cleared"));
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
    CHECK_EQ(page["count"].asInt(), 5);  // the TOTAL matched, on every page — never the page length
    for (const Json::Value& n : page["nodes"]) walked.push_back(n["id"].asString());
    ++pages;
    if (!page.isMember("nextCursor")) break;  // absent, not empty, on the last page
    cursor = page["nextCursor"].asString();
    CHECK_EQ(cursor, walked.back());  // the token is the last id emitted
  }

  CHECK_EQ(pages, 3);  // 2 + 2 + 1
  CHECK_EQ(walked, (std::vector<std::string>{"a", "b", "c", "d", "e"}));  // once each, in order, no gaps

  // get_tree pages the same way, and its `count` is the whole tree.
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
  CHECK_EQ(rest["tree"]["nodes"].size(), 2u);
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
  CHECK_EQ(message(refused), std::string("limit must be a number between 1 and 1000; got 5000"));

  Json::Value zero(Json::objectValue);
  zero["limit"] = 0;
  CHECK(h.call("get_tree", zero).isError);

  Json::Value ghost(Json::objectValue);
  ghost["cursor"] = "vanished";
  ToolResult lost = h.call("find_nodes", ghost);
  CHECK(lost.isError);
  CHECK_EQ(message(lost),
           std::string("unknown cursor: vanished — it names no node in this result set; "
                       "call again without a cursor to walk it from the start"));
}
