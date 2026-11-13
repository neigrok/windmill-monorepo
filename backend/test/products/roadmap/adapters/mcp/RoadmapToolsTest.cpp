#include "test/products/roadmap/adapters/mcp/ToolsHarness.h"

#include "platform/adapters/mcp/CompositeToolHost.h"
#include "platform/application/WriteObservation.h"
#include "products/roadmap/adapters/mcp/ReadShape.h"
#include "products/roadmap/adapters/json/CommandJson.h"
#include "products/roadmap/adapters/mcp/RoadmapToolCatalog.h"
#include "products/roadmap/application/ActivityFeed.h"
#include "products/roadmap/application/ForkService.h"
#include "platform/ports/FailureReporter.h"
#include "test/testing.h"

#include <chrono>
#include <limits>
#include <memory>
#include <mutex>
#include <new>
#include <optional>
#include <thread>
#include <tuple>
#include <typeinfo>

using namespace wm;
using namespace wm::fake;
using namespace wm::test;

namespace {

// change_edges' arguments that add the one edge `edge`.
Json::Value adding(const Json::Value& edge) {
  Json::Value args(Json::objectValue);
  args["add"].append(edge);
  return args;
}

Json::Value everyNodeField() {
  return list({"id", "label", "icon", "color", "kind", "order", "prerequisites", "status",
               "seedStatus", "state", "summary", "description", "links", "opens"});
}

std::vector<std::string> ids(const Json::Value& nodes) {
  std::vector<std::string> out;
  for (const Json::Value& node : nodes) out.push_back(node["id"].asString());
  return out;
}

// A user's marks on tree "t" as the progress store holds them, on nodes the tree holds or not — what get_progress
// answers only for the nodes it holds.
Json::Value storedMarks(ProgressService& progress, const UserId& user) {
  const Progress overlay = progress.progressOf(TreeId{"t"}, user);
  Json::Value marks = parse(R"({"completed":[],"cleared":[]})");
  for (const NodeId& node : overlay.completed) marks["completed"].append(node.str());
  for (const NodeId& node : overlay.cleared) marks["cleared"].append(node.str());
  return marks;
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

// A store whose reads fail from the moment a tree has been inserted.
struct LoadsFailAfterCreate : FakeTreeRepository {
  bool inserted = false;
  void create(const TreeId& tree, const GraphState& state, const LegendState& legend, const std::string& title,
              const UserId& owner) override {
    FakeTreeRepository::create(tree, state, legend, title, owner);
    inserted = true;
  }
  std::optional<StoredTree> load(const TreeId& tree) override {
    if (inserted) throw std::runtime_error("connection reset mid-read");
    return FakeTreeRepository::load(tree);
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

TEST(mcp_adding_a_back_edge_surfaces_a_cycle_and_flags_it) {
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
  CHECK(body(h.call("change_edges", adding(forward)))["diagnosticsClean"].asBool());

  Json::Value back(Json::objectValue);
  back["from"] = "b";
  back["to"] = "a";
  CHECK_FALSE(body(h.call("change_edges", adding(back)))["diagnosticsClean"].asBool());

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

TEST(mcp_update_nodes_marks_and_flags_unmet_prerequisites) {
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
  ToolResult early = h.call("update_nodes", asUpdate(markB));
  CHECK_FALSE(early.isError);
  CHECK_FALSE(body(early)["progress"][0]["prerequisitesMet"].asBool());

  Json::Value markA(Json::objectValue);
  markA["nodeId"] = "a";
  markA["status"] = "complete";
  h.call("update_nodes", asUpdate(markA));
  CHECK(body(h.call("update_nodes", asUpdate(markB)))["progress"][0]["prerequisitesMet"].asBool());

  CHECK_EQ(body(h.call("get_progress", Json::Value(Json::objectValue)))["completed"].size(), 2u);

  REQUIRE_EQ(h.bus.progressBroadcasts.size(), 3u);
  const FakeBus::ProgressBroadcast& last = h.bus.progressBroadcasts.back();
  CHECK_EQ(last.user, h.caller.str());
  REQUIRE_EQ(last.marks.marks.size(), 1u);
  CHECK_EQ(last.marks.marks.begin()->first, nid("b"));
  CHECK(last.marks.marks.begin()->second.status == ProgressStatus::complete);
  CHECK(last.marks.marks.begin()->second.at.isSet());
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

TEST(mcp_create_tree_plants_the_legend_it_is_sent_and_answers_it) {
  Harness h;
  const ToolResult created = h.tools.callTool("create_tree", parse(R"({"title":"Crew board","kinds":[
    {"id":"developer","hue":"sky","label":"Developer"},
    {"id":"designer","hue":"plum","label":"Designer","description":"Draws the flows"},
    {"id":"owner","hue":"gold","label":"Owner"}]})"), h.actor);
  CHECK_FALSE(created.isError);
  const std::string tree = body(created)["treeId"].asString();
  CHECK_EQ(body(created), parse(R"({"treeId":")" + tree + R"(","url":"https://app.example/#/app/)" + tree +
                                R"(","kinds":[{"id":"developer","hue":"sky","label":"Developer"},
    {"id":"designer","hue":"plum","label":"Designer"},{"id":"owner","hue":"gold","label":"Owner"}]})"));

  Json::Value read = parse(R"({"kindFields":["id","hue","label","description"]})");
  read["treeId"] = tree;
  CHECK_EQ(body(h.tools.callTool("get_tree", read, h.actor))["tree"]["kinds"],
           parse(R"([{"id":"developer","hue":"sky","label":"Developer","description":""},
    {"id":"designer","hue":"plum","label":"Designer","description":"Draws the flows"},
    {"id":"owner","hue":"gold","label":"Owner","description":""}])"));

  Json::Value filed = parse(R"({"label":"Fix the crash","kind":"developer"})");
  filed["treeId"] = tree;
  CHECK_EQ(body(h.tools.callTool("create_node", filed, h.actor)),
           parse(R"({"applied":true,"seq":1,"id":"fix-the-crash","kind":"developer","diagnosticsClean":true,
    "introducedDiagnostics":[]})"));
}

// The reply answers the legend from what the call planted, with no read after the insert: a read that
// fails once the tree exists cannot turn a planted tree into a refusal that invites a second one.
TEST(mcp_create_tree_answers_the_legend_it_planted_without_reading_the_tree_back) {
  FakeProgressRepository progressRepo;
  LoadsFailAfterCreate trees;
  FakeOpLog ops;
  FakeBus bus;
  StepClock clock;
  FakeTokens tokens;
  RoomRegistry registry{trees, ops, bus};
  ProgressService progress{progressRepo, trees};
  TreeRegistry treeRegistry{trees, progressRepo, tokens, Hlc{1, 0, "genesis"}, registry, clock};
  RoadmapTools tools{registry, progress, clock, treeRegistry, bus, "https://app.example"};
  CompositeToolHost gate(std::vector<ToolModule>{{tools, ""}});

  const ToolResult created =
      gate.callTool("create_tree", parse(R"({"title":"Crew board","kinds":[{"id":"owner","hue":"gold","label":"Owner"}]})"),
                    ToolCaller{uid("agent"), ToolScope::everything()});
  CHECK_FALSE(created.isError);
  REQUIRE_EQ(trees.byId.size(), 1u);
  const std::string tree = trees.byId.begin()->first;
  CHECK_EQ(body(created), parse(R"({"treeId":")" + tree + R"(","url":"https://app.example/#/app/)" + tree +
                                R"(","kinds":[{"id":"owner","hue":"gold","label":"Owner"}]})"));
}

TEST(mcp_create_tree_without_kinds_plants_the_default_legend_and_answers_it) {
  Harness h;
  const Json::Value created = body(h.tools.callTool("create_tree", with("title", "Sailing"), h.actor));
  const std::string tree = created["treeId"].asString();
  CHECK_EQ(created, parse(R"({"treeId":")" + tree + R"(","url":"https://app.example/#/app/)" + tree + R"(","kinds":[
    {"id":"build","hue":"terracotta","label":"Build"},{"id":"learn","hue":"olive","label":"Learn"},
    {"id":"milestone","hue":"gold","label":"Milestone"}]})"));
}

TEST(mcp_create_tree_refuses_a_legend_it_cannot_plant_and_plants_no_tree) {
  Harness h;
  const auto trees = [&] { return body(h.tools.callTool("list_trees", Json::Value(Json::objectValue), h.actor)); };
  const Json::Value before = trees();
  const std::size_t rows = h.trees.byId.size();
  std::string seven = R"({"kinds":[)";
  for (const char* hue : {"terracotta", "olive", "gold", "brick", "sky", "plum", "sky"})
    seven += std::string(seven.back() == '[' ? "" : ",") + R"({"id":"k)" + std::to_string(seven.size()) +
             R"(","hue":")" + hue + R"("})";
  seven += "]}";

  for (const auto& [arguments, refusal] : std::vector<std::pair<std::string, std::string>>{
           {R"({"kinds":[]})",
            "create_tree: kinds, when sent, names at least one kind — leave it out for the default legend"},
           {R"({"kinds":[{"id":"dev","hue":"sky"},{"id":"dev","hue":"plum"}]})",
            "create_tree: kinds[1].id \"dev\" is already used by kinds[0] — an id names one kind per batch"},
           {R"({"kinds":[{"id":"dev","hue":"sky"},{"id":"ops","hue":"sky"}]})",
            "create_tree: kinds[1].hue \"sky\" already belongs to kind \"dev\" — a hue names one kind, so pick a "
            "free one"},
           {seven, "create_tree: kinds has 7 items, max 6"},
           {R"({"kinds":"owner"})", "create_tree: argument \"kinds\" must be an array of objects, got string"},
           {R"({"kinds":[{"id":"dev","hue":"chartreuse"}]})",
            "create_tree: kinds[0].hue \"chartreuse\" is not one of {terracotta, olive, gold, brick, sky, plum}"}}) {
    const ToolResult refused = h.tools.callTool("create_tree", parse(arguments), h.actor);
    CHECK(refused.isError);
    CHECK_EQ(message(refused), refusal);
  }
  CHECK_EQ(trees(), before);
  CHECK_EQ(h.trees.byId.size(), rows);
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

TEST(mcp_update_nodes_annotates_and_leaves_untouched_fields_alone) {
  Harness h;
  h.call("create_node", node("a", "A"));

  Json::Value describe(Json::objectValue);
  describe["nodeId"] = "a";
  describe["description"] = "first pass";
  CHECK_FALSE(h.call("update_nodes", asUpdate(describe)).isError);

  Json::Value linkOnly(Json::objectValue);
  linkOnly["nodeId"] = "a";
  Json::Value links(Json::arrayValue);
  links.append("https://only-a-url");
  linkOnly["links"] = links;
  CHECK_FALSE(h.call("update_nodes", asUpdate(linkOnly)).isError);

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

TEST(mcp_update_nodes_marks_are_order_safe_and_each_reported) {
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

  ToolResult result = h.call("update_nodes", args);
  CHECK_FALSE(result.isError);
  const Json::Value res = body(result);
  CHECK_EQ(res["progress"].size(), 2u);
  for (const Json::Value& row : res["progress"])
    if (row["nodeId"].asString() == "b") CHECK(row["prerequisitesMet"].asBool());
}

TEST(mcp_update_nodes_refuses_a_mark_on_an_unknown_node) {
  Harness h;
  CHECK(h.call("update_nodes", asUpdate(mark("ghost", "complete"))).isError);

  Json::Value updates(Json::arrayValue);
  updates.append(mark("ghost", "active"));
  Json::Value args(Json::objectValue);
  args["updates"] = updates;
  CHECK(h.call("update_nodes", args).isError);
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

  const std::vector<const char*> reads = {"get_tree", "get_diagnostics", "find_nodes"};
  for (const char* name : reads) {
    ToolResult denied = h.tools.callTool(name, with("treeId", "priv"), h.actor);
    ToolResult absent = h.tools.callTool(name, with("treeId", "nope"), h.actor);
    CHECK(denied.isError);
    CHECK(absent.isError);
    CHECK_EQ(message(denied), std::string(name) + ": no such tree \"priv\"");
    CHECK_EQ(message(absent), std::string(name) + ": no such tree \"nope\"");
  }

  const auto progArgs = [](const char* tree) {
    Json::Value a = asUpdate(mark("anything", "complete"));
    a["treeId"] = tree;
    return a;
  };
  ToolResult progDenied = h.tools.callTool("update_nodes", progArgs("priv"), h.actor);
  ToolResult progAbsent = h.tools.callTool("update_nodes", progArgs("nope"), h.actor);
  CHECK(progDenied.isError);
  CHECK_EQ(message(progDenied), std::string("update_nodes: no such tree \"priv\""));
  CHECK_EQ(message(progAbsent), std::string("update_nodes: no such tree \"nope\""));
}

TEST(mcp_an_infrastructure_failure_answers_generically_and_never_leaks_its_detail) {
  FailingTreeRepository trees;
  FakeOpLog ops;
  FakeBus bus;
  FakeProgressRepository progressRepo;
  StepClock clock;
  FakeTokens tokens;
  RoomRegistry registry{trees, ops, bus};
  ProgressService progress{progressRepo, trees};
  TreeRegistry treeRegistry{trees, progressRepo, tokens, Hlc{1, 0, "genesis"}, registry, clock};
  const UserId caller = uid("agent");
  RoadmapTools tools{registry, progress, clock, treeRegistry, bus, "https://app.example"};

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

  Json::Value guide(Json::objectValue);
  guide["treeId"] = "demo";
  guide["guide"] = "Mine now";

  const std::vector<std::pair<const char*, Json::Value>> writes = {
      {"create_node", edit}, {"import_subgraph", graft}, {"import_subgraph", preview}, {"update_tree", guide}};
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

// --- The read projections (adapters/mcp/ReadShape.h) ---------------------------------------

TEST(mcp_find_nodes_answers_an_index_and_get_tree_the_shape) {
  Harness h;
  Json::Value a = node("a", "A");
  a["description"] = "four thousand bytes of prose live here";
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
  CHECK_EQ(keys(got["tree"]), (std::vector<std::string>{"guide", "guides", "id", "kinds", "nodes", "title", "url"}));
  CHECK_EQ(keys(got["tree"]["nodes"][0]),
           (std::vector<std::string>{"color", "id", "label", "prerequisites"}));
  CHECK_EQ(keys(got["tree"]["kinds"][0]), (std::vector<std::string>{"hue", "id", "label"}));

  h.call("update_nodes", asUpdate(mark("a", "complete")));
  h.call("update_nodes", asUpdate(mark("a", "none")));
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
                                              "opens", "order", "prerequisites", "seedStatus",
                                              "state", "status", "summary"}));  // no kind wears plum
  CHECK_EQ(b["opens"], parse(R"({"treeId":"t","title":"Test Roadmap","state":"open"})"));
  CHECK_EQ(b["id"].asString(), std::string("b"));
  CHECK_EQ(b["label"].asString(), std::string("B"));
  CHECK_EQ(b["icon"].asString(), std::string("anchor"));
  CHECK_EQ(b["color"].asString(), std::string("plum"));
  CHECK_EQ(b["order"].asString(), std::string("a0"));
  REQUIRE_EQ(b["prerequisites"].size(), 1u);
  CHECK_EQ(b["prerequisites"][0].asString(), std::string("a"));
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
  h.call("update_nodes", asUpdate(mark("a", "complete")));
  h.call("update_nodes", asUpdate(mark("b", "complete")));
  h.call("update_nodes", asUpdate(mark("b", "none")));

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
                       "prerequisites, status, seedStatus, state, summary, description, links, opens, url}"));

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
  h.call("update_nodes", asUpdate(mark("done", "complete")));
  h.call("update_nodes", asUpdate(mark("doing", "active")));

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
  Json::Value marked = asUpdate(mark("step", "complete"));
  marked["treeId"] = "open";
  h.tools.callTool("update_nodes", marked, h.actor);

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
  h.call("update_nodes", asUpdate(mark("a", "complete")));

  Json::Value args(Json::objectValue);
  args["fields"] = list({"id", "state", "status"});
  Json::Value tree = body(h.call("get_tree", args))["tree"]["nodes"];
  CHECK_EQ(ids(tree), (std::vector<std::string>{"a", "b", "c"}));
  CHECK_EQ(keys(tree[0]), (std::vector<std::string>{"id", "state", "status"}));
  CHECK_EQ(tree[0]["state"].asString(), std::string("complete"));
  CHECK_EQ(tree[1]["state"].asString(), std::string("available"));
  CHECK_EQ(tree[1]["status"].asString(), std::string("none"));
  CHECK_EQ(tree[2]["state"].asString(), std::string("locked"));

  h.call("update_nodes", asUpdate(mark("b", "active")));
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
  h.call("update_nodes", asUpdate(mark("a", "complete")));

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
  CHECK_FALSE(body(h.call("change_edges", adding(back)))["diagnosticsClean"].asBool());
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

  h.call("update_nodes", asUpdate(mark("shipped", "active")));
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

  Json::Value ghost = node("c", "C");
  ghost["prerequisites"] = list({"ghost"});
  const Json::Value guilty = body(h.call("create_node", ghost));
  CHECK_FALSE(guilty["diagnosticsClean"].asBool());
  CHECK_EQ(introduced(guilty), (std::vector<std::string>{"dangling edge \"ghost\" -> \"c\""}));

  Json::Value renamed(Json::objectValue);
  renamed["nodeId"] = "a";
  renamed["label"] = "A renamed";
  const Json::Value innocent = body(h.call("update_nodes", asUpdate(renamed)));
  CHECK_FALSE(innocent["diagnosticsClean"].asBool());
  CHECK_EQ(introduced(innocent), std::vector<std::string>{});

  const Json::Value cleaned = body(h.call("change_edges", parse(R"({"remove":[{"from":"ghost","to":"c"}]})")));
  CHECK(cleaned["diagnosticsClean"].asBool());
  CHECK_EQ(introduced(cleaned), std::vector<std::string>{});
}

TEST(mcp_an_edit_names_the_cycle_the_dangle_and_the_self_edge_it_introduced) {
  Harness h;
  h.call("create_node", node("a", "A"));
  h.call("create_node", node("b", "B"));
  Json::Value forward(Json::objectValue);
  forward["from"] = "a";
  forward["to"] = "b";
  CHECK_EQ(introduced(body(h.call("change_edges", adding(forward)))), std::vector<std::string>{});

  Json::Value back(Json::objectValue);
  back["from"] = "b";
  back["to"] = "a";
  CHECK_EQ(introduced(body(h.call("change_edges", adding(back)))),
           (std::vector<std::string>{"cycle among \"a\", \"b\""}));

  Json::Value loop(Json::objectValue);
  loop["from"] = "a";
  loop["to"] = "a";
  CHECK_EQ(introduced(body(h.call("change_edges", adding(loop)))),
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

// --- delete_node: the two-form batch contract ------------------------------

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
  h.call("change_edges", adding(edge("a", "b")));
  h.call("change_edges", adding(edge("b", "c")));
  h.call("change_edges", adding(edge("c", "d")));
  h.call("update_nodes", asUpdate(mark("a", "complete")));
  h.call("update_nodes", asUpdate(mark("b", "complete")));
  h.call("update_nodes", asUpdate(mark("c", "active")));
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
  // Dirt this delete did not make, as a client's frame may land it: it stays.
  h.registry.open(TreeId{"t"})->applyCommand(AddEdge{NodeId{"a"}, NodeId{"ghost"}}, h.clock.nowMs(), h.caller);
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

  // The tree's old dirt is the caller's to remove, by naming the edge.
  const Json::Value swept = body(h.call("change_edges", parse(R"({"remove":[{"from":"a","to":"ghost"}]})")));
  CHECK_EQ(swept["removedEdges"], parse(R"([{"from":"a","to":"ghost"}])"));
  CHECK(swept["diagnosticsClean"].asBool());
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
  CHECK_EQ(receipt["pruned"]["progress"].asInt(), 1);
  CHECK_EQ(body(h.call("get_progress", kNoArgs))["completed"].size(), 1u);  // the caller's mark on b goes with it

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


// Removing an edge the tree never held plants no tombstone: nothing lands, no seq is minted, and the lattice holds the
// entries it held; a present edge among absent ones lands alone, as the one entry its frame touches.
TEST(mcp_removing_an_edge_the_tree_never_held_plants_no_tombstone) {
  Harness h;
  chain(h);
  const Seq before = headOf(h);
  const std::size_t entries = h.registry.open(tid())->exportState().edges.size();
  CHECK_EQ(entries, 3u);

  Json::Value args(Json::objectValue);
  args["remove"] = edgeList({{"x", "y"}, {"a", "d"}, {"d", "a"}});
  const Json::Value receipt = body(h.call("change_edges", args));
  CHECK(receipt["unchanged"].asBool());
  CHECK_EQ(receipt["unchangedEdges"].asInt(), 3);
  CHECK_EQ(receipt["seq"].asInt64(), before);
  CHECK_EQ(h.registry.open(tid())->exportState().edges.size(), entries);
  CHECK_EQ(h.ops.byTree["t"].size(), static_cast<std::size_t>(before));
  CHECK_EQ(h.bus.subgraphBroadcasts.size(), static_cast<std::size_t>(before));

  args["remove"] = edgeList({{"x", "y"}, {"a", "b"}});
  const Json::Value mixed = body(h.call("change_edges", args));
  CHECK_EQ(mixed["removedEdges"], edgeList({{"a", "b"}}));
  CHECK_EQ(mixed["seq"].asInt64(), before + 1);
  CHECK_EQ(h.registry.open(tid())->exportState().edges.size(), entries);
  CHECK_EQ(h.bus.subgraphBroadcasts.back().subgraph.graph.edges.size(), 1u);
}

// A malformed batch is refused whole, naming what is wrong, and nothing lands: no edge named, a row missing an
// endpoint, an edge named twice, and a list past the cap.
TEST(mcp_change_edges_refuses_a_malformed_batch_whole) {
  Harness h;
  chain(h);
  const Seq before = headOf(h);

  CHECK_EQ(message(h.call("change_edges", kNoArgs)),
           std::string("change_edges: add and remove must contain 1 to 500 edges in total. Call get_tree with fields "
                       "[\"id\",\"prerequisites\"] to list the edges this tree has."));

  Json::Value halfRow(Json::objectValue);
  halfRow["remove"] = edgeList({{"a", "b"}});
  halfRow["remove"][0].removeMember("to");
  CHECK_EQ(message(h.call("change_edges", halfRow)),
           std::string("change_edges: missing required argument \"remove[0].to\""));

  Json::Value repeated(Json::objectValue);
  repeated["remove"] = edgeList({{"a", "b"}, {"b", "c"}, {"a", "b"}});
  CHECK_EQ(message(h.call("change_edges", repeated)),
           std::string("change_edges: remove repeats edge \"a\" -> \"b\""));

  Json::Value tooMany(Json::objectValue);
  Json::Value many(Json::arrayValue);
  for (int i = 0; i < 501; ++i) many.append(edge("a", ("n" + std::to_string(i)).c_str()));
  tooMany["remove"] = many;
  CHECK_EQ(message(h.call("change_edges", tooMany)), std::string("change_edges: remove has 501 items, max 500"));

  CHECK_EQ(headOf(h), before);
  CHECK_EQ(body(h.call("get_tree", kNoArgs))["tree"]["nodes"].size(), 4u);
}

TEST(mcp_delete_node_publishes_both_forms_in_its_schema) {
  Harness h;
  const Json::Value catalog = h.tools.listTools(h.actor);

  const Json::Value* del = nullptr;
  for (const Json::Value& tool : catalog)
    if (tool["name"].asString() == "delete_node") del = &tool;
  REQUIRE(del != nullptr);

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
    {"id":"review","label":"Backend review","icon":"magnifier","color":"sky","order":"a0",
     "seedStatus":"complete","description":"Read the diff.","links":[{"url":"https://windmill.works/review","label":"guide"}]}]})")).isError);
  const Json::Value read = parse(R"({"nodeIds":["review"],"fields":["id","label","icon","color","order",
    "prerequisites","seedStatus","description","links"]})");

  const ToolResult result = h.call("import_subgraph", parse(R"({"nodes":[{"id":"review","prerequisites":["ask"]}]})"));
  CHECK_FALSE(result.isError);
  CHECK_EQ(body(result), parse(R"({"nodes":1,"edges":1,"kinds":0,"nodeCollisions":["review"],"kindCollisions":[],
    "newNodes":0,"newKinds":0,"prerequisiteMode":"merge","keptEdges":[],"keptEdgeCount":0,
    "tombstoned":{"nodes":0,"edges":0},"graphApplied":true,"progressApplied":true,"imported":true,"seq":2,
    "diagnosticsClean":true,"introducedDiagnostics":[]})"));
  CHECK_EQ(body(h.call("get_nodes", read)), parse(R"({"treeId":"t","seq":2,"nodes":[
    {"id":"review","label":"Backend review","icon":"magnifier","color":"sky","order":"a0","prerequisites":["ask"],
     "seedStatus":"complete","description":"Read the diff.",
     "links":[{"url":"https://windmill.works/review","label":"guide"}]}],"missingNodeIds":[]})"));
}

TEST(mcp_import_subgraph_applies_every_field_a_re_sent_node_carries_and_an_empty_one_clears_it) {
  Harness h;
  CHECK_FALSE(h.call("import_subgraph", parse(R"({"nodes":[{"id":"ask","label":"Ask AI"},
    {"id":"review","label":"Backend review","icon":"magnifier","color":"sky","order":"a0",
     "seedStatus":"complete","description":"Read the diff.","links":[{"url":"https://windmill.works/review","label":"guide"}]}]})")).isError);
  const Json::Value read = parse(R"({"nodeIds":["review"],"fields":["id","label","icon","color","order",
    "prerequisites","seedStatus","description","links"]})");

  const ToolResult result = h.call("import_subgraph", parse(R"({"nodes":[{"id":"review","label":"Review the backend",
    "icon":"","color":"plum","order":"","seedStatus":"none","description":"","links":[]}]})"));
  CHECK_FALSE(result.isError);
  CHECK_EQ(body(result), parse(R"({"nodes":1,"edges":0,"kinds":0,"nodeCollisions":["review"],"kindCollisions":[],
    "newNodes":0,"newKinds":0,"prerequisiteMode":"merge","keptEdges":[],"keptEdgeCount":0,
    "tombstoned":{"nodes":0,"edges":0},"graphApplied":true,"progressApplied":true,"imported":true,"seq":2,
    "diagnosticsClean":true,"introducedDiagnostics":[]})"));
  CHECK_EQ(body(h.call("get_nodes", read)), parse(R"({"treeId":"t","seq":2,"nodes":[
    {"id":"review","label":"Review the backend","icon":"","color":"plum","prerequisites":[],
     "seedStatus":"none"}],"missingNodeIds":[]})"));
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
    "prerequisites","seedStatus","description","links"]})"))),
           parse(R"({"treeId":"t","seq":1,"nodes":[{"id":"fresh","label":"","icon":"","color":"terracotta",
    "prerequisites":[]}],"missingNodeIds":[]})"));
}

TEST(mcp_import_subgraph_replace_swaps_a_re_sent_nodes_prerequisites_and_keeps_the_fields_it_leaves_out) {
  Harness h;
  CHECK_FALSE(h.call("import_subgraph", parse(R"({"nodes":[{"id":"ask","label":"Ask AI"},
    {"id":"review","label":"Backend review","icon":"magnifier","color":"sky","order":"a0",
     "seedStatus":"complete","description":"Read the diff.","links":[{"url":"https://windmill.works/review","label":"guide"}]}]})")).isError);
  const Json::Value read = parse(R"({"nodeIds":["review"],"fields":["id","label","icon","color","order",
    "prerequisites","seedStatus","description","links"]})");
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
     "seedStatus":"complete","description":"Read the diff.",
     "links":[{"url":"https://windmill.works/review","label":"guide"}]}],"missingNodeIds":[]})"));
}

TEST(mcp_import_subgraph_revives_a_deleted_node_with_the_fields_it_leaves_out) {
  Harness h;
  CHECK_FALSE(h.call("import_subgraph", parse(R"({"nodes":[{"id":"ask","label":"Ask AI"},
    {"id":"review","label":"Backend review","icon":"magnifier","color":"sky","order":"a0",
     "seedStatus":"complete","description":"Read the diff.","links":[{"url":"https://windmill.works/review","label":"guide"}]}]})")).isError);
  const Json::Value read = parse(R"({"nodeIds":["review"],"fields":["id","label","icon","color","order",
    "prerequisites","seedStatus","description","links"]})");
  CHECK_FALSE(h.call("delete_node", with("nodeId", "review")).isError);

  const ToolResult result = h.call("import_subgraph", parse(R"({"nodes":[{"id":"review"}]})"));
  CHECK_FALSE(result.isError);
  CHECK_EQ(body(result), parse(R"({"nodes":1,"edges":0,"kinds":0,"nodeCollisions":[],"kindCollisions":[],
    "newNodes":1,"newKinds":0,"prerequisiteMode":"merge","keptEdges":[],"keptEdgeCount":0,
    "tombstoned":{"nodes":0,"edges":0},"graphApplied":true,"progressApplied":true,"imported":true,"seq":3,
    "diagnosticsClean":true,"introducedDiagnostics":[]})"));
  CHECK_EQ(body(h.call("get_nodes", read)), parse(R"({"treeId":"t","seq":3,"nodes":[
    {"id":"review","label":"Backend review","icon":"magnifier","color":"sky","order":"a0","prerequisites":[],
     "seedStatus":"complete","description":"Read the diff.",
     "links":[{"url":"https://windmill.works/review","label":"guide"}]}],"missingNodeIds":[]})"));
}

TEST(mcp_import_subgraph_dry_run_of_a_field_less_node_previews_the_collision_and_changes_nothing) {
  Harness h;
  CHECK_FALSE(h.call("import_subgraph", parse(R"({"nodes":[{"id":"ask","label":"Ask AI"},
    {"id":"review","label":"Backend review","icon":"magnifier","color":"sky","order":"a0",
     "seedStatus":"complete","description":"Read the diff.","links":[{"url":"https://windmill.works/review","label":"guide"}]}]})")).isError);
  const Json::Value read = parse(R"({"nodeIds":["review"],"fields":["id","label","icon","color","order",
    "prerequisites","seedStatus","description","links"]})");

  const ToolResult result = h.call("import_subgraph", parse(R"({"nodes":[{"id":"review","prerequisites":["ask"]}],
    "dryRun":true})"));
  CHECK_FALSE(result.isError);
  CHECK_EQ(body(result), parse(R"({"nodes":1,"edges":1,"kinds":0,"nodeCollisions":["review"],"kindCollisions":[],
    "newNodes":0,"newKinds":0,"prerequisiteMode":"merge","keptEdges":[],"keptEdgeCount":0,
    "tombstoned":{"nodes":0,"edges":0},"dryRun":true,"tombstone":[]})"));
  CHECK_EQ(body(h.call("get_nodes", read)), parse(R"({"treeId":"t","seq":1,"nodes":[
    {"id":"review","label":"Backend review","icon":"magnifier","color":"sky","order":"a0","prerequisites":[],
     "seedStatus":"complete","description":"Read the diff.",
     "links":[{"url":"https://windmill.works/review","label":"guide"}]}],"missingNodeIds":[]})"));
}

// Re-sending a node the tree holds to add an edge edits it the way connect would: its creation stamp,
// which orders it among its siblings, stays; the op row is the edge, and the feed says it was linked.
TEST(mcp_import_subgraph_re_sending_a_held_node_keeps_its_creation_and_the_feed_says_what_changed) {
  Harness h;
  for (const char* id : {"root", "x"}) CHECK_FALSE(h.call("create_node", node(id, id)).isError);
  for (const char* id : {"a", "b"}) {
    Json::Value child = node(id, id);
    child["parentId"] = "root";
    CHECK_FALSE(h.call("create_node", child).isError);
  }
  const auto stateOf = [&](const char* id) {
    for (const NodeStateEntry& entry : h.registry.open(TreeId{"t"})->exportState().nodes)
      if (entry.id == NodeId{id}) return entry;
    return NodeStateEntry{};
  };
  const NodeStateEntry held = stateOf("a");
  const Json::Value resend = parse(R"({"nodes":[{"id":"a","label":"a","prerequisites":["root","x"]}]})");

  Json::Value preview = resend;
  preview["dryRun"] = true;
  CHECK_EQ(body(h.call("import_subgraph", preview)), parse(R"({"nodes":1,"edges":2,"kinds":0,"nodeCollisions":["a"],
    "kindCollisions":[],"newNodes":0,"newKinds":0,"prerequisiteMode":"merge","keptEdges":[],"keptEdgeCount":0,
    "tombstoned":{"nodes":0,"edges":0},"dryRun":true,"tombstone":[]})"));
  CHECK(stateOf("a") == held);

  CHECK_EQ(body(h.call("import_subgraph", resend)), parse(R"({"nodes":1,"edges":2,"kinds":0,"nodeCollisions":["a"],
    "kindCollisions":[],"newNodes":0,"newKinds":0,"prerequisiteMode":"merge","keptEdges":[],"keptEdgeCount":0,
    "tombstoned":{"nodes":0,"edges":0},"graphApplied":true,"progressApplied":true,"imported":true,"seq":5,
    "diagnosticsClean":true,"introducedDiagnostics":[]})"));
  CHECK(stateOf("a") == held);
  CHECK_EQ(strings((*nodeNamed(body(h.call("get_tree", kNoArgs)), "a"))["prerequisites"]),
           (std::vector<std::string>{"root", "x"}));

  REQUIRE_EQ(h.ops.byTree["t"].size(), 5u);
  const Command& row = h.ops.byTree["t"].back().command;
  CHECK_EQ(commandKind(row), std::string("AddEdge"));
  CHECK_EQ(commandPayload(row), parse(R"({"from":"x","to":"a"})"));
  const std::vector<ActivityEvent> feed =
      activityFeed(h.registry.open(TreeId{"t"})->snapshot(), h.ops.byTree["t"], 50);
  REQUIRE_EQ(feed.size(), 5u);
  const ActivityEvent& linked = feed.back();
  CHECK_EQ((std::vector<std::string>{std::to_string(linked.seq), std::to_string(linked.at), linked.actor, linked.verb,
                                     linked.node.str(), linked.label, linked.kind, linked.summary}),
           (std::vector<std::string>{"5", "0", "", "linked", "a", "a", "terracotta",
                                     "linked x → a · cross-branch"}));
}

// A get_tree round trip carries the legend back. A kind sent as the legend holds it changes nothing, so
// re-sending a node to add an edge with the kinds carried still leaves the edge as the op row.
TEST(mcp_import_subgraph_with_the_legend_carried_back_names_the_edge_it_added) {
  Harness h;
  CHECK_FALSE(h.call("import_subgraph", parse(R"({"nodes":[{"id":"ask","label":"Ask AI"},
    {"id":"review","label":"Backend review","color":"sky"}],"kinds":[{"id":"backend","hue":"sky","label":"Backend"}]})"))
                  .isError);
  const LegendState legend = h.registry.open(TreeId{"t"})->exportLegend();

  CHECK_EQ(body(h.call("import_subgraph", parse(R"({"nodes":[{"id":"review","prerequisites":["ask"]}],
    "kinds":[{"id":"backend","hue":"sky","label":"Backend"}]})"))),
           parse(R"({"nodes":1,"edges":1,"kinds":1,"nodeCollisions":["review"],"kindCollisions":["backend"],
    "newNodes":0,"newKinds":0,"prerequisiteMode":"merge","keptEdges":[],"keptEdgeCount":0,
    "tombstoned":{"nodes":0,"edges":0},"graphApplied":true,"progressApplied":true,"imported":true,"seq":2,
    "diagnosticsClean":true,"introducedDiagnostics":[]})"));
  CHECK(h.registry.open(TreeId{"t"})->exportLegend() == legend);

  REQUIRE_EQ(h.ops.byTree["t"].size(), 2u);
  const Command& row = h.ops.byTree["t"].back().command;
  CHECK_EQ(commandKind(row), std::string("AddEdge"));
  CHECK_EQ(commandPayload(row), parse(R"({"from":"ask","to":"review"})"));
  const std::vector<ActivityEvent> feed =
      activityFeed(h.registry.open(TreeId{"t"})->snapshot(), h.ops.byTree["t"], 1);
  REQUIRE_EQ(feed.size(), 1u);
  CHECK_EQ((std::vector<std::string>{std::to_string(feed[0].seq), feed[0].verb, feed[0].node.str(), feed[0].label,
                                     feed[0].kind, feed[0].summary}),
           (std::vector<std::string>{"2", "linked", "review", "Backend review", "sky",
                                     "linked Ask AI → Backend review"}));
}

// An import is one op row, and the row names the batch's most salient change, the same with the legend
// carried back as the tree holds it or not: an added edge beside a rename reads as the rename, two new
// edges as the first of them, a new node beside a renamed one as the new node.
TEST(mcp_import_subgraph_names_the_most_salient_change_of_its_batch_in_its_one_row) {
  struct Case {
    const char* batch;
    const char* row;
    const char* summary;
  };
  for (const Case& c : {Case{R"([{"id":"n","label":"N2","prerequisites":["p"]}])",
                             R"({"kind":"RenameNode","payload":{"id":"n","label":"N2"}})", "renamed to N2"},
                        Case{R"([{"id":"n","prerequisites":["p","q"]}])",
                             R"({"kind":"AddEdge","payload":{"from":"p","to":"n"}})", "linked P → N"},
                        Case{R"([{"id":"zeta","label":"Zeta"},{"id":"n","label":"N2"}])",
                             R"({"kind":"CreateNode","payload":{"id":"zeta","label":"Zeta","icon":"","color":"terracotta"}})",
                             "added Zeta"}}) {
    for (const bool legendCarried : {false, true}) {
      Harness h;
      CHECK_FALSE(h.call("import_subgraph", parse(R"({"nodes":[{"id":"p","label":"P"},{"id":"q","label":"Q"},
        {"id":"n","label":"N"}],"kinds":[{"id":"build","hue":"terracotta","label":"Build"}]})")).isError);
      Json::Value args(Json::objectValue);
      args["nodes"] = parse(c.batch);
      if (legendCarried) args["kinds"] = parse(R"([{"id":"build","hue":"terracotta","label":"Build"}])");
      CHECK_FALSE(h.call("import_subgraph", args).isError);

      REQUIRE_EQ(h.ops.byTree["t"].size(), 2u);
      const Command& row = h.ops.byTree["t"].back().command;
      Json::Value written(Json::objectValue);
      written["kind"] = commandKind(row);
      written["payload"] = commandPayload(row);
      CHECK_EQ(written, parse(c.row));
      const std::vector<ActivityEvent> feed =
          activityFeed(h.registry.open(TreeId{"t"})->snapshot(), h.ops.byTree["t"], 1);
      REQUIRE_EQ(feed.size(), 1u);
      CHECK_EQ(feed[0].summary, std::string(c.summary));
    }
  }
}

// An import that re-sends the tree a node opens as the node holds it writes nothing and sends no frame; one
// that changes only that register sends a frame carrying it alone.
TEST(mcp_import_subgraph_writes_the_tree_a_node_opens_only_when_the_batch_changes_it) {
  Harness h;
  h.trees.byId["t_sub"] = StoredTree{LooseGraph().exportState(), LegendState{}, {"Deep dive", {}}, 0, h.caller};
  h.trees.byId["t_two"] = StoredTree{LooseGraph().exportState(), LegendState{}, {"Second look", {}}, 0, h.caller};
  CHECK_FALSE(h.call("import_subgraph", parse(R"({"nodes":[{"id":"a","label":"A","opens":"t_sub"}]})")).isError);
  const std::size_t rows = h.ops.byTree["t"].size();
  const std::size_t frames = h.bus.subgraphBroadcasts.size();

  CHECK(body(h.call("import_subgraph", parse(R"({"nodes":[{"id":"a","opens":"t_sub"}]})")))["unchanged"].asBool());
  CHECK_EQ(h.bus.subgraphBroadcasts.size(), frames);
  CHECK_EQ(h.ops.byTree["t"].size(), rows);

  CHECK_FALSE(h.call("import_subgraph", parse(R"({"nodes":[{"id":"a","opens":"t_two"}]})")).isError);
  const GraphState& moved = h.bus.subgraphBroadcasts.back().subgraph.graph;
  REQUIRE_EQ(moved.nodes.size(), 1u);
  CHECK(moved.nodes[0].opensAt.isSet());
  CHECK(moved == (GraphState{{NodeStateEntry{.id = NodeId{"a"}, .opens = TreeId{"t_two"},
                                             .opensAt = moved.nodes[0].opensAt}},
                             {}}));
  CHECK_EQ(body(h.call("get_tree", parse(R"({"fields":["id","label","opens"]})")))["tree"]["nodes"],
           parse(R"([{"id":"a","label":"A","opens":{"treeId":"t_two","title":"Second look","state":"open"}}])"));
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
  ProgressService progress{progressRepo, trees};
  TreeRegistry treeRegistry{trees, progressRepo, tokens, Hlc{1, 0, "genesis"}, registry, clock};
  const UserId caller = uid("agent");
  RoadmapTools tools{registry, progress, clock, treeRegistry, bus, "https://app.example"};
  trees.byId["t"] = StoredTree{LooseGraph().exportState(), LegendState{}, {"Test Roadmap", {}}, 0, caller};
  auto call = [&](const char* name, Json::Value args) {
    args["treeId"] = "t";
    return tools.callTool(name, args, ToolCaller{caller, ToolScope::everything()});
  };
  CHECK_FALSE(call("create_node", node("n", "N")).isError);
  CHECK_FALSE(call("update_nodes", asUpdate(mark("n", "complete"))).isError);
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
  CHECK_EQ(storedMarks(progress, caller), parse(R"({"completed":["n"],"cleared":[]})"));
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
           std::string("and 10 more — to drop the ones you do not want, re-send the node with prerequisiteMode "
                       "\"replace\" and its whole prerequisites list"));
  CHECK_EQ(receipt["keptEdgeCount"].asUInt64(), 60u);
}

TEST(mcp_import_subgraph_tombstones_nodes_and_edges_in_one_seq_and_clears_progress_after_the_graft) {
  Harness h;
  h.call("create_node", node("a", "A"));
  CHECK_FALSE(h.call("import_subgraph", importOf({nodeWith("n", {"a"}), nodeWith("b", {"n"})})).isError);
  CHECK_FALSE(h.call("update_nodes", asUpdate(mark("n", "complete"))).isError);
  CHECK_FALSE(h.call("update_nodes", asUpdate(mark("a", "complete"))).isError);
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
  CHECK_FALSE(h.call("update_nodes", asUpdate(mark("b", "active"))).isError);

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
                       "description, icon, id, kind, label, links, opens, order, prerequisites, seedStatus."));
  CHECK_EQ(body(h.call("get_tree", kNoArgs))["tree"]["nodes"].size(), 0u);

  Json::Value deeper = node("x", "X");
  deeper["links"] = parse(R"([{"url":"https://a.example/","z":2}])");
  Json::Value deep = importOf({deeper});
  deep["treeId"] = "t";
  CHECK_EQ(message(gate.callTool("import_subgraph", deep, h.actor)),
           std::string("import_subgraph: unknown argument \"nodes[0].links[0].z\". nodes[0].links[0] takes: label, url."));
}

TEST(mcp_import_subgraph_takes_no_title_and_never_touches_the_trees) {
  Harness h;
  CompositeToolHost gate(std::vector<ToolModule>{{h.tools, ""}});
  const Json::Value titled = parse(R"({"treeId":"t","title":"Renamed","nodes":[{"id":"a","label":"A"}]})");
  CHECK_EQ(message(gate.callTool("import_subgraph", titled, h.actor)),
           std::string("import_subgraph: unknown argument \"title\". This tool takes: dryRun, expectedSeq, kinds, nodes, "
                       "prerequisiteMode, progress, tombstone, treeId."));
  CHECK_EQ(body(h.call("get_tree", kNoArgs))["tree"]["nodes"].size(), 0u);

  CHECK_FALSE(h.call("import_subgraph", titled).isError);
  CHECK_EQ(body(h.call("get_tree", kNoArgs)),
           parse(R"({"count":1,"seq":1,"tree":{"guide":{"text":"","yours":true},"guides":[],"id":"t","kinds":[],
             "nodes":[{"id":"a","label":"A","color":"terracotta","prerequisites":[]}],"title":"Test Roadmap",
             "url":"https://app.example/#/app/t"}})"));
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

}

TEST(mcp_include_edges_lists_every_live_edge_and_none_of_the_tombstoned) {
  Harness h;
  h.call("create_node", node("a", "A"));
  h.call("create_node", coloredNode("b", "sky", {"a"}));
  h.call("create_node", coloredNode("c", "sky", {"a", "b"}));
  h.call("create_node", coloredNode("d", "sky", {"c"}));
  CHECK_FALSE(h.call("change_edges", parse(R"({"remove":[{"from":"a","to":"c"}]})")).isError);  // tombstoned edge
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

TEST(mcp_update_nodes_sets_and_clears_the_icon_and_the_empty_icon_smell_follows) {
  Harness h;
  CHECK_FALSE(h.call("add_kind", parse(R"({"id":"k","hue":"terracotta"})")).isError);  // a node's hue says what it is
  h.call("create_node", node("a", "A"));

  auto smells = [&] { return body(h.call("get_diagnostics", kNoArgs))["smells"]; };
  const Json::Value iconless = parse(R"([{"kind":"empty-icon","count":1,"nodes":["a"]}])");
  auto icon = [&] {
    Json::Value args(Json::objectValue);
    args["fields"] = list({"id", "icon"});
    return body(h.call("get_tree", args))["tree"]["nodes"][0]["icon"].asString();
  };
  CHECK_EQ(smells(), iconless);

  Json::Value set(Json::objectValue);
  set["nodeId"] = "a";
  set["icon"] = "star";
  const ToolResult setResult = h.call("update_nodes", asUpdate(set));
  CHECK_FALSE(setResult.isError);
  CHECK(body(setResult)["applied"].asBool());
  CHECK_EQ(icon(), std::string("star"));
  CHECK_EQ(smells(), parse("[]"));

  Json::Value clear(Json::objectValue);
  clear["nodeId"] = "a";
  clear["icon"] = "";
  CHECK_FALSE(h.call("update_nodes", asUpdate(clear)).isError);
  CHECK_EQ(icon(), std::string(""));
  CHECK_EQ(smells(), iconless);

  Json::Value over(Json::objectValue);
  over["nodeId"] = "a";
  over["icon"] = std::string(65, 'i');
  CHECK_EQ(message(h.call("update_nodes", asUpdate(over))),
           std::string("update_nodes: icon would be 65 characters, 1 over the 64 cap"));
}

TEST(mcp_update_nodes_appends_to_the_description_and_refuses_both_forms_at_once) {
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
  CHECK_FALSE(h.call("update_nodes", asUpdate(first)).isError);
  CHECK_EQ(description(), std::string("first entry"));

  Json::Value second(Json::objectValue);
  second["nodeId"] = "a";
  second["appendDescription"] = "second entry";
  CHECK_FALSE(h.call("update_nodes", asUpdate(second)).isError);
  CHECK_EQ(description(), std::string("first entry\n\nsecond entry"));

  Json::Value both(Json::objectValue);
  both["nodeId"] = "a";
  both["description"] = "one";
  both["appendDescription"] = "two";
  const ToolResult refused = h.call("update_nodes", asUpdate(both));
  CHECK(refused.isError);
  CHECK_EQ(message(refused),
           std::string("update_nodes: updates[0]: \"description\" and \"appendDescription\" are both given — pass one: description replaces the body, appendDescription joins onto it."));
  CHECK_EQ(description(), std::string("first entry\n\nsecond entry"));

  Json::Value nothing(Json::objectValue);
  nothing["nodeId"] = "a";
  CHECK_EQ(message(h.call("update_nodes", asUpdate(nothing))),
           std::string("update_nodes: updates[0] sets nothing — pass at least one of label, color, kind, "
                       "description, appendDescription, icon, links, addLinks, opens, status."));

  Json::Value tail(Json::objectValue);
  tail["nodeId"] = "a";
  tail["appendDescription"] = std::string(16000 - 25 + 1, 'y');  // the body is 25 characters and the blank line 2
  CHECK_EQ(message(h.call("update_nodes", asUpdate(tail))),
           std::string("update_nodes: description would be 16003 characters, 3 over the 16000 cap"));
  CHECK_EQ(description(), std::string("first entry\n\nsecond entry"));

  Json::Value fits(Json::objectValue);
  fits["nodeId"] = "a";
  fits["appendDescription"] = std::string(16000 - 25 - 2, 'y');
  CHECK_FALSE(h.call("update_nodes", asUpdate(fits)).isError);
  CHECK_EQ(description().size(), 16000u);
}

TEST(mcp_update_nodes_adds_links_after_the_ones_the_node_holds) {
  Harness h;
  CHECK_FALSE(h.call("create_node", parse(R"({"id":"a","label":"A","links":[{"url":"https://a.example/1","label":"One"},
    {"url":"https://a.example/2","label":"Two"}]})")).isError);

  CHECK_EQ(body(h.call("update_nodes", asUpdate(parse(R"({"nodeId":"a","addLinks":[{"url":"https://figma.example/f","label":"Flow"},
    {"url":"https://a.example/1","label":"Spec"}]})")))),
           parse(R"({"applied":true,"changedNodeIds":["a"],"diagnosticsClean":true,"dryRun":false,"introducedDiagnostics":[],"seq":2,"treeId":"t","unchangedNodeIds":[]})"));
  CHECK_EQ(body(h.call("get_nodes", parse(R"({"nodeIds":["a"],"fields":["id","links"]})"))),
           parse(R"({"treeId":"t","seq":2,"nodes":[{"id":"a","links":[{"url":"https://a.example/1","label":"Spec"},
    {"url":"https://a.example/2","label":"Two"},{"url":"https://figma.example/f","label":"Flow"}]}],"missingNodeIds":[]})"));
}

// addLinks joins the other annotation fields in one write and lands as the same `links` command; a held
// url sent without a label keeps its own, and a null addLinks is left out like any other field.
TEST(mcp_update_nodes_adds_links_beside_the_other_annotation_fields_in_one_write) {
  Harness h;
  h.trees.byId["t_sub"] = StoredTree{LooseGraph().exportState(), LegendState{}, {"Deep dive", {}}, 0, h.caller};
  CHECK_FALSE(h.call("create_node", parse(R"({"id":"a","label":"A","description":"Notes",
    "links":[{"url":"https://a.example/1","label":"One"}]})")).isError);

  CHECK_EQ(body(h.call("update_nodes", asUpdate(parse(R"({"nodeId":"a","appendDescription":"Shipped","icon":"pin",
    "opens":"t_sub","addLinks":[{"url":"https://a.example/1"},{"url":"https://github.example/pr/7","label":"PR"}]})")))),
           parse(R"({"applied":true,"changedNodeIds":["a"],"diagnosticsClean":true,"dryRun":false,"introducedDiagnostics":[],"seq":2,"treeId":"t","unchangedNodeIds":[]})"));
  CHECK_EQ(body(h.call("update_nodes", asUpdate(parse(R"({"nodeId":"a","description":"Rewritten",
    "addLinks":[{"url":"https://figma.example/f","label":"Flow"}]})")))),
           parse(R"({"applied":true,"changedNodeIds":["a"],"diagnosticsClean":true,"dryRun":false,"introducedDiagnostics":[],"seq":3,"treeId":"t","unchangedNodeIds":[]})"));
  CHECK_EQ(commandPayload(h.ops.byTree["t"].back().command),
           parse(R"({"id":"a","description":"Rewritten","links":[{"url":"https://a.example/1","label":"One"},
    {"url":"https://github.example/pr/7","label":"PR"},{"url":"https://figma.example/f","label":"Flow"}]})"));
  CHECK_FALSE(h.call("update_nodes", asUpdate(parse(R"({"nodeId":"a","icon":"flag"})"))).isError);
  CHECK_EQ(commandPayload(h.ops.byTree["t"].back().command), parse(R"({"id":"a","icon":"flag"})"));
  CHECK_EQ(body(h.call("get_nodes", parse(R"({"nodeIds":["a"],"fields":["id","icon","description","links","opens"]})"))),
           parse(R"({"treeId":"t","seq":4,"nodes":[{"id":"a","icon":"flag","description":"Rewritten",
    "links":[{"url":"https://a.example/1","label":"One"},{"url":"https://github.example/pr/7","label":"PR"},
    {"url":"https://figma.example/f","label":"Flow"}],"opens":{"treeId":"t_sub","title":"Deep dive","state":"open"}}],
    "missingNodeIds":[]})"));
}

TEST(mcp_update_nodes_refuses_links_it_cannot_add_and_leaves_the_nodes_links_as_they_were) {
  Harness h;
  Json::Value held = parse(R"({"id":"a","label":"A","links":[]})");
  for (int i = 0; i < 31; ++i) held["links"].append("https://held.example/" + std::to_string(i));
  CHECK_FALSE(h.call("create_node", held).isError);
  const auto read = [&] { return body(h.call("get_nodes", parse(R"({"nodeIds":["a"],"fields":["id","links"]})"))); };
  const Json::Value before = read();
  CompositeToolHost gate(std::vector<ToolModule>{{h.tools, ""}});
  const auto annotate = [&](const char* row) {
    Json::Value args = asUpdate(parse(row));
    args["treeId"] = "t";
    return gate.callTool("roadmap_update_nodes", args, h.actor);
  };
  std::vector<WriteCompletion> lines;
  installWriteSink([&](const WriteCompletion& line) { lines.push_back(line); });

  for (const auto& [arguments, refusal] : std::vector<std::pair<const char*, const char*>>{
           {R"({"nodeId":"a","links":[{"url":"https://x.example"}],"addLinks":[{"url":"https://y.example"}]})",
            "update_nodes: updates[0]: \"links\" and \"addLinks\" are both given — pass one: links replaces the "
            "set, addLinks joins onto it."},
           {R"({"nodeId":"a","addLinks":[]})",
            "update_nodes: updates[0].addLinks, when sent, names at least one link — leave it out to keep the node's "
            "links as they are"},
           {R"({"nodeId":"a","addLinks":[{"url":"https://n.example/1"},{"url":"https://n.example/2"},
              {"url":"https://n.example/1","label":"again"}]})",
            "update_nodes: updates[0].addLinks[2].url repeats updates[0].addLinks[0].url — send each link once"},
           {R"({"nodeId":"a","addLinks":[{"url":"https://n.example/1"},{"url":"https://n.example/2"}]})",
            "update_nodes: links would hold 33 links, 1 over the 32 cap"},
           {R"({"nodeId":"a","addLinks":"https://n.example/1"})",
            "update_nodes: updates[0].addLinks must be an array"},
           {R"({"nodeId":"a","addLinks":[7]})",
            "update_nodes: updates[0].addLinks[0] must be an object {url, label?} or a url string, got number"}}) {
    const ToolResult refused = annotate(arguments);
    CHECK(refused.isError);
    CHECK_EQ(message(refused), std::string(refusal));
  }
  CHECK_EQ(read(), before);

  CHECK_FALSE(annotate(R"({"nodeId":"a","addLinks":[{"url":"https://n.example/1","label":"Last"}]})").isError);
  CHECK_EQ(read()["nodes"][0]["links"].size(), 32u);
  installWriteSink({});

  // One write line per call, a refusal `refused`, and no line carries a url or a label.
  REQUIRE_EQ(lines.size(), 7u);
  for (std::size_t i = 0; i < lines.size(); ++i) {
    CHECK_EQ(lines[i].operation, std::string("mcp.roadmap_update_nodes"));
    CHECK_EQ(lines[i].outcome, std::string(i < 6 ? "refused" : "ok"));
    for (const char* content : {"example", "again", "Last"})
      CHECK_EQ(writeCompletionJson(lines[i]).find(content), std::string::npos);
  }

  // The schema states the same bounds: the item `links` takes, at least one, at most the 32 cap.
  const Json::Value catalog = h.tools.listTools(h.actor);
  const Json::Value* declared = nullptr;
  for (const Json::Value& tool : catalog)
    if (tool["name"].asString() == "update_nodes") declared = &tool;
  REQUIRE(declared != nullptr);
  const Json::Value& properties = (*declared)["inputSchema"]["properties"]["updates"]["items"]["properties"];
  Json::Value linksWithAtLeastOne = properties["links"];
  linksWithAtLeastOne["minItems"] = 1;
  linksWithAtLeastOne["description"] = properties["addLinks"]["description"];
  CHECK_EQ(properties["addLinks"], linksWithAtLeastOne);
  CHECK_EQ(properties["addLinks"]["maxItems"].asUInt64(), 32u);
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
TEST(mcp_a_mark_out_of_order_is_acknowledged_kept_and_shown) {
  Harness h;
  chainAB(h);

  Json::Value meant = markArgs("b", "complete");
  meant["outOfOrder"] = true;
  ToolResult receipt = h.call("update_nodes", asUpdate(meant));
  CHECK_FALSE(receipt.isError);
  CHECK_EQ(keys(body(receipt)["progress"][0]), (std::vector<std::string>{"acknowledged", "nodeId", "prerequisitesMet", "status"}));
  CHECK_FALSE(body(receipt)["progress"][0]["prerequisitesMet"].asBool());
  CHECK(body(receipt)["progress"][0]["acknowledged"].asBool());
  CHECK_EQ(body(receipt)["progress"][0]["status"].asString(), std::string("complete"));

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

  ToolResult plain = h.call("update_nodes", asUpdate(markArgs("b", "complete")));
  CHECK_EQ(keys(body(plain)["progress"][0]), (std::vector<std::string>{"nodeId", "prerequisitesMet", "status"}));
  CHECK_FALSE(body(plain)["progress"][0]["prerequisitesMet"].asBool());
  CHECK_EQ(body(h.call("get_progress", kNoArgs))["outOfOrder"].size(), 0u);
  CHECK_FALSE(h.bus.progressBroadcasts.back().marks.marks.at(nid("b")).outOfOrder);
}

TEST(mcp_update_nodes_carries_out_of_order_per_row) {
  Harness h;
  chainAB(h);

  Json::Value late = markArgs("b", "complete");
  late["outOfOrder"] = true;
  Json::Value updates(Json::arrayValue);
  updates.append(late);
  updates.append(markArgs("a", "complete"));
  Json::Value args(Json::objectValue);
  args["updates"] = updates;

  ToolResult receipt = h.call("update_nodes", args);
  CHECK_FALSE(receipt.isError);
  const Json::Value results = body(receipt)["progress"];
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

TEST(mcp_a_mark_refuses_out_of_order_off_a_completion_and_records_nothing) {
  Harness h;
  chainAB(h);

  Json::Value active = markArgs("b", "active");
  active["outOfOrder"] = true;
  CHECK_EQ(message(h.call("update_nodes", asUpdate(active))),
           std::string("update_nodes: argument \"updates[0].outOfOrder\" acknowledges completing a node before its prerequisites, so it rides status \"complete\" only, got \"none\""));

  Json::Value typed = markArgs("b", "complete");
  typed["outOfOrder"] = "yes";
  CHECK_EQ(message(h.call("update_nodes", asUpdate(typed))),
           std::string("update_nodes: argument \"updates[0].outOfOrder\" must be a boolean, got string"));

  Json::Value cleared = markArgs("a", "none");
  cleared["outOfOrder"] = true;
  Json::Value updates(Json::arrayValue);
  updates.append(markArgs("b", "complete"));
  updates.append(cleared);
  Json::Value bulk(Json::objectValue);
  bulk["updates"] = updates;
  CHECK_EQ(message(h.call("update_nodes", bulk)),
           std::string("update_nodes: argument \"updates[1].outOfOrder\" acknowledges completing a node before its prerequisites, so it rides status \"complete\" only, got \"none\""));

  // A false word is just a completion.
  Json::Value plain = markArgs("b", "complete");
  plain["outOfOrder"] = false;
  CHECK_EQ(keys(body(h.call("update_nodes", asUpdate(plain)))["progress"][0]), (std::vector<std::string>{"nodeId", "prerequisitesMet", "status"}));

  Json::Value overlay = body(h.call("get_progress", kNoArgs));
  CHECK_EQ(overlay["completed"].size(), 1u);
  CHECK_EQ(overlay["outOfOrder"].size(), 0u);
  CHECK_EQ(h.bus.progressBroadcasts.size(), 1u);
}

// A re-sent kind changes only in the fields the batch sends; a new kind without them gets the defaults.
// Rank is never on the wire, so a re-sent kind keeps its place: the frame every replica joins carries
// only the label it changed, with its creation, hue and rank unset. New kinds land after the last one,
// in batch order rather than id order.
TEST(mcp_import_subgraph_keeps_the_legend_order_on_a_colliding_kind_and_appends_a_new_one) {
  Harness h;
  CHECK_FALSE(h.call("add_kind", kindArgs("a", "gold")).isError);
  CHECK_FALSE(h.call("add_kind", kindArgs("b", "sky")).isError);
  CHECK_FALSE(h.call("add_kind", kindArgs("c", "plum")).isError);

  Json::Value kinds(Json::arrayValue);
  kinds.append(kindArgs("c", "plum"));
  kinds[0]["label"] = "Craft";
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
  CHECK(frame.legend.kinds[0].labelAt.isSet());
  CHECK(frame.legend ==
        (LegendState{{KindStateEntry{.id = KindId{"c"}, .label = "Craft", .labelAt = frame.legend.kinds[0].labelAt}}}));

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
// completed whose mark carried the flag, met prerequisites or not.
TEST(mcp_get_progress_describes_out_of_order_as_the_marks_that_carried_the_flag) {
  Harness h;
  for (const ToolDeclaration& tool : h.tools.declareTools()) {
    if (tool.name() != "get_progress") continue;
    CHECK_EQ(tool.descriptor["description"].asString(),
             std::string("The caller's private progress overlay for a roadmap: the node ids that are "
                         "completed, and outOfOrder — the subset of completed whose mark carried "
                         "outOfOrder:true, from an update_nodes row's `status` or an import's progress row. Per-user, "
                         "separate from the shared structure. Only marks on nodes the tree holds are answered: a mark "
                         "on a node someone deleted is kept and shows again when the node comes back."));
    const std::string fields = tool.descriptor["inputSchema"]["properties"]["fields"]["description"].asString();
    CHECK(fields.find("the subset of `completed` whose mark carried outOfOrder:true") != std::string::npos);
    return;
  }
  CHECK(false);
}

TEST(mcp_import_subgraph_keeps_a_colliding_kinds_omitted_fields_and_defaults_a_new_kinds) {
  Harness h;
  Json::Value drill = kindArgs("drill", "gold");
  drill["label"] = "Drill";
  drill["description"] = "Daily drills";
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
  read["kindFields"] = list({"id", "hue", "label", "description"});
  Json::Value legend = body(h.call("get_tree", read))["tree"]["kinds"];
  REQUIRE_EQ(legend.size(), 2u);
  const Json::Value* kept = kindNamed(legend, "drill");
  REQUIRE(kept != nullptr);
  CHECK_EQ((*kept)["hue"].asString(), std::string("gold"));
  CHECK_EQ((*kept)["label"].asString(), std::string("Drill"));
  CHECK_EQ((*kept)["description"].asString(), std::string("Daily drills"));
  const Json::Value* fresh = kindNamed(legend, "read");
  REQUIRE(fresh != nullptr);
  CHECK_EQ((*fresh)["hue"].asString(), std::string("sky"));
  CHECK_EQ((*fresh)["label"].asString(), std::string(""));
  CHECK_EQ((*fresh)["description"].asString(), std::string(""));

  // Sent, a field replaces — an empty string included.
  Json::Value spelled = kindArgs("drill", "gold");
  spelled["label"] = "Drills";
  spelled["description"] = "";
  Json::Value again(Json::arrayValue);
  again.append(spelled);
  args["kinds"] = again;
  CHECK_FALSE(h.call("import_subgraph", args).isError);
  legend = body(h.call("get_tree", read))["tree"]["kinds"];
  const Json::Value* replaced = kindNamed(legend, "drill");
  REQUIRE(replaced != nullptr);
  CHECK_EQ((*replaced)["label"].asString(), std::string("Drills"));
  CHECK_EQ((*replaced)["description"].asString(), std::string(""));
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

TEST(mcp_update_nodes_is_one_edit_preserves_omissions_and_retries_as_noop) {
  Harness h;
  Json::Value a = node("a", "A");
  a["icon"] = "star";
  a["description"] = "Keep this";
  h.call("create_node", a);
  h.call("create_node", node("b", "B"));
  Json::Value args = parse(R"({"updates":[{"nodeId":"a","label":"New A"},{"nodeId":"b","description":"New B"}],"expectedSeq":2})");
  const ToolResult result = h.call("update_nodes", args);
  CHECK_FALSE(result.isError);
  CHECK_EQ(body(result), parse(R"({"treeId":"t","applied":true,"dryRun":false,"seq":3,"changedNodeIds":["a","b"],"unchangedNodeIds":[],"diagnosticsClean":true,"introducedDiagnostics":[]})"));
  CHECK_EQ(result.structured, body(result));
  REQUIRE_EQ(h.bus.subgraphBroadcasts.size(), 3u);
  REQUIRE_EQ(h.ops.byTree["t"].size(), 3u);
  CHECK(std::holds_alternative<Batch>(h.ops.byTree["t"].back().command));
  Json::Value read = parse(R"({"nodeIds":["b","missing","a"],"fields":["id","label","icon","description"]})");
  CHECK_EQ(body(h.call("get_nodes", read)), parse(R"({"treeId":"t","seq":3,"nodes":[{"id":"b","label":"B","icon":"","description":"New B"},{"id":"a","label":"New A","icon":"star","description":"Keep this"}],"missingNodeIds":["missing"]})"));
  const ToolResult conflict = h.call("update_nodes", args);
  CHECK(conflict.isError);
  CHECK_EQ(message(conflict), std::string("update_nodes: expectedSeq conflict: requested 2, current seq is 3. Nothing changed; read get_nodes or get_tree and retry with the current seq."));
  args.removeMember("expectedSeq");
  CHECK_EQ(body(h.call("update_nodes", args)), parse(R"({"treeId":"t","applied":true,"dryRun":false,"seq":3,"changedNodeIds":[],"unchangedNodeIds":["a","b"],"diagnosticsClean":true,"introducedDiagnostics":[],"unchanged":true})"));
  CHECK_EQ(h.bus.subgraphBroadcasts.size(), 3u);
  CHECK_EQ(h.ops.byTree["t"].size(), 3u);
}

TEST(mcp_update_nodes_refuses_the_whole_batch_and_dry_run_changes_nothing) {
  Harness h;
  h.call("create_node", node("a", "A"));
  h.call("create_node", node("b", "B"));
  const Json::Value before = body(h.call("get_tree", kNoArgs));
  for (const char* json : {
      R"({"updates":[{"nodeId":"a","label":"New"},{"nodeId":"missing","label":"Bad"}]})",
      R"({"updates":[{"nodeId":"a","label":"New"},{"nodeId":"a","label":"Duplicate"}]})",
      R"({"updates":[{"nodeId":"a","label":"New"},{"nodeId":"b","description":null}]})",
      R"({"updates":[{"nodeId":"a","label":"New"},{"nodeId":"b","opens":null}]})",
      R"({"updates":[{"nodeId":"a","label":"New"},{"nodeId":"b"}]})",
      R"({"updates":[]})"}) {
    CHECK(h.call("update_nodes", parse(json)).isError);
    CHECK_EQ(body(h.call("get_tree", kNoArgs)), before);
  }
  CHECK_EQ(message(h.call("update_nodes", parse(R"({"updates":[{"nodeId":"b","status":"complete"},{"nodeId":"b","status":"none"}]})"))),
           std::string("update_nodes: updates repeats nodeId \"b\""));
  CHECK_EQ(message(h.call("update_nodes", parse(R"({"updates":[{"nodeId":"b","description":null}]})"))),
           std::string("update_nodes: missing required argument \"updates[0].description\""));
  CHECK_EQ(message(h.call("update_nodes", parse(R"({"updates":[{"nodeId":"b","opens":null}]})"))),
           std::string("update_nodes: missing required argument \"updates[0].opens\""));
  CHECK_EQ(body(h.call("update_nodes", parse(R"({"updates":[{"nodeId":"a","description":""}],"dryRun":true,"expectedSeq":2})"))),
           parse(R"({"treeId":"t","applied":false,"dryRun":true,"seq":2,"changedNodeIds":[],"unchangedNodeIds":["a"],
             "unchanged":true})"));
  CHECK_EQ(body(h.call("get_tree", kNoArgs)), before);
  CHECK_EQ(h.bus.subgraphBroadcasts.size(), 2u);
}

TEST(mcp_change_edges_is_atomic_and_reports_cycles_and_noop_retries) {
  Harness h;
  h.call("create_node", node("a", "A"));
  h.call("create_node", node("b", "B"));
  h.call("change_edges", parse(R"({"add":[{"from":"a","to":"b"}]})"));
  const Json::Value args = parse(R"({"add":[{"from":"b","to":"a"}],"remove":[{"from":"missing","to":"a"}],"expectedSeq":3})");
  CHECK_EQ(body(h.call("change_edges", args)), parse(R"({"treeId":"t","applied":true,"dryRun":false,"seq":4,"addedEdges":[{"from":"b","to":"a"}],"removedEdges":[],"unchangedEdges":1,"diagnosticsClean":false,"introducedDiagnostics":["cycle among \"a\", \"b\""]})"));
  Json::Value retry = args;
  retry.removeMember("expectedSeq");
  CHECK_EQ(body(h.call("change_edges", retry)), parse(R"({"treeId":"t","applied":true,"dryRun":false,"seq":4,"addedEdges":[],"removedEdges":[],"unchangedEdges":2,"diagnosticsClean":false,"introducedDiagnostics":[],"unchanged":true})"));
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
  CHECK_EQ(message(h.call("update_nodes", parse(R"({"updates":[{"nodeId":"n0","label":"No"}]})"))), std::string("update_nodes: no such tree \"t\""));
  CHECK_EQ(message(h.call("change_edges", parse(R"({"add":[{"from":"n0","to":"n1"}]})"))), std::string("change_edges: no such tree \"t\""));
}

TEST(mcp_legacy_progress_aliases_clear_without_completing_prerequisites) {
  Harness h;
  h.call("create_node", node("a", "A"));
  h.call("create_node", node("b", "B"));
  h.call("change_edges", adding(edge("a", "b")));
  h.call("update_nodes", asUpdate(mark("a", "complete")));
  CHECK_FALSE(h.call("update_nodes", asUpdate(mark("a", "active"))).isError);
  CHECK_FALSE(h.call("update_nodes", asUpdate(mark("b", "inProgress"))).isError);

  Json::Value args(Json::objectValue);
  args["fields"] = list({"completed", "cleared", "outOfOrder"});
  CHECK_EQ(body(h.call("get_progress", args)),
           parse(R"({"completed":[],"cleared":["a","b"],"outOfOrder":[]})"));
  args["fields"] = list({"id", "state"});
  CHECK_EQ(body(h.call("get_tree", args))["tree"]["nodes"],
           parse(R"([{"id":"a","state":"available"},{"id":"b","state":"locked"}])"));
}

TEST(mcp_a_guide_set_through_update_tree_rides_every_page_of_get_tree) {
  Harness h;
  for (const char* id : {"a", "b", "c", "d", "e"}) h.call("create_node", node(id, id));
  const std::size_t opRows = h.ops.byTree["t"].size();

  const ToolResult described = h.call("update_tree", with("guide", "Work the trunk first; leaves can wait."));
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

  CHECK_EQ(body(h.call("update_tree", with("guide", ""))), parse(R"({"applied":true,"seq":7})"));
  CHECK_EQ(body(h.call("get_tree", kNoArgs))["tree"]["guide"], parse(R"({"text":"","yours":true})"));
  CHECK_EQ(h.ops.byTree["t"].size(), opRows);
}

TEST(mcp_no_read_but_get_tree_carries_the_guide) {
  Harness h;
  h.call("create_node", node("a", "A"));
  CHECK_FALSE(h.call("update_tree", with("guide", "Rig first, then sail.")).isError);

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
  CHECK_EQ(reads, (std::vector<std::string>{"get_nodes", "list_trees", "get_diagnostics", "get_progress",
                                            "find_nodes"}));

  Json::Value everything(Json::objectValue);
  everything["fields"] = everyNodeField();
  CHECK_EQ(keys(body(h.call("find_nodes", everything))), (std::vector<std::string>{"count", "nodes"}));
  everything["nodeIds"] = list({"a"});
  CHECK_EQ(keys(body(h.call("get_nodes", everything))),
           (std::vector<std::string>{"missingNodeIds", "nodes", "seq", "treeId"}));
}

// describe_tree was update_tree's earlier name and is retired: no declaration carries it, and a call to it is refused as
// a tool the server does not have, in the gate's own words, with nothing written.
TEST(mcp_describe_tree_is_refused_as_an_unknown_tool) {
  Harness h;
  for (const Json::Value& tool : h.tools.listTools(h.actor)) CHECK(tool["name"].asString() != "describe_tree");
  CompositeToolHost gate(std::vector<ToolModule>{{h.tools, ""}});
  const ToolResult refused = gate.callTool("describe_tree", parse(R"({"treeId":"t","guide":"Rig first."})"), h.actor);
  CHECK(refused.isError);
  CHECK_EQ(message(refused),
           std::string("describe_tree: no such tool on this server — call tools/list for the whole surface."));
  CHECK_EQ(h.trees.byId["t"].guide.value, std::string(""));
}

TEST(mcp_a_second_account_reads_an_unlisted_trees_guide_as_not_theirs_and_cannot_set_it) {
  Harness h;
  h.trees.byId["t"].visibility = Visibility::unlisted;
  h.call("create_node", node("a", "A"));
  CHECK_FALSE(h.call("update_tree", with("guide", "Rig first, then sail.")).isError);
  const StoredTree before = h.trees.byId["t"];
  const std::size_t broadcasts = h.bus.subgraphBroadcasts.size();

  h.caller = uid("stranger");
  CHECK_EQ(body(h.call("get_tree", kNoArgs))["tree"]["guide"],
           parse(R"({"text":"Rig first, then sail.","yours":false})"));

  const ToolResult refused = h.call("update_tree", with("guide", "Mine now"));
  CHECK(refused.isError);
  CHECK_EQ(message(refused), ("update_tree: this tree belongs to another account. Call "
                                         "list_trees to see the roadmaps you own."));
  CHECK_EQ(message(h.call("create_node", node("b", "B"))),
           std::string("create_node: this tree belongs to another account. Call list_trees to see the "
                       "roadmaps you own."));
  CHECK(h.trees.byId["t"] == before);
  CHECK_EQ(h.bus.subgraphBroadcasts.size(), broadcasts);
}

TEST(mcp_update_tree_holds_5000_code_points_of_any_width_and_names_the_bound_when_it_refuses) {
  Harness h;
  std::string wide;  // 5000 three-byte characters: 15000 bytes
  for (std::size_t i = 0; i < kMaxGuideChars; ++i) wide += "\xE5\xAD\x97";

  CHECK_FALSE(h.call("update_tree", with("guide", wide.c_str())).isError);
  CHECK_EQ(body(h.call("get_tree", kNoArgs))["tree"]["guide"]["text"].asString(), wide);

  const ToolResult over = h.call("update_tree", with("guide", (wide + "\xE5\xAD\x97").c_str()));
  CHECK(over.isError);
  CHECK_EQ(message(over), ("update_tree: guide is 5001 characters, 1 over the 5000 cap"));
  Json::Value number(Json::objectValue);
  number["guide"] = 42;
  CHECK_EQ(message(h.call("update_tree", number)),
           ("update_tree: argument \"guide\" must be a string, got number. A guide is plain "
                       "text of at most 5000 characters; \"\" clears it."));
  CHECK_EQ(message(h.call("update_tree", kNoArgs)),
           ("update_tree: nothing to set — pass at least one of \"title\", \"guide\"."));
  CHECK_EQ(message(h.call("update_tree", with("guide", "\xE5\xAD"))),
           ("update_tree: guide is not valid UTF-8"));
  CHECK_EQ(h.trees.byId["t"].guide.value, wide);

  const Json::Value catalog = h.tools.listTools(h.actor);
  const Json::Value* declared = nullptr;
  for (const Json::Value& tool : catalog)
    if (tool["name"].asString() == "update_tree") declared = &tool;
  REQUIRE(declared != nullptr);
  const Json::Value& schema = (*declared)["inputSchema"];
  CHECK_EQ(schema["properties"]["guide"]["type"].asString(), std::string("string"));
  CHECK_EQ(schema["properties"]["guide"]["maxLength"].asUInt64(), static_cast<Json::UInt64>(5000));
  CHECK_EQ(schema["properties"]["title"]["type"].asString(), std::string("string"));
  CHECK_EQ(schema["properties"]["title"]["maxLength"].asUInt64(), static_cast<Json::UInt64>(200));
  CHECK_EQ(schema["required"], list({"treeId"}));
}

TEST(mcp_a_tree_with_no_guide_answers_an_empty_text_and_says_whose_it_is) {
  Harness h;
  CHECK_EQ(body(h.call("get_tree", kNoArgs))["tree"]["guide"], parse(R"({"text":"","yours":true})"));

  h.registry.open(TreeId{"t"})->setVisibility(Visibility::public_);
  h.caller = UserId{""};
  CHECK_EQ(body(h.call("get_tree", kNoArgs))["tree"]["guide"], parse(R"({"text":"","yours":false})"));
}

TEST(mcp_update_tree_logs_one_line_per_call_and_no_line_or_refusal_carries_the_guide) {
  Harness h;
  CompositeToolHost gate(std::vector<ToolModule>{{h.tools, ""}});
  std::vector<WriteCompletion> lines;
  installWriteSink([&](const WriteCompletion& line) { lines.push_back(line); });

  Json::Value args(Json::objectValue);
  args["treeId"] = "t";
  args["guide"] = "Private compass: sail at dawn.";
  const ToolResult landed = gate.callTool("roadmap_update_tree", args, h.actor);
  args["guide"] = "Private compass: " + std::string(kMaxGuideChars, 'x');
  const ToolResult over = gate.callTool("roadmap_update_tree", args, h.actor);
  args["treeId"] = "nope";
  args["guide"] = "Private compass: sail at dawn.";
  const ToolResult absent = gate.callTool("update_tree", args, h.actor);
  installWriteSink({});

  CHECK_FALSE(landed.isError);
  CHECK_EQ(message(over), ("update_tree: guide is 5017 characters, 17 over the 5000 cap"));
  CHECK_EQ(message(absent), ("update_tree: no such tree \"nope\""));
  REQUIRE_EQ(lines.size(), 3u);
  const std::vector<std::string> outcomes = {"ok", "refused", "refused"};
  for (std::size_t i = 0; i < lines.size(); ++i) {
    CHECK_EQ(lines[i].operation, ("mcp.roadmap_update_tree"));
    CHECK_EQ(lines[i].product, std::string("roadmap"));
    CHECK_EQ(lines[i].door, std::string("mcp"));
    CHECK_EQ(lines[i].outcome, outcomes[i]);
    CHECK_EQ(writeCompletionJson(lines[i]).find("compass"), std::string::npos);
  }
}

TEST(mcp_update_tree_on_a_tree_whose_row_went_away_answers_as_every_write_does_for_an_absent_tree) {
  Harness h;
  CHECK_FALSE(h.call("update_tree", with("guide", "Rig first, then sail.")).isError);
  REQUIRE(h.registry.isOpen(TreeId{"t"}));
  h.trees.deletedIds.insert("t");  // soft-deleted outside this registry, its row kept

  const ToolResult refused = h.call("update_tree", with("guide", "A ghost's guide"));
  CHECK(refused.isError);
  CHECK_EQ(message(refused), ("update_tree: no such tree \"t\""));
  CHECK_FALSE(h.registry.isOpen(TreeId{"t"}));
  CHECK_EQ(h.trees.byId["t"].guide.value, std::string("Rig first, then sail."));
  CHECK_EQ(message(h.call("create_node", node("a", "A"))), std::string("create_node: no such tree \"t\""));
  CHECK_EQ(message(h.call("get_tree", kNoArgs)), std::string("get_tree: no such tree \"t\""));
}

TEST(mcp_update_tree_refuses_a_guide_carrying_a_nul_with_the_admissions_sentence) {
  Harness h;
  CHECK_FALSE(h.call("update_tree", with("guide", "Rig first, then sail.")).isError);
  const std::size_t broadcasts = h.bus.subgraphBroadcasts.size();

  Json::Value args(Json::objectValue);
  args["guide"] = std::string("Rig first\0then sail.", 20);
  const ToolResult refused = h.call("update_tree", args);
  CHECK(refused.isError);
  CHECK_EQ(message(refused), ("update_tree: the guide contains a NUL character"));
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
  CHECK_FALSE(h.call("update_tree", with("guide", "Delete what you do not need.")).isError);
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
  CHECK_FALSE(h.tools.callTool("update_tree", mcp, ToolCaller{forker, ToolScope::everything()}).isError);

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

TEST(mcp_update_tree_stores_a_guide_of_only_whitespace_as_no_guide_and_keeps_a_real_guides_spaces) {
  Harness h;
  CHECK_EQ(body(h.call("update_tree", with("guide", " \n\t\r "))), parse(R"({"applied":true,"seq":1})"));
  CHECK_EQ(h.trees.byId["t"].guide.value, std::string(""));
  CHECK_EQ(body(h.call("get_tree", kNoArgs))["tree"]["guide"], parse(R"({"text":"","yours":true})"));

  CHECK_FALSE(h.call("update_tree", with("guide", "  Rig first, then sail.\n")).isError);
  CHECK_EQ(h.trees.byId["t"].guide.value, std::string("  Rig first, then sail.\n"));
}

TEST(mcp_update_tree_names_the_guide_a_plain_text_note) {
  Harness h;
  for (const Json::Value& tool : h.tools.listTools(h.actor))
    if (tool["name"].asString() == "update_tree")
      CHECK(tool["description"].asString().find("The guide is one plain-text note on what the tree is") !=
            std::string::npos);
}

// Forking your own tree copies your own words, so the copy stays yours; forking someone else's tree, or
// your own fork whose guide is still its source author's, copies words that are not.
TEST(mcp_forking_your_own_tree_keeps_its_guide_yours_and_anyone_elses_does_not) {
  Harness h;
  ForkService forks{h.registry, h.trees, h.tokens, h.clock};
  h.trees.byId["t"].visibility = Visibility::public_;
  CHECK_FALSE(h.call("update_tree", with("guide", "Rig first, then sail.")).isError);
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
  CHECK_FALSE(h.call("update_nodes", asUpdate(parse(R"({"nodeId":"b","opens":"t_sub"})"))).isError);
  CHECK_FALSE(h.call("create_node", parse(R"({"id":"c","label":"C","opens":""})")).isError);
  CHECK_EQ(body(h.call("update_nodes", parse(R"({"updates":[{"nodeId":"c","opens":"t_sub"}]})"))),
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

TEST(mcp_update_nodes_clears_the_tree_a_node_opens_with_an_empty_string) {
  Harness h;
  h.trees.byId["t_sub"] = StoredTree{LooseGraph().exportState(), LegendState{}, {"Deep dive", {}}, 0, h.caller};
  CHECK_FALSE(h.call("create_node", parse(R"({"id":"a","label":"A","opens":"t_sub"})")).isError);
  CHECK_FALSE(h.call("create_node", parse(R"({"id":"b","label":"B","opens":"t_sub"})")).isError);
  CHECK_FALSE(h.call("create_node", parse(R"({"id":"c","label":"C","opens":"t_sub"})")).isError);

  CHECK_FALSE(h.call("update_nodes", asUpdate(parse(R"({"nodeId":"a","opens":""})"))).isError);
  CHECK_EQ(body(h.call("update_nodes", parse(R"({"updates":[{"nodeId":"b","opens":""},{"nodeId":"c","opens":"t_sub"}]})"))),
           parse(R"({"treeId":"t","applied":true,"dryRun":false,"seq":5,"changedNodeIds":["b"],"unchangedNodeIds":["c"],"diagnosticsClean":true,"introducedDiagnostics":[]})"));

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
    CHECK_EQ(message(h.call("update_nodes", asUpdate(parse(R"({"nodeId":"a","description":"kept out","opens":")" + target + R"("})")))),
             refusal("update_nodes", "updates[0].opens", target));
    for (const std::string dryRun : {"false", "true"}) {
      CHECK_EQ(message(h.call("update_nodes", parse(R"({"updates":[{"nodeId":"a","label":"Kept out"},{"nodeId":"b","opens":")" +
                                                   target + R"("}],"dryRun":)" + dryRun + "}"))),
               refusal("update_nodes", "updates[1].opens", target));
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
  const std::vector<std::set<TreeId>> followedByTheWrite = h.trees.openedReads;

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
  CHECK_EQ(h.trees.openedReads, followedByTheWrite);

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

// A write asks after the trees it opens once for the whole call, and one that makes a node open a tree follows the
// tree's pointers once for its receipt; a reply follows them only when asked for the field.
TEST(mcp_the_trees_a_call_opens_are_read_once_and_a_reply_follows_them_only_when_asked_for_opens) {
  Harness h;
  h.trees.byId["t_sub"] = StoredTree{LooseGraph().exportState(), LegendState{}, {"Deep dive", {}}, 0, h.caller};
  h.trees.byId["t_other"] = StoredTree{LooseGraph().exportState(), LegendState{}, {"Side quest", {}}, 0, h.caller};

  CHECK_FALSE(h.call("import_subgraph",
                     parse(R"({"nodes":[{"id":"a","opens":"t_sub"},{"id":"b","opens":"t_other"},{"id":"c","opens":"t_sub"},{"id":"d"}]})"))
                  .isError);
  CHECK_EQ(h.trees.titleReads, (std::vector<std::set<TreeId>>{{TreeId{"t_other"}, TreeId{"t_sub"}}}));
  const std::set<TreeId> opened{TreeId{"t_other"}, TreeId{"t_sub"}};
  CHECK_EQ(h.trees.openedReads, (std::vector<std::set<TreeId>>{opened}));
  CHECK_FALSE(h.call("update_nodes", parse(R"({"updates":[{"nodeId":"a","opens":"t_other"},{"nodeId":"d","opens":"t_sub"},{"nodeId":"b","label":"B"}]})")).isError);
  CHECK_EQ(h.trees.titleReads.size(), 2u);
  CHECK_EQ(h.trees.openedReads, (std::vector<std::set<TreeId>>{opened, opened}));
  CHECK_FALSE(h.call("create_node", parse(R"({"id":"e","label":"E"})")).isError);
  CHECK_FALSE(h.call("update_nodes", asUpdate(parse(R"({"nodeId":"e","opens":""})"))).isError);
  CHECK_EQ(h.trees.titleReads.size(), 2u);

  CHECK_FALSE(h.call("get_tree", kNoArgs).isError);
  CHECK_FALSE(h.call("find_nodes", kNoArgs).isError);
  CHECK_FALSE(h.call("get_nodes", parse(R"({"nodeIds":["a"],"fields":["id","label","description"]})")).isError);
  CHECK_EQ(h.trees.titleReads.size(), 2u);
  CHECK_EQ(h.trees.openedReads, (std::vector<std::set<TreeId>>{opened, opened}));
  CHECK_FALSE(h.call("get_tree", parse(R"({"fields":["id","opens"]})")).isError);
  CHECK_EQ(h.trees.titleReads.size(), 2u);
  CHECK_EQ(h.trees.openedReads, (std::vector<std::set<TreeId>>{opened, opened, opened}));
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
        {"roadmap_update_nodes", R"({"treeId":"t","updates":[{"nodeId":"a","opens":")" + target + R"("}],"dryRun":true})"},
        {"roadmap_import_subgraph", R"({"treeId":"t","nodes":[{"id":"a","opens":")" + target + R"("}]})"}};
    for (const auto& [tool, arguments] : calls) {
      const ToolResult refused = gate.callTool(tool, parse(arguments), h.actor);
      CHECK(refused.isError);
      CHECK_EQ(refused.outcomeCode, std::string("opens-not-yours"));
      expected.push_back(std::string("mcp.") + tool + " opens-not-yours");
    }
  }
  CHECK(gate.callTool("roadmap_update_nodes", parse(R"({"treeId":"t","updates":[{"nodeId":"a","opens":7}]})"), h.actor).isError);
  expected.push_back("mcp.roadmap_update_nodes refused");
  CHECK(gate.callTool("roadmap_update_nodes", parse(R"({"treeId":"t","updates":[{"nodeId":"a","open":"t"}]})"), h.actor).isError);
  expected.push_back("mcp.roadmap_update_nodes invalid-arguments");
  CHECK_FALSE(gate.callTool("roadmap_update_nodes", parse(R"({"treeId":"t","updates":[{"nodeId":"a","opens":"t"}]})"), h.actor).isError);
  expected.push_back("mcp.roadmap_update_nodes ok");
  installWriteSink({});

  std::vector<std::string> observed;
  for (const WriteCompletion& completion : completions)
    if (completion.operation.rfind("mcp.", 0) == 0) observed.push_back(completion.operation + " " + completion.outcome);
  CHECK_EQ(observed, expected);
}

// Every state, filter and count reads one completed set, in which the node follows its tree and not the mark it held before it opened one.
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
  CHECK_FALSE(h.call("import_subgraph", parse(R"({"nodes":[{"id":"idea","label":"Idea"},
                                                            {"id":"next","label":"Next","prerequisites":["idea"]}]})")).isError);
  CHECK_FALSE(sub("update_nodes", R"({"updates":[{"nodeId":"s1","status":"complete"}]})").isError);
  CHECK_FALSE(h.call("update_nodes", asUpdate(parse(R"({"nodeId":"idea","status":"complete"})"))).isError);
  CHECK_FALSE(h.call("update_nodes", asUpdate(parse(R"({"nodeId":"idea","opens":"t_sub"})"))).isError);

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

  CHECK_FALSE(sub("update_nodes", R"({"updates":[{"nodeId":"s2","status":"complete"}]})").isError);

  const Json::Value complete = parse(
      R"([{"id":"idea","status":"complete","state":"complete","opens":{"treeId":"t_sub","title":"Deep dive","state":"complete"}},
          {"id":"next","status":"none","state":"available"}])");
  CHECK_EQ(body(h.call("get_tree", parse(R"({"fields":["id","status","state","opens"]})")))["tree"]["nodes"], complete);
  CHECK_EQ(body(h.call("get_nodes", parse(R"({"nodeIds":["idea","next"],"fields":["id","status","state","opens"]})")))["nodes"], complete);
  CHECK_EQ(body(h.call("find_nodes", parse(R"({"state":"available","fields":["id","state"]})"))),
           parse(R"({"count":1,"nodes":[{"id":"next","state":"available"}]})"));
  CHECK_EQ(body(h.call("find_nodes", parse(R"({"state":"complete","fields":["id","opens"]})"))),
           parse(R"({"count":1,"nodes":[{"id":"idea","opens":{"treeId":"t_sub","title":"Deep dive","state":"complete"}}]})"));
  CHECK_EQ(body(h.call("get_progress", kNoArgs)), parse(R"({"completed":["idea"],"outOfOrder":[]})"));
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
  CHECK_FALSE(in("t_mid", "update_nodes", R"({"updates":[{"nodeId":"m","status":"complete"},{"nodeId":"deeper","status":"complete"}]})").isError);

  CHECK_EQ(body(in("t", "get_tree", R"({"fields":["id","state","opens"]})"))["tree"]["nodes"],
           parse(R"([{"id":"idea","state":"available","opens":{"treeId":"t_mid","title":"Middle","state":"open"}}])"));
  CHECK_EQ(body(in("t_mid", "get_tree", R"({"fields":["id","state","opens"]})"))["tree"]["nodes"],
           parse(R"([{"id":"deeper","state":"available","opens":{"treeId":"t_leaf","title":"Leaf","state":"open"}},
                     {"id":"m","state":"complete"}])"));
  CHECK(counts() == (std::map<std::string, std::string>{{"t", "0/1"}, {"t_leaf", "0/1"}, {"t_mid", "1/2"}}));

  CHECK_FALSE(in("t_leaf", "update_nodes", R"({"updates":[{"nodeId":"l","status":"complete"}]})").isError);

  CHECK_EQ(body(in("t", "get_tree", R"({"fields":["id","state","opens"]})"))["tree"]["nodes"],
           parse(R"([{"id":"idea","state":"complete","opens":{"treeId":"t_mid","title":"Middle","state":"complete"}}])"));
  CHECK_EQ(body(in("t_mid", "find_nodes", R"({"state":"complete","fields":["id","opens"]})")),
           parse(R"({"count":2,"nodes":[{"id":"deeper","opens":{"treeId":"t_leaf","title":"Leaf","state":"complete"}},{"id":"m"}]})"));
  CHECK(counts() == (std::map<std::string, std::string>{{"t", "1/1"}, {"t_leaf", "1/1"}, {"t_mid", "2/2"}}));
}

// Nothing such a reader receives says a node opens a tree, whatever the opened tree has come to, and no read is made for them.
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
  CHECK_FALSE(h.tools.callTool("update_nodes", parse(R"({"treeId":"t","updates":[{"nodeId":"idea","status":"complete"}]})"), stranger).isError);
  const std::size_t readsForTheWrite = h.trees.openedReads.size();

  const char* everything = R"({"fields":["id","status","state","opens"]})";
  const Json::Value marked = parse(R"([{"id":"idea","status":"complete","state":"complete"},{"id":"next","status":"none","state":"available"}])");
  const Json::Value unmarked = parse(R"([{"id":"idea","status":"none","state":"available"},{"id":"next","status":"none","state":"locked"}])");
  CHECK_EQ(read(stranger, "get_tree", everything)["tree"]["nodes"], marked);
  CHECK_EQ(read(stranger, "get_nodes", R"({"nodeIds":["idea","next"],"fields":["id","status","state","opens"]})")["nodes"], marked);
  CHECK_EQ(read(stranger, "find_nodes", R"({"state":"complete","fields":["id","opens"]})"), parse(R"({"count":1,"nodes":[{"id":"idea"}]})"));
  CHECK_EQ(read(signedOut, "get_tree", everything)["tree"]["nodes"], unmarked);
  CHECK_EQ(read(signedOut, "find_nodes", R"({"state":"available","fields":["id","opens"]})"), parse(R"({"count":1,"nodes":[{"id":"idea"}]})"));
  CHECK_EQ(h.trees.openedReads.size(), readsForTheWrite);
  CHECK_EQ(read(h.actor, "get_tree", everything)["tree"]["nodes"],
           parse(R"([{"id":"idea","status":"none","state":"available","opens":{"treeId":"t_sub","title":"Deep dive","state":"open"}},
                     {"id":"next","status":"none","state":"locked"}])"));

  CHECK_FALSE(h.tools.callTool("update_nodes", parse(R"({"treeId":"t_sub","updates":[{"nodeId":"s","status":"complete"}]})"), h.actor).isError);
  CHECK_FALSE(h.tools.callTool("update_nodes", parse(R"({"treeId":"t","updates":[{"nodeId":"idea","status":"none"}]})"), stranger).isError);
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

// Nothing is read for a tree with no pointer, for other fields, for a reader who cannot write, or for the registry list.
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

  CHECK_FALSE(h.call("update_nodes", parse(R"({"updates":[{"nodeId":"a","opens":"t_sub"},{"nodeId":"b","opens":"t_other"},{"nodeId":"c","opens":"t_sub"}]})")).isError);
  CHECK_EQ(h.trees.openedReads.size(), 1u);
  h.trees.openedReads.clear();
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

// Following is part of the reply: its failure is the tool's server failure, naming nothing, and only where it is made.
TEST(mcp_a_reply_whose_pointers_cannot_be_followed_fails_as_the_call_and_other_reads_are_untouched) {
  Harness h;
  h.trees.byId["t"].visibility = Visibility::public_;
  h.trees.byId["t_sub"] = StoredTree{LooseGraph().exportState(), LegendState{}, {"Deep dive", {}}, 0, h.caller};
  CHECK_FALSE(h.call("create_node", parse(R"({"id":"a","label":"A","opens":"t_sub"})")).isError);
  h.trees.openedReadsFail = true;

  const std::vector<std::pair<const char*, const char*>> following = {
      {"get_tree", R"({"fields":["id","state"]})"},
      {"get_nodes", R"({"nodeIds":["a"],"fields":["id","opens"]})"},
      {"find_nodes", R"({"state":"available"})"}};
  for (const auto& [tool, arguments] : following) {
    const ToolResult failed = h.call(tool, parse(arguments));
    CHECK(failed.isError);
    CHECK_EQ(message(failed), std::string(tool) + ": that call failed inside the server. The outcome may be uncertain; "
                                                  "read the affected records before retrying. The detail is in the server log.");
  }
  CHECK_EQ(body(h.call("get_tree", parse(R"({"fields":["id","status"]})")))["tree"]["nodes"], parse(R"([{"id":"a","status":"none"}])"));
  CHECK_EQ(body(h.tools.callTool("get_tree", parse(R"({"treeId":"t","fields":["id","state","opens"]})"),
                                 ToolCaller{uid("stranger"), ToolScope::everything()}))["tree"]["nodes"],
           parse(R"([{"id":"a","state":"available"}])"));
}

// A stranger's read must not wait on the owner's statement: that wait would say the tree holds a pointer.
TEST(mcp_a_read_follows_pointers_after_it_has_let_go_of_the_trees_strand) {
  Harness h;
  h.trees.byId["t"].visibility = Visibility::public_;
  h.trees.byId["t_sub"] = StoredTree{LooseGraph().exportState(), LegendState{}, {"Deep dive", {}}, 0, h.caller};
  CHECK_FALSE(h.call("create_node", parse(R"({"id":"a","label":"A","opens":"t_sub"})")).isError);
  bool strandWasFree = false;
  Json::Value readMeanwhile;
  h.trees.duringOpenedRead = [&] {
    std::thread other([&] {
      std::mutex& strand = h.registry.strandFor(TreeId{"t"});
      if (!strand.try_lock()) return;
      strand.unlock();
      strandWasFree = true;
      readMeanwhile = body(h.tools.callTool("get_tree", parse(R"({"treeId":"t","fields":["id","state"]})"),
                                            ToolCaller{uid("stranger"), ToolScope::everything()}))["tree"]["nodes"];
    });
    other.join();
  };

  const std::vector<std::pair<const char*, const char*>> following = {
      {"get_tree", R"({"fields":["id","state"]})"},
      {"get_nodes", R"({"nodeIds":["a"],"fields":["id","opens"]})"},
      {"find_nodes", R"({"state":"available"})"}};
  for (const auto& [tool, arguments] : following) {
    strandWasFree = false;
    readMeanwhile = Json::Value();
    CHECK_FALSE(h.call(tool, parse(arguments)).isError);
    CHECK(strandWasFree);
    CHECK_EQ(readMeanwhile, parse(R"([{"id":"a","state":"available"}])"));
  }
  CHECK_EQ(h.trees.openedReads.size(), 4u);
}

// Two things can be wrong with a pointer, and only the tree's writer is told either: a loop of trees through this
// tree, with a shortest way back, and a pointer that names no standing tree of theirs.
TEST(mcp_get_diagnostics_tells_the_owner_each_loop_of_trees_through_the_tree_and_each_pointer_that_leads_nowhere) {
  Harness h;
  h.plant("t_b", h.caller, "", {"t"});
  h.plant("t_c", h.caller, "", {"t_b"});
  h.plant("t_x", h.caller, "", {"t_y"});
  h.plant("t_y", h.caller, "", {"t_x"});
  h.plant("t_gone", h.caller, "", {});
  h.plant("t_theirs", uid("someone-else"), "", {});
  CHECK_FALSE(h.call("import_subgraph", parse(R"({"nodes":[
      {"id":"near","label":"Near","icon":"n","opens":"t_b"},{"id":"far","label":"Far","icon":"f","opens":"t_c"},
      {"id":"again","label":"Again","icon":"a","opens":"t"},{"id":"elsewhere","label":"Elsewhere","icon":"e","opens":"t_x"},
      {"id":"gone","label":"Gone","icon":"g","opens":"t_gone"},{"id":"theirs","label":"Theirs","icon":"t"},
      {"id":"text","label":"Text","icon":"x"},{"id":"plain","label":"Plain","icon":"p"}]})")).isError);
  h.trees.softDelete(TreeId{"t_gone"});
  for (const auto& [node, pointer] : {std::pair{"theirs", "t_theirs"}, std::pair{"text", "said \"so\""}}) {
    AnnotateNode planted{NodeId{node}};
    planted.opens = TreeId{pointer};
    h.registry.open(TreeId{"t"})->applyCommand(planted, h.clock.nowMs(), h.caller);
  }
  h.trees.openedReads.clear();

  const ToolResult told = h.call("get_diagnostics", kNoArgs);

  CHECK_EQ(body(told), parse(R"({"cycles":[],"dangling":[],"selfEdges":[],"smells":[{"kind":"empty-legend"}],"maskedWork":[],
      "treeLoops":[
        {"node":"again","path":[{"treeId":"t","title":"Test Roadmap"}]},
        {"node":"far","path":[{"treeId":"t_c","title":"Tree t_c"},{"treeId":"t_b","title":"Tree t_b"},
                              {"treeId":"t","title":"Test Roadmap"}]},
        {"node":"near","path":[{"treeId":"t_b","title":"Tree t_b"},{"treeId":"t","title":"Test Roadmap"}]}],
      "danglingPointers":[{"node":"gone","treeId":"t_gone"},{"node":"text","treeId":"said \"so\""},
                          {"node":"theirs","treeId":"t_theirs"}]})"));
  CHECK(message(told).find(R"({"node":"text","treeId":"said \"so\""})") != std::string::npos);
  CHECK_EQ(h.trees.openedReads, (std::vector<std::set<TreeId>>{{TreeId{"said \"so\""}, TreeId{"t"}, TreeId{"t_b"}, TreeId{"t_c"},
                                                                 TreeId{"t_gone"}, TreeId{"t_theirs"}, TreeId{"t_x"}}}));

  CHECK_EQ(body(h.tools.callTool("get_diagnostics", with("treeId", "t_b"), h.actor)),
           parse(R"({"cycles":[],"dangling":[],"selfEdges":[],"smells":[{"kind":"empty-legend"},{"kind":"empty-icon","count":1,"nodes":["to-t"]}],"maskedWork":[],
               "treeLoops":[{"node":"to-t","path":[{"treeId":"t","title":"Test Roadmap"},{"treeId":"t_b","title":"Tree t_b"}]}],
               "danglingPointers":[]})"));
  CHECK_EQ(body(h.tools.callTool("get_diagnostics", with("treeId", "t_x"), h.actor)),
           parse(R"({"cycles":[],"dangling":[],"selfEdges":[],"smells":[{"kind":"empty-legend"},{"kind":"empty-icon","count":1,"nodes":["to-t_y"]}],"maskedWork":[],
               "treeLoops":[{"node":"to-t_y","path":[{"treeId":"t_y","title":"Tree t_y"},{"treeId":"t_x","title":"Tree t_x"}]}],
               "danglingPointers":[]})"));
  CHECK_EQ(h.trees.openedReads.size(), 3u);
}

// A reader's reply must not say the tree holds a pointer: for a tree on a loop with a dangling pointer it is, byte
// for byte, the reply for a twin without pointers, with nothing read for it, whatever the reader asks for.
TEST(mcp_get_diagnostics_answers_a_reader_who_cannot_write_the_tree_what_a_twin_without_pointers_answers_and_reads_nothing) {
  Harness h;
  h.trees.byId["t"].visibility = Visibility::public_;
  h.trees.byId["t_twin"] =
      StoredTree{LooseGraph().exportState(), LegendState{}, {"Test Roadmap", {}}, 0, h.caller, Visibility::public_};
  h.plant("t_b", h.caller, "", {"t"});
  h.plant("t_gone", h.caller, "", {});
  CHECK_FALSE(h.call("import_subgraph", parse(R"({"nodes":[{"id":"loop","label":"Loop","opens":"t_b"},
      {"id":"gone","label":"Gone","opens":"t_gone"},{"id":"plain","label":"Plain","prerequisites":["ghost"]}]})")).isError);
  CHECK_FALSE(h.tools.callTool("import_subgraph", parse(R"({"treeId":"t_twin","nodes":[{"id":"loop","label":"Loop"},
      {"id":"gone","label":"Gone"},{"id":"plain","label":"Plain","prerequisites":["ghost"]}]})"), h.actor).isError);
  h.trees.softDelete(TreeId{"t_gone"});
  const std::size_t titleReads = h.trees.titleReads.size();
  h.trees.openedReads.clear();
  h.trees.openedReadsFail = true;

  const std::string graphAlone =
      R"({"cycles":[],"dangling":[{"from":"ghost","to":"plain"}],"maskedWork":[],"selfEdges":[],)"
      R"("smells":[{"kind":"empty-legend"},{"count":3,"kind":"empty-icon","nodes":["gone","loop","plain"]}]})";
  for (const UserId& reader : {uid("stranger"), UserId{}}) {
    const ToolCaller caller{reader, ToolScope::everything()};
    for (const char* asked : {R"({})", R"({"includePointers":true})", R"({"includePointers":false})"}) {
      Json::Value args = parse(asked);
      args["treeId"] = "t";
      const ToolResult pointed = h.tools.callTool("get_diagnostics", args, caller);
      args["treeId"] = "t_twin";
      const ToolResult twin = h.tools.callTool("get_diagnostics", args, caller);
      CHECK_FALSE(pointed.isError);
      CHECK_EQ(message(pointed), graphAlone);
      CHECK_EQ(message(pointed), message(twin));
    }
  }
  CHECK(h.trees.openedReads.empty());
  CHECK_EQ(h.trees.titleReads.size(), titleReads);
}

// Following costs one read, and only where it can say something: none for a tree that holds no pointer, where
// both lists are empty, and none for a call that asks for the graph alone, which is answered no key.
TEST(mcp_get_diagnostics_reads_no_other_tree_for_a_tree_without_pointers_or_a_call_that_asks_for_none) {
  Harness h;
  h.plant("t_b", h.caller, "", {"t"});
  CHECK_FALSE(h.call("create_node", parse(R"({"id":"a","label":"A","icon":"a"})")).isError);
  h.trees.openedReadsFail = true;

  CHECK_EQ(body(h.call("get_diagnostics", kNoArgs)),
           parse(R"({"cycles":[],"dangling":[],"selfEdges":[],"smells":[{"kind":"empty-legend"}],"maskedWork":[],"treeLoops":[],"danglingPointers":[]})"));
  CHECK(h.trees.openedReads.empty());

  h.trees.openedReadsFail = false;
  CHECK_FALSE(h.call("update_nodes", asUpdate(parse(R"({"nodeId":"a","opens":"t_b"})"))).isError);
  h.trees.openedReads.clear();
  h.trees.openedReadsFail = true;
  CHECK_EQ(body(h.call("get_diagnostics", parse(R"({"includePointers":false})"))),
           parse(R"({"cycles":[],"dangling":[],"selfEdges":[],"smells":[{"kind":"empty-legend"}],"maskedWork":[]})"));
  CHECK(h.trees.openedReads.empty());
  CHECK_EQ(message(h.call("get_diagnostics", parse(R"({"includePointers":"no"})"))),
           std::string("get_diagnostics: argument \"includePointers\" must be a boolean, got string"));

  h.trees.openedReadsFail = false;
  CHECK_EQ(body(h.call("get_diagnostics", parse(R"({"includePointers":true})"))),
           parse(R"({"cycles":[],"dangling":[],"selfEdges":[],"smells":[{"kind":"empty-legend"}],"maskedWork":[],
               "treeLoops":[{"node":"a","path":[{"treeId":"t_b","title":"Tree t_b"},{"treeId":"t","title":"Test Roadmap"}]}],
               "danglingPointers":[]})"));
  CHECK_EQ(h.trees.openedReads, (std::vector<std::set<TreeId>>{{TreeId{"t_b"}}}));
}

// A stranger's read must not wait on the owner's statement: that wait would say the tree holds a pointer.
TEST(mcp_get_diagnostics_follows_pointers_after_it_has_let_go_of_the_trees_strand) {
  Harness h;
  h.trees.byId["t"].visibility = Visibility::public_;
  h.plant("t_b", h.caller, "", {"t"});
  CHECK_FALSE(h.call("create_node", parse(R"({"id":"a","label":"A","icon":"a","opens":"t_b"})")).isError);
  h.trees.openedReads.clear();
  bool strandWasFree = false;
  Json::Value readMeanwhile;
  h.trees.duringOpenedRead = [&] {
    std::thread other([&] {
      std::mutex& strand = h.registry.strandFor(TreeId{"t"});
      if (!strand.try_lock()) return;
      strand.unlock();
      strandWasFree = true;
      readMeanwhile = body(h.tools.callTool("get_diagnostics", with("treeId", "t"),
                                            ToolCaller{uid("stranger"), ToolScope::everything()}));
    });
    other.join();
  };

  CHECK_EQ(body(h.call("get_diagnostics", kNoArgs))["treeLoops"],
           parse(R"([{"node":"a","path":[{"treeId":"t_b","title":"Tree t_b"},{"treeId":"t","title":"Test Roadmap"}]}])"));

  CHECK(strandWasFree);
  CHECK_EQ(readMeanwhile, parse(R"({"cycles":[],"dangling":[],"selfEdges":[],"smells":[{"kind":"empty-legend"}],"maskedWork":[]})"));
  CHECK_EQ(h.trees.openedReads.size(), 1u);
}

// The graph's diagnostics do not depend on the other trees: a follow that fails leaves them whole, says the pointers
// were not followed, and is reported once under its own name with the exception's type alone.
TEST(mcp_get_diagnostics_whose_pointers_cannot_be_followed_answers_the_graphs_diagnostics_and_says_so_and_files_one_issue) {
  struct Failures : FailureReporter {
    std::vector<std::string> reports;
    void report(const std::string&, const std::string&, const std::string&) override {}
    void reportWrite(const std::string& operation, const std::string& product, const std::string& door,
                     const std::string& outcome, const std::string&, const std::string& exceptionType) override {
      reports.push_back(operation + " " + product + " " + door + " " + outcome + " " + exceptionType);
    }
  };
  struct ReporterScope {
    std::shared_ptr<Failures> failures = std::make_shared<Failures>();
    ReporterScope() { installWriteReporter(failures); }
    ~ReporterScope() { installWriteReporter(nullptr); }
  } reporter;
  Harness h;
  h.trees.byId["t"].visibility = Visibility::public_;
  h.plant("t_b", h.caller, "", {"t"});
  CHECK_FALSE(h.call("import_subgraph", parse(R"({"nodes":[{"id":"a","label":"A","opens":"t_b","prerequisites":["ghost"]}]})")).isError);

  h.trees.openedReadsFail = true;
  const ToolResult degraded = h.call("get_diagnostics", kNoArgs);

  CHECK_FALSE(degraded.isError);
  CHECK_EQ(body(degraded), parse(R"({"cycles":[],"dangling":[{"from":"ghost","to":"a"}],"selfEdges":[],
      "smells":[{"kind":"empty-legend"},{"kind":"empty-icon","count":1,"nodes":["a"]}],"maskedWork":[],"pointerDiagnosticsUnavailable":true})"));
  CHECK_EQ(reporter.failures->reports,
           (std::vector<std::string>{std::string("roadmap.diagnostics.follow roadmap mcp failed ") + typeid(std::runtime_error).name()}));

  const Json::Value graphAlone = parse(R"({"cycles":[],"dangling":[{"from":"ghost","to":"a"}],"selfEdges":[],
      "smells":[{"kind":"empty-legend"},{"kind":"empty-icon","count":1,"nodes":["a"]}],"maskedWork":[]})");
  CHECK_EQ(body(h.call("get_diagnostics", parse(R"({"includePointers":false})"))), graphAlone);
  CHECK_EQ(body(h.tools.callTool("get_diagnostics", with("treeId", "t"), ToolCaller{uid("stranger"), ToolScope::everything()})),
           graphAlone);
  CHECK_EQ(reporter.failures->reports.size(), 1u);
}

// An edit that changes the tree a node opens follows the pointers it set once, after it has landed and within the
// receipt's budget, and names each loop of trees it closed after the graph's errors. A pointer it left as it was is
// not followed at all, one it took off a loop is not named, and `diagnosticsClean` stays the graph's.
TEST(mcp_an_edit_that_closes_a_loop_of_trees_says_so_in_its_receipt_through_each_write_tool) {
  Harness h;
  h.plant("t_b", h.caller, "", {"t"});
  h.plant("t_c", h.caller, "", {"t_b"});
  h.plant("t_sub", h.caller, "", {});

  CHECK_EQ(body(h.call("create_node", parse(R"({"id":"a","label":"A","opens":"t_b"})"))),
           parse(R"({"applied":true,"seq":1,"id":"a","diagnosticsClean":true,
               "introducedDiagnostics":["loop of trees from \"a\" through \"t_b\" -> \"t\""]})"));
  CHECK_EQ(body(h.call("update_nodes", asUpdate(parse(R"({"nodeId":"a","opens":"t_b"})")))),
           parse(R"({"applied":true,"changedNodeIds":[],"diagnosticsClean":true,"dryRun":false,"introducedDiagnostics":[],"seq":1,"treeId":"t","unchanged":true,"unchangedNodeIds":["a"]})"));
  CHECK_EQ(body(h.call("update_nodes", asUpdate(parse(R"({"nodeId":"a","opens":"t_c"})")))),
           parse(R"({"applied":true,"changedNodeIds":["a"],"diagnosticsClean":true,"dryRun":false,"introducedDiagnostics":["loop of trees from \"a\" through \"t_c\" -> \"t_b\" -> \"t\""],"seq":2,"treeId":"t","unchangedNodeIds":[]})"));
  CHECK_EQ(body(h.call("update_nodes", asUpdate(parse(R"({"nodeId":"a","opens":"t_sub"})")))),
           parse(R"({"applied":true,"changedNodeIds":["a"],"diagnosticsClean":true,"dryRun":false,"introducedDiagnostics":[],"seq":3,"treeId":"t","unchangedNodeIds":[]})"));

  const ToolResult patched = h.call("update_nodes", parse(R"({"updates":[{"nodeId":"a","opens":"t"}]})"));
  CHECK_EQ(body(patched), parse(R"({"treeId":"t","applied":true,"dryRun":false,"seq":4,"changedNodeIds":["a"],"unchangedNodeIds":[],
      "diagnosticsClean":true,"introducedDiagnostics":["loop of trees from \"a\" through \"t\""]})"));
  CHECK_EQ(patched.structured, body(patched));

  CHECK_EQ(body(h.call("import_subgraph", parse(R"({"nodes":[{"id":"b","label":"B","opens":"t_b","prerequisites":["ghost"]},
                                                              {"id":"c","label":"C"}]})"))),
           parse(R"({"nodes":2,"edges":1,"kinds":0,"nodeCollisions":[],"kindCollisions":[],"newNodes":2,"newKinds":0,
               "prerequisiteMode":"merge","keptEdges":[],"keptEdgeCount":0,"tombstoned":{"nodes":0,"edges":0},
               "graphApplied":true,"progressApplied":true,"imported":true,"seq":5,"diagnosticsClean":false,
               "introducedDiagnostics":["dangling edge \"ghost\" -> \"b\"","loop of trees from \"b\" through \"t_b\" -> \"t\""]})"));

  CHECK_EQ(h.trees.openedReads,
           (std::vector<std::set<TreeId>>{{TreeId{"t_b"}}, {TreeId{"t_c"}}, {TreeId{"t_sub"}}, {TreeId{"t"}}, {TreeId{"t_b"}}}));
  CHECK_EQ(h.trees.openedBudgets,
           (std::vector<std::optional<std::chrono::milliseconds>>(5, std::chrono::milliseconds{750})));
}

// The two rules meet on the pointer and agree. An update_nodes row that re-sends the tree a node opens changes
// nothing: it writes nothing, says `unchanged`, follows nothing and names no loop, on a loop or off one. One that
// changes another field beside the same pointer lands and still follows nothing. One that changes the pointer alone
// is changed, lands, and is followed once. A `create_node` on a present id always lands, and one that names the tree
// the node already opens follows nothing.
TEST(mcp_a_node_edit_follows_a_pointer_only_when_it_changes_it_and_says_unchanged_only_when_it_changes_nothing) {
  Harness h;
  h.plant("t_b", h.caller, "", {"t"});
  h.plant("t_sub", h.caller, "", {});
  CHECK_FALSE(h.call("create_node", parse(R"({"id":"a","label":"A","opens":"t_sub"})")).isError);
  h.trees.openedReads.clear();
  const std::size_t saves = h.trees.savedNodeCounts.size();

  CHECK_EQ(body(h.call("update_nodes", asUpdate(parse(R"({"nodeId":"a","opens":"t_sub"})")))),
           parse(R"({"applied":true,"changedNodeIds":[],"diagnosticsClean":true,"dryRun":false,"introducedDiagnostics":[],"seq":1,"treeId":"t","unchanged":true,"unchangedNodeIds":["a"]})"));
  CHECK_EQ(h.trees.savedNodeCounts.size(), saves);
  CHECK(h.trees.openedReads.empty());

  CHECK_EQ(body(h.call("update_nodes", asUpdate(parse(R"({"nodeId":"a","opens":"t_sub","description":"A note."})")))),
           parse(R"({"applied":true,"changedNodeIds":["a"],"diagnosticsClean":true,"dryRun":false,"introducedDiagnostics":[],"seq":2,"treeId":"t","unchangedNodeIds":[]})"));
  CHECK_EQ(h.trees.savedNodeCounts.size(), saves + 1);
  CHECK(h.trees.openedReads.empty());

  CHECK_EQ(body(h.call("update_nodes", asUpdate(parse(R"({"nodeId":"a","opens":"t_b"})")))),
           parse(R"({"applied":true,"changedNodeIds":["a"],"diagnosticsClean":true,"dryRun":false,"introducedDiagnostics":["loop of trees from \"a\" through \"t_b\" -> \"t\""],"seq":3,"treeId":"t","unchangedNodeIds":[]})"));
  CHECK_EQ(h.trees.savedNodeCounts.size(), saves + 2);
  CHECK_EQ(h.trees.openedReads, (std::vector<std::set<TreeId>>{{TreeId{"t_b"}}}));

  CHECK_EQ(body(h.call("update_nodes", asUpdate(parse(R"({"nodeId":"a","opens":"t_b"})")))),
           parse(R"({"applied":true,"changedNodeIds":[],"diagnosticsClean":true,"dryRun":false,"introducedDiagnostics":[],"seq":3,"treeId":"t","unchanged":true,"unchangedNodeIds":["a"]})"));
  CHECK_EQ(h.trees.savedNodeCounts.size(), saves + 2);

  CHECK_EQ(body(h.call("create_node", parse(R"({"id":"a","label":"A","opens":"t_b"})"))),
           parse(R"({"applied":true,"seq":4,"id":"a","diagnosticsClean":true,"introducedDiagnostics":[]})"));
  CHECK_EQ(h.trees.savedNodeCounts.size(), saves + 3);
  CHECK_EQ(h.trees.openedReads.size(), 1u);

  CHECK_EQ(body(h.call("get_tree", parse(R"({"fields":["id","description","opens"],"includeGuides":false})")))["tree"]["nodes"],
           parse(R"([{"id":"a","description":"A note.","opens":{"treeId":"t_b","title":"Tree t_b","state":"open"}}])"));
}

TEST(mcp_a_receipt_names_five_of_the_loops_an_edit_closed_and_counts_the_rest) {
  Harness h;
  h.plant("t_b", h.caller, "", {"t"});

  const Json::Value receipt = body(h.call("import_subgraph", parse(R"({"nodes":[
      {"id":"n1","opens":"t_b"},{"id":"n2","opens":"t_b"},{"id":"n3","opens":"t_b"},{"id":"n4","opens":"t_b"},
      {"id":"n5","opens":"t_b"},{"id":"n6","opens":"t_b"},{"id":"n7","opens":"t_b"}]})")));

  CHECK_EQ(introduced(receipt),
           (std::vector<std::string>{"loop of trees from \"n1\" through \"t_b\" -> \"t\"", "loop of trees from \"n2\" through \"t_b\" -> \"t\"",
                                     "loop of trees from \"n3\" through \"t_b\" -> \"t\"", "loop of trees from \"n4\" through \"t_b\" -> \"t\"",
                                     "loop of trees from \"n5\" through \"t_b\" -> \"t\"",
                                     "and 2 more — call get_diagnostics for the whole list"}));
  CHECK(receipt["diagnosticsClean"].asBool());
}

// Only an edit that makes a node open a tree pays for the follow: on a tree that already sits on a loop, every
// other edit — one that clears a pointer and a dry run among them — reads no other tree and answers what it did.
TEST(mcp_an_edit_that_makes_no_node_open_a_tree_follows_nothing_and_its_receipt_is_unchanged) {
  Harness h;
  h.plant("t_b", h.caller, "", {"t"});
  CHECK_FALSE(h.call("import_subgraph", parse(R"({"nodes":[{"id":"a","label":"A","opens":"t_b"},{"id":"b","label":"B","opens":"t_b"}]})")).isError);
  h.trees.openedReads.clear();
  h.trees.openedReadsFail = true;

  CHECK_EQ(body(h.call("update_nodes", asUpdate(parse(R"({"nodeId":"a","label":"A renamed"})")))),
           parse(R"({"applied":true,"changedNodeIds":["a"],"diagnosticsClean":true,"dryRun":false,"introducedDiagnostics":[],"seq":2,"treeId":"t","unchangedNodeIds":[]})"));
  CHECK_EQ(body(h.call("create_node", parse(R"({"id":"c","label":"C"})"))),
           parse(R"({"applied":true,"seq":3,"id":"c","diagnosticsClean":true,"introducedDiagnostics":[]})"));
  CHECK_EQ(body(h.call("update_nodes", asUpdate(parse(R"({"nodeId":"a","description":"a note"})")))),
           parse(R"({"applied":true,"changedNodeIds":["a"],"diagnosticsClean":true,"dryRun":false,"introducedDiagnostics":[],"seq":4,"treeId":"t","unchangedNodeIds":[]})"));
  CHECK_EQ(body(h.call("update_nodes", asUpdate(parse(R"({"nodeId":"a","opens":""})")))),
           parse(R"({"applied":true,"changedNodeIds":["a"],"diagnosticsClean":true,"dryRun":false,"introducedDiagnostics":[],"seq":5,"treeId":"t","unchangedNodeIds":[]})"));
  CHECK_EQ(body(h.call("change_edges", parse(R"({"add":[{"from":"a","to":"c"}]})"))),
           parse(R"({"treeId":"t","applied":true,"dryRun":false,"seq":6,"addedEdges":[{"from":"a","to":"c"}],
             "removedEdges":[],"unchangedEdges":0,"diagnosticsClean":true,"introducedDiagnostics":[]})"));
  const ToolResult patched = h.call("update_nodes", parse(R"({"updates":[{"nodeId":"b","opens":""},{"nodeId":"c","label":"C renamed"}]})"));
  CHECK_EQ(body(patched), parse(R"({"treeId":"t","applied":true,"dryRun":false,"seq":7,"changedNodeIds":["b","c"],"unchangedNodeIds":[],
      "diagnosticsClean":true,"introducedDiagnostics":[]})"));
  CHECK_EQ(patched.structured, body(patched));
  const ToolResult previewed = h.call("update_nodes", parse(R"({"updates":[{"nodeId":"c","opens":"t_b"}],"dryRun":true})"));
  CHECK_EQ(body(previewed), parse(R"({"treeId":"t","applied":false,"dryRun":true,"seq":7,"changedNodeIds":["c"],"unchangedNodeIds":[]})"));
  CHECK_EQ(previewed.structured, body(previewed));
  CHECK_EQ(body(h.call("change_edges", parse(R"({"remove":[{"from":"a","to":"c"}]})"))),
           parse(R"({"treeId":"t","applied":true,"dryRun":false,"seq":8,"addedEdges":[],"removedEdges":[{"from":"a","to":"c"}],
               "unchangedEdges":0,"diagnosticsClean":true,"introducedDiagnostics":[]})"));
  CHECK_EQ(body(h.call("import_subgraph", parse(R"({"nodes":[{"id":"a","label":"A again"},{"id":"d","label":"D","opens":""}]})"))),
           parse(R"({"nodes":2,"edges":0,"kinds":0,"nodeCollisions":["a"],"kindCollisions":[],"newNodes":1,"newKinds":0,
               "prerequisiteMode":"merge","keptEdges":[],"keptEdgeCount":0,"tombstoned":{"nodes":0,"edges":0},
               "graphApplied":true,"progressApplied":true,"imported":true,"seq":9,"diagnosticsClean":true,"introducedDiagnostics":[]})"));
  CHECK_EQ(body(h.call("import_subgraph", parse(R"({"nodes":[{"id":"e","label":"E","opens":"t_b"}],"dryRun":true})")))["dryRun"],
           Json::Value(true));
  CHECK_EQ(body(h.call("delete_node", parse(R"({"nodeId":"d"})"))),
           parse(R"({"applied":true,"seq":10,"id":"d","ids":["d"],"pruned":{"edges":0,"progress":0},"diagnosticsClean":true,
               "introducedDiagnostics":[]})"));

  CHECK(h.trees.openedReads.empty());
}

// The edit has landed and saved by the time its pointers are followed, and the strand is free: no other caller of
// the tree waits on that read.
TEST(mcp_an_edit_follows_pointers_for_its_receipt_after_it_has_let_go_of_the_trees_strand) {
  Harness h;
  h.trees.byId["t"].visibility = Visibility::public_;
  h.plant("t_b", h.caller, "", {"t"});
  CHECK_FALSE(h.call("import_subgraph", parse(R"({"nodes":[{"id":"a","label":"A"},{"id":"b","label":"B"},{"id":"c","label":"C"}]})")).isError);
  bool strandWasFree = false;
  Json::Value readMeanwhile;
  h.trees.duringOpenedRead = [&] {
    std::thread other([&] {
      std::mutex& strand = h.registry.strandFor(TreeId{"t"});
      if (!strand.try_lock()) return;
      strand.unlock();
      strandWasFree = true;
      readMeanwhile = body(h.tools.callTool("get_tree", parse(R"({"treeId":"t","fields":["id"]})"),
                                            ToolCaller{uid("stranger"), ToolScope::everything()}))["tree"]["nodes"];
    });
    other.join();
  };

  const std::vector<std::tuple<const char*, const char*, const char*>> edits = {
      {"update_nodes", R"({"updates":[{"nodeId":"a","opens":"t_b"}]})", R"([{"id":"a"},{"id":"b"},{"id":"c"}])"},
      {"update_nodes", R"({"updates":[{"nodeId":"b","opens":"t_b"}]})", R"([{"id":"a"},{"id":"b"},{"id":"c"}])"},
      {"import_subgraph", R"({"nodes":[{"id":"c","opens":"t_b"}]})", R"([{"id":"a"},{"id":"b"},{"id":"c"}])"},
      {"create_node", R"({"id":"d","label":"D","opens":"t_b"})", R"([{"id":"a"},{"id":"b"},{"id":"c"},{"id":"d"}])"}};
  for (const auto& [tool, arguments, landed] : edits) {
    strandWasFree = false;
    readMeanwhile = Json::Value();
    CHECK_EQ(introduced(body(h.call(tool, parse(arguments)))).size(), 1u);
    CHECK(strandWasFree);
    CHECK_EQ(readMeanwhile, parse(landed));
  }
  CHECK_EQ(h.trees.openedReads.size(), 4u);
}

// The edit is durable before its pointers are followed, so a follow that fails cannot fail it: the receipt answers
// the graph's diagnostics, says the pointers were not followed, and the failure is reported once under its own name.
TEST(mcp_an_edit_whose_pointers_cannot_be_followed_still_lands_and_says_so_and_each_files_one_issue) {
  struct Failures : FailureReporter {
    std::vector<std::string> reports;
    void report(const std::string&, const std::string&, const std::string&) override {}
    void reportWrite(const std::string& operation, const std::string& product, const std::string& door,
                     const std::string& outcome, const std::string&, const std::string& exceptionType) override {
      reports.push_back(operation + " " + product + " " + door + " " + outcome + " " + exceptionType);
    }
  };
  struct ReporterScope {
    std::shared_ptr<Failures> failures = std::make_shared<Failures>();
    ReporterScope() { installWriteReporter(failures); }
    ~ReporterScope() { installWriteReporter(nullptr); }
  } reporter;
  Harness h;
  h.plant("t_b", h.caller, "", {"t"});
  h.trees.openedReadsFail = true;

  CHECK_EQ(body(h.call("create_node", parse(R"({"id":"a","label":"A","opens":"t_b","prerequisites":["ghost"]})"))),
           parse(R"({"applied":true,"seq":1,"id":"a","diagnosticsClean":false,
               "introducedDiagnostics":["dangling edge \"ghost\" -> \"a\""],"pointerDiagnosticsUnavailable":true})"));
  CHECK_EQ(reporter.failures->reports,
           (std::vector<std::string>{std::string("roadmap.receipt.follow roadmap mcp failed ") + typeid(std::runtime_error).name()}));
  const ToolResult patched = h.call("update_nodes", parse(R"({"updates":[{"nodeId":"a","opens":"t"}]})"));
  CHECK_EQ(body(patched), parse(R"({"treeId":"t","applied":true,"dryRun":false,"seq":2,"changedNodeIds":["a"],"unchangedNodeIds":[],
      "diagnosticsClean":false,"introducedDiagnostics":[],"pointerDiagnosticsUnavailable":true})"));
  CHECK_EQ(patched.structured, body(patched));

  h.trees.openedReadsFail = false;
  CHECK_EQ(body(h.call("get_tree", parse(R"({"fields":["id","opens"]})")))["tree"]["nodes"],
           parse(R"([{"id":"a","opens":{"treeId":"t","title":"Test Roadmap","state":"open"}}])"));
  CHECK_EQ(reporter.failures->reports.size(), 2u);
}

// What one reply builds follows the caps and not the tree: fifty nodes of each list in node id order, eight trees
// of a way, and a count of whatever is left off. A cut way does not end with this tree. The receipt of the edit that
// closed those loops names the same eight trees and counts the rest of the way and of the list.
TEST(mcp_get_diagnostics_lists_fifty_nodes_and_eight_trees_of_a_way_and_counts_the_rest_and_a_receipt_names_as_many) {
  Harness h;
  const auto numbered = [](const char* prefix, int k) { return std::string(prefix) + (k < 10 ? "0" : "") + std::to_string(k); };
  h.plant("t_w12", h.caller, "", {"t"});
  for (int k = 11; k >= 1; --k) h.plant(numbered("t_w", k).c_str(), h.caller, "", {numbered("t_w", k + 1).c_str()});
  Json::Value batch(Json::objectValue);
  for (int k = 1; k <= 60; ++k) {
    Json::Value looping = node(numbered("l", k).c_str(), "L");
    looping["icon"] = "l";
    looping["opens"] = "t_w01";
    batch["nodes"].append(looping);
    Json::Value plain = node(numbered("g", k).c_str(), "G");
    plain["icon"] = "g";
    batch["nodes"].append(plain);
  }

  const std::string way = R"("t_w01" -> "t_w02" -> "t_w03" -> "t_w04" -> "t_w05" -> "t_w06" -> "t_w07" -> "t_w08" and 5 more)";
  CHECK_EQ(introduced(body(h.call("import_subgraph", batch))),
           (std::vector<std::string>{"loop of trees from \"l01\" through " + way, "loop of trees from \"l02\" through " + way,
                                     "loop of trees from \"l03\" through " + way, "loop of trees from \"l04\" through " + way,
                                     "loop of trees from \"l05\" through " + way,
                                     "and 55 more — call get_diagnostics for the whole list"}));
  for (int k = 1; k <= 60; ++k) {
    AnnotateNode planted{NodeId{numbered("g", k)}};
    planted.opens = TreeId{numbered("t_gone", k)};
    h.registry.open(TreeId{"t"})->applyCommand(planted, h.clock.nowMs(), h.caller);
  }

  Json::Value expected = parse(R"({"cycles":[],"dangling":[],"selfEdges":[],"smells":[{"kind":"empty-legend"}],"maskedWork":[],
      "treeLoops":[],"treeLoopsOmitted":10,"danglingPointers":[],"danglingPointersOmitted":10})");
  for (int k = 1; k <= 50; ++k) {
    Json::Value loop(Json::objectValue);
    loop["node"] = numbered("l", k);
    for (int on = 1; on <= 8; ++on) {
      Json::Value tree(Json::objectValue);
      tree["treeId"] = numbered("t_w", on);
      tree["title"] = "Tree " + numbered("t_w", on);
      loop["path"].append(tree);
    }
    loop["pathOmitted"] = 5;
    expected["treeLoops"].append(loop);
    Json::Value dangling(Json::objectValue);
    dangling["node"] = numbered("g", k);
    dangling["treeId"] = numbered("t_gone", k);
    expected["danglingPointers"].append(dangling);
  }
  CHECK_EQ(body(h.call("get_diagnostics", kNoArgs)), expected);
}

// A node an import brings back from a delete opens the tree the batch names and no other, as a node created on a
// deleted id does: no batch restores a pointer it does not name, so none closes a loop unsaid.
TEST(mcp_import_subgraph_brings_a_deleted_node_back_opening_nothing_unless_the_batch_names_a_tree) {
  Harness h;
  h.plant("t_b", h.caller, "", {"t"});
  CHECK_FALSE(h.call("create_node", parse(R"({"id":"a","label":"A","icon":"a","description":"Kept.","opens":"t_b"})")).isError);
  CHECK_FALSE(h.call("delete_node", parse(R"({"nodeId":"a"})")).isError);
  h.trees.openedReads.clear();

  CHECK_EQ(body(h.call("import_subgraph", parse(R"({"nodes":[{"id":"a","label":"A back"}]})"))),
           parse(R"({"nodes":1,"edges":0,"kinds":0,"nodeCollisions":[],"kindCollisions":[],"newNodes":1,"newKinds":0,
               "prerequisiteMode":"merge","keptEdges":[],"keptEdgeCount":0,"tombstoned":{"nodes":0,"edges":0},
               "graphApplied":true,"progressApplied":true,"imported":true,"seq":3,"diagnosticsClean":true,"introducedDiagnostics":[]})"));
  CHECK(h.trees.openedReads.empty());
  CHECK_EQ(body(h.call("get_tree", parse(R"({"fields":["id","label","description","opens"]})")))["tree"]["nodes"],
           parse(R"([{"id":"a","label":"A back","description":"Kept."}])"));
  CHECK_EQ(body(h.call("get_diagnostics", kNoArgs)),
           parse(R"({"cycles":[],"dangling":[],"selfEdges":[],"smells":[{"kind":"empty-legend"}],"maskedWork":[],"treeLoops":[],"danglingPointers":[]})"));
  REQUIRE_EQ(h.trees.byId["t"].state.nodes.size(), 1u);
  CHECK_EQ(h.trees.byId["t"].state.nodes[0].opens, TreeId{});

  CHECK_FALSE(h.call("delete_node", parse(R"({"nodeId":"a"})")).isError);
  CHECK_EQ(introduced(body(h.call("import_subgraph", parse(R"({"nodes":[{"id":"a","opens":"t_b"}]})")))),
           (std::vector<std::string>{"loop of trees from \"a\" through \"t_b\" -> \"t\""}));
  CHECK_EQ(h.trees.openedReads, (std::vector<std::set<TreeId>>{{TreeId{"t_b"}}}));
}

// The edit is saved before its pointers are followed and its reply waits on that read alone, so the read is given
// a short budget of its own: past it the receipt goes out without the loops and says so. That is an expected refusal
// under load — one WARN line under the follow's own name, no Issue — and the tree's diagnostics, read under the
// ordinary limit, still tell the loop.
TEST(mcp_an_edit_whose_follow_runs_past_its_budget_answers_without_the_loops_at_warn_and_files_no_issue) {
  struct Failures : FailureReporter {
    std::vector<std::string> reports;
    void report(const std::string&, const std::string&, const std::string&) override {}
    void reportWrite(const std::string& operation, const std::string& product, const std::string& door,
                     const std::string& outcome, const std::string&, const std::string& exceptionType) override {
      reports.push_back(operation + " " + product + " " + door + " " + outcome + " " + exceptionType);
    }
  };
  struct Observed {
    std::shared_ptr<Failures> failures = std::make_shared<Failures>();
    std::vector<std::string> completions;
    Observed() {
      installWriteReporter(failures);
      installWriteSink([this](const WriteCompletion& done) {
        completions.push_back(done.operation + " " + done.product + " " + done.door + " " + done.outcome +
                              (done.severity == WriteSeverity::warn ? " WARN" : " other"));
      });
    }
    ~Observed() {
      installWriteReporter(nullptr);
      installWriteSink(nullptr);
    }
  } observed;
  Harness h;
  h.plant("t_b", h.caller, "", {"t"});
  h.trees.budgetedReadsTimeOut = true;

  CHECK_EQ(body(h.call("create_node", parse(R"({"id":"a","label":"A","icon":"a","opens":"t_b"})"))),
           parse(R"({"applied":true,"seq":1,"id":"a","diagnosticsClean":true,"introducedDiagnostics":[],
               "pointerDiagnosticsUnavailable":true})"));
  const ToolResult patched = h.call("update_nodes", parse(R"({"updates":[{"nodeId":"a","opens":"t"}]})"));
  CHECK_EQ(body(patched), parse(R"({"treeId":"t","applied":true,"dryRun":false,"seq":2,"changedNodeIds":["a"],"unchangedNodeIds":[],
      "diagnosticsClean":true,"introducedDiagnostics":[],"pointerDiagnosticsUnavailable":true})"));
  CHECK_EQ(patched.structured, body(patched));

  CHECK_EQ(observed.completions, (std::vector<std::string>(2, "roadmap.receipt.follow roadmap mcp timeout WARN")));
  CHECK(observed.failures->reports.empty());
  CHECK_EQ(body(h.call("get_diagnostics", kNoArgs)),
           parse(R"({"cycles":[],"dangling":[],"selfEdges":[],"smells":[{"kind":"empty-legend"}],"maskedWork":[],
               "treeLoops":[{"node":"a","path":[{"treeId":"t","title":"Test Roadmap"}]}],"danglingPointers":[]})"));
  CHECK_EQ(h.trees.openedBudgets,
           (std::vector<std::optional<std::chrono::milliseconds>>{std::chrono::milliseconds{750}, std::chrono::milliseconds{750},
                                                                   std::nullopt}));
  CHECK_EQ(observed.completions.size(), 2u);
}

// An exhausted process must die rather than answer: neither the read nor an edit's follow reports it as pointers
// that could not be followed.
TEST(mcp_an_exhausted_process_is_not_answered_as_pointers_that_could_not_be_followed) {
  Harness h;
  h.plant("t_b", h.caller, "", {"t"});
  CHECK_FALSE(h.call("create_node", parse(R"({"id":"a","label":"A","opens":"t_b"})")).isError);
  h.trees.duringOpenedRead = [] { throw std::bad_alloc{}; };

  for (const auto& [tool, arguments] : {std::pair{"get_diagnostics", "{}"}, std::pair{"update_nodes", R"({"updates":[{"nodeId":"a","opens":"t"}]})"}}) {
    bool propagated = false;
    try {
      h.call(tool, parse(arguments));
    } catch (const std::bad_alloc&) {
      propagated = true;
    }
    CHECK(propagated);
  }
}

TEST(mcp_create_node_files_the_node_under_the_kind_it_names_and_says_so) {
  Harness h;
  CHECK_FALSE(h.call("add_kind", parse(R"({"id":"owner","hue":"gold","label":"Owner"})")).isError);

  const ToolResult created = h.call("create_node", parse(R"({"label":"Ship v1","kind":"owner"})"));
  CHECK_FALSE(created.isError);
  CHECK_EQ(body(created), parse(R"({"applied":true,"seq":2,"id":"ship-v1","kind":"owner","diagnosticsClean":true,
    "introducedDiagnostics":[]})"));
  CHECK_EQ(body(h.call("get_nodes", parse(R"({"nodeIds":["ship-v1"],"fields":["id","color","kind"]})"))),
           parse(R"({"treeId":"t","seq":2,"nodes":[{"id":"ship-v1","color":"gold","kind":"owner"}],"missingNodeIds":[]})"));
}

TEST(mcp_create_node_refuses_a_kind_the_legend_does_not_hold_or_a_colour_that_disagrees) {
  Harness h;
  CHECK_EQ(message(h.call("create_node", parse(R"({"label":"Ship","kind":"owner"})"))),
           std::string("create_node: kind \"owner\" is not a kind of this tree, whose legend holds none — add one "
                       "with roadmap_add_kind first"));
  for (const char* kind : {R"({"id":"developer","hue":"terracotta"})", R"({"id":"designer","hue":"olive"})",
                           R"({"id":"owner","hue":"gold"})"})
    CHECK_FALSE(h.call("add_kind", parse(kind)).isError);
  CHECK_EQ(message(h.call("create_node", parse(R"({"label":"Ship","kind":"ownr"})"))),
           std::string("create_node: kind \"ownr\" is not a kind of this tree; its legend holds \"developer\", "
                       "\"designer\", \"owner\""));
  CompositeToolHost gate(std::vector<ToolModule>{{h.tools, ""}});
  const ToolResult behindTheGate =
      gate.callTool("create_node", parse(R"({"treeId":"t","label":"Ship","kind":"ownr"})"), h.actor);
  CHECK_EQ(message(behindTheGate), message(h.call("create_node", parse(R"({"label":"Ship","kind":"ownr"})"))));
  CHECK_EQ(message(h.call("create_node", parse(R"({"label":"Ship","kind":"owner","color":"sky"})"))),
           std::string("create_node: kind \"owner\" wears gold, but color is \"sky\" — send one of the two, or both "
                       "when they agree"));
  CHECK_EQ(message(h.call("create_node", parse(R"({"label":"Ship","kind":""})"))),
           std::string("create_node: argument \"kind\" must be a non-empty string, got \"\""));
  CHECK_EQ(body(h.call("get_tree", kNoArgs))["count"].asUInt64(), 0u);
  CHECK_EQ(h.bus.subgraphBroadcasts.size(), 3u);

  CHECK_EQ(body(h.call("create_node", parse(R"({"label":"Ship","kind":"owner","color":"gold"})"))),
           parse(R"({"applied":true,"seq":4,"id":"ship","kind":"owner","diagnosticsClean":true,"introducedDiagnostics":[]})"));
  CHECK_EQ(body(h.call("create_node", parse(R"({"label":"Plan"})"))),
           parse(R"({"applied":true,"seq":5,"id":"plan","kind":"developer","diagnosticsClean":true,"introducedDiagnostics":[]})"));
}

TEST(mcp_an_update_nodes_row_takes_a_kind_or_a_colour_and_refuses_a_disagreeing_pair) {
  Harness h;
  CHECK_FALSE(h.call("add_kind", parse(R"({"id":"owner","hue":"gold"})")).isError);
  CHECK_EQ(body(h.call("create_node", parse(R"({"label":"Ship"})"))),
           parse(R"({"applied":true,"seq":2,"id":"ship","diagnosticsClean":true,"introducedDiagnostics":[]})"));

  CHECK_EQ(body(h.call("update_nodes", asUpdate(parse(R"({"nodeId":"ship","kind":"owner"})")))),
           parse(R"({"applied":true,"changedNodeIds":["ship"],"diagnosticsClean":true,"dryRun":false,"introducedDiagnostics":[],"seq":3,"treeId":"t","unchangedNodeIds":[]})"));
  CHECK_EQ(body(h.call("update_nodes", asUpdate(parse(R"({"nodeId":"ship","kind":"owner","color":"gold"})")))),
           parse(R"({"applied":true,"changedNodeIds":[],"diagnosticsClean":true,"dryRun":false,"introducedDiagnostics":[],"seq":3,"treeId":"t","unchanged":true,"unchangedNodeIds":["ship"]})"));
  CHECK_EQ(message(h.call("update_nodes", asUpdate(parse(R"({"nodeId":"ship","kind":"owner","color":"plum"})")))),
           std::string("update_nodes: updates[0].kind \"owner\" wears gold, but updates[0].color is \"plum\" — send one of the two, or both when they agree"));
  CHECK_EQ(message(h.call("update_nodes", asUpdate(parse(R"({"nodeId":"ship","kind":"crew"})")))),
           std::string("update_nodes: updates[0].kind \"crew\" is not a kind of this tree; its legend holds \"owner\""));
  CHECK_EQ(message(h.call("update_nodes", asUpdate(parse(R"({"nodeId":"ship"})")))),
           std::string("update_nodes: updates[0] sets nothing — pass at least one of label, color, kind, description, appendDescription, icon, links, addLinks, opens, status."));
  CHECK_EQ(body(h.call("update_nodes", asUpdate(parse(R"({"nodeId":"ship","color":"sky"})")))),
           parse(R"({"applied":true,"changedNodeIds":["ship"],"diagnosticsClean":true,"dryRun":false,"introducedDiagnostics":[],"seq":4,"treeId":"t","unchangedNodeIds":[]})"));
  CHECK_EQ(body(h.call("get_nodes", parse(R"({"nodeIds":["ship"],"fields":["id","color","kind"]})"))),
           parse(R"({"treeId":"t","seq":4,"nodes":[{"id":"ship","color":"sky"}],"missingNodeIds":[]})"));
}

// A client frame can land a second kind on a hue a kind already wears. A write that names its kind is
// answered with that kind, which wears the node's hue by construction; one that names none answers from
// the hue join the read field `kind` uses.
TEST(mcp_a_node_write_that_names_a_kind_answers_that_kind_when_two_kinds_share_its_hue) {
  Harness h;
  CHECK_FALSE(h.call("add_kind", parse(R"({"id":"backend","hue":"sky"})")).isError);
  Subgraph frame;
  frame.treeId = TreeId{"t"};
  frame.frameId = "client-add-kind";
  frame.actor = "r_client";
  frame.intent = SubgraphIntent::live;
  const Hlc stamp{5000, 0, "r_client"};
  frame.legend.kinds.push_back(KindStateEntry{.id = KindId{"zinfra"}, .createdAt = stamp, .hue = NodeColor::sky,
                                              .hueAt = stamp, .rank = 1, .rankAt = stamp});
  REQUIRE(h.registry.open(TreeId{"t"})->joinSubgraph(frame, h.caller).has_value());

  CHECK_EQ(body(h.call("create_node", parse(R"({"label":"N","kind":"backend"})"))),
           parse(R"({"applied":true,"seq":3,"id":"n","kind":"backend","diagnosticsClean":true,"introducedDiagnostics":[]})"));
  CHECK_EQ(body(h.call("update_nodes", asUpdate(parse(R"({"nodeId":"n","kind":"backend"})")))),
           parse(R"({"applied":true,"changedNodeIds":[],"diagnosticsClean":true,"dryRun":false,"introducedDiagnostics":[],"seq":3,"treeId":"t","unchanged":true,"unchangedNodeIds":["n"]})"));
  CHECK_EQ(body(h.call("update_nodes", asUpdate(parse(R"({"nodeId":"n","color":"sky"})")))),
           parse(R"({"applied":true,"changedNodeIds":[],"diagnosticsClean":true,"dryRun":false,"introducedDiagnostics":[],"seq":3,"treeId":"t","unchanged":true,"unchangedNodeIds":["n"]})"));
}

TEST(mcp_update_nodes_takes_a_kind_per_row_and_one_bad_row_writes_nothing) {
  Harness h;
  CHECK_FALSE(h.call("add_kind", parse(R"({"id":"owner","hue":"gold"})")).isError);
  CHECK_FALSE(h.call("add_kind", parse(R"({"id":"designer","hue":"olive"})")).isError);
  CHECK_FALSE(h.call("create_node", node("a", "A")).isError);
  CHECK_FALSE(h.call("create_node", node("b", "B")).isError);
  const Json::Value before = body(h.call("get_tree", kNoArgs));

  CHECK_EQ(message(h.call("update_nodes", parse(R"({"updates":[{"nodeId":"a","kind":"owner"},{"nodeId":"b","kind":"ghost"}]})"))),
           std::string("update_nodes: updates[1].kind \"ghost\" is not a kind of this tree; its legend holds \"owner\", \"designer\""));
  CHECK_EQ(message(h.call("update_nodes", parse(R"({"updates":[{"nodeId":"a","kind":"owner"},
    {"nodeId":"b","kind":"designer","color":"sky"}]})"))),
           std::string("update_nodes: updates[1].kind \"designer\" wears olive, but updates[1].color is \"sky\" — send one of the two, or both when they agree"));
  CHECK_EQ(message(h.call("update_nodes", parse(R"({"updates":[{"nodeId":"a","kind":""}]})"))),
           std::string("update_nodes: argument \"updates[0].kind\" must be a non-empty string, got \"\""));
  CHECK_EQ(body(h.call("get_tree", kNoArgs)), before);

  CHECK_EQ(body(h.call("update_nodes", parse(R"({"updates":[{"nodeId":"a","kind":"owner"},
    {"nodeId":"b","kind":"designer","color":"olive"}]})"))),
           parse(R"({"treeId":"t","applied":true,"dryRun":false,"seq":5,"changedNodeIds":["a","b"],"unchangedNodeIds":[],
    "diagnosticsClean":true,"introducedDiagnostics":[]})"));
  CHECK_EQ(body(h.call("get_nodes", parse(R"({"nodeIds":["a","b"],"fields":["id","color","kind"]})"))),
           parse(R"({"treeId":"t","seq":5,"nodes":[{"id":"a","color":"gold","kind":"owner"},
    {"id":"b","color":"olive","kind":"designer"}],"missingNodeIds":[]})"));
}

TEST(mcp_import_subgraph_files_nodes_under_a_kind_the_same_batch_adds) {
  Harness h;
  CHECK_EQ(body(h.call("import_subgraph", parse(R"({"kinds":[{"id":"owner","hue":"gold","label":"Owner"}],
    "nodes":[{"id":"ship","label":"Ship","kind":"owner"},{"id":"plan","label":"Plan","kind":"owner","color":"gold"}]})"))),
           parse(R"({"nodes":2,"edges":0,"kinds":1,"nodeCollisions":[],"kindCollisions":[],"newNodes":2,"newKinds":1,
    "prerequisiteMode":"merge","keptEdges":[],"keptEdgeCount":0,"tombstoned":{"nodes":0,"edges":0},"graphApplied":true,
    "progressApplied":true,"imported":true,"seq":1,"diagnosticsClean":true,"introducedDiagnostics":[]})"));
  CHECK_EQ(body(h.call("get_nodes", parse(R"({"nodeIds":["ship","plan"],"fields":["id","label","color","kind"]})"))),
           parse(R"({"treeId":"t","seq":1,"nodes":[{"id":"ship","label":"Ship","color":"gold","kind":"owner"},
    {"id":"plan","label":"Plan","color":"gold","kind":"owner"}],"missingNodeIds":[]})"));
}

TEST(mcp_import_subgraph_refuses_a_kind_its_legend_does_not_hold_and_writes_nothing) {
  Harness h;
  CHECK_FALSE(h.call("add_kind", parse(R"({"id":"developer","hue":"terracotta"})")).isError);

  const Json::Value unknown =
      parse(R"({"nodes":[{"id":"a","label":"A"},{"id":"b","label":"B"},{"id":"c","label":"C","kind":"ownr"}]})");
  const std::string refusal("import_subgraph: nodes[2].kind \"ownr\" is not a kind of this tree; its legend holds "
                            "\"developer\"");
  CHECK_EQ(message(h.call("import_subgraph", unknown)), refusal);
  Json::Value preview = unknown;
  preview["dryRun"] = true;
  CHECK_EQ(message(h.call("import_subgraph", preview)), refusal);
  CHECK_EQ(message(h.call("import_subgraph", parse(R"({"nodes":[{"id":"a","label":"A","kind":"developer","color":"sky"}]})"))),
           std::string("import_subgraph: nodes[0].kind \"developer\" wears terracotta, but nodes[0].color is \"sky\" — "
                       "send one of the two, or both when they agree"));
  CHECK_EQ(message(h.call("import_subgraph", parse(R"({"nodes":[{"id":"a","label":"A","kind":""}]})"))),
           std::string("import_subgraph: argument \"nodes[0].kind\" must be a non-empty string, got \"\""));

  CHECK_EQ(body(h.call("get_tree", kNoArgs))["count"].asUInt64(), 0u);
  CHECK_EQ(h.bus.subgraphBroadcasts.size(), 1u);
}

// The write line tells a kind the legend lacks, and a colour that disagrees with the kind sent beside
// it, from every other refusal on the four tools that take a kind; no line carries the kind it named.
TEST(mcp_a_refused_kind_completes_as_kind_unknown_or_kind_hue_mismatch) {
  Harness h;
  CompositeToolHost gate(std::vector<ToolModule>{{h.tools, ""}});
  const auto call = [&](const char* tool, const char* arguments) {
    Json::Value args = parse(arguments);
    args["treeId"] = "t";
    return gate.callTool(tool, args, h.actor);
  };
  std::vector<WriteCompletion> completions;
  installWriteSink([&](const WriteCompletion& completion) { completions.push_back(completion); });

  CHECK(call("roadmap_create_node", R"({"label":"Ship","kind":"pilot"})").isError);  // a legend that holds none
  CHECK_FALSE(h.call("add_kind", parse(R"({"id":"pilot","hue":"gold"})")).isError);
  CHECK_FALSE(h.call("create_node", node("a", "A")).isError);
  CHECK_FALSE(h.call("create_node", node("b", "B")).isError);
  for (const auto& [tool, arguments] : std::vector<std::pair<const char*, const char*>>{
           {"roadmap_create_node", R"({"label":"Ship","kind":"pilt"})"},
           {"roadmap_create_node", R"({"label":"Ship","kind":"pilot","color":"sky"})"},
           {"roadmap_update_nodes", R"({"updates":[{"nodeId":"a","label":"Renamed"},{"nodeId":"b","kind":"pilt"}]})"},
           {"roadmap_update_nodes", R"({"updates":[{"nodeId":"a","label":"Renamed"},
              {"nodeId":"b","kind":"pilot","color":"sky"}],"dryRun":true})"},
           {"roadmap_import_subgraph", R"({"nodes":[{"id":"n","label":"New"},{"id":"m","label":"More","kind":"pilt"}],
              "dryRun":true})"},
           {"roadmap_import_subgraph", R"({"nodes":[{"id":"n","label":"New","kind":"pilot","color":"sky"}]})"},
           {"roadmap_create_node", R"({"label":"Ship","kind":7})"},
           {"roadmap_update_nodes", R"({"updates":[{"nodeId":"a"}]})"},
           {"roadmap_create_node", R"({"label":"Ship","knd":"pilot"})"}})
    CHECK(call(tool, arguments).isError);
  CHECK_EQ(body(h.call("get_tree", parse(R"({"fields":["id","label","color"]})")))["tree"]["nodes"],
           parse(R"([{"id":"a","label":"A","color":"terracotta"},{"id":"b","label":"B","color":"terracotta"}])"));
  CHECK_FALSE(call("roadmap_create_node", R"({"label":"Ship","kind":"pilot"})").isError);
  installWriteSink({});

  std::vector<std::string> observed;
  for (const WriteCompletion& completion : completions) {
    observed.push_back(completion.operation + " " + completion.outcome);
    for (const char* content : {"pilot", "pilt", "Ship", "Renamed", "More"})
      CHECK_EQ(writeCompletionJson(completion).find(content), std::string::npos);
  }
  CHECK_EQ(observed, (std::vector<std::string>{
                         "mcp.roadmap_create_node kind-unknown", "mcp.roadmap_create_node kind-unknown",
                         "mcp.roadmap_create_node kind-hue-mismatch", "mcp.roadmap_update_nodes kind-unknown",
                         "mcp.roadmap_update_nodes kind-hue-mismatch", "mcp.roadmap_import_subgraph kind-unknown",
                         "mcp.roadmap_import_subgraph kind-hue-mismatch", "mcp.roadmap_create_node refused",
                         "mcp.roadmap_update_nodes refused", "mcp.roadmap_create_node invalid-arguments",
                         "mcp.roadmap_create_node ok"}));
}

TEST(mcp_import_subgraph_re_files_a_node_by_kind_alone_and_keeps_its_other_fields) {
  Harness h;
  CHECK_FALSE(h.call("add_kind", parse(R"({"id":"owner","hue":"gold"})")).isError);
  CHECK_FALSE(h.call("import_subgraph", parse(R"({"nodes":[{"id":"review","label":"Backend review","icon":"magnifier",
    "color":"sky"}]})")).isError);

  CHECK_EQ(body(h.call("import_subgraph", parse(R"({"nodes":[{"id":"review","kind":"owner"}]})"))),
           parse(R"({"nodes":1,"edges":0,"kinds":0,"nodeCollisions":["review"],"kindCollisions":[],"newNodes":0,
    "newKinds":0,"prerequisiteMode":"merge","keptEdges":[],"keptEdgeCount":0,"tombstoned":{"nodes":0,"edges":0},
    "graphApplied":true,"progressApplied":true,"imported":true,"seq":3,"diagnosticsClean":true,"introducedDiagnostics":[]})"));
  CHECK_EQ(body(h.call("get_nodes", parse(R"({"nodeIds":["review"],"fields":["id","label","icon","color","kind"]})"))),
           parse(R"({"treeId":"t","seq":3,"nodes":[{"id":"review","label":"Backend review","icon":"magnifier",
    "color":"gold","kind":"owner"}],"missingNodeIds":[]})"));
}

// A node's kind and the tree it opens are separate registers, so one write may name both.
TEST(mcp_a_node_write_may_name_its_kind_and_the_tree_it_opens_together) {
  Harness h;
  h.trees.byId["t_sub"] = StoredTree{LooseGraph().exportState(), LegendState{}, {"Deep dive", {}}, 0, h.caller};
  CHECK_FALSE(h.call("add_kind", parse(R"({"id":"owner","hue":"gold"})")).isError);
  CHECK_EQ(body(h.call("create_node", parse(R"({"id":"a","label":"A","kind":"owner","opens":"t_sub"})"))),
           parse(R"({"applied":true,"seq":2,"id":"a","kind":"owner","diagnosticsClean":true,"introducedDiagnostics":[]})"));
  CHECK_FALSE(h.call("import_subgraph", parse(R"({"nodes":[{"id":"b","label":"B","kind":"owner","opens":"t_sub"}]})"))
                  .isError);
  CHECK_FALSE(h.call("add_kind", parse(R"({"id":"crew","hue":"sky"})")).isError);
  CHECK_EQ(body(h.call("update_nodes", parse(R"({"updates":[{"nodeId":"a","kind":"crew","opens":""}]})"))),
           parse(R"({"treeId":"t","applied":true,"dryRun":false,"seq":5,"changedNodeIds":["a"],"unchangedNodeIds":[],
    "diagnosticsClean":true,"introducedDiagnostics":[]})"));
  CHECK_EQ(body(h.call("get_tree", parse(R"({"fields":["id","color","kind","opens"]})")))["tree"]["nodes"],
           parse(R"([{"id":"a","color":"sky","kind":"crew"},
    {"id":"b","color":"gold","kind":"owner","opens":{"treeId":"t_sub","title":"Deep dive","state":"open"}}])"));
}

// Guides add: the method a tree above holds comes with the tree worked under it, farthest first and the tree's own last.
TEST(mcp_get_tree_answers_the_guides_of_the_callers_trees_above_farthest_first_then_its_own_on_the_first_page_alone) {
  Harness h;
  h.plant("t_root", h.caller, "Write the outcome first.", {"t_middle"});
  h.plant("t_middle", h.caller, "Ship weekly.", {"t"});
  h.plant("t_beside", h.caller, "Keep it small.", {"t"});
  h.plant("t_silent", h.caller, "", {"t"});
  CHECK_FALSE(h.call("update_tree", with("guide", "Tests before code.")).isError);
  for (const char* id : {"a", "b", "c"}) CHECK_FALSE(h.call("create_node", node(id, id)).isError);

  const Json::Value first = body(h.call("get_tree", parse(R"({"limit":2})")));
  CHECK_EQ(keys(first["tree"]), (std::vector<std::string>{"guide", "guides", "id", "kinds", "nodes", "title", "url"}));
  CHECK_EQ(first["tree"]["guide"], parse(R"({"text":"Tests before code.","yours":true})"));
  CHECK_EQ(first["tree"]["guides"],
           parse(R"([{"treeId":"t_root","title":"Tree t_root","text":"Write the outcome first.","yours":true},
                     {"treeId":"t_beside","title":"Tree t_beside","text":"Keep it small.","yours":true},
                     {"treeId":"t_middle","title":"Tree t_middle","text":"Ship weekly.","yours":true},
                     {"treeId":"t","title":"Test Roadmap","text":"Tests before code.","yours":true}])"));

  Json::Value next(Json::objectValue);
  next["limit"] = 2;
  next["cursor"] = first["nextCursor"];
  const Json::Value second = body(h.call("get_tree", next));
  CHECK_EQ(ids(second["tree"]["nodes"]), (std::vector<std::string>{"c"}));
  CHECK_EQ(keys(second["tree"]), (std::vector<std::string>{"guide", "id", "kinds", "nodes", "title", "url"}));
  CHECK_EQ(second["tree"]["guide"], parse(R"({"text":"Tests before code.","yours":true})"));

  CHECK_FALSE(h.call("update_tree", with("guide", "")).isError);
  CHECK_EQ(body(h.call("get_tree", kNoArgs))["tree"]["guides"],
           parse(R"([{"treeId":"t_root","title":"Tree t_root","text":"Write the outcome first.","yours":true},
                     {"treeId":"t_beside","title":"Tree t_beside","text":"Keep it small.","yours":true},
                     {"treeId":"t_middle","title":"Tree t_middle","text":"Ship weekly.","yours":true}])"));
}

TEST(mcp_guides_are_yours_where_the_caller_wrote_them_and_not_where_a_fork_copied_them) {
  Harness h;
  h.plant("t_written", h.caller, "My method.", {"t"});
  h.plant("t_forked", h.caller, "Its author's method.", {"t"});
  h.trees.byId["t_forked"].guideInherited = true;
  h.trees.byId["t"].guide = Lww<std::string>{"Copied with the fork.", Hlc{2, 0, "seed"}};
  h.trees.byId["t"].guideInherited = true;

  CHECK_EQ(body(h.call("get_tree", kNoArgs))["tree"]["guides"],
           parse(R"([{"treeId":"t_forked","title":"Tree t_forked","text":"Its author's method.","yours":false},
                     {"treeId":"t_written","title":"Tree t_written","text":"My method.","yours":true},
                     {"treeId":"t","title":"Test Roadmap","text":"Copied with the fork.","yours":false}])"));

  CHECK_FALSE(h.call("update_tree", with("guide", "Mine now.")).isError);
  CHECK_EQ(body(h.call("get_tree", kNoArgs))["tree"]["guides"][2],
           parse(R"({"treeId":"t","title":"Test Roadmap","text":"Mine now.","yours":true})"));
}

// Only the caller's own trees are above a tree, so a reader of someone else's is answered that tree's guide and no walk is made.
TEST(mcp_a_caller_who_cannot_write_the_tree_receives_its_own_guide_alone_and_no_tree_above_is_read) {
  Harness h;
  h.trees.byId["t"].visibility = Visibility::public_;
  h.plant("t_root", h.caller, "The owner's private method.", {"t"});
  h.plant("t_theirs", uid("stranger"), "The stranger's own method.", {"t"});
  CHECK_FALSE(h.call("update_tree", with("guide", "Rig first, then sail.")).isError);

  for (const UserId& reader : {uid("stranger"), UserId{}}) {
    const ToolResult read = h.tools.callTool("get_tree", with("treeId", "t"), ToolCaller{reader, ToolScope::everything()});
    CHECK_EQ(body(read)["tree"]["guides"],
             parse(R"([{"treeId":"t","title":"Test Roadmap","text":"Rig first, then sail.","yours":false}])"));
    CHECK_EQ(message(read).find("t_root"), std::string::npos);
    CHECK_EQ(message(read).find("private method"), std::string::npos);
    CHECK_EQ(message(read).find("stranger's own"), std::string::npos);
  }
  CHECK_FALSE(h.call("update_tree", with("guide", "")).isError);
  for (const UserId& reader : {uid("stranger"), UserId{}}) {
    const ToolResult read = h.tools.callTool("get_tree", with("treeId", "t"), ToolCaller{reader, ToolScope::everything()});
    CHECK_EQ(body(read)["tree"]["guides"], parse("[]"));
  }
  CHECK(h.trees.aboveReads.empty());

  CHECK_EQ(body(h.call("get_tree", kNoArgs))["tree"]["guides"],
           parse(R"([{"treeId":"t_root","title":"Tree t_root","text":"The owner's private method.","yours":true}])"));
  CHECK_EQ(h.trees.aboveReads, (std::vector<TreeId>{TreeId{"t"}}));
}

// The room, the socket and PUT admit any pointer text, so a pointer at a tree proves nothing about who planted it.
TEST(mcp_a_removed_tree_someone_elses_tree_and_a_tombstoned_pointer_are_not_above_a_tree) {
  Harness h;
  h.plant("t_removed", h.caller, "Removed.", {"t"});
  h.trees.softDelete(TreeId{"t_removed"});
  h.plant("t_beyond", h.caller, "Reached only through the removed tree.", {"t_removed"});
  h.plant("t_theirs", uid("someone-else"), "Someone else's.", {"t"});
  h.plant("t_tombstoned", h.caller, "Its pointer was deleted.", {"t"});
  LooseGraph tombstoned(h.trees.byId["t_tombstoned"].state);
  tombstoned.deleteNode(NodeId{"to-t"}, Hlc{3, 0, "seed"});
  h.trees.byId["t_tombstoned"].state = tombstoned.exportState();
  h.plant("t_standing", h.caller, "Standing.", {"t"});

  CHECK_EQ(body(h.call("get_tree", kNoArgs))["tree"]["guides"],
           parse(R"([{"treeId":"t_standing","title":"Tree t_standing","text":"Standing.","yours":true}])"));
}

TEST(mcp_a_tree_reached_a_short_and_a_long_way_sits_at_its_shortest_distance_and_a_loop_never_puts_the_tree_above_itself) {
  Harness h;
  h.plant("t_a_mid", h.caller, "Mid.", {"t"});
  h.plant("t_z_both", h.caller, "Both ways.", {"t", "t_a_mid"});
  h.plant("t_top", h.caller, "Top.", {"t_z_both"});
  CHECK_FALSE(h.call("update_tree", with("guide", "Own.")).isError);
  CHECK_FALSE(h.call("create_node", parse(R"({"id":"back","label":"Back","opens":"t_top"})")).isError);
  CHECK_FALSE(h.call("create_node", parse(R"({"id":"self","label":"Self","opens":"t"})")).isError);

  CHECK_EQ(body(h.call("get_tree", kNoArgs))["tree"]["guides"],
           parse(R"([{"treeId":"t_top","title":"Tree t_top","text":"Top.","yours":true},
                     {"treeId":"t_a_mid","title":"Tree t_a_mid","text":"Mid.","yours":true},
                     {"treeId":"t_z_both","title":"Tree t_z_both","text":"Both ways.","yours":true},
                     {"treeId":"t","title":"Test Roadmap","text":"Own.","yours":true}])"));
}

TEST(mcp_a_tree_eight_pointers_up_is_above_and_one_nine_up_is_not) {
  Harness h;
  h.plant("t_up1", h.caller, "", {"t"});
  for (int level = 2; level <= 9; ++level) {
    const std::string below = "t_up" + std::to_string(level - 1);
    const std::string guide = level == 8 ? "Eight up." : level == 9 ? "Nine up." : "";
    h.plant(("t_up" + std::to_string(level)).c_str(), h.caller, guide.c_str(), {below.c_str()});
  }

  CHECK_EQ(body(h.call("get_tree", kNoArgs))["tree"]["guides"],
           parse(R"([{"treeId":"t_up8","title":"Tree t_up8","text":"Eight up.","yours":true}])"));
}

TEST(mcp_more_guided_trees_above_than_the_cap_holds_keeps_the_nearest_and_the_trees_own_guide) {
  Harness h;
  h.plant("t_up1", h.caller, "Guide 1.", {"t"});
  for (int level = 2; level <= 8; ++level)
    h.plant(("t_up" + std::to_string(level)).c_str(), h.caller, ("Guide " + std::to_string(level) + ".").c_str(),
            {("t_up" + std::to_string(level - 1)).c_str()});
  CHECK_FALSE(h.call("update_tree", with("guide", "Own.")).isError);

  const Json::Value guides = body(h.call("get_tree", kNoArgs))["tree"]["guides"];

  Json::Value nearest(Json::arrayValue);
  for (int level = 7; level >= 1; --level) {
    Json::Value guide(Json::objectValue);
    guide["treeId"] = "t_up" + std::to_string(level);
    guide["title"] = "Tree t_up" + std::to_string(level);
    guide["text"] = "Guide " + std::to_string(level) + ".";
    guide["yours"] = true;
    nearest.append(guide);
  }
  nearest.append(parse(R"({"treeId":"t","title":"Test Roadmap","text":"Own.","yours":true})"));
  CHECK_EQ(guides, nearest);
}

// One walk per first page of get_tree, for its writer; nothing else a caller sends reads the trees above.
TEST(mcp_the_trees_above_are_read_once_per_first_page_of_get_tree_and_by_no_other_reply) {
  Harness h;
  h.trees.byId["t"].visibility = Visibility::public_;
  h.plant("t_root", h.caller, "The method.", {"t"});
  for (const char* id : {"a", "b", "c"}) CHECK_FALSE(h.call("create_node", node(id, id)).isError);
  CHECK_FALSE(h.call("update_tree", with("guide", "Own.")).isError);
  CHECK(h.trees.aboveReads.empty());

  CHECK_FALSE(h.call("get_tree", kNoArgs).isError);
  CHECK_FALSE(h.call("get_tree", parse(R"({"fields":["id","state","opens"],"includeEdges":true,"limit":1})")).isError);
  CHECK_EQ(h.trees.aboveReads, (std::vector<TreeId>{TreeId{"t"}, TreeId{"t"}}));

  CHECK_FALSE(h.call("get_tree", parse(R"({"limit":1,"cursor":"a"})")).isError);
  CHECK_FALSE(h.call("get_tree", parse(R"({"cursor":"c"})")).isError);
  CHECK_FALSE(h.call("get_tree", parse(R"({"includeGuides":false})")).isError);
  CHECK(h.call("get_tree", parse(R"({"limit":0})")).isError);
  CHECK(h.call("get_tree", parse(R"({"fields":["nope"]})")).isError);
  CHECK(h.call("get_tree", parse(R"({"cursor":"ghost"})")).isError);
  CHECK_FALSE(h.call("get_nodes", parse(R"({"nodeIds":["a"],"fields":["id","state","opens"]})")).isError);
  CHECK_FALSE(h.call("find_nodes", parse(R"({"state":"available"})")).isError);
  CHECK_FALSE(h.call("get_progress", kNoArgs).isError);
  CHECK_FALSE(h.call("get_diagnostics", kNoArgs).isError);
  CHECK_FALSE(h.tools.callTool("list_trees", kNoArgs, h.actor).isError);
  for (const UserId& reader : {uid("stranger"), UserId{}})
    CHECK_FALSE(h.tools.callTool("get_tree", with("treeId", "t"), ToolCaller{reader, ToolScope::everything()}).isError);
  CHECK_EQ(h.trees.aboveReads.size(), 2u);
}

// A walk that cannot be made does not fail the read: the first page answers the tree's own guide alone and says the
// trees above could not be read, nothing else of the reply changes, and one issue is filed under the walk's own name.
TEST(mcp_a_first_page_whose_trees_above_cannot_be_read_answers_the_trees_own_guide_and_says_so_and_files_one_issue) {
  struct Failures : FailureReporter {
    std::vector<std::string> reports;
    void report(const std::string&, const std::string&, const std::string&) override {}
    void reportWrite(const std::string& operation, const std::string& product, const std::string& door,
                     const std::string& outcome, const std::string&, const std::string& exceptionType) override {
      reports.push_back(operation + " " + product + " " + door + " " + outcome + " " + exceptionType);
    }
  };
  struct ReporterScope {
    std::shared_ptr<Failures> failures = std::make_shared<Failures>();
    ReporterScope() { installWriteReporter(failures); }
    ~ReporterScope() { installWriteReporter(nullptr); }
  } reporter;
  Harness h;
  h.trees.byId["t"].visibility = Visibility::public_;
  h.plant("t_root", h.caller, "The method.", {"t"});
  for (const char* id : {"a", "b"}) CHECK_FALSE(h.call("create_node", node(id, id)).isError);
  CHECK_FALSE(h.call("update_tree", with("guide", "Own.")).isError);
  const Json::Value everything = parse(R"({"fields":["id","label","state"],"includeEdges":true,"limit":1})");
  Json::Value read = body(h.call("get_tree", everything));
  CHECK_EQ(read["tree"]["guides"],
           parse(R"([{"treeId":"t_root","title":"Tree t_root","text":"The method.","yours":true},
                     {"treeId":"t","title":"Test Roadmap","text":"Own.","yours":true}])"));
  CHECK_FALSE(read["tree"].isMember("guidesAboveUnavailable"));

  h.trees.aboveReadsFail = true;
  const ToolResult degraded = h.call("get_tree", everything);

  CHECK_FALSE(degraded.isError);
  read["tree"]["guides"] = parse(R"([{"treeId":"t","title":"Test Roadmap","text":"Own.","yours":true}])");
  read["tree"]["guidesAboveUnavailable"] = true;
  CHECK_EQ(body(degraded), read);
  CHECK_EQ(reporter.failures->reports,
           (std::vector<std::string>{std::string("roadmap.tree.guides roadmap mcp failed ") + typeid(std::runtime_error).name()}));

  for (const char* unwalked : {R"({"cursor":"a"})", R"({"includeGuides":false})"})
    CHECK_FALSE(body(h.call("get_tree", parse(unwalked)))["tree"].isMember("guidesAboveUnavailable"));
  CHECK_EQ(body(h.tools.callTool("get_tree", with("treeId", "t"), ToolCaller{uid("stranger"), ToolScope::everything()}))["tree"]["guides"],
           parse(R"([{"treeId":"t","title":"Test Roadmap","text":"Own.","yours":false}])"));
  CHECK_EQ(reporter.failures->reports.size(), 1u);
}

// A call that only needs the nodes or the seq says so: no `guides` key, and no tree above is read.
TEST(mcp_get_tree_asked_for_no_guides_carries_none_and_reads_no_tree_above) {
  Harness h;
  h.plant("t_root", h.caller, "The method.", {"t"});
  CHECK_FALSE(h.call("update_tree", with("guide", "Own.")).isError);
  h.trees.aboveReadsFail = true;

  CHECK_EQ(body(h.call("get_tree", parse(R"({"includeGuides":false})"))),
           parse(R"({"count":0,"seq":1,"tree":{"guide":{"text":"Own.","yours":true},"id":"t","kinds":[],"nodes":[],
                     "title":"Test Roadmap","url":"https://app.example/#/app/t"}})"));
  CHECK(h.trees.aboveReads.empty());
  CHECK_EQ(message(h.call("get_tree", parse(R"({"includeGuides":"no"})"))),
           std::string("get_tree: argument \"includeGuides\" must be a boolean, got string"));

  h.trees.aboveReadsFail = false;
  CHECK_EQ(body(h.call("get_tree", parse(R"({"includeGuides":true})")))["tree"]["guides"],
           parse(R"([{"treeId":"t_root","title":"Tree t_root","text":"The method.","yours":true},
                     {"treeId":"t","title":"Test Roadmap","text":"Own.","yours":true}])"));
  CHECK_EQ(h.trees.aboveReads, (std::vector<TreeId>{TreeId{"t"}}));
}

// A stranger's read must not wait on the owner's statement: that wait would say a tree of the owner's opens this one.
TEST(mcp_get_tree_reads_the_trees_above_after_it_has_let_go_of_the_trees_strand) {
  Harness h;
  h.trees.byId["t"].visibility = Visibility::public_;
  h.plant("t_root", h.caller, "The method.", {"t"});
  bool strandWasFree = false;
  Json::Value readMeanwhile;
  h.trees.duringAboveRead = [&] {
    std::thread other([&] {
      std::mutex& strand = h.registry.strandFor(TreeId{"t"});
      if (!strand.try_lock()) return;
      strand.unlock();
      strandWasFree = true;
      readMeanwhile = body(h.tools.callTool("get_tree", with("treeId", "t"),
                                            ToolCaller{uid("stranger"), ToolScope::everything()}))["tree"]["guides"];
    });
    other.join();
  };

  CHECK_EQ(body(h.call("get_tree", kNoArgs))["tree"]["guides"],
           parse(R"([{"treeId":"t_root","title":"Tree t_root","text":"The method.","yours":true}])"));

  CHECK(strandWasFree);
  CHECK_EQ(readMeanwhile, parse("[]"));
  CHECK_EQ(h.trees.aboveReads, (std::vector<TreeId>{TreeId{"t"}}));
}

// A tree answers where it opens on the web: in the app for its owner, on its share page for anyone else who may read
// it, and a step the same way with its id percent-encoded. The node field is asked for, never a default, and no write
// line carries an address.
TEST(mcp_a_tree_and_its_steps_answer_where_they_open_on_the_web) {
  Harness h;
  LooseGraph theirs;
  theirs.createNode(NodeId{"why?"}, "Why", "", NodeColor::sky, std::nullopt, Hlc{1, 0, "x"});
  h.trees.byId["t_theirs"] = StoredTree{theirs.exportState(), LegendState{}, {"Their plans", {}}, 0,
                                        uid("someone-else"), Visibility::public_};
  CHECK_FALSE(h.call("create_node", parse(R"({"id":"two words","label":"Two words"})")).isError);
  CompositeToolHost gate(std::vector<ToolModule>{{h.tools, ""}});
  const auto call = [&](const char* tool, const char* arguments) {
    return body(gate.callTool(tool, parse(arguments), h.actor));
  };
  std::vector<WriteCompletion> completions;
  installWriteSink([&](const WriteCompletion& completion) { completions.push_back(completion); });

  const std::string planted = call("roadmap_create_tree", R"({"title":"Sailing"})")["treeId"].asString();
  const Json::Value rows = call("roadmap_list_trees", "{}")["trees"];
  Json::Value listed(Json::arrayValue);
  for (const Json::Value& row : rows) {
    Json::Value entry(Json::objectValue);
    entry["id"] = row["id"];
    entry["url"] = row["url"];
    listed.append(entry);
  }
  CHECK_EQ(listed, parse(R"([{"id":"t","url":"https://app.example/#/app/t"},
    {"id":")" + planted + R"(","url":"https://app.example/#/app/)" + planted + R"("}])"));

  const Json::Value mine = call("roadmap_get_tree", R"({"treeId":"t","fields":["id","url"],"includeGuides":false})");
  CHECK_EQ(mine["tree"]["url"], Json::Value("https://app.example/#/app/t"));
  CHECK_EQ(mine["tree"]["nodes"], parse(R"([{"id":"two words","url":"https://app.example/#/app/t?step=two%20words"}])"));
  CHECK_EQ(call("roadmap_get_tree", R"({"treeId":"t_theirs"})")["tree"]["url"],
           Json::Value("https://app.example/t/t_theirs"));
  CHECK_EQ(call("roadmap_get_tree", R"({"treeId":"t_theirs"})")["tree"]["nodes"],
           parse(R"([{"id":"why?","label":"Why","color":"sky","prerequisites":[]}])"));
  const Json::Value theirStep = parse(R"([{"id":"why?","url":"https://app.example/t/t_theirs#?step=why%3F"}])");
  CHECK_EQ(call("roadmap_get_nodes", R"({"treeId":"t_theirs","nodeIds":["why?"],"fields":["id","url"]})")["nodes"],
           theirStep);
  CHECK_EQ(call("roadmap_find_nodes", R"({"treeId":"t_theirs","query":"why","fields":["id","url"]})")["nodes"],
           theirStep);
  CHECK_EQ(kGetTreeFields.count(NodeField::url), 0u);
  CHECK_EQ(kFindNodesFields.count(NodeField::url), 0u);
  installWriteSink({});

  std::vector<std::string> observed;
  for (const WriteCompletion& completion : completions) {
    observed.push_back(completion.operation + " " + completion.outcome);
    for (const char* address : {"app.example", "/#/app/", "step="})
      CHECK_EQ(writeCompletionJson(completion).find(address), std::string::npos);
  }
  CHECK_EQ(observed, (std::vector<std::string>{"mcp.roadmap_create_tree ok"}));
}


// An update_nodes row sent what the node already holds changes nothing, so it writes nothing: no seq, no op row, no
// frame and no save. It answers `unchanged: true` with the tree's head, and still logs one `ok`.
TEST(mcp_an_update_nodes_row_that_changes_nothing_writes_nothing_and_says_so) {
  Harness h;
  h.trees.byId["t_sub"] = StoredTree{LooseGraph().exportState(), LegendState{}, {"Deep dive", {}}, 0, h.caller};
  CHECK_FALSE(h.call("add_kind", parse(R"({"id":"pilot","hue":"gold"})")).isError);
  CHECK_FALSE(h.call("create_node", parse(R"({"id":"a","label":"A","color":"gold","description":"Notes",
    "icon":"pin","links":[{"url":"https://a.example/1","label":"One"},{"url":"https://a.example/2","label":"Two"}],
    "opens":"t_sub"})")).isError);
  const StoredTree stored = h.trees.byId["t"];
  const std::size_t rows = h.ops.byTree["t"].size();
  const std::size_t frames = h.bus.subgraphBroadcasts.size();
  CompositeToolHost gate(std::vector<ToolModule>{{h.tools, ""}});
  std::vector<WriteCompletion> completions;
  installWriteSink([&](const WriteCompletion& completion) { completions.push_back(completion); });

  for (const char* row : {R"({"nodeId":"a","label":"A"})", R"({"nodeId":"a","color":"gold"})",
                          R"({"nodeId":"a","kind":"pilot"})", R"({"nodeId":"a","description":"Notes"})",
                          R"({"nodeId":"a","icon":"pin"})",
                          R"({"nodeId":"a","links":[{"url":"https://a.example/1","label":"One"},
                            {"url":"https://a.example/2","label":"Two"}]})",
                          R"({"nodeId":"a","opens":"t_sub"})",
                          R"({"nodeId":"a","addLinks":[{"url":"https://a.example/2","label":"Two"}]})",
                          R"({"nodeId":"a","description":"Notes","icon":"pin","opens":"t_sub"})"}) {
    Json::Value args(Json::objectValue);
    args["treeId"] = "t";
    args["updates"].append(parse(row));
    CHECK_EQ(body(gate.callTool("roadmap_update_nodes", args, h.actor)),
             parse(R"({"treeId":"t","changedNodeIds":[],"unchangedNodeIds":["a"],"dryRun":false,"applied":true,"seq":2,
               "unchanged":true,"diagnosticsClean":true,"introducedDiagnostics":[]})"));
  }
  installWriteSink({});

  CHECK_EQ(h.registry.open(TreeId{"t"})->head(), static_cast<Seq>(2));
  CHECK_EQ(h.ops.byTree["t"].size(), rows);
  CHECK_EQ(h.bus.subgraphBroadcasts.size(), frames);
  CHECK(h.trees.byId["t"] == stored);
  std::vector<std::string> observed;
  for (const WriteCompletion& completion : completions) observed.push_back(completion.operation + " " + completion.outcome);
  CHECK_EQ(observed, std::vector<std::string>(9, "mcp.roadmap_update_nodes ok"));
}

// An update_nodes row that changes any field it names lands: a seq, an op row, and no `unchanged`.
TEST(mcp_an_update_nodes_row_that_changes_one_field_it_names_lands_with_a_seq_and_a_row) {
  Harness h;
  CHECK_FALSE(h.call("create_node", parse(R"({"id":"a","label":"A","description":"Notes","icon":"pin",
    "links":[{"url":"https://a.example/1","label":"One"}]})")).isError);

  for (const auto& [row, seq] : std::vector<std::pair<const char*, int>>{
           {R"({"nodeId":"a","description":"Notes","icon":"flag"})", 2},
           {R"({"nodeId":"a","addLinks":[{"url":"https://a.example/1","label":"Spec"}]})", 3},
           {R"({"nodeId":"a","appendDescription":"More"})", 4},
           {R"({"nodeId":"a","label":"B"})", 5}}) {
    Json::Value expected = parse(R"({"treeId":"t","changedNodeIds":["a"],"unchangedNodeIds":[],"dryRun":false,
      "applied":true,"diagnosticsClean":true,"introducedDiagnostics":[]})");
    expected["seq"] = seq;
    Json::Value args(Json::objectValue);
    args["updates"].append(parse(row));
    CHECK_EQ(body(h.call("update_nodes", args)), expected);
    CHECK_EQ(h.ops.byTree["t"].size(), static_cast<std::size_t>(seq));
  }
  CHECK_EQ(body(h.call("get_nodes", parse(R"({"nodeIds":["a"],"fields":["label","icon","description","links"]})")))["nodes"],
           parse(R"([{"label":"B","icon":"flag","description":"Notes\n\nMore","links":[{"url":"https://a.example/1","label":"Spec"}]}])"));
}

// An import re-sending what the tree holds lands nothing: no seq, no op row, no frame and no save. Its receipt is the
// usual one with `unchanged: true` and the tree's head, its dry run says the same, and each call logs one `ok`.
TEST(mcp_an_import_that_changes_nothing_keeps_the_seq_and_says_so) {
  Harness h;
  CHECK_FALSE(h.call("import_subgraph", parse(R"({"kinds":[{"id":"owner","hue":"gold","label":"Owner"}],
    "nodes":[{"id":"a","label":"A","color":"gold"},{"id":"b","label":"B","prerequisites":["a"]}]})")).isError);
  const StoredTree stored = h.trees.byId["t"];
  const std::size_t rows = h.ops.byTree["t"].size();
  const std::size_t frames = h.bus.subgraphBroadcasts.size();
  CompositeToolHost gate(std::vector<ToolModule>{{h.tools, ""}});
  std::vector<WriteCompletion> completions;
  installWriteSink([&](const WriteCompletion& completion) { completions.push_back(completion); });

  const std::string nodes = R"("nodes":[{"id":"a","label":"A","color":"gold"},{"id":"b","label":"B","prerequisites":["a"]}])";
  const std::string legend = R"("kinds":[{"id":"owner","hue":"gold","label":"Owner"}])";
  const std::string sameShape = R"("nodes":2,"edges":1,"nodeCollisions":["a","b"],"newNodes":0,"keptEdges":[],
    "keptEdgeCount":0,"tombstoned":{"nodes":0,"edges":0},"unchanged":true)";
  const std::string noKinds = R"("kinds":0,"kindCollisions":[],"newKinds":0)";
  const std::string oneKind = R"("kinds":1,"kindCollisions":["owner"],"newKinds":0)";
  const std::string landed = R"("graphApplied":true,"progressApplied":true,"imported":true,"seq":1,
    "diagnosticsClean":true,"introducedDiagnostics":[])";
  const std::string previewed = R"("dryRun":true,"tombstone":[])";
  for (const auto& [arguments, receipt] : std::vector<std::pair<std::string, std::string>>{
           {"{" + nodes + "}", "{" + sameShape + "," + noKinds + R"(,"prerequisiteMode":"merge",)" + landed + "}"},
           {"{" + legend + "," + nodes + "}", "{" + sameShape + "," + oneKind + R"(,"prerequisiteMode":"merge",)" + landed + "}"},
           {R"({"prerequisiteMode":"replace",)" + nodes + "}",
            "{" + sameShape + "," + noKinds + R"(,"prerequisiteMode":"replace","removedEdges":0,)" + landed + "}"},
           {R"({"dryRun":true,)" + nodes + "}", "{" + sameShape + "," + noKinds + R"(,"prerequisiteMode":"merge",)" + previewed + "}"},
           {R"({"dryRun":true,)" + legend + "," + nodes + "}",
            "{" + sameShape + "," + oneKind + R"(,"prerequisiteMode":"merge",)" + previewed + "}"},
           {R"({"dryRun":true,"prerequisiteMode":"replace",)" + nodes + "}",
            "{" + sameShape + "," + noKinds + R"(,"prerequisiteMode":"replace","removedEdges":0,)" + previewed + "}"}}) {
    Json::Value args = parse(arguments);
    args["treeId"] = "t";
    CHECK_EQ(body(gate.callTool("roadmap_import_subgraph", args, h.actor)), parse(receipt));
  }
  installWriteSink({});

  CHECK_EQ(h.registry.open(TreeId{"t"})->head(), static_cast<Seq>(1));
  CHECK_EQ(h.ops.byTree["t"].size(), rows);
  CHECK_EQ(h.bus.subgraphBroadcasts.size(), frames);
  CHECK(h.trees.byId["t"] == stored);
  std::vector<std::string> observed;
  for (const WriteCompletion& completion : completions) observed.push_back(completion.operation + " " + completion.outcome);
  CHECK_EQ(observed, std::vector<std::string>(6, "mcp.roadmap_import_subgraph ok"));
}

// Every kind of change an import makes lands as it always has: a seq, an op row, and no `unchanged`.
TEST(mcp_an_import_that_changes_anything_lands_with_a_seq_and_no_unchanged) {
  Harness h;
  CHECK_FALSE(h.call("import_subgraph", parse(R"({"kinds":[{"id":"owner","hue":"gold","label":"Owner"}],
    "nodes":[{"id":"a","label":"A","color":"gold"},{"id":"b","label":"B","prerequisites":["a"]},{"id":"c","label":"C"}]})"))
                  .isError);

  int seq = 1;
  for (const char* change : {
           R"({"nodes":[{"id":"c","label":"C","prerequisites":["a"]}]})",
           R"({"nodes":[{"id":"a","label":"A2","color":"gold"}]})",
           R"({"nodes":[{"id":"a","label":"A2","color":"gold"}],"tombstone":["c"]})",
           R"({"prerequisiteMode":"replace","nodes":[{"id":"b","label":"B","prerequisites":[]}]})",
           R"({"kinds":[{"id":"owner","hue":"gold","label":"Captain"}],"nodes":[{"id":"a","label":"A2","color":"gold"}]})",
           R"({"nodes":[{"id":"c","label":"C"}]})"}) {
    const Json::Value receipt = body(h.call("import_subgraph", parse(change)));
    ++seq;
    CHECK_EQ(receipt["seq"].asInt(), seq);
    CHECK_FALSE(receipt.isMember("unchanged"));
    CHECK_EQ(h.ops.byTree["t"].size(), static_cast<std::size_t>(seq));
  }
  CHECK_EQ(body(h.call("get_tree", parse(R"({"fields":["id","label","prerequisites"],"includeGuides":false})")))["tree"]
               ["nodes"],
           parse(R"([{"id":"a","label":"A2","prerequisites":[]},{"id":"b","label":"B","prerequisites":[]},
             {"id":"c","label":"C","prerequisites":[]}])"));
  CHECK_EQ(body(h.call("get_tree", parse(R"({"includeGuides":false})")))["tree"]["kinds"],
           parse(R"([{"id":"owner","hue":"gold","label":"Captain"}])"));
}

// `unchanged` speaks for the graft only: progress carried beside an unchanged graft is applied and reported as ever.
TEST(mcp_an_import_whose_graft_changes_nothing_still_applies_its_progress) {
  Harness h;
  CHECK_FALSE(h.call("import_subgraph", parse(R"({"nodes":[{"id":"a","label":"A"},{"id":"b","label":"B",
    "prerequisites":["a"]}]})")).isError);

  CHECK_EQ(body(h.call("import_subgraph", parse(R"({"nodes":[{"id":"a","label":"A"}],
    "progress":[{"nodeId":"a","status":"complete"}]})"))),
           parse(R"({"nodes":1,"edges":0,"kinds":0,"nodeCollisions":["a"],"kindCollisions":[],"newNodes":0,
             "newKinds":0,"prerequisiteMode":"merge","keptEdges":[],"keptEdgeCount":0,"tombstoned":{"nodes":0,"edges":0},
             "graphApplied":true,"progressApplied":true,"imported":true,"seq":1,"unchanged":true,
             "diagnosticsClean":true,"introducedDiagnostics":[],
             "progress":[{"nodeId":"a","status":"complete","prerequisitesMet":true}]})"));
  CHECK_EQ(body(h.call("get_progress", Json::Value(Json::objectValue))), parse(R"({"completed":["a"],"outOfOrder":[]})"));
}

// Under replace, a node sent without `prerequisites` keeps every edge into it, in the dry run and for real, and a
// re-send that changes nothing else is unchanged; `[]` clears them, a list keeps exactly what it names, and a node
// brought back from a delete without the key comes back with its edges.
TEST(mcp_import_subgraph_under_replace_keeps_the_edges_of_a_node_sent_without_prerequisites) {
  Harness h;
  CHECK_FALSE(h.call("import_subgraph", parse(R"({"nodes":[{"id":"a","label":"A"},{"id":"b","label":"B"},
    {"id":"c","label":"C","prerequisites":["a","b"]}]})")).isError);
  const auto prerequisitesOfC = [&] {
    return body(h.call("get_nodes", parse(R"({"nodeIds":["c"],"fields":["label","prerequisites"]})")))["nodes"][0];
  };

  const std::string kept = R"("nodes":1,"edges":0,"kinds":0,"nodeCollisions":["c"],"kindCollisions":[],"newNodes":0,
    "newKinds":0,"prerequisiteMode":"replace","keptEdges":[{"from":"a","to":"c"},{"from":"b","to":"c"}],
    "keptEdgeCount":2,"removedEdges":0,"tombstoned":{"nodes":0,"edges":0})";
  CHECK_EQ(body(h.call("import_subgraph", parse(R"({"dryRun":true,"prerequisiteMode":"replace",
    "nodes":[{"id":"c","label":"C2"}]})"))),
           parse("{" + kept + R"(,"dryRun":true,"tombstone":[]})"));
  CHECK_EQ(body(h.call("import_subgraph", parse(R"({"prerequisiteMode":"replace","nodes":[{"id":"c","label":"C2"}]})"))),
           parse("{" + kept + R"(,"graphApplied":true,"progressApplied":true,"imported":true,"seq":2,
             "diagnosticsClean":true,"introducedDiagnostics":[]})"));
  CHECK_EQ(prerequisitesOfC(), parse(R"({"label":"C2","prerequisites":["a","b"]})"));
  CHECK_EQ(body(h.call("import_subgraph", parse(R"({"prerequisiteMode":"replace","nodes":[{"id":"c","label":"C2"}]})"))),
           parse("{" + kept + R"(,"graphApplied":true,"progressApplied":true,"imported":true,"seq":2,"unchanged":true,
             "diagnosticsClean":true,"introducedDiagnostics":[]})"));

  const Json::Value cleared =
      body(h.call("import_subgraph", parse(R"({"prerequisiteMode":"replace","nodes":[{"id":"c","prerequisites":[]}]})")));
  CHECK_EQ(cleared["removedEdges"].asUInt64(), 2u);
  CHECK_EQ(prerequisitesOfC(), parse(R"({"label":"C2","prerequisites":[]})"));
  CHECK_FALSE(h.call("import_subgraph", parse(R"({"nodes":[{"id":"c","prerequisites":["a","b"]}]})")).isError);
  CHECK_EQ(body(h.call("import_subgraph", parse(R"({"prerequisiteMode":"replace",
    "nodes":[{"id":"c","prerequisites":["a"]}]})")))["removedEdges"].asUInt64(), 1u);
  CHECK_EQ(prerequisitesOfC(), parse(R"({"label":"C2","prerequisites":["a"]})"));

  CHECK_FALSE(h.call("delete_node", parse(R"({"nodeId":"c"})")).isError);
  CHECK_FALSE(h.call("import_subgraph", parse(R"({"prerequisiteMode":"replace","nodes":[{"id":"c","label":"C3"}]})")).isError);
  CHECK_EQ(prerequisitesOfC(), parse(R"({"label":"C3","prerequisites":["a"]})"));
}

// import_subgraph takes `expectedSeq` as update_nodes and change_edges do: a stale one refuses the whole call before
// anything lands — graft, tombstones and carried progress — in their words and outcome, a dry run included; the
// current one lands; the schema is theirs.
TEST(mcp_import_subgraph_takes_expected_seq_like_the_other_batch_tools) {
  Harness h;
  CHECK_FALSE(h.call("import_subgraph", parse(R"({"nodes":[{"id":"a","label":"A"},{"id":"b","label":"B"}]})")).isError);
  CHECK_FALSE(h.call("update_nodes", asUpdate(parse(R"({"nodeId":"a","label":"Named by a person"})"))).isError);
  const StoredTree stored = h.trees.byId["t"];
  const std::size_t rows = h.ops.byTree["t"].size();
  CompositeToolHost gate(std::vector<ToolModule>{{h.tools, ""}});
  std::vector<WriteCompletion> completions;
  installWriteSink([&](const WriteCompletion& completion) { completions.push_back(completion); });
  const auto call = [&](const char* arguments) {
    Json::Value args = parse(arguments);
    args["treeId"] = "t";
    return gate.callTool("roadmap_import_subgraph", args, h.actor);
  };

  const std::string stale = "import_subgraph: expectedSeq conflict: requested 1, current seq is 2. Nothing changed; "
                            "read get_nodes or get_tree and retry with the current seq.";
  CHECK_EQ(message(call(R"({"expectedSeq":1,"nodes":[{"id":"a","label":"Agent"}],"tombstone":["b"],
    "progress":[{"nodeId":"a","status":"complete"}]})")), stale);
  CHECK_EQ(message(call(R"({"expectedSeq":1,"dryRun":true,"nodes":[{"id":"a","label":"Agent"}]})")), stale);
  CHECK_EQ(message(call(R"({"expectedSeq":-1,"nodes":[{"id":"a","label":"Agent"}]})")),
           std::string("import_subgraph: expectedSeq must be a non-negative integer from get_tree or get_nodes"));
  CHECK(h.trees.byId["t"] == stored);
  CHECK_EQ(h.ops.byTree["t"].size(), rows);
  CHECK_EQ(body(h.call("get_progress", Json::Value(Json::objectValue))), parse(R"({"completed":[],"outOfOrder":[]})"));

  CHECK_EQ(body(call(R"({"expectedSeq":2,"nodes":[{"id":"a","label":"Agent"}]})"))["seq"].asInt(), 3);
  installWriteSink({});
  std::vector<std::string> observed;
  for (const WriteCompletion& completion : completions) observed.push_back(completion.outcome);
  CHECK_EQ(observed, (std::vector<std::string>{"refused", "refused", "refused", "ok"}));

  const Json::Value catalog = h.tools.listTools(h.actor);
  std::map<std::string, Json::Value> expectedSeqOf;
  for (const Json::Value& tool : catalog)
    if (tool["inputSchema"]["properties"].isMember("expectedSeq"))
      expectedSeqOf[tool["name"].asString()] = tool["inputSchema"]["properties"]["expectedSeq"];
  REQUIRE_EQ(expectedSeqOf.size(), 3u);
  CHECK_EQ(expectedSeqOf.at("import_subgraph"), expectedSeqOf.at("update_nodes"));
  CHECK_EQ(expectedSeqOf.at("import_subgraph"), expectedSeqOf.at("change_edges"));
}

// An update_nodes whose rows change nothing, and a change_edges that adds only held edges and removes only absent ones,
// answer `unchanged: true` beside their usual keys, on the dry run and for real; a batch that changes anything does not.
TEST(mcp_a_batch_that_changes_nothing_says_unchanged) {
  Harness h;
  CHECK_FALSE(h.call("import_subgraph", parse(R"({"nodes":[{"id":"a","label":"A"},{"id":"b","label":"B",
    "prerequisites":["a"]}]})")).isError);

  for (const char* dryRun : {"true", "false"}) {
    const std::string tail = std::string(R"("dryRun":)") + dryRun + R"(,"applied":)" +
                             (std::string(dryRun) == "true" ? "false" : "true") + R"(,"seq":1)" +
                             (std::string(dryRun) == "true" ? "" : R"(,"diagnosticsClean":true,"introducedDiagnostics":[])") +
                             R"(,"unchanged":true})";
    CHECK_EQ(body(h.call("update_nodes", parse(std::string(R"({"dryRun":)") + dryRun +
                                                 R"(,"updates":[{"nodeId":"a","label":"A"}]})"))),
             parse(R"({"treeId":"t","changedNodeIds":[],"unchangedNodeIds":["a"],)" + tail));
    CHECK_EQ(body(h.call("change_edges", parse(std::string(R"({"dryRun":)") + dryRun +
                                                  R"(,"add":[{"from":"a","to":"b"}],"remove":[{"from":"b","to":"a"}]})"))),
             parse(R"({"treeId":"t","addedEdges":[],"removedEdges":[],"unchangedEdges":2,)" + tail));
  }
  CHECK_EQ(h.ops.byTree["t"].size(), 1u);

  CHECK_FALSE(body(h.call("update_nodes", parse(R"({"updates":[{"nodeId":"a","label":"A2"}]})"))).isMember("unchanged"));
  CHECK_FALSE(body(h.call("change_edges", parse(R"({"remove":[{"from":"a","to":"b"}]})"))).isMember("unchanged"));
  CHECK_EQ(h.ops.byTree["t"].size(), 3u);

  const Json::Value catalog = h.tools.listTools(h.actor);
  for (const Json::Value& tool : catalog)
    if (tool["name"].asString() == "update_nodes" || tool["name"].asString() == "change_edges")
      CHECK_EQ(tool["outputSchema"]["properties"]["unchanged"]["type"].asString(), std::string("boolean"));
}

// update_tree takes a `title` beside its `guide`: each lands only when sent, both together land as one
// frame or not at all, by rename's own title rule, and an open page sees the new title in the frame the tree broadcasts.
TEST(mcp_update_tree_renames_the_tree_and_sets_its_guide_in_one_step) {
  Harness h;
  CHECK_FALSE(h.call("create_node", node("a", "A")).isError);
  const std::size_t rows = h.ops.byTree["t"].size();
  const auto title = [&] { return body(h.call("get_tree", parse(R"({"includeGuides":false})")))["tree"]["title"]; };

  CHECK_EQ(body(h.call("update_tree", with("title", "  Autumn plans  "))), parse(R"({"applied":true,"seq":2})"));
  CHECK_EQ(title(), Json::Value("Autumn plans"));
  CHECK_EQ(body(h.call("list_trees", Json::Value(Json::objectValue)))["trees"][0]["title"], Json::Value("Autumn plans"));
  REQUIRE(h.bus.subgraphBroadcasts.back().subgraph.title.has_value());
  CHECK_EQ(h.bus.subgraphBroadcasts.back().subgraph.title->value, std::string("Autumn plans"));
  CHECK_FALSE(h.bus.subgraphBroadcasts.back().subgraph.guide.has_value());

  const std::size_t frames = h.bus.subgraphBroadcasts.size();
  CHECK_EQ(body(h.call("update_tree", with("title", "Autumn plans"))), parse(R"({"applied":true,"seq":2,"unchanged":true})"));
  CHECK_EQ(h.bus.subgraphBroadcasts.size(), frames);

  CHECK_EQ(body(h.call("update_tree", parse(R"({"title":"Winter plans","guide":"Rig first."})"))),
           parse(R"({"applied":true,"seq":3})"));
  CHECK_EQ(h.bus.subgraphBroadcasts.size(), frames + 1);
  CHECK_EQ(h.bus.subgraphBroadcasts.back().subgraph.title->value, std::string("Winter plans"));
  CHECK_EQ(h.bus.subgraphBroadcasts.back().subgraph.guide->value, std::string("Rig first."));
  CHECK_EQ(body(h.call("update_tree", with("guide", "Rig first."))), parse(R"({"applied":true,"seq":4})"));
  CHECK_EQ(body(h.call("update_tree", with("title", std::string(201, 'x').c_str()))), parse(R"({"applied":true,"seq":5})"));
  CHECK_EQ(title(), Json::Value(std::string(200, 'x')));
  CHECK_EQ(body(h.call("update_tree", with("title", "Winter plans"))), parse(R"({"applied":true,"seq":6})"));
  CHECK_EQ(h.ops.byTree["t"].size(), rows);

  const StoredTree stored = h.trees.byId["t"];
  Json::Value number(Json::objectValue);
  number["title"] = 7;
  Json::Value overGuide = parse(R"({"title":"Spring plans"})");
  overGuide["guide"] = std::string(5001, 'g');
  for (const auto& [arguments, refusal] : std::vector<std::pair<Json::Value, std::string>>{
           {with("title", ""), "update_tree: a tree always has a name"},
           {with("title", "  \t\n "), "update_tree: a tree always has a name"},
           {number, "update_tree: argument \"title\" must be a string, got number"},
           {Json::Value(Json::objectValue), "update_tree: nothing to set — pass at least one of \"title\", \"guide\"."},
           {overGuide, "update_tree: guide is 5001 characters, 1 over the 5000 cap"}})
    CHECK_EQ(message(h.call("update_tree", arguments)), refusal);
  CHECK(h.trees.byId["t"] == stored);

  h.trees.byId["t_theirs"] = StoredTree{LooseGraph().exportState(), LegendState{}, {"Their plans", {}}, 0,
                                        uid("someone-else"), Visibility::public_};
  Json::Value theirs = with("title", "Mine now");
  theirs["treeId"] = "t_theirs";
  CHECK_EQ(message(h.tools.callTool("update_tree", theirs, h.actor)),
           ("update_tree: this tree belongs to another account. Call list_trees to see the roadmaps you "
                       "own."));
  CHECK_EQ(h.trees.byId["t_theirs"].title.value, std::string("Their plans"));

  CompositeToolHost gate(std::vector<ToolModule>{{h.tools, ""}});
  std::vector<WriteCompletion> lines;
  installWriteSink([&](const WriteCompletion& line) { lines.push_back(line); });
  Json::Value secret = with("title", "Private compass title");
  secret["treeId"] = "t";
  CHECK_FALSE(gate.callTool("roadmap_update_tree", secret, h.actor).isError);
  installWriteSink({});
  REQUIRE_EQ(lines.size(), 1u);
  CHECK_EQ(lines[0].outcome, std::string("ok"));
  CHECK_EQ(writeCompletionJson(lines[0]).find("compass"), std::string::npos);
}

// Every title refusal is worded once, in TreeRegistry::sentenceOf, on both doors.
TEST(mcp_update_tree_refuses_a_title_in_the_words_rest_uses) {
  Harness h;
  CHECK_EQ(message(h.call("update_tree", with("title", "cut \xE2\x82"))),
           "update_tree: " + std::string(TreeRegistry::sentenceOf(TreeRegistry::Renaming::malformedTitle)));
  CHECK_EQ(message(h.call("update_tree", with("title", " "))),
           "update_tree: " + std::string(TreeRegistry::sentenceOf(TreeRegistry::Renaming::blankTitle)));
}

// A guide is written whenever it is sent, even as the tree holds it: that is how a fork's owner makes an inherited
// guide theirs. A title equal to the one the tree has is not written.
TEST(mcp_update_tree_writes_a_guide_sent_as_held_so_a_forks_owner_makes_it_theirs) {
  Harness h;
  ForkService forks{h.registry, h.trees, h.tokens, h.clock};
  h.trees.byId["t"].visibility = Visibility::public_;
  CHECK_FALSE(h.call("update_tree", with("guide", "Rig first, then sail.")).isError);
  const UserId stranger = uid("stranger");
  REQUIRE(forks.fork(TreeId{"t"}, "t_theirs", "", stranger).outcome == ForkService::Outcome::forked);
  const auto call = [&](const char* tool, Json::Value args) {
    args["treeId"] = "t_theirs";
    return body(h.tools.callTool(tool, args, ToolCaller{stranger, ToolScope::everything()}));
  };
  const Json::Value before = call("get_tree", parse(R"({"includeGuides":false})"));
  CHECK_EQ(before["tree"]["guide"], parse(R"({"text":"Rig first, then sail.","yours":false})"));
  const int seq = before["seq"].asInt();

  CHECK_EQ(call("update_tree", with("guide", "Rig first, then sail.")),
           parse("{\"applied\":true,\"seq\":" + std::to_string(seq + 1) + "}"));
  CHECK_EQ(call("get_tree", parse(R"({"includeGuides":false})"))["tree"]["guide"],
           parse(R"({"text":"Rig first, then sail.","yours":true})"));
  const std::string title = before["tree"]["title"].asString();
  CHECK_EQ(call("update_tree", with("title", title.c_str())),
           parse("{\"applied\":true,\"seq\":" + std::to_string(seq + 1) + ",\"unchanged\":true}"));
}

// An annotation write lands only the fields that differ from what the node holds, through every door: the frame and
// the op row carry the description alone, and a client's icon stamped before the write and joined after it wins.
TEST(mcp_an_annotation_lands_only_the_fields_that_differ_through_every_door) {
  for (const auto& [tool, arguments] : std::vector<std::pair<const char*, const char*>>{
           {"update_nodes", R"({"updates":[{"nodeId":"a","icon":"star","description":"new"}]})"},
           {"import_subgraph", R"({"nodes":[{"id":"a","icon":"star","description":"new"}]})"}}) {
    Harness h;
    CHECK_FALSE(h.call("create_node", parse(R"({"id":"a","label":"A","icon":"star","description":"old"})")).isError);
    TreeRoom& room = *h.registry.open(TreeId{"t"});
    Hlc held;
    for (const NodeStateEntry& node : room.exportState().nodes)
      if (node.id == NodeId{"a"}) held = node.iconAt;

    CHECK_FALSE(h.call(tool, parse(arguments)).isError);
    const GraphState& frame = h.bus.subgraphBroadcasts.back().subgraph.graph;
    REQUIRE_EQ(frame.nodes.size(), 1u);
    CHECK(frame.nodes[0].descriptionAt.isSet());
    CHECK_FALSE(frame.nodes[0].iconAt.isSet());
    CHECK_EQ(commandPayload(h.ops.byTree["t"].back().command), parse(R"({"id":"a","description":"new"})"));

    Subgraph client;
    client.treeId = TreeId{"t"};
    client.frameId = std::string("client-icon-") + tool;
    client.actor = "r_client";
    client.intent = SubgraphIntent::live;
    client.graph.nodes.push_back(
        NodeStateEntry{.id = NodeId{"a"}, .icon = "anchor", .iconAt = Hlc{held.physicalMs, held.counter + 1, "r_client"}});
    REQUIRE(room.joinSubgraph(client, h.caller).has_value());
    CHECK_EQ(body(h.call("get_nodes", parse(R"({"nodeIds":["a"],"fields":["icon","description"]})")))["nodes"],
             parse(R"([{"icon":"anchor","description":"new"}])"));
  }
}

// An import that changes a held kind's hue repaints every node wearing the old hue, as a re-hue does, in the
// graft's frame: the receipt counts them and the dry run previews the count.
TEST(mcp_an_import_that_rehues_a_kind_repaints_the_nodes_that_wore_its_hue) {
  Harness h;
  CHECK_FALSE(h.call("add_kind", parse(R"({"id":"backend","hue":"sky"})")).isError);
  CHECK_FALSE(h.call("create_node", parse(R"({"id":"a","label":"A","color":"sky"})")).isError);
  CHECK_FALSE(h.call("create_node", parse(R"({"id":"old","label":"Old","kind":"backend"})")).isError);
  const auto nodesOf = [&](const char* ids) {
    return body(h.call("get_nodes", parse(std::string(R"({"fields":["id","color","kind"],"nodeIds":)") + ids + "}")))["nodes"];
  };

  const Json::Value preview =
      body(h.call("import_subgraph", parse(R"({"dryRun":true,"kinds":[{"id":"backend","hue":"plum"}],"nodes":[]})")));
  CHECK_EQ(preview["repaintedNodes"].asUInt64(), 2u);
  CHECK_EQ(nodesOf(R"(["a","old"])"), parse(R"([{"id":"a","color":"sky","kind":"backend"},
    {"id":"old","color":"sky","kind":"backend"}])"));

  const Json::Value landed = body(h.call("import_subgraph", parse(R"({"kinds":[{"id":"backend","hue":"plum"}],
    "nodes":[{"id":"fresh","label":"Fresh","kind":"backend"}]})")));
  CHECK_EQ(landed["repaintedNodes"].asUInt64(), 2u);
  CHECK_EQ(nodesOf(R"(["a","old","fresh"])"), parse(R"([{"id":"a","color":"plum","kind":"backend"},
    {"id":"old","color":"plum","kind":"backend"},{"id":"fresh","color":"plum","kind":"backend"}])"));

  CHECK_FALSE(body(h.call("import_subgraph", parse(R"({"kinds":[{"id":"backend","hue":"plum"}],"nodes":[]})")))
                  .isMember("repaintedNodes"));
  CHECK_FALSE(h.call("import_subgraph", parse(R"({"kinds":[{"id":"backend","hue":"olive"}],"nodes":[]})")).isError);
  CHECK_EQ(commandKind(h.ops.byTree["t"].back().command), std::string("RecolorKind"));
  CHECK_EQ(commandPayload(h.ops.byTree["t"].back().command), parse(R"({"id":"backend","hue":"olive"})"));
  CHECK_EQ(nodesOf(R"(["a","old","fresh"])"), parse(R"([{"id":"a","color":"olive","kind":"backend"},
    {"id":"old","color":"olive","kind":"backend"},{"id":"fresh","color":"olive","kind":"backend"}])"));
}

// The repaint reads the legend and the nodes as they stood before the batch, so a swap swaps; a node the batch gives
// its own colour or kind lands what the batch says, and a deleted node or one the batch tombstones is left alone.
TEST(mcp_an_import_repaints_against_the_legend_before_the_batch_and_yields_to_its_word) {
  Harness h;
  for (const char* kind : {R"({"id":"apps","hue":"sky"})", R"({"id":"infra","hue":"plum"})", R"({"id":"ops","hue":"gold"})"})
    CHECK_FALSE(h.call("add_kind", parse(kind)).isError);
  for (const char* node : {R"({"id":"s1","label":"S1","color":"sky"})", R"({"id":"s2","label":"S2","color":"sky"})",
                           R"({"id":"s3","label":"S3","color":"sky"})", R"({"id":"p1","label":"P1","color":"plum"})",
                           R"({"id":"gone","label":"Gone","color":"sky"})", R"({"id":"cut","label":"Cut","color":"sky"})"})
    CHECK_FALSE(h.call("create_node", parse(node)).isError);
  CHECK_FALSE(h.call("delete_node", parse(R"({"nodeId":"gone"})")).isError);

  const Json::Value receipt = body(h.call("import_subgraph", parse(R"({"kinds":[{"id":"apps","hue":"plum"},
    {"id":"infra","hue":"sky"}],"nodes":[{"id":"s2","color":"gold"},{"id":"s3","kind":"ops"}],"tombstone":["cut"]})")));
  CHECK_EQ(receipt["repaintedNodes"].asUInt64(), 2u);
  CHECK_EQ(body(h.call("get_nodes", parse(R"({"nodeIds":["s1","s2","s3","p1"],"fields":["id","color","kind"]})")))["nodes"],
           parse(R"([{"id":"s1","color":"plum","kind":"apps"},{"id":"s2","color":"gold","kind":"ops"},
             {"id":"s3","color":"gold","kind":"ops"},{"id":"p1","color":"sky","kind":"infra"}])"));
  for (const NodeStateEntry& node : h.registry.open(TreeId{"t"})->exportState().nodes)
    if (node.id == NodeId{"gone"} || node.id == NodeId{"cut"}) CHECK(node.color == NodeColor::sky);
}

// A node is the batch's word only when the colour the batch lands for it differs from the one it holds: a get_tree
// round trip that re-hues a kind repaints every wearer, a colour sent as held is repainted, a third hue stays the
// batch's, and the new hue sent as a colour or by the re-hued kind ends on the new hue either way.
TEST(mcp_an_import_round_trip_that_rehues_a_kind_repaints_every_wearer) {
  const auto seeded = [] {
    auto h = std::make_unique<Harness>();
    CHECK_FALSE(h->call("add_kind", parse(R"({"id":"k","hue":"sky"})")).isError);
    CHECK_FALSE(h->call("import_subgraph", parse(R"({"nodes":[{"id":"a","label":"A","color":"sky"},
      {"id":"b","label":"B","color":"sky"},{"id":"c","label":"C","color":"sky"},{"id":"d","label":"D","color":"sky"},
      {"id":"e","label":"E","color":"gold"}]})")).isError);
    return h;
  };
  const auto colours = [](Harness& h) {
    return body(h.call("get_nodes", parse(R"({"nodeIds":["a","b","c","d","e"],"fields":["id","color"]})")))["nodes"];
  };

  auto round = seeded();
  Json::Value batch = body(round->call("get_tree", parse(R"({"includeGuides":false})")))["tree"];
  batch.removeMember("guide");
  batch.removeMember("id");
  batch.removeMember("title");
  batch.removeMember("url");
  for (Json::Value& kind : batch["kinds"]) kind["hue"] = "plum";
  Json::Value preview = batch;
  preview["dryRun"] = true;
  CHECK_EQ(body(round->call("import_subgraph", preview))["repaintedNodes"].asUInt64(), 4u);
  CHECK_EQ(body(round->call("import_subgraph", batch))["repaintedNodes"].asUInt64(), 4u);
  CHECK_EQ(colours(*round), parse(R"([{"id":"a","color":"plum"},{"id":"b","color":"plum"},{"id":"c","color":"plum"},
    {"id":"d","color":"plum"},{"id":"e","color":"gold"}])"));

  auto sent = seeded();
  const Json::Value receipt = body(sent->call("import_subgraph", parse(R"({"kinds":[{"id":"k","hue":"plum"}],
    "nodes":[{"id":"a","color":"sky"},{"id":"b","color":"olive"},{"id":"c","color":"plum"},{"id":"d","kind":"k"}]})")));
  CHECK_EQ(receipt["repaintedNodes"].asUInt64(), 1u);
  CHECK_EQ(colours(*sent), parse(R"([{"id":"a","color":"plum"},{"id":"b","color":"olive"},{"id":"c","color":"plum"},
    {"id":"d","color":"plum"},{"id":"e","color":"gold"}])"));
}

// A node the batch files by `kind` is the batch's word whatever it wore: it lands the hue that kind wears after the
// batch and is never repainted, even when that hue is the one it holds — a swap, or a new kind on the hue a re-hue
// frees. repaintedNodes counts only the nodes the repaint moved, and a round trip read with `kind` lands every wearer
// on the new hue by the batch's own word.
TEST(mcp_an_import_that_files_a_node_by_kind_beside_a_rehue_lands_the_kind_it_names) {
  const auto seeded = [] {
    auto h = std::make_unique<Harness>();
    CHECK_FALSE(h->call("add_kind", parse(R"({"id":"k","hue":"sky"})")).isError);
    CHECK_FALSE(h->call("add_kind", parse(R"({"id":"j","hue":"plum"})")).isError);
    CHECK_FALSE(h->call("import_subgraph", parse(R"({"nodes":[{"id":"a","label":"A","color":"sky"},
      {"id":"b","label":"B","color":"sky"},{"id":"c","label":"C","color":"plum"}]})")).isError);
    return h;
  };
  const auto filed = [](Harness& h) {
    return body(h.call("get_nodes", parse(R"({"nodeIds":["a","b","c"],"fields":["id","color","kind"]})")))["nodes"];
  };

  auto swap = seeded();
  CHECK_EQ(body(swap->call("import_subgraph", parse(R"({"kinds":[{"id":"k","hue":"plum"},{"id":"j","hue":"sky"}],
    "nodes":[{"id":"a","kind":"j"}]})")))["repaintedNodes"].asUInt64(), 2u);
  CHECK_EQ(filed(*swap), parse(R"([{"id":"a","color":"sky","kind":"j"},{"id":"b","color":"plum","kind":"k"},
    {"id":"c","color":"sky","kind":"j"}])"));

  auto freed = seeded();
  CHECK_EQ(body(freed->call("import_subgraph", parse(R"({"kinds":[{"id":"k","hue":"olive"},{"id":"m","hue":"sky"}],
    "nodes":[{"id":"a","kind":"m"}]})")))["repaintedNodes"].asUInt64(), 1u);
  CHECK_EQ(filed(*freed), parse(R"([{"id":"a","color":"sky","kind":"m"},{"id":"b","color":"olive","kind":"k"},
    {"id":"c","color":"plum","kind":"j"}])"));

  auto round = seeded();
  Json::Value batch =
      body(round->call("get_tree", parse(R"({"includeGuides":false,"fields":["id","label","kind"]})")))["tree"];
  batch.removeMember("guide");
  batch.removeMember("id");
  batch.removeMember("title");
  batch.removeMember("url");
  for (Json::Value& kind : batch["kinds"])
    if (kind["id"] == "k") kind["hue"] = "olive";
  CHECK_EQ(body(round->call("import_subgraph", batch))["repaintedNodes"].asUInt64(), 0u);
  CHECK_EQ(filed(*round), parse(R"([{"id":"a","color":"olive","kind":"k"},{"id":"b","color":"olive","kind":"k"},
    {"id":"c","color":"plum","kind":"j"}])"));
}

// A link a node holds is one a person can open: every door that writes links trims a url's surrounding whitespace and
// refuses one that does not start with http:, https: or mailto:, naming it by its path, with nothing applied.
TEST(mcp_every_door_that_writes_links_takes_only_urls_a_person_can_open) {
  Harness h;
  CHECK_FALSE(h.call("create_node", parse(R"({"id":"a","label":"A","links":[{"url":"https://a.example/"}]})")).isError);
  const StoredTree stored = h.trees.byId["t"];
  const std::size_t rows = h.ops.byTree["t"].size();
  const auto with = [](const char* arguments, const char* url) {
    Json::Value args = parse(arguments);
    for (const char* list : {"links", "addLinks", "updates", "nodes"}) {
      if (!args.isMember(list)) continue;
      Json::Value& row = args[list][args[list].size() - 1];
      Json::Value& links = std::string(list) == "updates" || std::string(list) == "nodes"
                               ? (row.isMember("links") ? row["links"] : row["addLinks"]) : args[list];
      links[1]["url"] = url;
    }
    return args;
  };
  for (const char* url : {"javascript:alert(1)", "data:text/html,hi", "vbscript:x", "example.com", "   "}) {
    for (const auto& [tool, arguments, path] : std::vector<std::tuple<std::string, const char*, std::string>>{
             {"create_node", R"({"id":"b","label":"B","links":[{"url":"https://ok.example"},{}]})", "links[1].url"},
             {"update_nodes", R"({"updates":[{"nodeId":"a","addLinks":[{"url":"https://ok.example"},{}]}]})",
              "updates[0].addLinks[1].url"},
             {"update_nodes", R"({"updates":[{"nodeId":"a","label":"A2","links":[{"url":"https://ok.example"},{}]}]})",
              "updates[0].links[1].url"},
             {"import_subgraph", R"({"nodes":[{"id":"a","label":"A2"},{"id":"c","label":"C",
                "links":[{"url":"https://ok.example"},{}]}]})", "nodes[1].links[1].url"}})
      CHECK_EQ(message(h.call(tool.c_str(), with(arguments, url))),
               tool + ": " + path + " must start with http:, https: or mailto:, the links a person can open");
  }
  CHECK(h.trees.byId["t"] == stored);
  CHECK_EQ(h.ops.byTree["t"].size(), rows);

  CHECK_FALSE(h.call("create_node", parse(R"({"id":"b","label":"B","links":[{"url":" https://b.example/ "},
    {"url":"HTTPS://A.example"},{"url":"mailto:a@b.example"}]})")).isError);
  CHECK_FALSE(h.call("update_nodes", asUpdate(parse(R"({"nodeId":"a","addLinks":[{"url":"\thttps://a.example/ ","label":"A"}]})")))
                  .isError);
  CHECK_EQ(body(h.call("get_nodes", parse(R"({"nodeIds":["a"],"fields":["id","links"]})")))["nodes"],
           parse(R"([{"id":"a","links":[{"url":"https://a.example/","label":"A"}]}])"));
  CHECK_FALSE(h.call("update_nodes", parse(R"({"updates":[{"nodeId":"a","links":[{"url":" https://a.example/","label":"A"},
    {"url":"\nhttps://p.example "}]}]})")).isError);
  CHECK_FALSE(h.call("import_subgraph", parse(R"({"nodes":[{"id":"c","label":"C","links":[{"url":" https://c.example "}]}]})"))
                  .isError);
  CHECK_EQ(body(h.call("get_nodes", parse(R"({"nodeIds":["a","b","c"],"fields":["id","links"]})")))["nodes"],
           parse(R"([{"id":"a","links":[{"url":"https://a.example/","label":"A"},{"url":"https://p.example"}]},
             {"id":"b","links":[{"url":"https://b.example/"},{"url":"HTTPS://A.example"},{"url":"mailto:a@b.example"}]},
             {"id":"c","links":[{"url":"https://c.example"}]}])"));
}

// A link a node already holds is not the write's word: a tree holding a url the rule refuses, written before the rule or
// by a client frame, reads and sends back as held at every door that writes links, and only the urls a write brings
// are judged. A new node, or a new tree, holds nothing, so the same links are refused there, and nothing is applied.
TEST(mcp_create_node_on_a_deleted_nodes_id_holds_none_of_its_links) {
  Harness h;
  CHECK_FALSE(h.call("create_node", parse(R"({"id":"a","label":"A"})")).isError);
  AnnotateNode planted{NodeId{"a"}};
  planted.links = std::vector<Link>{{.label = "J", .url = "javascript:alert(1)"}};
  h.registry.open(TreeId{"t"})->applyCommand(planted, h.clock.nowMs(), h.caller);
  CHECK_FALSE(h.call("delete_node", parse(R"({"nodeId":"a"})")).isError);
  const std::size_t rows = h.ops.byTree["t"].size();

  const std::string refused =
      "create_node: links[0].url must start with http:, https: or mailto:, the links a person can open";
  CHECK_EQ(message(h.call("create_node", parse(R"j({"id":"a","label":"A","links":["javascript:alert(1)"]})j"))),
           refused);
  CHECK_EQ(message(h.call("create_node", parse(R"j({"label":"A","links":["javascript:alert(1)"]})j"))), refused);
  CHECK_EQ(h.ops.byTree["t"].size(), rows);
  CHECK_FALSE(h.call("create_node", parse(R"j({"id":"a","label":"A","links":["https://ok.example/"]})j")).isError);
}

TEST(mcp_a_link_a_node_already_holds_is_sent_back_as_held_at_every_door) {
  Harness h;
  CHECK_FALSE(h.call("create_node", parse(R"({"id":"a","label":"A"})")).isError);
  AnnotateNode planted{NodeId{"a"}};
  planted.links =
      std::vector<Link>{{.label = "J", .url = "javascript:alert(1)"}, {.label = "", .url = "https://ok.example/"}};
  h.registry.open(TreeId{"t"})->applyCommand(planted, h.clock.nowMs(), h.caller);
  Json::Value document =
      body(h.call("get_tree", parse(R"({"includeGuides":false,"fields":["id","label","links"]})")))["tree"];
  for (const char* field : {"guide", "id", "title", "url"}) document.removeMember(field);
  const Json::Value held = document["nodes"][0]["links"];
  CHECK_EQ(held, parse(R"j([{"url":"javascript:alert(1)","label":"J"},{"url":"https://ok.example/"}])j"));

  Json::Value annotate = parse(R"({"nodeId":"a"})");
  annotate["links"] = held;
  Json::Value patch = parse(R"({"updates":[{"nodeId":"a"}]})");
  patch["updates"][0]["links"] = held;
  const Json::Value added = parse(R"j({"nodeId":"a","addLinks":[{"url":"javascript:alert(1)"}]})j");
  for (const auto& [tool, arguments] : std::vector<std::pair<const char*, Json::Value>>{
           {"import_subgraph", document}, {"update_nodes", asUpdate(annotate)}, {"update_nodes", patch},
           {"update_nodes", asUpdate(added)}})
    CHECK_EQ(body(h.call(tool, arguments))["unchanged"], Json::Value(true));

  const std::string rule = " must start with http:, https: or mailto:, the links a person can open";
  Json::Value more = held;
  more.append(parse(R"({"url":"data:text/html,x"})"));
  document["nodes"][0]["links"] = more;
  annotate["links"] = more;
  patch["updates"][0]["links"] = more;
  CHECK_EQ(message(h.call("import_subgraph", document)), "import_subgraph: nodes[0].links[2].url" + rule);
  CHECK_EQ(message(h.call("update_nodes", asUpdate(annotate))), std::string("update_nodes: updates[0].links[2].url must start with http:, https: or mailto:, the links a person can open"));
  CHECK_EQ(message(h.call("update_nodes", patch)), std::string("update_nodes: updates[0].links[2].url must start with http:, https: or mailto:, the links a person can open"));
  CHECK_EQ(message(h.call("update_nodes", asUpdate(parse(R"j({"nodeId":"a","addLinks":[{"url":" javascript:alert(1)"}]})j")))),
           std::string("update_nodes: updates[0].addLinks[0].url must start with http:, https: or mailto:, the links a person can open"));

  Json::Value created = parse(R"({"id":"b","label":"B"})");
  created["links"] = held;
  CHECK_EQ(message(h.call("create_node", created)), "create_node: links[0].url" + rule);
  h.plant("t_copy", h.caller, "", {});
  document["nodes"][0]["links"] = held;
  document["treeId"] = "t_copy";
  CHECK_EQ(message(h.tools.callTool("import_subgraph", document, ToolCaller{h.caller, ToolScope::everything()})),
           "import_subgraph: nodes[0].links[0].url" + rule);
  CHECK_EQ(body(h.call("get_nodes", parse(R"({"nodeIds":["a"],"fields":["id","links"]})")))["nodes"][0]["links"], held);
}

// A link's identity is its url trimmed: an addLinks url names the held link stored with whitespace around it, which
// keeps its place and holds the trimmed url from then on, the link a person can see, with no second entry.
TEST(mcp_add_links_names_a_held_link_by_its_trimmed_url) {
  Harness h;
  CHECK_FALSE(h.call("create_node", parse(R"({"id":"a","label":"A"})")).isError);
  AnnotateNode planted{NodeId{"a"}};
  planted.links =
      std::vector<Link>{{.label = "", .url = " https://a.example/"}, {.label = "", .url = "https://b.example/"}};
  h.registry.open(TreeId{"t"})->applyCommand(planted, h.clock.nowMs(), h.caller);
  CHECK_FALSE(h.call("update_nodes", asUpdate(parse(R"({"nodeId":"a","addLinks":[{"url":"https://a.example/","label":"A"}]})")))
                  .isError);
  CHECK_EQ(body(h.call("get_nodes", parse(R"({"nodeIds":["a"],"fields":["id","links"]})")))["nodes"],
           parse(R"([{"id":"a","links":[{"url":"https://a.example/","label":"A"},{"url":"https://b.example/"}]}])"));
}

// A batch edit that lands nothing takes no save, as a single-node edit and an import that land nothing take none, and
// answers as it always has; one that lands takes one save.
TEST(mcp_a_batch_edit_that_lands_nothing_takes_no_save) {
  Harness h;
  CHECK_FALSE(h.call("create_node", parse(R"({"id":"a","label":"A"})")).isError);
  const Json::Value created = body(h.call("create_node", parse(R"({"id":"b","label":"B","prerequisites":["a"]})")));
  const std::size_t saved = h.trees.savedNodeCounts.size();

  Json::Value patched = parse(R"({"treeId":"t","changedNodeIds":[],"unchangedNodeIds":["a"],"dryRun":false,
    "applied":true,"unchanged":true,"diagnosticsClean":true,"introducedDiagnostics":[]})");
  patched["seq"] = created["seq"];
  CHECK_EQ(body(h.call("update_nodes", parse(R"({"updates":[{"nodeId":"a","label":"A"}]})"))), patched);
  Json::Value edged = parse(R"({"treeId":"t","addedEdges":[],"removedEdges":[],"unchangedEdges":2,"dryRun":false,
    "applied":true,"unchanged":true,"diagnosticsClean":true,"introducedDiagnostics":[]})");
  edged["seq"] = created["seq"];
  CHECK_EQ(body(h.call("change_edges", parse(R"({"add":[{"from":"a","to":"b"}],"remove":[{"from":"b","to":"a"}]})"))),
           edged);
  CHECK_EQ(h.trees.savedNodeCounts.size(), saved);

  CHECK_FALSE(h.call("update_nodes", parse(R"({"updates":[{"nodeId":"a","label":"A2"}]})")).isError);
  CHECK_EQ(h.trees.savedNodeCounts.size(), saved + 1);
  CHECK_FALSE(h.call("change_edges", parse(R"({"remove":[{"from":"a","to":"b"}]})")).isError);
  CHECK_EQ(h.trees.savedNodeCounts.size(), saved + 2);
}

// A colour sent beside a kind that wears another hue is an echo when it is the colour the node holds, and the kind is
// the write's word: a read carrying both, sent back after the kind's re-hue, lands every node of that kind on its new
// hue, and so does an update_nodes row. A third colour, or a disagreeing pair on a node the tree does not
// hold, is refused as before, under kind-hue-mismatch.
TEST(mcp_a_colour_sent_as_held_beside_a_kind_is_an_echo_and_the_kind_lands) {
  const auto seeded = [] {
    auto h = std::make_unique<Harness>();
    CHECK_FALSE(h->call("add_kind", parse(R"({"id":"infra","hue":"olive"})")).isError);
    CHECK_FALSE(h->call("add_kind", parse(R"({"id":"apps","hue":"sky"})")).isError);
    CHECK_FALSE(h->call("import_subgraph", parse(R"({"nodes":[{"id":"a","label":"A","color":"olive"},
      {"id":"b","label":"B","color":"olive"},{"id":"c","label":"C","color":"sky"}]})")).isError);
    return h;
  };
  const auto fallen = [&] {  // a and b hold olive, which infra no longer wears
    auto h = seeded();
    CHECK_FALSE(h->call("update_kind", parse(R"({"id":"infra","hue":"terracotta"})")).isError);
    for (const char* id : {"a", "b"}) {
      Json::Value olive = parse(R"({"color":"olive"})");
      olive["nodeId"] = id;
      CHECK_FALSE(h->call("update_nodes", asUpdate(olive)).isError);
    }
    return h;
  };
  const auto filed = [](Harness& h) {
    return body(h.call("get_nodes", parse(R"({"nodeIds":["a","b","c"],"fields":["id","color","kind"]})")))["nodes"];
  };
  const Json::Value landed = parse(R"([{"id":"a","color":"terracotta","kind":"infra"},
    {"id":"b","color":"terracotta","kind":"infra"},{"id":"c","color":"sky","kind":"apps"}])");

  auto round = seeded();
  Json::Value document =
      body(round->call("get_tree", parse(R"({"includeGuides":false,"fields":["id","label","color","kind"]})")))["tree"];
  for (const char* field : {"guide", "id", "title", "url"}) document.removeMember(field);
  for (Json::Value& kind : document["kinds"])
    if (kind["id"] == "infra") kind["hue"] = "terracotta";
  const ToolResult imported = round->call("import_subgraph", document);
  REQUIRE(!imported.isError);
  CHECK_EQ(body(imported)["repaintedNodes"].asUInt64(), 0u);
  CHECK_EQ(filed(*round), landed);

  auto patched = fallen();
  CHECK_EQ(body(patched->call("update_nodes", parse(R"({"updates":[{"nodeId":"a","color":"olive","kind":"infra"},
    {"nodeId":"b","color":"olive","kind":"infra"}]})")))["changedNodeIds"], parse(R"(["a","b"])"));
  CHECK_EQ(filed(*patched), landed);

  auto refusing = fallen();
  CompositeToolHost gate(std::vector<ToolModule>{{refusing->tools, ""}});
  std::vector<std::string> outcomes;
  installWriteSink([&](const WriteCompletion& completion) { outcomes.push_back(completion.outcome); });
  const std::string agree = " — send one of the two, or both when they agree";
  for (const auto& [tool, arguments, sentence] : std::vector<std::tuple<const char*, const char*, std::string>>{
           {"import_subgraph", R"({"nodes":[{"id":"a","color":"gold","kind":"infra"}]})",
            "nodes[0].kind \"infra\" wears terracotta, but nodes[0].color is \"gold\"" + agree},
           {"update_nodes", R"({"updates":[{"nodeId":"a","color":"gold","kind":"infra"}]})",
            "updates[0].kind \"infra\" wears terracotta, but updates[0].color is \"gold\"" + agree},
           {"import_subgraph", R"({"nodes":[{"id":"n","label":"N","color":"olive","kind":"infra"}]})",
            "nodes[0].kind \"infra\" wears terracotta, but nodes[0].color is \"olive\"" + agree},
           {"create_node", R"({"id":"n","label":"N","color":"olive","kind":"infra"})",
            "kind \"infra\" wears terracotta, but color is \"olive\"" + agree}}) {
    Json::Value args = parse(arguments);
    args["treeId"] = "t";
    CHECK_EQ(message(gate.callTool(tool, args, refusing->actor)), std::string(tool) + ": " + sentence);
  }
  installWriteSink({});
  CHECK_EQ(outcomes, std::vector<std::string>(4, "kind-hue-mismatch"));
  CHECK_EQ(filed(*refusing), parse(R"([{"id":"a","color":"olive"},{"id":"b","color":"olive"},
    {"id":"c","color":"sky","kind":"apps"}])"));
}

// A progress row says when its mark changed nothing — the status sent is the one held and the outOfOrder word is the
// same — with `unchanged: true`, on update_nodes and on an import's progress rows; an update_nodes call whose every
// row is unchanged says so as a whole. A changed word is a change.
TEST(mcp_a_progress_mark_already_held_says_so_on_its_row) {
  Harness h;
  CHECK_FALSE(h.call("import_subgraph", parse(R"({"nodes":[{"id":"a","label":"A"},{"id":"b","label":"B",
    "prerequisites":["a"]}]})")).isError);
  CHECK_EQ(body(h.call("update_nodes", asUpdate(parse(R"({"nodeId":"a","status":"complete"})")))),
           parse(R"({"applied":true,"changedNodeIds":[],"diagnosticsClean":true,"dryRun":false,"introducedDiagnostics":[],"progress":[{"nodeId":"a","prerequisitesMet":true,"status":"complete"}],"seq":1,"treeId":"t","unchanged":true,"unchangedNodeIds":["a"]})"));
  CHECK_EQ(body(h.call("update_nodes", asUpdate(parse(R"({"nodeId":"a","status":"complete"})")))),
           parse(R"({"applied":true,"changedNodeIds":[],"diagnosticsClean":true,"dryRun":false,"introducedDiagnostics":[],"progress":[{"nodeId":"a","prerequisitesMet":true,"status":"complete","unchanged":true}],"seq":1,"treeId":"t","unchanged":true,"unchangedNodeIds":["a"]})"));
  CHECK_EQ(body(h.call("update_nodes", asUpdate(parse(R"({"nodeId":"b","status":"complete","outOfOrder":true})")))),
           parse(R"({"applied":true,"changedNodeIds":[],"diagnosticsClean":true,"dryRun":false,"introducedDiagnostics":[],"progress":[{"acknowledged":true,"nodeId":"b","prerequisitesMet":true,"status":"complete"}],"seq":1,"treeId":"t","unchanged":true,"unchangedNodeIds":["b"]})"));
  CHECK_EQ(body(h.call("update_nodes", asUpdate(parse(R"({"nodeId":"b","status":"complete"})")))),
           parse(R"({"applied":true,"changedNodeIds":[],"diagnosticsClean":true,"dryRun":false,"introducedDiagnostics":[],"progress":[{"nodeId":"b","prerequisitesMet":true,"status":"complete"}],"seq":1,"treeId":"t","unchanged":true,"unchangedNodeIds":["b"]})"));

  CHECK_EQ(body(h.call("update_nodes", parse(R"({"updates":[{"nodeId":"a","status":"complete"},
    {"nodeId":"b","status":"none"}]})"))),
           parse(R"({"applied":true,"changedNodeIds":[],"diagnosticsClean":true,"dryRun":false,"introducedDiagnostics":[],"progress":[{"nodeId":"a","prerequisitesMet":true,"status":"complete","unchanged":true},{"nodeId":"b","prerequisitesMet":true,"status":"none"}],"seq":1,"treeId":"t","unchanged":true,"unchangedNodeIds":["a","b"]})"));
  CHECK_EQ(body(h.call("update_nodes", parse(R"({"updates":[{"nodeId":"a","status":"complete"},
    {"nodeId":"b","status":"none"}]})"))),
           parse(R"({"applied":true,"changedNodeIds":[],"diagnosticsClean":true,"dryRun":false,"introducedDiagnostics":[],"progress":[{"nodeId":"a","prerequisitesMet":true,"status":"complete","unchanged":true},{"nodeId":"b","prerequisitesMet":true,"status":"none","unchanged":true}],"seq":1,"treeId":"t","unchanged":true,"unchangedNodeIds":["a","b"]})"));
  CHECK_EQ(body(h.call("import_subgraph", parse(R"({"nodes":[{"id":"a","label":"A"}],"progress":[
    {"nodeId":"a","status":"complete"},{"nodeId":"b","status":"complete"}]})")))["progress"],
           parse(R"([{"nodeId":"a","status":"complete","prerequisitesMet":true,"unchanged":true},
             {"nodeId":"b","status":"complete","prerequisitesMet":true}])"));
}

// Each progress row of an import is judged against the overlay as the rows before it in the same call leave it, so a row's word
// is true at its turn: a node completed and then cleared in one call changes twice, and a repeat of the row before it
// changes nothing. A call whose net effect is nothing — complete then clear on a node never marked — still wrote twice,
// so neither row nor the call says unchanged. A row that changes nothing is still stamped, and open pages receive it.
TEST(mcp_a_bulk_progress_row_is_judged_at_its_turn_in_the_batch) {
  Harness h;
  CHECK_FALSE(h.call("import_subgraph", parse(R"({"nodes":[{"id":"n0","label":"N0"},{"id":"n3","label":"N3"},
    {"id":"n","label":"N"},{"id":"c","label":"C"}]})")).isError);

  CHECK_EQ(body(h.call("import_subgraph", parse(R"({"nodes":[],"progress":[{"nodeId":"n0","status":"complete","outOfOrder":true},
    {"nodeId":"n3","status":"complete"},{"nodeId":"n0","status":"none"}]})")))["progress"],
           parse(R"([{"nodeId":"n0","status":"complete","prerequisitesMet":true,"acknowledged":true},
             {"nodeId":"n3","status":"complete","prerequisitesMet":true},
             {"nodeId":"n0","status":"none","prerequisitesMet":true}])"));
  CHECK_EQ(body(h.call("import_subgraph", parse(R"({"nodes":[],"progress":[{"nodeId":"n","status":"complete"},
    {"nodeId":"n","status":"complete"}]})")))["progress"],
           parse(R"([{"nodeId":"n","status":"complete","prerequisitesMet":true},
             {"nodeId":"n","status":"complete","prerequisitesMet":true,"unchanged":true}])"));
  CHECK_EQ(body(h.call("import_subgraph", parse(R"({"nodes":[],"progress":[{"nodeId":"c","status":"complete"},
    {"nodeId":"c","status":"none"}]})")))["progress"],
           parse(R"([{"nodeId":"c","status":"complete","prerequisitesMet":true},
             {"nodeId":"c","status":"none","prerequisitesMet":true}])"));

  const std::size_t frames = h.bus.progressBroadcasts.size();
  CHECK_EQ(body(h.call("update_nodes", asUpdate(parse(R"({"nodeId":"n","status":"complete"})"))))["progress"][0]["unchanged"],
           Json::Value(true));
  REQUIRE_EQ(h.bus.progressBroadcasts.size(), frames + 1);
  CHECK_EQ(h.bus.progressBroadcasts.back().marks.completed, (std::set<NodeId>{NodeId{"n"}}));
}

// A mark on such a node told its maker it did something; the door says what completes the node, names no tree, and
// writes nothing, a clear as much as a completion. A call of such marks alone is no error and completes as opens-a-tree.
TEST(mcp_an_update_nodes_mark_on_a_node_that_opens_a_tree_writes_nothing_complete_or_none) {
  Harness h;
  h.trees.byId["t_sub"] = StoredTree{LooseGraph().exportState(), LegendState{}, {"Deep dive", {}}, 0, h.caller};
  CHECK_FALSE(h.call("create_node", parse(R"({"id":"idea","label":"Idea"})")).isError);
  CHECK_FALSE(h.call("update_nodes", asUpdate(mark("idea", "complete"))).isError);
  CHECK_FALSE(h.call("update_nodes", asUpdate(parse(R"({"nodeId":"idea","opens":"t_sub"})"))).isError);
  const std::map<std::string, FakeProgressRepository::Entry> stored = h.progressRepo.byKey;
  const std::size_t broadcasts = h.bus.progressBroadcasts.size();
  CompositeToolHost gate(std::vector<ToolModule>{{h.tools, ""}});
  std::vector<WriteCompletion> completions;
  installWriteSink([&](const WriteCompletion& completion) { completions.push_back(completion); });

  for (const std::string status : {"complete", "none"}) {
    const ToolResult refused = gate.callTool(
        "roadmap_update_nodes", parse(R"({"treeId":"t","updates":[{"nodeId":"idea","status":")" + status + R"("}]})"),
        h.actor);
    CHECK_FALSE(refused.isError);
    CHECK_EQ(body(refused), parse(R"({"applied":true,"changedNodeIds":[],"diagnosticsClean":true,"dryRun":false,
      "introducedDiagnostics":[],"progress":[{"nodeId":"idea","refused":"\"idea\" opens a tree: it is complete when that tree is and takes no mark of its own — mark the steps of the tree it opens"}],
      "progressApplied":false,"progressError":"Some requested progress marks nodes that open a tree, which take no mark of their own — each is complete when the tree it opens is; those ids are listed in progressRefused.",
      "progressRefused":["idea"],"seq":2,"treeId":"t","unchanged":true,"unchangedNodeIds":["idea"]})"));
  }
  installWriteSink({});

  CHECK(h.progressRepo.byKey == stored);
  CHECK_EQ(stored.size(), 1u);
  CHECK_EQ(h.bus.progressBroadcasts.size(), broadcasts);
  std::vector<std::string> observed;
  for (const WriteCompletion& completion : completions) observed.push_back(completion.operation + " " + completion.outcome);
  CHECK_EQ(observed, (std::vector<std::string>{"mcp.roadmap_update_nodes opens-a-tree", "mcp.roadmap_update_nodes opens-a-tree"}));
}

// Each row answers for its own node in the call's order; the call's outcome says whether any mark was recorded.
TEST(mcp_a_batch_records_its_ordinary_marks_and_answers_a_refused_row_for_each_node_that_opens_a_tree) {
  Harness h;
  h.trees.byId["t_sub"] = StoredTree{LooseGraph().exportState(), LegendState{}, {"Deep dive", {}}, 0, h.caller};
  CHECK_FALSE(h.call("import_subgraph", parse(R"({"nodes":[{"id":"a","label":"A"},{"id":"idea","label":"Idea","opens":"t_sub"},
                                                            {"id":"b","label":"B","prerequisites":["a"]},
                                                            {"id":"deeper","label":"Deeper","opens":"t_sub"}]})")).isError);
  CompositeToolHost gate(std::vector<ToolModule>{{h.tools, ""}});
  std::vector<WriteCompletion> completions;
  installWriteSink([&](const WriteCompletion& completion) { completions.push_back(completion); });

  const ToolResult mixed = gate.callTool("roadmap_update_nodes", parse(R"({"treeId":"t","updates":[
      {"nodeId":"idea","status":"complete"},{"nodeId":"a","status":"complete"},
      {"nodeId":"deeper","status":"none"},{"nodeId":"b","status":"complete"}]})"), h.actor);
  const ToolResult everyRowRefused = gate.callTool("roadmap_update_nodes", parse(R"({"treeId":"t","updates":[
      {"nodeId":"deeper","status":"complete"},{"nodeId":"idea","status":"complete"}]})"), h.actor);
  installWriteSink({});

  CHECK_FALSE(mixed.isError);
  CHECK_EQ(body(mixed), parse(R"({"applied":true,"changedNodeIds":[],"diagnosticsClean":true,"dryRun":false,
      "introducedDiagnostics":[],"progress":[
      {"nodeId":"idea","refused":"\"idea\" opens a tree: it is complete when that tree is and takes no mark of its own — mark the steps of the tree it opens"},
      {"nodeId":"a","status":"complete","prerequisitesMet":true},
      {"nodeId":"deeper","refused":"\"deeper\" opens a tree: it is complete when that tree is and takes no mark of its own — mark the steps of the tree it opens"},
      {"nodeId":"b","status":"complete","prerequisitesMet":true}],
      "progressApplied":false,"progressError":"Some requested progress marks nodes that open a tree, which take no mark of their own — each is complete when the tree it opens is; those ids are listed in progressRefused.",
      "progressRefused":["idea","deeper"],"seq":1,"treeId":"t","unchanged":true,"unchangedNodeIds":["idea","a","deeper","b"]})"));
  CHECK_FALSE(everyRowRefused.isError);
  CHECK_EQ(body(everyRowRefused), parse(R"({"applied":true,"changedNodeIds":[],"diagnosticsClean":true,"dryRun":false,
      "introducedDiagnostics":[],"progress":[
      {"nodeId":"deeper","refused":"\"deeper\" opens a tree: it is complete when that tree is and takes no mark of its own — mark the steps of the tree it opens"},
      {"nodeId":"idea","refused":"\"idea\" opens a tree: it is complete when that tree is and takes no mark of its own — mark the steps of the tree it opens"}],
      "progressApplied":false,"progressError":"Some requested progress marks nodes that open a tree, which take no mark of their own — each is complete when the tree it opens is; those ids are listed in progressRefused.",
      "progressRefused":["deeper","idea"],"seq":1,"treeId":"t","unchanged":true,"unchangedNodeIds":["deeper","idea"]})"));
  CHECK_EQ(body(h.call("get_progress", kNoArgs)), parse(R"({"completed":["a","b"],"outOfOrder":[]})"));
  CHECK_EQ(h.progressRepo.byKey.size(), 2u);
  REQUIRE_EQ(h.bus.progressBroadcasts.size(), 1u);
  CHECK(h.bus.progressBroadcasts[0].marks.completed == (std::set<NodeId>{nid("a"), nid("b")}));
  CHECK_EQ(h.bus.progressBroadcasts[0].marks.marks.size(), 2u);
  std::vector<std::string> observed;
  for (const WriteCompletion& completion : completions) observed.push_back(completion.operation + " " + completion.outcome);
  CHECK_EQ(observed, (std::vector<std::string>{"mcp.roadmap_update_nodes ok", "mcp.roadmap_update_nodes opens-a-tree"}));
}

// The marks ride after the graft, so a pointer the same import sets already refuses the mark sent with it.
TEST(mcp_an_imports_progress_reports_the_nodes_that_open_a_tree_and_still_grafts_and_marks_the_rest) {
  Harness h;
  h.trees.byId["t_sub"] = StoredTree{LooseGraph().exportState(), LegendState{}, {"Deep dive", {}}, 0, h.caller};
  CompositeToolHost gate(std::vector<ToolModule>{{h.tools, ""}});
  std::vector<WriteCompletion> completions;
  installWriteSink([&](const WriteCompletion& completion) { completions.push_back(completion); });

  const ToolResult imported = gate.callTool("roadmap_import_subgraph", parse(R"({"treeId":"t",
      "nodes":[{"id":"idea","label":"Idea","opens":"t_sub"},{"id":"a","label":"A"}],
      "progress":[{"nodeId":"idea","status":"complete"},{"nodeId":"a","status":"complete"},{"nodeId":"ghost","status":"complete"}]})"), h.actor);
  const ToolResult onlyRefused = gate.callTool("roadmap_import_subgraph", parse(R"({"treeId":"t","nodes":[],
      "progress":[{"nodeId":"idea","status":"none"}]})"), h.actor);
  installWriteSink({});

  CHECK_FALSE(imported.isError);
  CHECK_EQ(body(imported), parse(R"({"nodes":2,"edges":0,"kinds":0,"nodeCollisions":[],"kindCollisions":[],
      "newNodes":2,"newKinds":0,"prerequisiteMode":"merge","keptEdges":[],"keptEdgeCount":0,
      "tombstoned":{"nodes":0,"edges":0},"graphApplied":true,"progressApplied":false,"imported":true,"seq":1,
      "diagnosticsClean":true,"introducedDiagnostics":[],
      "progress":[
        {"nodeId":"idea","refused":"\"idea\" opens a tree: it is complete when that tree is and takes no mark of its own — mark the steps of the tree it opens"},
        {"nodeId":"a","status":"complete","prerequisitesMet":true}],
      "progressSkipped":["ghost"],"progressRefused":["idea"],
      "progressError":"Some requested progress names nodes absent after the graft; those ids are listed in progressSkipped. Some requested progress marks nodes that open a tree, which take no mark of their own — each is complete when the tree it opens is; those ids are listed in progressRefused."})"));
  CHECK_FALSE(onlyRefused.isError);
  CHECK_EQ(body(onlyRefused), parse(R"({"nodes":0,"edges":0,"kinds":0,"nodeCollisions":[],"kindCollisions":[],
      "newNodes":0,"newKinds":0,"prerequisiteMode":"merge","keptEdges":[],"keptEdgeCount":0,
      "tombstoned":{"nodes":0,"edges":0},"graphApplied":true,"progressApplied":false,"imported":true,"seq":1,
      "unchanged":true,"diagnosticsClean":true,"introducedDiagnostics":[],
      "progress":[
        {"nodeId":"idea","refused":"\"idea\" opens a tree: it is complete when that tree is and takes no mark of its own — mark the steps of the tree it opens"}],
      "progressRefused":["idea"],
      "progressError":"Some requested progress marks nodes that open a tree, which take no mark of their own — each is complete when the tree it opens is; those ids are listed in progressRefused."})"));
  CHECK_EQ(body(h.call("get_tree", parse(R"({"fields":["id","status"]})")))["tree"]["nodes"],
           parse(R"([{"id":"a","status":"complete"},{"id":"idea","status":"none"}])"));
  CHECK_EQ(h.progressRepo.byKey.size(), 1u);
  std::vector<std::string> observed;
  for (const WriteCompletion& completion : completions) observed.push_back(completion.operation + " " + completion.outcome);
  CHECK_EQ(observed, (std::vector<std::string>{"mcp.roadmap_import_subgraph ok", "mcp.roadmap_import_subgraph opens-a-tree"}));
}

// An import whose graft landed wrote, whatever its marks came to: one whose every mark was refused on a node that opens a
// tree still completes ok, and only an import that landed nothing completes as opens-a-tree.
TEST(mcp_an_import_whose_graft_landed_completes_ok_though_every_mark_was_refused) {
  Harness h;
  h.trees.byId["t_sub"] = StoredTree{LooseGraph().exportState(), LegendState{}, {"Deep dive", {}}, 0, h.caller};
  CompositeToolHost gate(std::vector<ToolModule>{{h.tools, ""}});
  CHECK_FALSE(gate.callTool("roadmap_import_subgraph", parse(R"({"treeId":"t",
      "nodes":[{"id":"idea","label":"Idea","opens":"t_sub"}]})"), h.actor).isError);
  std::vector<WriteCompletion> completions;
  installWriteSink([&](const WriteCompletion& completion) { completions.push_back(completion); });

  const ToolResult landed = gate.callTool("roadmap_import_subgraph", parse(R"({"treeId":"t",
      "nodes":[{"id":"b","label":"B"}],"progress":[{"nodeId":"idea","status":"complete"}]})"), h.actor);
  const ToolResult nothing = gate.callTool("roadmap_import_subgraph", parse(R"({"treeId":"t",
      "nodes":[],"progress":[{"nodeId":"idea","status":"complete"}]})"), h.actor);
  installWriteSink({});

  CHECK_EQ(body(landed), parse(R"({"nodes":1,"edges":0,"kinds":0,"nodeCollisions":[],"kindCollisions":[],
      "newNodes":1,"newKinds":0,"prerequisiteMode":"merge","keptEdges":[],"keptEdgeCount":0,
      "tombstoned":{"nodes":0,"edges":0},"graphApplied":true,"progressApplied":false,"imported":true,"seq":2,
      "diagnosticsClean":true,"introducedDiagnostics":[],
      "progress":[
        {"nodeId":"idea","refused":"\"idea\" opens a tree: it is complete when that tree is and takes no mark of its own — mark the steps of the tree it opens"}],
      "progressRefused":["idea"],
      "progressError":"Some requested progress marks nodes that open a tree, which take no mark of their own — each is complete when the tree it opens is; those ids are listed in progressRefused."})"));
  CHECK_FALSE(nothing.isError);
  std::vector<std::string> observed;
  for (const WriteCompletion& completion : completions) observed.push_back(completion.operation + " " + completion.outcome);
  CHECK_EQ(observed, (std::vector<std::string>{"mcp.roadmap_import_subgraph ok", "mcp.roadmap_import_subgraph opens-a-tree"}));
}

// A pointer at a tree that is absent, deleted or someone else's follows nothing, so its node keeps its own mark.
TEST(mcp_a_node_whose_pointer_is_not_valid_is_marked_as_any_node) {
  Harness h;
  h.trees.byId["t_gone"] = StoredTree{LooseGraph().exportState(), LegendState{}, {"Retired", {}}, 0, h.caller};
  h.trees.byId["t_theirs"] = StoredTree{LooseGraph().exportState(), LegendState{}, {"Their plans", {}}, 0,
                                        uid("someone-else"), Visibility::public_};
  CHECK_FALSE(h.call("import_subgraph", parse(R"({"nodes":[{"id":"gone","label":"Gone","opens":"t_gone"},{"id":"theirs","label":"Theirs"},
                                                            {"id":"absent","label":"Absent"},{"id":"plain","label":"Plain"}]})")).isError);
  h.trees.softDelete(TreeId{"t_gone"});
  for (const auto& [node, target] : std::vector<std::pair<const char*, const char*>>{{"theirs", "t_theirs"}, {"absent", "t_absent"}}) {
    AnnotateNode planted{NodeId{node}};
    planted.opens = TreeId{target};
    h.registry.open(TreeId{"t"})->applyCommand(planted, h.clock.nowMs(), h.caller);
  }

  CHECK_EQ(body(h.call("update_nodes", parse(R"({"updates":[{"nodeId":"gone","status":"complete"},{"nodeId":"theirs","status":"complete"},
                                                             {"nodeId":"absent","status":"complete"},{"nodeId":"plain","status":"complete"}]})"))),
           parse(R"({"applied":true,"changedNodeIds":[],"diagnosticsClean":true,"dryRun":false,"introducedDiagnostics":[],
                     "progress":[{"nodeId":"gone","status":"complete","prerequisitesMet":true},
                                 {"nodeId":"theirs","status":"complete","prerequisitesMet":true},
                                 {"nodeId":"absent","status":"complete","prerequisitesMet":true},
                                 {"nodeId":"plain","status":"complete","prerequisitesMet":true}],
                     "seq":3,"treeId":"t","unchanged":true,"unchangedNodeIds":["gone","theirs","absent","plain"]})"));
  CHECK_EQ(body(h.call("update_nodes", asUpdate(parse(R"({"nodeId":"gone","status":"none"})")))),
           parse(R"({"applied":true,"changedNodeIds":[],"diagnosticsClean":true,"dryRun":false,"introducedDiagnostics":[],
                     "progress":[{"nodeId":"gone","status":"none","prerequisitesMet":true}],
                     "seq":3,"treeId":"t","unchanged":true,"unchangedNodeIds":["gone"]})"));
  CHECK_EQ(body(h.call("get_tree", parse(R"({"fields":["id","status","state"]})")))["tree"]["nodes"],
           parse(R"([{"id":"absent","status":"complete","state":"complete"},{"id":"gone","status":"none","state":"available"},
                     {"id":"plain","status":"complete","state":"complete"},{"id":"theirs","status":"complete","state":"complete"}])"));
}

// A refusal would tell such a caller the node opens a tree, and so would a read made only for that node.
TEST(mcp_a_caller_who_cannot_write_the_tree_marks_a_node_that_opens_a_tree_exactly_as_on_a_twin_and_nothing_is_read) {
  Harness h;
  h.trees.byId["t"].visibility = Visibility::public_;
  h.trees.byId["t_twin"] = StoredTree{LooseGraph().exportState(), LegendState{}, {"Test Roadmap", {}}, 0, h.caller, Visibility::public_};
  h.trees.byId["t_sub"] = StoredTree{LooseGraph().exportState(), LegendState{}, {"Deep dive", {}}, 0, h.caller};
  CHECK_FALSE(h.tools.callTool("import_subgraph", parse(R"({"treeId":"t","nodes":[{"id":"idea","label":"Idea","opens":"t_sub"},
                                                            {"id":"next","label":"Next","prerequisites":["idea"]}]})"), h.actor).isError);
  CHECK_FALSE(h.tools.callTool("import_subgraph", parse(R"({"treeId":"t_twin","nodes":[{"id":"idea","label":"Idea"},
                                                            {"id":"next","label":"Next","prerequisites":["idea"]}]})"), h.actor).isError);
  const std::size_t readsForTheOwner = h.trees.openedReads.size();

  const std::vector<std::pair<const char*, const char*>> marks = {
      {R"([{"nodeId":"next","status":"complete"}])", R"([{"nodeId":"next","status":"complete","prerequisitesMet":false}])"},
      {R"([{"nodeId":"idea","status":"complete"}])", R"([{"nodeId":"idea","status":"complete","prerequisitesMet":true}])"},
      {R"([{"nodeId":"idea","status":"none"}])", R"([{"nodeId":"idea","status":"none","prerequisitesMet":true}])"},
      {R"([{"nodeId":"idea","status":"complete"},{"nodeId":"next","status":"complete"}])",
       R"([{"nodeId":"idea","status":"complete","prerequisitesMet":true},
           {"nodeId":"next","status":"complete","prerequisitesMet":true,"unchanged":true}])"}};
  for (const UserId& reader : {uid("stranger"), UserId{}}) {
    const ToolCaller caller{reader, ToolScope::everything()};
    for (const auto& [updates, rows] : marks) {
      Json::Value onTheTree(Json::objectValue);
      onTheTree["treeId"] = "t";
      onTheTree["updates"] = parse(updates);
      Json::Value onTheTwin = onTheTree;
      onTheTwin["treeId"] = "t_twin";
      const ToolResult marked = h.tools.callTool("update_nodes", onTheTree, caller);
      const ToolResult twin = h.tools.callTool("update_nodes", onTheTwin, caller);
      CHECK_FALSE(marked.isError);
      Json::Value receipt = body(marked);
      Json::Value twinReceipt = body(twin);
      receipt.removeMember("treeId");
      twinReceipt.removeMember("treeId");
      CHECK_EQ(receipt, twinReceipt);
      CHECK_EQ(receipt["progress"], parse(rows));
    }
    CHECK(h.progressRepo.load(TreeId{"t"}, reader).completed == (std::set<NodeId>{nid("idea"), nid("next")}));
  }
  CHECK_EQ(h.trees.openedReads.size(), readsForTheOwner);
}

// The advisory reads the completed set the tree derives: a step behind such a node waits on the opened tree, not on a stored mark.
TEST(mcp_prerequisites_met_follows_the_tree_a_prerequisite_opens_whatever_mark_that_node_holds) {
  Harness h;
  h.trees.byId["t"].visibility = Visibility::public_;
  h.trees.byId["t_open"] = StoredTree{LooseGraph().exportState(), LegendState{}, {"Still open", {}}, 0, h.caller};
  h.trees.byId["t_done"] = StoredTree{LooseGraph().exportState(), LegendState{}, {"Done", {}}, 0, h.caller};
  CHECK_FALSE(h.tools.callTool("create_node", parse(R"({"treeId":"t_open","id":"s","label":"S"})"), h.actor).isError);
  CHECK_FALSE(h.tools.callTool("create_node", parse(R"({"treeId":"t_done","id":"d","label":"D"})"), h.actor).isError);
  CHECK_FALSE(h.tools.callTool("update_nodes", parse(R"({"treeId":"t_done","updates":[{"nodeId":"d","status":"complete"}]})"), h.actor).isError);
  CHECK_FALSE(h.call("import_subgraph", parse(R"({"nodes":[{"id":"marked","label":"Marked"},{"id":"unmarked","label":"Unmarked","opens":"t_done"},
                                                            {"id":"behind-marked","label":"Behind marked","prerequisites":["marked"]},
                                                            {"id":"behind-unmarked","label":"Behind unmarked","prerequisites":["unmarked"]}],
                                                   "progress":[{"nodeId":"marked","status":"complete"}]})")).isError);
  CHECK_FALSE(h.call("update_nodes", asUpdate(parse(R"({"nodeId":"marked","opens":"t_open"})"))).isError);
  // The receipt of a call of marks alone on `t`: no tree op, so the head it stands at and every row's node unchanged.
  const auto receipt = [](const char* progress, const char* nodes) {
    return parse(std::string(R"({"applied":true,"changedNodeIds":[],"diagnosticsClean":true,"dryRun":false,)"
                             R"("introducedDiagnostics":[],"progress":)") + progress +
                 R"(,"seq":2,"treeId":"t","unchanged":true,"unchangedNodeIds":)" + nodes + "}");
  };

  CHECK_EQ(body(h.call("update_nodes", parse(R"({"updates":[{"nodeId":"behind-marked","status":"complete","outOfOrder":true},
                                                             {"nodeId":"behind-unmarked","status":"complete"}]})"))),
           receipt(R"([{"nodeId":"behind-marked","status":"complete","prerequisitesMet":false,"acknowledged":true},
                       {"nodeId":"behind-unmarked","status":"complete","prerequisitesMet":true}])",
                   R"(["behind-marked","behind-unmarked"])"));
  CHECK_EQ(body(h.call("update_nodes", asUpdate(parse(R"({"nodeId":"behind-marked","status":"complete"})")))),
           receipt(R"([{"nodeId":"behind-marked","status":"complete","prerequisitesMet":false}])", R"(["behind-marked"])"));

  CHECK_FALSE(h.tools.callTool("update_nodes", parse(R"({"treeId":"t_open","updates":[{"nodeId":"s","status":"complete"}]})"), h.actor).isError);
  CHECK_EQ(body(h.call("update_nodes", asUpdate(parse(R"({"nodeId":"behind-marked","status":"complete"})")))),
           receipt(R"([{"nodeId":"behind-marked","status":"complete","prerequisitesMet":true,"unchanged":true}])",
                   R"(["behind-marked"])"));

  const ToolCaller stranger{uid("stranger"), ToolScope::everything()};
  CHECK_EQ(body(h.tools.callTool("update_nodes", parse(R"({"treeId":"t","updates":[{"nodeId":"behind-unmarked","status":"complete"}]})"), stranger)),
           receipt(R"([{"nodeId":"behind-unmarked","status":"complete","prerequisitesMet":false}])", R"(["behind-unmarked"])"));
  CHECK_EQ(body(h.tools.callTool("update_nodes", parse(R"({"treeId":"t","updates":[{"nodeId":"unmarked","status":"complete"},
                                                                                    {"nodeId":"behind-unmarked","status":"complete"}]})"), stranger)),
           receipt(R"([{"nodeId":"unmarked","status":"complete","prerequisitesMet":true},
                       {"nodeId":"behind-unmarked","status":"complete","prerequisitesMet":true,"unchanged":true}])",
                   R"(["unmarked","behind-unmarked"])"));
}

// Nothing is read for a tree with no pointer, for a caller who cannot write the tree, or for a call refused before it is judged.
TEST(mcp_a_mark_follows_pointers_in_one_read_for_the_trees_writer_and_reads_nothing_where_no_pointer_is_followed) {
  Harness h;
  h.trees.byId["t"].visibility = Visibility::public_;
  h.trees.byId["t_sub"] = StoredTree{LooseGraph().exportState(), LegendState{}, {"Deep dive", {}}, 0, h.caller};
  h.trees.byId["t_other"] = StoredTree{LooseGraph().exportState(), LegendState{}, {"Side quest", {}}, 0, h.caller};
  CHECK_FALSE(h.call("import_subgraph", parse(R"({"nodes":[{"id":"a","label":"A"},{"id":"b","label":"B"},{"id":"c","label":"C"}],
                                                   "progress":[{"nodeId":"c","status":"complete"}]})")).isError);
  CHECK_FALSE(h.call("update_nodes", parse(R"({"updates":[{"nodeId":"a","status":"complete"}]})")).isError);
  CHECK_FALSE(h.call("update_nodes", parse(R"({"updates":[{"nodeId":"a","status":"none"},{"nodeId":"b","status":"complete"}]})")).isError);
  CHECK(h.trees.openedReads.empty());

  CHECK_FALSE(h.call("update_nodes", parse(R"({"updates":[{"nodeId":"a","opens":"t_sub"},{"nodeId":"b","opens":"t_other"}]})")).isError);
  h.trees.openedReads.clear();  // the edit followed the pointers it set, for its own receipt
  CHECK(h.call("update_nodes", parse(R"({"updates":[{"nodeId":"ghost","status":"complete"},{"nodeId":"c","status":"none"}]})")).isError);
  for (const UserId& reader : {uid("stranger"), UserId{}}) {
    const ToolCaller caller{reader, ToolScope::everything()};
    CHECK_FALSE(h.tools.callTool("update_nodes", parse(R"({"treeId":"t","updates":[{"nodeId":"a","status":"complete"}]})"), caller).isError);
    CHECK_FALSE(h.tools.callTool("update_nodes", parse(R"({"treeId":"t","updates":[{"nodeId":"b","status":"complete"},{"nodeId":"c","status":"complete"}]})"), caller).isError);
  }
  CHECK(h.trees.openedReads.empty());

  const std::set<TreeId> opened{TreeId{"t_other"}, TreeId{"t_sub"}};
  CHECK_FALSE(h.call("update_nodes", parse(R"({"updates":[{"nodeId":"c","status":"none"}]})")).isError);
  CHECK_EQ(h.trees.openedReads, (std::vector<std::set<TreeId>>{opened}));
  CHECK_FALSE(h.call("update_nodes", parse(R"({"updates":[{"nodeId":"a","status":"complete"},{"nodeId":"b","status":"complete"},{"nodeId":"c","status":"complete"}]})")).isError);
  CHECK_EQ(h.trees.openedReads, (std::vector<std::set<TreeId>>{opened, opened}));
  CHECK_FALSE(h.call("import_subgraph", parse(R"({"nodes":[],"progress":[{"nodeId":"a","status":"complete"},{"nodeId":"c","status":"none"}]})")).isError);
  CHECK_EQ(h.trees.openedReads, (std::vector<std::set<TreeId>>{opened, opened, opened}));
}

// A stranger's read or mark must not wait on the owner's statements: that wait would say the tree holds a pointer.
TEST(mcp_a_mark_reads_and_writes_the_repositories_after_it_has_let_go_of_the_trees_strand) {
  Harness h;
  h.trees.byId["t"].visibility = Visibility::public_;
  h.trees.byId["t_sub"] = StoredTree{LooseGraph().exportState(), LegendState{}, {"Deep dive", {}}, 0, h.caller};
  CHECK_FALSE(h.call("import_subgraph", parse(R"({"nodes":[{"id":"idea","label":"Idea","opens":"t_sub"},{"id":"a","label":"A"}]})")).isError);
  std::vector<std::string> statementsUnderAFreeStrand;
  Json::Value readMeanwhile;
  const auto during = [&](const char* statement) {
    return [&, statement] {
      std::thread other([&] {
        std::mutex& strand = h.registry.strandFor(TreeId{"t"});
        if (!strand.try_lock()) return;
        strand.unlock();
        statementsUnderAFreeStrand.push_back(statement);
        readMeanwhile = body(h.tools.callTool("get_tree", parse(R"({"treeId":"t","fields":["id"]})"),
                                              ToolCaller{uid("stranger"), ToolScope::everything()}))["tree"]["nodes"];
      });
      other.join();
    };
  };
  h.trees.duringOpenedRead = during("read");
  h.progressRepo.duringBatchWrite = during("write");

  const std::vector<std::pair<const char*, const char*>> marking = {
      {"update_nodes", R"({"updates":[{"nodeId":"a","status":"complete"}]})"},
      {"update_nodes", R"({"updates":[{"nodeId":"idea","status":"complete"},{"nodeId":"a","status":"none"}]})"},
      {"import_subgraph", R"({"nodes":[],"progress":[{"nodeId":"a","status":"complete"}]})"}};
  for (const auto& [tool, arguments] : marking) {
    statementsUnderAFreeStrand.clear();
    readMeanwhile = Json::Value();
    CHECK_FALSE(h.call(tool, parse(arguments)).isError);
    CHECK_EQ(statementsUnderAFreeStrand, (std::vector<std::string>{"read", "write"}));
    CHECK_EQ(readMeanwhile, parse(R"([{"id":"a"},{"id":"idea"}])"));
  }
}

// Following is part of the marks: when they are the call its failure is the call's server failure, before any mark is
// written; beside a tree op that landed it is the marks' own, told in the receipt; and it is made only where it is due.
TEST(mcp_a_mark_whose_pointers_cannot_be_followed_fails_as_the_call_and_records_nothing) {
  Harness h;
  h.trees.byId["t"].visibility = Visibility::public_;
  h.trees.byId["t_sub"] = StoredTree{LooseGraph().exportState(), LegendState{}, {"Deep dive", {}}, 0, h.caller};
  CHECK_FALSE(h.call("import_subgraph", parse(R"({"nodes":[{"id":"idea","label":"Idea","opens":"t_sub"},{"id":"a","label":"A"}]})")).isError);
  h.trees.openedReadsFail = true;
  CompositeToolHost gate(std::vector<ToolModule>{{h.tools, ""}});
  std::vector<WriteCompletion> completions;
  installWriteSink([&](const WriteCompletion& completion) { completions.push_back(completion); });

  const ToolResult failed =
      gate.callTool("roadmap_update_nodes", parse(R"({"treeId":"t","updates":[{"nodeId":"a","status":"complete"}]})"), h.actor);
  const ToolResult edited = gate.callTool("roadmap_update_nodes", parse(R"({"treeId":"t","updates":[
      {"nodeId":"idea","label":"Idea 2"},{"nodeId":"a","status":"complete"}]})"), h.actor);
  const ToolResult imported = gate.callTool("roadmap_import_subgraph", parse(R"({"treeId":"t","nodes":[],"progress":[{"nodeId":"a","status":"complete"}]})"), h.actor);
  installWriteSink({});

  CHECK(failed.isError);
  CHECK_EQ(message(failed), std::string("update_nodes: that call failed inside the server. The outcome may be uncertain; "
                                        "read the affected records before retrying. The detail is in the server log."));
  CHECK_FALSE(edited.isError);
  CHECK_EQ(body(edited), parse(R"({"applied":true,"changedNodeIds":["idea"],"diagnosticsClean":true,"dryRun":false,
    "introducedDiagnostics":[],"progressApplied":false,
    "progressError":"The marks' outcome is uncertain. Read get_progress before retrying progress changes.",
    "seq":2,"treeId":"t","unchangedNodeIds":["a"]})"));
  CHECK_FALSE(imported.isError);
  CHECK(body(imported)["graphApplied"].asBool());
  CHECK_FALSE(body(imported)["progressApplied"].asBool());
  CHECK_EQ(body(imported)["progressError"].asString(),
           std::string("The graph committed, but the requested progress outcome is uncertain. Read get_progress before retrying progress changes."));
  CHECK(h.progressRepo.byKey.empty());
  CHECK(h.bus.progressBroadcasts.empty());
  std::vector<std::string> observed;
  for (const WriteCompletion& completion : completions) observed.push_back(completion.operation + " " + completion.outcome);
  CHECK_EQ(observed, (std::vector<std::string>{"mcp.roadmap_update_nodes failed", "roadmap.update_nodes.marks failed",
                                               "mcp.roadmap_update_nodes ok", "mcp.roadmap_import_subgraph failed"}));
  CHECK_EQ(body(h.tools.callTool("update_nodes", parse(R"({"treeId":"t","updates":[{"nodeId":"a","status":"complete"}]})"),
                                 ToolCaller{uid("stranger"), ToolScope::everything()}))["progress"],
           parse(R"([{"nodeId":"a","status":"complete","prerequisitesMet":true}])"));
}

// A mark is judged against the nodes that open a tree and nothing else of the room, so no caller's mark copies the tree out.
TEST(mcp_a_mark_copies_the_whole_tree_out_of_its_room_for_no_caller) {
  Harness h;
  h.trees.byId["t"].visibility = Visibility::public_;
  h.trees.byId["t_plain"] = StoredTree{LooseGraph().exportState(), LegendState{}, {"No pointers", {}}, 0, h.caller};
  h.trees.byId["t_sub"] = StoredTree{LooseGraph().exportState(), LegendState{}, {"Deep dive", {}}, 0, h.caller};
  CHECK_FALSE(h.call("import_subgraph", parse(R"({"nodes":[{"id":"idea","label":"Idea","opens":"t_sub"},{"id":"a","label":"A"},{"id":"b","label":"B"}]})")).isError);
  CHECK_FALSE(h.tools.callTool("create_node", parse(R"({"treeId":"t_plain","id":"a","label":"A"})"), h.actor).isError);
  const TreeRoom& room = *h.registry.open(TreeId{"t"});
  const TreeRoom& plain = *h.registry.open(TreeId{"t_plain"});
  const std::size_t copies = room.snapshots();
  const std::size_t plainCopies = plain.snapshots();

  CHECK_FALSE(h.call("update_nodes", parse(R"({"updates":[{"nodeId":"a","status":"complete"}]})")).isError);
  CHECK_FALSE(h.call("update_nodes", parse(R"({"updates":[{"nodeId":"idea","status":"complete"},{"nodeId":"b","status":"complete"}]})")).isError);
  for (const UserId& reader : {uid("stranger"), UserId{}}) {
    const ToolCaller caller{reader, ToolScope::everything()};
    CHECK_FALSE(h.tools.callTool("update_nodes", parse(R"({"treeId":"t","updates":[{"nodeId":"idea","status":"complete"}]})"), caller).isError);
    CHECK_FALSE(h.tools.callTool("update_nodes", parse(R"({"treeId":"t","updates":[{"nodeId":"a","status":"complete"}]})"), caller).isError);
  }
  CHECK_FALSE(h.tools.callTool("update_nodes", parse(R"({"treeId":"t_plain","updates":[{"nodeId":"a","status":"complete"}]})"), h.actor).isError);
  CHECK_EQ(room.snapshots(), copies);
  CHECK_EQ(plain.snapshots(), plainCopies);

  CHECK_FALSE(h.call("import_subgraph", parse(R"({"nodes":[]})")).isError);
  const std::size_t aGraftsOwnCopies = room.snapshots() - copies;
  CHECK_FALSE(h.call("import_subgraph", parse(R"({"nodes":[],"progress":[{"nodeId":"a","status":"none"},{"nodeId":"idea","status":"none"}]})")).isError);
  CHECK_EQ(room.snapshots() - copies, 2 * aGraftsOwnCopies);
}

// The write line says what a call of marks came to: nothing recorded and a mark refused completes as opens-a-tree, and a
// mark recorded beside a refusal is an ok, the clear of a mark the caller's phone stamped ahead of the server among them,
// which lands just after that stamp. Each mark is answered once, refused or landed.
TEST(mcp_a_call_that_recorded_no_mark_and_was_refused_one_completes_as_opens_a_tree) {
  Harness h;
  h.trees.byId["t_sub"] = StoredTree{LooseGraph().exportState(), LegendState{}, {"Deep dive", {}}, 0, h.caller};
  CHECK_FALSE(h.call("import_subgraph", parse(R"({"nodes":[{"id":"idea","label":"Idea","opens":"t_sub"},{"id":"a","label":"A"},{"id":"b","label":"B"}]})")).isError);
  h.progressRepo.setStatus(TreeId{"t"}, h.caller, nid("a"), ProgressStatus::complete, false, Hlc{9'000'000, 0, "r_phone"}, 9'000'000);
  CompositeToolHost gate(std::vector<ToolModule>{{h.tools, ""}});
  std::vector<WriteCompletion> completions;
  installWriteSink([&](const WriteCompletion& completion) { completions.push_back(completion); });

  const ToolResult refused = gate.callTool("roadmap_update_nodes", parse(R"({"treeId":"t","updates":[
      {"nodeId":"idea","status":"complete"}]})"), h.actor);
  const ToolResult refusedAndAhead = gate.callTool("roadmap_update_nodes", parse(R"({"treeId":"t","updates":[
      {"nodeId":"idea","status":"complete"},{"nodeId":"a","status":"none"}]})"), h.actor);
  const ToolResult refusedAndRecorded = gate.callTool("roadmap_update_nodes", parse(R"({"treeId":"t","updates":[
      {"nodeId":"idea","status":"none"},{"nodeId":"b","status":"complete"}]})"), h.actor);
  installWriteSink({});

  // The receipt of a call of marks alone that refused the mark on `idea` beside `others`, and what those answered.
  const auto receipt = [](const char* others, const char* nodes) {
    return parse(std::string(R"({"applied":true,"changedNodeIds":[],"diagnosticsClean":true,"dryRun":false,)"
                             R"("introducedDiagnostics":[],"progress":[{"nodeId":"idea","refused":"\"idea\" opens a tree: it is complete when that tree is and takes no mark of its own — mark the steps of the tree it opens"})") +
                 others + R"(],"progressApplied":false,"progressError":"Some requested progress marks nodes that open a tree, which take no mark of their own — each is complete when the tree it opens is; those ids are listed in progressRefused.",)"
                          R"("progressRefused":["idea"],"seq":1,"treeId":"t","unchanged":true,"unchangedNodeIds":)" + nodes + "}");
  };
  CHECK_EQ(body(refused), receipt("", R"(["idea"])"));
  CHECK_EQ(body(refusedAndAhead), receipt(R"(,{"nodeId":"a","status":"none","prerequisitesMet":true})", R"(["idea","a"])"));
  CHECK_EQ(h.progressRepo.byKey.at(fake::FakeProgressRepository::key(TreeId{"t"}, h.caller, nid("a"))).at,
           (Hlc{9'000'000, 1, std::string{TreeRoom::kServerActor}}));
  CHECK_EQ(body(refusedAndRecorded), receipt(R"(,{"nodeId":"b","status":"complete","prerequisitesMet":true})", R"(["idea","b"])"));
  CHECK_EQ(body(h.call("get_progress", kNoArgs)), parse(R"({"completed":["b"],"outOfOrder":[]})"));
  std::vector<std::string> observed;
  for (const WriteCompletion& completion : completions) observed.push_back(completion.operation + " " + completion.outcome);
  CHECK_EQ(observed, (std::vector<std::string>{"mcp.roadmap_update_nodes opens-a-tree", "mcp.roadmap_update_nodes ok",
                                               "mcp.roadmap_update_nodes ok"}));
}

// With no mark to judge there is nothing the opened trees could decide, so they are not read.
TEST(mcp_an_import_whose_progress_names_only_absent_nodes_follows_no_pointer) {
  Harness h;
  h.trees.byId["t_sub"] = StoredTree{LooseGraph().exportState(), LegendState{}, {"Deep dive", {}}, 0, h.caller};
  CHECK_FALSE(h.call("create_node", parse(R"({"id":"idea","label":"Idea","opens":"t_sub"})")).isError);
  h.trees.openedReads.clear();  // the edit followed the pointer it set, for its own receipt

  const ToolResult imported = h.call("import_subgraph", parse(R"({"nodes":[],"progress":[{"nodeId":"ghost","status":"complete"}]})"));

  CHECK_EQ(body(imported)["progressSkipped"], parse(R"(["ghost"])"));
  CHECK_EQ(body(imported)["progress"], parse("[]"));
  CHECK(h.trees.openedReads.empty());
  CHECK(h.progressRepo.byKey.empty());
}

// Clearing the marks on removed nodes fails apart from the graft that landed: it is reported once under its own name, and
// said beside what else fell short.
TEST(mcp_an_import_whose_clear_of_marks_on_removed_nodes_throws_reports_it_once_and_keeps_every_sentence) {
  FakeTreeRepository trees;
  FakeOpLog ops;
  FakeBus bus;
  ThrowingProgressRepository progressRepo;
  StepClock clock;
  FakeTokens tokens;
  RoomRegistry registry{trees, ops, bus};
  ProgressService progress{progressRepo, trees};
  TreeRegistry treeRegistry{trees, progressRepo, tokens, Hlc{1, 0, "genesis"}, registry, clock};
  const ToolCaller caller{uid("agent"), ToolScope::everything()};
  RoadmapTools tools{registry, progress, clock, treeRegistry, bus, "https://app.example"};
  trees.byId["t"] = StoredTree{LooseGraph().exportState(), LegendState{}, {"Test Roadmap", {}}, 0, caller.user};
  CHECK_FALSE(tools.callTool("import_subgraph", parse(R"({"treeId":"t","nodes":[{"id":"n","label":"N"},{"id":"m","label":"M"}],
                                                          "progress":[{"nodeId":"n","status":"complete"},{"nodeId":"m","status":"complete"}]})"), caller).isError);
  progressRepo.armed = true;
  CompositeToolHost gate(std::vector<ToolModule>{{tools, ""}});
  std::vector<WriteCompletion> completions;
  installWriteSink([&](const WriteCompletion& completion) { completions.push_back(completion); });

  const ToolResult skipping = gate.callTool("roadmap_import_subgraph", parse(R"({"treeId":"t","nodes":[],"tombstone":["n"],
                                                                                 "progress":[{"nodeId":"ghost","status":"complete"}]})"), caller);
  const ToolResult alone = gate.callTool("roadmap_import_subgraph", parse(R"({"treeId":"t","nodes":[],"tombstone":["m"]})"), caller);
  installWriteSink({});

  CHECK_FALSE(skipping.isError);
  CHECK(body(skipping)["graphApplied"].asBool());
  CHECK_FALSE(body(skipping)["progressApplied"].asBool());
  CHECK_EQ(body(skipping)["progressError"].asString(),
           std::string("The graph committed, but clearing progress on removed nodes failed. Read get_progress before retrying "
                       "progress changes. Some requested progress names nodes absent after the graft; those ids are listed in "
                       "progressSkipped."));
  CHECK_EQ(body(alone)["progressError"].asString(),
           std::string("The graph committed, but clearing progress on removed nodes failed. Read get_progress before retrying "
                       "progress changes."));
  std::vector<std::string> observed;
  for (const WriteCompletion& completion : completions) observed.push_back(completion.operation + " " + completion.outcome);
  CHECK_EQ(observed, (std::vector<std::string>{"roadmap.import.clear_marks failed", "mcp.roadmap_import_subgraph ok",
                                               "roadmap.import.clear_marks failed", "mcp.roadmap_import_subgraph ok"}));
}

// A hue no kind wears is a smell, one line per hue naming how many present nodes wear it and the first of them, however
// they got there: written with no colour where no kind wears terracotta, sent a kind's old hue by the import that
// re-hues it, revived after its kind moved, or given a third hue. A node under a kind is not counted. A smell is no
// structural error, so receipts stay clean.
TEST(mcp_a_hue_no_kind_wears_is_a_smell) {
  Harness h;
  CHECK_FALSE(h.call("add_kind", parse(R"({"id":"k","hue":"sky"})")).isError);
  CHECK_FALSE(h.call("import_subgraph", parse(R"({"nodes":[{"id":"a","label":"A","icon":"i"},
    {"id":"c","label":"C","icon":"i","color":"sky"},{"id":"d","label":"D","icon":"i","kind":"k"},
    {"id":"e","label":"E","icon":"i","kind":"k"}]})")).isError);
  CHECK_FALSE(h.call("delete_node", parse(R"({"nodeId":"c"})")).isError);
  CHECK_FALSE(h.call("import_subgraph", parse(R"({"kinds":[{"id":"k","hue":"plum"}],
    "nodes":[{"id":"b","label":"B","icon":"i","color":"sky"}]})")).isError);
  CHECK_FALSE(h.call("import_subgraph", parse(R"({"nodes":[{"id":"c","label":"C"}]})")).isError);
  const Json::Value recolored = body(h.call("update_nodes", asUpdate(parse(R"({"nodeId":"e","color":"olive"})"))));
  CHECK_EQ(recolored["diagnosticsClean"], Json::Value(true));
  CHECK_EQ(recolored["introducedDiagnostics"], parse("[]"));

  CHECK_EQ(body(h.call("get_diagnostics", kNoArgs))["smells"],
           parse(R"([{"kind":"unclaimed-hue","hue":"terracotta","count":1,"nodes":["a"]},
             {"kind":"unclaimed-hue","hue":"olive","count":1,"nodes":["e"]},
             {"kind":"unclaimed-hue","hue":"sky","count":2,"nodes":["b","c"]}])"));
}

// An unclaimed hue names at most the first ten nodes wearing it, in the order nodes are reported, and counts them all:
// twelve on olive and two on plum are two lines, beside the per-node smells.
TEST(mcp_an_unclaimed_hue_names_its_first_ten_nodes_and_counts_them_all) {
  Harness h;
  CHECK_FALSE(h.call("add_kind", parse(R"({"id":"k","hue":"sky"})")).isError);
  Json::Value batch = parse(R"({"nodes":[{"id":"p01","label":"P1","icon":"i","color":"plum"},
    {"id":"p02","label":"P2","color":"plum"}]})");
  for (int i = 1; i <= 12; ++i) {
    Json::Value node = parse(R"({"label":"O","icon":"i","color":"olive"})");
    node["id"] = std::string(i < 10 ? "o0" : "o") + std::to_string(i);
    batch["nodes"].append(node);
  }
  CHECK_FALSE(h.call("import_subgraph", batch).isError);
  CHECK_EQ(body(h.call("get_diagnostics", kNoArgs))["smells"],
           parse(R"([{"kind":"unclaimed-hue","hue":"olive","count":12,
               "nodes":["o01","o02","o03","o04","o05","o06","o07","o08","o09","o10"]},
             {"kind":"unclaimed-hue","hue":"plum","count":2,"nodes":["p01","p02"]},
             {"kind":"empty-icon","count":1,"nodes":["p02"]}])"));
}

// The smell is per hue, so its size does not grow with the tree: ten thousand nodes on one unclaimed hue are one line.
TEST(mcp_ten_thousand_nodes_on_one_unclaimed_hue_answer_one_short_line) {
  Harness h;
  TreeData data;
  data.id = TreeId{"t"};
  for (int i = 0; i < 10000; ++i) {
    NodeSpec node;
    const std::string digits = std::to_string(i);
    node.id = NodeId{"n" + std::string(5 - digits.size(), '0') + digits};
    node.label = "N";
    node.icon = "i";
    node.color = NodeColor::olive;
    data.nodes.push_back(node);
  }
  h.trees.byId["t"] = StoredTree{LooseGraph(data, Hlc{1, 0, "seed"}).exportState(),
                                 Legend({{KindId{"k"}, NodeColor::sky, "K"}}, Hlc{1, 0, "seed"}).exportState(),
                                 {"Big", {}}, 0, h.caller};
  const Json::Value smells = body(h.call("get_diagnostics", kNoArgs))["smells"];
  CHECK_EQ(smells, parse(R"([{"kind":"unclaimed-hue","hue":"olive","count":10000,
    "nodes":["n00000","n00001","n00002","n00003","n00004","n00005","n00006","n00007","n00008","n00009"]}])"));
  CHECK(dump(smells).size() < 300);
}

// A tree whose legend holds no kind says so in one line for the whole tree, not once per node, beside the smells its
// nodes carry; a tree with no node says nothing.
TEST(mcp_a_tree_with_no_kinds_reports_one_empty_legend_smell) {
  Harness h;
  CHECK_EQ(body(h.call("get_diagnostics", kNoArgs))["smells"], parse("[]"));
  CHECK_FALSE(h.call("import_subgraph", parse(R"({"nodes":[{"id":"a","label":"A","icon":"i"},
    {"id":"b","label":"B","color":"sky"}]})")).isError);
  CHECK_EQ(body(h.call("get_diagnostics", kNoArgs))["smells"],
           parse(R"([{"kind":"empty-legend"},{"kind":"empty-icon","count":1,"nodes":["b"]}])"));
}

// Each smell kind is one line naming how many nodes it covers and the first ten of them, in the order nodes are
// reported, so get_diagnostics answers a bounded list whatever the tree's size; a kind no node has is left out, and a
// tree with no smell answers [].
TEST(mcp_get_diagnostics_answers_each_smell_kind_once_with_its_count_and_first_ten_nodes) {
  Harness h;
  CHECK_FALSE(h.call("add_kind", parse(R"({"id":"k","hue":"terracotta"})")).isError);
  Json::Value bare = parse(R"({"nodes":[]})");
  for (int i = 1; i <= 12; ++i) {
    Json::Value node = parse(R"({"label":"B"})");
    node["id"] = std::string(i < 10 ? "b0" : "b") + std::to_string(i);
    bare["nodes"].append(node);
  }
  CHECK_FALSE(h.call("import_subgraph", bare).isError);
  CHECK_EQ(body(h.call("get_diagnostics", kNoArgs))["smells"],
           parse(R"([{"kind":"empty-icon","count":12,
             "nodes":["b01","b02","b03","b04","b05","b06","b07","b08","b09","b10"]}])"));

  Harness mixed;
  CHECK_FALSE(mixed.call("add_kind", parse(R"({"id":"k","hue":"terracotta"})")).isError);
  Json::Value batch = parse(R"({"nodes":[{"id":"p1","label":"P1","icon":"i"},{"id":"p2","label":"P2","icon":"i"},
    {"id":"p3","label":"P3","icon":"i"},{"id":"p4","label":"P4","icon":"i"},{"id":"p5","label":"P5","icon":"i"},
    {"id":"hub","label":"Hub","icon":"i","prerequisites":["p1","p2","p3","p4","p5"]},
    {"id":"plain","label":"Plain"},{"id":"olive","label":"Olive","icon":"i","color":"olive"}]})");
  Json::Value wordy = parse(R"({"id":"long","icon":"i"})");
  std::string label;  // a hundred code points, within the label cap, three hundred bytes past the smell's 256
  for (int i = 0; i < 100; ++i) label += "\xE6\x97\xA5";
  wordy["label"] = label;
  batch["nodes"].append(wordy);
  CHECK_FALSE(mixed.call("import_subgraph", batch).isError);
  CHECK_EQ(body(mixed.call("get_diagnostics", kNoArgs))["smells"],
           parse(R"([{"kind":"unclaimed-hue","hue":"olive","count":1,"nodes":["olive"]},
             {"kind":"label-too-long","count":1,"nodes":["long"]},{"kind":"empty-icon","count":1,"nodes":["plain"]},
             {"kind":"high-in-degree","count":1,"nodes":["hub"]}])"));

  Harness clean;
  CHECK_FALSE(clean.call("add_kind", parse(R"({"id":"k","hue":"terracotta"})")).isError);
  CHECK_FALSE(clean.call("import_subgraph", parse(R"({"nodes":[{"id":"a","label":"A","icon":"i"}]})")).isError);
  CHECK_EQ(body(clean.call("get_diagnostics", kNoArgs))["smells"], parse("[]"));
}

// Ten thousand nodes without an icon are one short smell line, not one line each.
TEST(mcp_ten_thousand_nodes_without_an_icon_answer_one_short_smell_line) {
  Harness h;
  TreeData data;
  data.id = TreeId{"t"};
  for (int i = 0; i < 10000; ++i) {
    NodeSpec node;
    const std::string digits = std::to_string(i);
    node.id = NodeId{"n" + std::string(5 - digits.size(), '0') + digits};
    node.label = "N";
    data.nodes.push_back(node);
  }
  h.trees.byId["t"] = StoredTree{LooseGraph(data, Hlc{1, 0, "seed"}).exportState(),
                                 Legend({{KindId{"k"}, NodeColor::terracotta, "K"}}, Hlc{1, 0, "seed"}).exportState(),
                                 {"Big", {}}, 0, h.caller};
  const Json::Value smells = body(h.call("get_diagnostics", kNoArgs))["smells"];
  CHECK_EQ(smells, parse(R"([{"kind":"empty-icon","count":10000,
    "nodes":["n00000","n00001","n00002","n00003","n00004","n00005","n00006","n00007","n00008","n00009"]}])"));
  CHECK(dump(smells).size() < 300);
}

// An import's progress rows are update_nodes marks: the same schema, the same checks and the same receipt, so a
// completion made before its prerequisites keeps its outOfOrder word through an import, a repeat says unchanged, and
// the marks get_progress answers go back through an import leaving the overlay as it was.
TEST(mcp_import_progress_rows_carry_out_of_order_as_update_nodes_marks_do) {
  Harness h;
  CHECK_FALSE(h.call("import_subgraph", parse(R"({"nodes":[{"id":"a","label":"A"},{"id":"b","label":"B",
    "prerequisites":["a"]},{"id":"c","label":"C"}]})")).isError);

  const char* early = R"({"nodes":[],"progress":[{"nodeId":"b","status":"complete","outOfOrder":true}]})";
  CHECK_EQ(body(h.call("import_subgraph", parse(early)))["progress"],
           parse(R"([{"nodeId":"b","status":"complete","prerequisitesMet":false,"acknowledged":true}])"));
  CHECK_EQ(body(h.call("get_progress", kNoArgs))["outOfOrder"], parse(R"(["b"])"));
  CHECK_EQ(body(h.call("import_subgraph", parse(early)))["progress"],
           parse(R"([{"nodeId":"b","status":"complete","prerequisitesMet":false,"acknowledged":true,"unchanged":true}])"));

  const std::string refusal = R"(argument "%s.outOfOrder" acknowledges completing a node before its prerequisites, )"
                              R"(so it rides status "complete" only, got "none")";
  const auto refused = [&](const char* path) {
    std::string sentence = refusal;
    sentence.replace(sentence.find("%s"), 2, path);
    return sentence;
  };
  CHECK_EQ(message(h.call("import_subgraph", parse(R"({"nodes":[],"progress":[{"nodeId":"c","status":"none",
    "outOfOrder":true}]})"))), "import_subgraph: " + refused("progress[0]"));
  CHECK_EQ(message(h.call("update_nodes", parse(R"({"updates":[{"nodeId":"c","status":"none","outOfOrder":true}]})"))),
           std::string("update_nodes: argument \"updates[0].outOfOrder\" acknowledges completing a node before its prerequisites, so it rides status \"complete\" only, got \"none\""));

  Json::Value updates, rows;
  for (const Json::Value& tool : h.tools.listTools(h.actor)) {
    if (tool["name"].asString() == "update_nodes") updates = tool["inputSchema"]["properties"]["updates"]["items"];
    if (tool["name"].asString() == "import_subgraph") rows = tool["inputSchema"]["properties"]["progress"]["items"];
  }
  REQUIRE(updates.isObject());
  for (const char* field : {"status", "outOfOrder"})
    CHECK_EQ(rows["properties"][field], updates["properties"][field]);

  CHECK_FALSE(h.call("update_nodes", parse(R"({"updates":[{"nodeId":"a","status":"complete"},
    {"nodeId":"c","status":"none"}]})")).isError);
  const Json::Value everyMark = parse(R"({"fields":["completed","cleared","outOfOrder"]})");
  const Json::Value held = body(h.call("get_progress", everyMark));
  CHECK_EQ(held, parse(R"({"completed":["a","b"],"cleared":["c"],"outOfOrder":["b"]})"));
  Json::Value sentBack = parse(R"({"nodes":[],"progress":[]})");
  std::set<std::string> acknowledged;
  for (const Json::Value& id : held["outOfOrder"]) acknowledged.insert(id.asString());
  for (const char* list : {"completed", "cleared"})
    for (const Json::Value& id : held[list]) {
      Json::Value row(Json::objectValue);
      row["nodeId"] = id;
      row["status"] = std::string(list) == "completed" ? "complete" : "none";
      if (acknowledged.count(id.asString())) row["outOfOrder"] = true;
      sentBack["progress"].append(row);
    }
  const Json::Value receipt = body(h.call("import_subgraph", sentBack));
  REQUIRE_EQ(receipt["progress"].size(), 3u);
  for (const Json::Value& row : receipt["progress"]) CHECK_EQ(row["unchanged"], Json::Value(true));
  CHECK_EQ(body(h.call("get_progress", everyMark)), held);
}

// A delete clears the caller's own stored mark on each node it deletes, in the same call, by either form and with or
// without prune, counted in pruned.progress; a mark someone else holds on the node stays theirs, and a revive of the
// node later brings no cleared mark back.
TEST(mcp_delete_node_clears_the_callers_marks_on_the_nodes_it_deletes) {
  for (const auto& [arguments, cleared, left] : std::vector<std::tuple<const char*, int, const char*>>{
           {R"({"nodeId":"a"})", 1, R"({"completed":["b"],"cleared":["a"]})"},
           {R"({"nodeId":"a","prune":true})", 1, R"({"completed":["b"],"cleared":["a"]})"},
           {R"({"nodeIds":["a","b","c"]})", 2, R"({"completed":[],"cleared":["a","b"]})"},
           {R"({"nodeIds":["a","b","c"],"prune":true})", 2, R"({"completed":[],"cleared":["a","b"]})"}}) {
    Harness h;
    h.trees.byId["t"].visibility = Visibility::public_;
    CHECK_FALSE(h.call("import_subgraph", parse(R"({"nodes":[{"id":"a","label":"A"},{"id":"b","label":"B"},
      {"id":"c","label":"C"}]})")).isError);
    CHECK_FALSE(h.call("update_nodes", parse(R"({"updates":[{"nodeId":"a","status":"complete"},
      {"nodeId":"b","status":"complete"}]})")).isError);
    const ToolCaller stranger{uid("stranger"), ToolScope::everything()};
    CHECK_FALSE(h.tools.callTool("update_nodes", parse(R"({"treeId":"t","updates":[{"nodeId":"a","status":"complete"}]})"), stranger)
                    .isError);

    CHECK_EQ(body(h.call("delete_node", parse(arguments)))["pruned"]["progress"].asInt(), cleared);
    CHECK_EQ(storedMarks(h.progress, h.caller), parse(left));
    CHECK_EQ(storedMarks(h.progress, stranger.user), parse(R"({"completed":["a"],"cleared":[]})"));

    CHECK_FALSE(h.call("import_subgraph", parse(R"({"nodes":[{"id":"a","label":"A"}]})")).isError);
    CHECK_EQ(storedMarks(h.progress, h.caller), parse(left));
    CHECK_EQ(storedMarks(h.progress, stranger.user), parse(R"({"completed":["a"],"cleared":[]})"));
  }
}

// A step that opens a tree keeps the mark it held before its pointer was set, and that mark goes with the step as any
// other does: a delete clears it, though a mark sent on the step is refused, get_progress answers nothing for the step
// while it is gone, and a step revived under its id holds none.
TEST(mcp_delete_node_clears_the_mark_a_step_that_opens_a_tree_kept) {
  Harness h;
  h.trees.byId["t_sub"] = StoredTree{LooseGraph().exportState(), LegendState{}, {"Deep dive", {}}, 0, h.caller};
  CHECK_FALSE(h.call("import_subgraph", parse(R"({"nodes":[{"id":"idea","label":"Idea"},{"id":"b","label":"B"}]})")).isError);
  CHECK_FALSE(h.call("update_nodes", parse(R"({"updates":[{"nodeId":"idea","status":"complete"},
    {"nodeId":"b","status":"complete"}]})")).isError);
  CHECK_FALSE(h.call("update_nodes", asUpdate(parse(R"({"nodeId":"idea","opens":"t_sub"})"))).isError);
  CHECK_EQ(body(h.call("update_nodes", asUpdate(parse(R"({"nodeId":"idea","status":"none"})"))))["progress"],
           parse(R"([{"nodeId":"idea","refused":"\"idea\" opens a tree: it is complete when that tree is and takes no mark of its own — mark the steps of the tree it opens"}])"));
  const auto marks = [&] {
    return body(h.call("get_progress", parse(R"({"fields":["completed","cleared"]})")));
  };
  CHECK_EQ(marks(), parse(R"({"completed":["b","idea"],"cleared":[]})"));

  CHECK_EQ(body(h.call("delete_node", parse(R"({"nodeId":"idea"})")))["pruned"], parse(R"({"edges":0,"progress":1})"));
  CHECK_EQ(storedMarks(h.progress, h.caller), parse(R"({"completed":["b"],"cleared":["idea"]})"));
  CHECK_EQ(marks(), parse(R"({"completed":["b"],"cleared":[]})"));
  CHECK_FALSE(h.call("create_node", parse(R"({"id":"idea","label":"Idea"})")).isError);
  CHECK_EQ(marks(), parse(R"({"completed":["b"],"cleared":["idea"]})"));
}

// A delete clears the caller's marks before it lands, so with the progress store down, reading or writing, the call fails
// with nothing deleted and the tree not saved, and once the store is back a retry does the whole of it.
TEST(mcp_delete_node_with_the_progress_store_down_deletes_nothing_and_a_retry_completes_it) {
  for (const bool readsDown : {true, false}) {
    Harness h;
    CHECK_FALSE(h.call("create_node", parse(R"({"id":"a","label":"A"})")).isError);
    CHECK_FALSE(h.call("update_nodes", asUpdate(parse(R"({"nodeId":"a","status":"complete"})"))).isError);
    const std::size_t saves = h.trees.savedNodeCounts.size();
    const std::size_t rows = h.ops.byTree["t"].size();
    (readsDown ? h.progressRepo.loadsFail : h.progressRepo.writesFail) = true;
    CHECK_EQ(message(h.call("delete_node", parse(R"({"nodeId":"a"})"))),
             std::string("delete_node: that call failed inside the server. The outcome may be uncertain; read the "
                         "affected records before retrying. The detail is in the server log."));
    CHECK(h.registry.open(TreeId{"t"})->hasNode(NodeId{"a"}));
    CHECK_EQ(h.trees.savedNodeCounts.size(), saves);
    CHECK_EQ(h.ops.byTree["t"].size(), rows);

    h.progressRepo.loadsFail = h.progressRepo.writesFail = false;
    CHECK_EQ(body(h.call("delete_node", parse(R"({"nodeId":"a"})")))["pruned"], parse(R"({"edges":0,"progress":1})"));
    CHECK_FALSE(h.registry.open(TreeId{"t"})->hasNode(NodeId{"a"}));
    CHECK_EQ(storedMarks(h.progress, h.caller), parse(R"({"completed":[],"cleared":["a"]})"));
  }
}

// A server's progress write comes after the stamp the caller's mark holds, so it lands over a mark a replica stamped
// ahead of the server: a delete clears one, counted from what landed, a revive brings none back, and an update_nodes
// mark of none clears one too.
TEST(mcp_a_server_progress_write_lands_over_a_mark_stamped_ahead_of_the_server) {
  Harness h;
  CHECK_FALSE(h.call("import_subgraph", parse(R"({"nodes":[{"id":"a","label":"A"},{"id":"b","label":"B"}]})")).isError);
  const std::uint64_t ahead = h.clock.ms + 120000;  // a phone two minutes ahead, inside the socket's five
  for (const char* node : {"a", "b"})
    REQUIRE(h.progressRepo.setStatuses(TreeId{"t"}, h.caller,
                                       {{NodeId{node}, ProgressStatus::complete, false, Hlc{ahead, 0, "phone"}}},
                                       h.clock.ms).front());

  CHECK_EQ(body(h.call("delete_node", parse(R"({"nodeId":"a"})")))["pruned"], parse(R"({"edges":0,"progress":1})"));
  CHECK_EQ(body(h.call("update_nodes", asUpdate(parse(R"({"nodeId":"b","status":"none"})")))),
           parse(R"({"applied":true,"changedNodeIds":[],"diagnosticsClean":true,"dryRun":false,"introducedDiagnostics":[],"progress":[{"nodeId":"b","prerequisitesMet":true,"status":"none"}],"seq":2,"treeId":"t","unchanged":true,"unchangedNodeIds":["b"]})"));
  const Json::Value cleared = parse(R"({"completed":[],"cleared":["a","b"]})");
  CHECK_EQ(storedMarks(h.progress, h.caller), cleared);
  CHECK_FALSE(h.call("create_node", parse(R"({"id":"a","label":"A"})")).isError);
  CHECK_EQ(body(h.call("get_progress", parse(R"({"fields":["completed","cleared"]})"))), cleared);
}

// A clear reaches the caller's open sessions as a mark does: one progress frame for the marks it cleared, from a
// delete and from an import's tombstone alike.
TEST(mcp_a_clear_sends_the_progress_frame_a_mark_sends) {
  Harness h;
  CHECK_FALSE(h.call("import_subgraph", parse(R"({"nodes":[{"id":"a","label":"A"},{"id":"b","label":"B"}]})")).isError);
  CHECK_FALSE(h.call("update_nodes", parse(R"({"updates":[{"nodeId":"a","status":"complete"},
    {"nodeId":"b","status":"complete"}]})")).isError);
  const std::size_t frames = h.bus.progressBroadcasts.size();

  CHECK_FALSE(h.call("delete_node", parse(R"({"nodeId":"a"})")).isError);
  REQUIRE_EQ(h.bus.progressBroadcasts.size(), frames + 1);
  CHECK_EQ(h.bus.progressBroadcasts.back().user, h.caller.str());
  CHECK_EQ(h.bus.progressBroadcasts.back().marks.cleared, (std::set<NodeId>{NodeId{"a"}}));
  CHECK(h.bus.progressBroadcasts.back().marks.completed.empty());

  CHECK_FALSE(h.call("import_subgraph", parse(R"({"nodes":[],"tombstone":["b"]})")).isError);
  REQUIRE_EQ(h.bus.progressBroadcasts.size(), frames + 2);
  CHECK_EQ(h.bus.progressBroadcasts.back().marks.cleared, (std::set<NodeId>{NodeId{"b"}}));
  CHECK(h.bus.progressBroadcasts.back().marks.completed.empty());
}

// An import's tombstones clear the caller's marks after the graft has landed, so a progress store that fails there does
// not fail the call: the reply says progressApplied: false, and the failure is reported under its own name — one
// report, under the request's latch.
TEST(mcp_an_imports_failed_clear_is_reported_under_its_own_name) {
  struct Failures : FailureReporter {
    std::vector<std::string> reports;
    void report(const std::string&, const std::string&, const std::string&) override {}
    void reportWrite(const std::string& operation, const std::string& product, const std::string& door,
                     const std::string& outcome, const std::string&, const std::string& exceptionType) override {
      reports.push_back(operation + " " + product + " " + door + " " + outcome + " " + exceptionType);
    }
  };
  struct ReporterScope {
    std::shared_ptr<Failures> failures = std::make_shared<Failures>();
    ReporterScope() { installWriteReporter(failures); }
    ~ReporterScope() { installWriteReporter(nullptr); }
  } reporter;
  Harness h;
  CHECK_FALSE(h.call("import_subgraph", parse(R"({"nodes":[{"id":"a","label":"A"}]})")).isError);
  CHECK_FALSE(h.call("update_nodes", asUpdate(parse(R"({"nodeId":"a","status":"complete"})"))).isError);
  CompositeToolHost gate(std::vector<ToolModule>{{h.tools, ""}});
  std::vector<std::string> lines;
  installWriteSink([&](const WriteCompletion& line) { lines.push_back(line.operation + " " + line.outcome); });

  h.progressRepo.writesFail = true;
  const Json::Value receipt =
      body(gate.callTool("roadmap_import_subgraph", parse(R"({"treeId":"t","nodes":[],"tombstone":["a"]})"), h.actor));
  installWriteSink({});
  CHECK_EQ(receipt["graphApplied"], Json::Value(true));
  CHECK_EQ(receipt["progressApplied"], Json::Value(false));
  CHECK_EQ(receipt["progressError"], Json::Value("The graph committed, but clearing progress on removed nodes failed. "
                                                 "Read get_progress before retrying progress changes."));
  CHECK_EQ(reporter.failures->reports,
           (std::vector<std::string>{std::string("roadmap.import.clear_marks roadmap mcp failed ") +
                                     typeid(std::runtime_error).name()}));
  CHECK_EQ(lines, (std::vector<std::string>{"roadmap.import.clear_marks failed", "mcp.roadmap_import_subgraph ok"}));
  CHECK_FALSE(h.registry.open(TreeId{"t"})->hasNode(NodeId{"a"}));
}

// A mark the caller's own replica stamped ahead of the server is overwritten and cleared just after its stamp — a node
// named twice in one batch after its own row — and carries nothing else ahead: the room's clock does not learn it, so
// the caller's next mark on another node, the tree's next graph write and, after a restart, the one after that carry
// the stamps they carry on a twin tree whose mark was stamped a moment ago.
TEST(mcp_a_mark_stamped_ahead_carries_no_other_write_ahead) {
  const auto run = [](bool ahead) -> std::vector<std::string> {
    Harness h;
    CHECK_FALSE(h.call("import_subgraph", parse(R"({"nodes":[{"id":"a","label":"A"},{"id":"b","label":"B"},
      {"id":"c","label":"C"}]})")).isError);
    const Hlc held{ahead ? h.clock.ms + 120000 : h.clock.ms - 1, 0, "phone"};
    CHECK(h.progressRepo.setStatuses(TreeId{"t"}, h.caller, {{NodeId{"a"}, ProgressStatus::complete, false, held}},
                                       h.clock.ms).front());
    const auto stampOf = [&](const char* node) {
      return h.progressRepo.byKey.at(fake::FakeProgressRepository::key(TreeId{"t"}, h.caller, NodeId{node})).at;
    };
    const auto lastFrame = [&] { return h.bus.subgraphBroadcasts.back().subgraph.frameId; };
    const std::string server{TreeRoom::kServerActor};

    CHECK_FALSE(h.call("import_subgraph", parse(R"({"nodes":[],"progress":[{"nodeId":"a","status":"none"},
      {"nodeId":"a","status":"complete"}]})")).isError);
    if (ahead) CHECK_EQ(stampOf("a"), (Hlc{held.physicalMs, 2, server}));
    CHECK_EQ(body(h.call("delete_node", parse(R"({"nodeId":"a"})")))["pruned"], parse(R"({"edges":0,"progress":1})"));
    if (ahead) CHECK_EQ(stampOf("a"), (Hlc{held.physicalMs, 3, server}));

    CHECK_FALSE(h.call("update_nodes", asUpdate(parse(R"({"nodeId":"b","status":"complete"})"))).isError);
    CHECK_FALSE(h.call("update_nodes", asUpdate(parse(R"({"nodeId":"c","label":"C1"})"))).isError);
    std::vector<std::string> stamps{toString(stampOf("b")), lastFrame()};

    RoomRegistry restarted{h.trees, h.ops, h.bus};
    ProgressService restartedProgress{h.progressRepo, h.trees};
    TreeRegistry restartedTrees{h.trees, h.progressRepo, h.tokens, Hlc{1, 0, "genesis"}, restarted, h.clock};
    RoadmapTools tools{restarted, restartedProgress, h.clock, restartedTrees, h.bus, "https://app.example"};
    CHECK_FALSE(tools.callTool("update_nodes", parse(R"({"treeId":"t","updates":[{"nodeId":"c","label":"C2"}]})"), h.actor).isError);
    stamps.push_back(lastFrame());

    CHECK(stampOf("b").physicalMs < h.clock.ms);
    for (const std::string& frame : {stamps[1], stamps[2]})
      CHECK(parseHlc(frame.substr(std::string("srv-").size())).value().physicalMs < h.clock.ms);
    return stamps;
  };
  CHECK_EQ(run(true), run(false));
}

// A reader's mark stamped ahead moves nothing of the owner's: on a public tree, a stranger's own write lands just after
// their ahead mark, its counter spent, and the owner's next graph frame carries the stamp it carries on a twin tree
// whose stranger stamped a moment ago.
TEST(mcp_a_readers_mark_stamped_ahead_moves_nothing_of_the_owners) {
  const auto run = [](bool ahead) -> std::string {
    Harness h;
    h.trees.byId["t"].visibility = Visibility::public_;
    CHECK_FALSE(h.call("import_subgraph", parse(R"({"nodes":[{"id":"a","label":"A"}]})")).isError);
    const UserId stranger = fake::uid("stranger");
    const Hlc held{ahead ? h.clock.ms + 300000 : h.clock.ms - 1, std::numeric_limits<std::uint32_t>::max(), "phone"};
    CHECK(h.progressRepo.setStatuses(TreeId{"t"}, stranger, {{NodeId{"a"}, ProgressStatus::complete, false, held}},
                                       h.clock.ms).front());

    CHECK_FALSE(h.tools.callTool("update_nodes", parse(R"({"treeId":"t","updates":[{"nodeId":"a","status":"none"}]})"),
                                 ToolCaller{stranger, ToolScope::everything()}).isError);
    const Hlc cleared = h.progressRepo.byKey.at(fake::FakeProgressRepository::key(TreeId{"t"}, stranger, NodeId{"a"})).at;
    if (ahead) CHECK_EQ(cleared, (Hlc{held.physicalMs + 1, 0, std::string{TreeRoom::kServerActor}}));
    CHECK_FALSE(h.call("update_nodes", asUpdate(parse(R"({"nodeId":"a","label":"A1"})"))).isError);

    const std::string frame = h.bus.subgraphBroadcasts.back().subgraph.frameId;
    CHECK(parseHlc(frame.substr(std::string("srv-").size())).value().physicalMs < h.clock.ms);
    return frame;
  };
  CHECK_EQ(run(true), run(false));
}

namespace {

// A kind k on sky, labelled and briefed, worn by a and b, and a kind j on gold.
std::unique_ptr<Harness> kindTree() {
  auto h = std::make_unique<Harness>();
  CHECK_FALSE(h->call("add_kind", parse(R"({"id":"k","hue":"sky","label":"K","description":"Brief."})")).isError);
  CHECK_FALSE(h->call("add_kind", parse(R"({"id":"j","hue":"gold","label":"J"})")).isError);
  CHECK_FALSE(h->call("import_subgraph", parse(R"({"nodes":[{"id":"a","label":"A","kind":"k"},
    {"id":"b","label":"B","kind":"k"},{"id":"c","label":"C","kind":"j"}]})")).isError);
  return h;
}

// An op row as the log holds it, every field but the server's receipt time.
Json::Value opRows(Harness& h) {
  Json::Value rows(Json::arrayValue);
  for (const AppliedOp& op : h.ops.byTree["t"]) {
    Json::Value row(Json::objectValue);
    row["seq"] = static_cast<Json::Int64>(op.seq);
    row["opId"] = op.opId;
    row["command"] = static_cast<Json::UInt64>(op.command.index());
    row["payload"] = commandPayload(op.command);
    row["hlc"] = toString(op.hlc);
    row["actor"] = op.actor.str();
    rows.append(row);
  }
  return rows;
}

}

// update_kind relabels, re-briefs and re-hues a kind in one call: one op under one seq, every node wearing the kind's
// old hue repainted and counted, and the rest of the legend untouched.
TEST(mcp_update_kind_relabels_rebriefs_and_rehues_a_kind_in_one_op) {
  auto h = kindTree();
  const std::size_t rows = h->ops.byTree["t"].size();
  const Json::Int64 seq = body(h->call("get_tree", parse(R"({"includeGuides":false})")))["seq"].asInt64();

  Json::Value expected = parse(R"({"applied":true,"id":"k","repaintedNodes":2,"diagnosticsClean":true,
    "introducedDiagnostics":[]})");
  expected["seq"] = seq + 1;
  CHECK_EQ(body(h->call("update_kind", parse(R"({"id":"k","label":"Kay","description":"New brief.","hue":"plum"})"))),
           expected);
  REQUIRE_EQ(h->ops.byTree["t"].size(), rows + 1);
  CHECK(std::holds_alternative<Batch>(h->ops.byTree["t"].back().command));
  CHECK_EQ(body(h->call("get_tree", parse(R"({"includeGuides":false,"fields":["id","color","kind"],
    "kindFields":["id","hue","label","description"]})")))["tree"]["kinds"],
           parse(R"([{"id":"k","hue":"plum","label":"Kay","description":"New brief."},
             {"id":"j","hue":"gold","label":"J","description":""}])"));
  CHECK_EQ(body(h->call("get_nodes", parse(R"({"nodeIds":["a","b","c"],"fields":["id","color","kind"]})")))["nodes"],
           parse(R"([{"id":"a","color":"plum","kind":"k"},{"id":"b","color":"plum","kind":"k"},
             {"id":"c","color":"gold","kind":"j"}])"));
}

// Each field alone lands as its own command — RenameKind, DescribeKind or RecolorKind — as one op row under one seq: the
// legend takes it, a new hue repaints the kind's nodes and the receipt counts them, and the Activity feed tells it in
// that command's sentence.
TEST(mcp_update_kind_lands_each_field_alone_as_its_own_command) {
  for (const auto& [arguments, receipt, row, kinds, nodes, summary] :
       std::vector<std::tuple<const char*, const char*, const char*, const char*, const char*, const char*>>{
           {R"({"id":"k","label":"Kay"})", R"({"applied":true,"id":"k"})",
            R"({"kind":"RenameKind","payload":{"id":"k","label":"Kay"}})",
            R"([{"id":"k","hue":"sky","label":"Kay","description":"Brief."},{"id":"j","hue":"gold","label":"J","description":""}])",
            R"([{"id":"a","color":"sky"},{"id":"b","color":"sky"},{"id":"c","color":"gold"}])", "renamed a kind to Kay"},
           {R"({"id":"k","description":"New brief."})", R"({"applied":true,"id":"k"})",
            R"({"kind":"DescribeKind","payload":{"id":"k","description":"New brief."}})",
            R"([{"id":"k","hue":"sky","label":"K","description":"New brief."},{"id":"j","hue":"gold","label":"J","description":""}])",
            R"([{"id":"a","color":"sky"},{"id":"b","color":"sky"},{"id":"c","color":"gold"}])", "described a kind"},
           {R"({"id":"k","hue":"plum"})", R"({"applied":true,"id":"k","repaintedNodes":2})",
            R"({"kind":"RecolorKind","payload":{"id":"k","hue":"plum"}})",
            R"([{"id":"k","hue":"plum","label":"K","description":"Brief."},{"id":"j","hue":"gold","label":"J","description":""}])",
            R"([{"id":"a","color":"plum"},{"id":"b","color":"plum"},{"id":"c","color":"gold"}])", "recolored a kind plum"}}) {
    auto h = kindTree();
    const std::size_t rows = h->ops.byTree["t"].size();
    const Json::Int64 seq = body(h->call("get_tree", parse(R"({"includeGuides":false})")))["seq"].asInt64();
    Json::Value expected = parse(receipt);
    expected["seq"] = seq + 1;
    expected["diagnosticsClean"] = true;
    expected["introducedDiagnostics"] = Json::Value(Json::arrayValue);
    CHECK_EQ(body(h->call("update_kind", parse(arguments))), expected);

    REQUIRE_EQ(h->ops.byTree["t"].size(), rows + 1);
    const AppliedOp& op = h->ops.byTree["t"].back();
    Json::Value landed(Json::objectValue);
    landed["kind"] = commandKind(op.command);
    landed["payload"] = commandPayload(op.command);
    CHECK_EQ(landed, parse(row));
    CHECK_EQ(static_cast<Json::Int64>(op.seq), seq + 1);
    CHECK_EQ(body(h->call("get_tree", parse(R"({"includeGuides":false,"fields":["id"],
      "kindFields":["id","hue","label","description"]})")))["tree"]["kinds"],
             parse(kinds));
    CHECK_EQ(body(h->call("get_nodes", parse(R"({"nodeIds":["a","b","c"],"fields":["id","color"]})")))["nodes"],
             parse(nodes));
    CHECK_EQ(activityFeed(h->registry.open(TreeId{"t"})->snapshot(), h->ops.byTree["t"], 1).back().summary,
             std::string(summary));
  }
}

// A field sent as the kind holds it is left out, so a call that changes nothing writes nothing and answers unchanged
// with the tree's seq; one that changes one field of three lands that field alone, as its earlier tool would.
TEST(mcp_update_kind_leaves_out_what_the_kind_holds) {
  auto h = kindTree();
  const std::size_t rows = h->ops.byTree["t"].size();
  const StoredTree stored = h->trees.byId["t"];
  const Json::Int64 seq = body(h->call("get_tree", parse(R"({"includeGuides":false})")))["seq"].asInt64();

  Json::Value unchanged = parse(R"({"applied":true,"id":"k","unchanged":true,"diagnosticsClean":true,
    "introducedDiagnostics":[]})");
  unchanged["seq"] = seq;
  CHECK_EQ(body(h->call("update_kind", parse(R"({"id":"k","label":"K","description":"Brief.","hue":"sky"})"))),
           unchanged);
  CHECK_EQ(h->ops.byTree["t"].size(), rows);
  CHECK(h->trees.byId["t"] == stored);

  CHECK_FALSE(h->call("update_kind", parse(R"({"id":"k","label":"K","description":"Changed.","hue":"sky"})")).isError);
  REQUIRE_EQ(h->ops.byTree["t"].size(), rows + 1);
  CHECK((std::holds_alternative<DescribeKind>(h->ops.byTree["t"].back().command)));
}

// An unknown kind, a hue another kind wears and a missing id are refused naming what is wrong, a call that sends nothing
// to set names all three fields, and a `kindId` is not taken; nothing is applied.
TEST(mcp_update_kind_refuses_an_unknown_kind_a_taken_hue_and_nothing_to_set) {
  auto h = kindTree();
  const StoredTree stored = h->trees.byId["t"];
  CHECK_EQ(message(h->call("update_kind", parse(R"({"id":"x","label":"X"})"))),
           std::string("update_kind: no kind \"x\" in this legend"));
  CHECK_EQ(message(h->call("update_kind", parse(R"({"id":"k","hue":"gold"})"))),
           std::string("update_kind: hue \"gold\" already belongs to kind \"j\" — a hue names one kind, so pick a "
                       "free one"));
  CHECK_EQ(message(h->call("update_kind", parse(R"({"label":"Kay"})"))),
           std::string("update_kind: missing required argument \"id\". Call get_tree and read `kinds` to list this "
                       "legend's ids."));
  CHECK_EQ(message(h->call("update_kind", parse(R"({"id":"k"})"))),
           std::string("update_kind: nothing to set — pass at least one of \"label\", \"description\", \"hue\"."));
  CompositeToolHost gate(std::vector<ToolModule>{{h->tools, ""}});
  CHECK_EQ(message(gate.callTool("update_kind", parse(R"({"treeId":"t","kindId":"k","label":"Kay"})"), h->actor)),
           std::string("update_kind: unknown argument \"kindId\". This tool takes: description, hue, id, label, "
                       "treeId."));
  CHECK(h->trees.byId["t"] == stored);
}

namespace {

// A tree whose kind owner wears gold, holding a — with a description and a link — and b after it, beside a tree t_sub
// of the caller's that a node may open.
std::unique_ptr<Harness> nodeTree() {
  auto h = std::make_unique<Harness>();
  h->plant("t_sub", h->caller, "", {});
  CHECK_FALSE(h->call("add_kind", parse(R"({"id":"owner","hue":"gold"})")).isError);
  CHECK_FALSE(h->call("import_subgraph", parse(R"({"nodes":[{"id":"a","label":"A","description":"Old.",
    "links":[{"url":"https://a.example/"}]},{"id":"b","label":"B","prerequisites":["a"]}]})")).isError);
  return h;
}

// The progress overlay as the repository holds it, stamps included.
Json::Value overlayRows(Harness& h) {
  Json::Value rows(Json::objectValue);
  for (const auto& [key, entry] : h.progressRepo.byKey)
    rows[key] = std::string(progressStatusName(entry.status)) + " " + toString(entry.at) +
                (entry.outOfOrder ? " outOfOrder" : "");
  return rows;
}

}

// One update_nodes call renames a node, files it under a kind, appends to its description, adds a link and marks it
// complete: the tree fields land as ONE op, and the mark lands after them, answered per row in `progress`.
TEST(mcp_update_nodes_edits_a_node_and_marks_it_in_one_call) {
  auto h = nodeTree();
  const std::size_t rows = h->ops.byTree["t"].size();
  const Json::Int64 seq = body(h->call("get_tree", parse(R"({"includeGuides":false})")))["seq"].asInt64();

  Json::Value expected = parse(R"({"treeId":"t","changedNodeIds":["a"],"unchangedNodeIds":[],"dryRun":false,
    "applied":true,"diagnosticsClean":true,"introducedDiagnostics":[],
    "progress":[{"nodeId":"a","status":"complete","prerequisitesMet":true}]})");
  expected["seq"] = seq + 1;
  CHECK_EQ(body(h->call("update_nodes", parse(R"({"updates":[{"nodeId":"a","label":"Alpha","kind":"owner",
    "appendDescription":"More.","addLinks":[{"url":"https://b.example/","label":"B"}],"status":"complete"}]})"))),
           expected);
  CHECK_EQ(h->ops.byTree["t"].size(), rows + 1);
  CHECK_EQ(body(h->call("get_nodes", parse(R"({"nodeIds":["a"],"fields":["id","label","color","kind","description",
    "links"]})")))["nodes"],
           parse(R"([{"id":"a","label":"Alpha","color":"gold","kind":"owner","description":"Old.\n\nMore.",
             "links":[{"url":"https://a.example/"},{"url":"https://b.example/","label":"B"}]}])"));
  CHECK_EQ(body(h->call("get_progress", kNoArgs))["completed"], parse(R"(["a"])"));
}

// A mark is the caller's own overlay: a call whose rows carry only marks works on a tree the caller can read and does
// not own, writing no op; a call carrying any tree field there is refused whole, and no mark lands.
TEST(mcp_update_nodes_marks_a_tree_the_caller_reads_and_refuses_a_tree_field_there_whole) {
  auto h = nodeTree();
  h->registry.setVisibility(TreeId{"t"}, Visibility::public_);
  const ToolCaller stranger{uid("stranger"), ToolScope::everything()};
  const std::size_t rows = h->ops.byTree["t"].size();
  const StoredTree stored = h->trees.byId["t"];
  const Json::Int64 seq = body(h->call("get_tree", parse(R"({"includeGuides":false})")))["seq"].asInt64();
  const auto progressOf = [&] {
    return body(h->tools.callTool("get_progress", parse(R"({"treeId":"t"})"), stranger))["completed"];
  };

  Json::Value expected = parse(R"({"treeId":"t","changedNodeIds":[],"unchangedNodeIds":["a"],"dryRun":false,
    "applied":true,"unchanged":true,"diagnosticsClean":true,"introducedDiagnostics":[],
    "progress":[{"nodeId":"a","status":"complete","prerequisitesMet":true}]})");
  expected["seq"] = seq;
  CHECK_EQ(body(h->tools.callTool("update_nodes", parse(R"({"treeId":"t","updates":[{"nodeId":"a","status":"complete"}]})"),
                                  stranger)),
           expected);
  CHECK_EQ(h->ops.byTree["t"].size(), rows);
  CHECK_EQ(progressOf(), parse(R"(["a"])"));

  CHECK_EQ(message(h->tools.callTool("update_nodes", parse(R"({"treeId":"t","updates":[{"nodeId":"b","status":"complete"},
    {"nodeId":"a","label":"Mine"}]})"), stranger)),
           std::string("update_nodes: this tree belongs to another account. Call list_trees to see the roadmaps you "
                       "own."));
  CHECK_EQ(progressOf(), parse(R"(["a"])"));
  CHECK(h->trees.byId["t"] == stored);
}

// One row with one field lands as the lone command that field is — RenameNode, SetNodeColor (a `kind` as the hue it
// wears), or AnnotateNode carrying that register alone, `addLinks` as the links the node then holds — as one op row
// under one seq. A label or a colour is a line of the Activity feed and an annotation is none. A mark lands on the
// caller's overlay and writes no op row.
TEST(mcp_update_nodes_lands_one_field_as_its_own_command) {
  Json::StreamWriterBuilder compact;
  compact["indentation"] = "";
  const char* node = R"("description":"Old.","icon":"","id":"a","label":"A","links":[{"url":"https://a.example/"}])";
  for (const auto& [updates, row, stored, feed] : std::vector<std::tuple<const char*, std::string, std::string, const char*>>{
           {R"([{"nodeId":"a","label":"Alpha"}])", R"(RenameNode {"id":"a","label":"Alpha"})",
            R"([{"color":"terracotta","description":"Old.","icon":"","id":"a","label":"Alpha","links":[{"url":"https://a.example/"}],"status":"none"}])",
            "3 renamed to Alpha"},
           {R"([{"nodeId":"a","color":"sky"}])", R"(SetNodeColor {"color":"sky","id":"a"})",
            std::string(R"([{"color":"sky",)") + node + R"(,"status":"none"}])", "3 recolored A sky"},
           {R"([{"nodeId":"a","kind":"owner"}])", R"(SetNodeColor {"color":"gold","id":"a"})",
            R"([{"color":"gold","description":"Old.","icon":"","id":"a","kind":"owner","label":"A","links":[{"url":"https://a.example/"}],"status":"none"}])",
            "3 recolored A gold"},
           {R"([{"nodeId":"a","description":"New."}])", R"(AnnotateNode {"description":"New.","id":"a"})",
            R"([{"color":"terracotta","description":"New.","icon":"","id":"a","label":"A","links":[{"url":"https://a.example/"}],"status":"none"}])",
            "2 added A"},
           {R"([{"nodeId":"a","appendDescription":"More."}])", R"(AnnotateNode {"appendDescription":"More.","id":"a"})",
            R"([{"color":"terracotta","description":"Old.\n\nMore.","icon":"","id":"a","label":"A","links":[{"url":"https://a.example/"}],"status":"none"}])",
            "2 added A"},
           {R"([{"nodeId":"a","icon":"star"}])", R"(AnnotateNode {"icon":"star","id":"a"})",
            R"([{"color":"terracotta","description":"Old.","icon":"star","id":"a","label":"A","links":[{"url":"https://a.example/"}],"status":"none"}])",
            "2 added A"},
           {R"([{"nodeId":"a","links":[{"url":"https://c.example/"}]}])", R"(AnnotateNode {"id":"a","links":[{"url":"https://c.example/"}]})",
            R"([{"color":"terracotta","description":"Old.","icon":"","id":"a","label":"A","links":[{"url":"https://c.example/"}],"status":"none"}])",
            "2 added A"},
           {R"([{"nodeId":"a","addLinks":[{"url":"https://c.example/","label":"C"}]}])",
            R"(AnnotateNode {"id":"a","links":[{"url":"https://a.example/"},{"label":"C","url":"https://c.example/"}]})",
            R"([{"color":"terracotta","description":"Old.","icon":"","id":"a","label":"A","links":[{"url":"https://a.example/"},{"label":"C","url":"https://c.example/"}],"status":"none"}])",
            "2 added A"},
           {R"([{"nodeId":"a","opens":"t_sub"}])", R"(AnnotateNode {"id":"a","opens":"t_sub"})",
            std::string(R"([{"color":"terracotta",)") + node +
                R"(,"opens":{"state":"open","title":"Tree t_sub","treeId":"t_sub"},"status":"none"}])",
            "2 added A"}}) {
    auto h = nodeTree();
    const std::size_t rows = h->ops.byTree["t"].size();
    Json::Value call(Json::objectValue);
    call["updates"] = parse(updates);
    CHECK_EQ(body(h->call("update_nodes", call)),
             parse(R"({"treeId":"t","changedNodeIds":["a"],"unchangedNodeIds":[],"dryRun":false,"applied":true,"seq":3,
               "diagnosticsClean":true,"introducedDiagnostics":[]})"));
    REQUIRE_EQ(h->ops.byTree["t"].size(), rows + 1);
    const AppliedOp& op = h->ops.byTree["t"].back();
    CHECK_EQ(commandKind(op.command) + " " + Json::writeString(compact, commandPayload(op.command)), row);
    CHECK_EQ(op.seq, Seq{3});
    CHECK_EQ(Json::writeString(compact, body(h->call("get_nodes", parse(R"({"nodeIds":["a"],"fields":["id","label",
      "color","kind","description","icon","links","opens","status"]})")))["nodes"]),
             stored);
    const ActivityEvent newest = activityFeed(h->registry.open(TreeId{"t"})->snapshot(), h->ops.byTree["t"], 1).back();
    CHECK_EQ(std::to_string(newest.seq) + " " + newest.summary, std::string(feed));
  }

  auto h = nodeTree();
  const std::size_t rows = h->ops.byTree["t"].size();
  CHECK_EQ(body(h->call("update_nodes", parse(R"({"updates":[{"nodeId":"a","status":"complete"}]})"))),
           parse(R"({"treeId":"t","changedNodeIds":[],"unchangedNodeIds":["a"],"dryRun":false,"applied":true,"seq":2,
             "unchanged":true,"diagnosticsClean":true,"introducedDiagnostics":[],
             "progress":[{"nodeId":"a","status":"complete","prerequisitesMet":true}]})"));
  CHECK_EQ(h->ops.byTree["t"].size(), rows);
  CHECK_EQ(body(h->call("get_progress", kNoArgs))["completed"], parse(R"(["a"])"));
}

// A field sent as the node holds it is left out, an addLinks url the node holds included, so a row that changes nothing
// is listed unchanged and a call that lands nothing on the tree says so and writes no op.
TEST(mcp_update_nodes_leaves_out_what_the_node_holds) {
  auto h = nodeTree();
  const std::size_t rows = h->ops.byTree["t"].size();
  const Json::Int64 seq = body(h->call("get_tree", parse(R"({"includeGuides":false})")))["seq"].asInt64();
  Json::Value expected = parse(R"({"treeId":"t","changedNodeIds":[],"unchangedNodeIds":["a","b"],"dryRun":false,
    "applied":true,"unchanged":true,"diagnosticsClean":true,"introducedDiagnostics":[]})");
  expected["seq"] = seq;
  CHECK_EQ(body(h->call("update_nodes", parse(R"({"updates":[{"nodeId":"a","label":"A","description":"Old.",
    "addLinks":[{"url":"https://a.example/"}]},{"nodeId":"b","label":"B","color":"terracotta"}]})"))),
           expected);
  CHECK_EQ(h->ops.byTree["t"].size(), rows);
}

// A stale expectedSeq refuses the whole call, marks included; a dry run applies nothing, previews the tree batch and
// answers no mark rows; a row's either/or pairs and an empty row are refused naming the row.
TEST(mcp_update_nodes_refuses_stale_calls_whole_and_previews_without_marking) {
  auto h = nodeTree();
  const std::size_t rows = h->ops.byTree["t"].size();
  const StoredTree stored = h->trees.byId["t"];
  const Json::Int64 seq = body(h->call("get_tree", parse(R"({"includeGuides":false})")))["seq"].asInt64();

  for (const char* updates : {R"([{"nodeId":"a","label":"Alpha","status":"complete"}])",
                              R"([{"nodeId":"a","status":"complete"}])"}) {
    Json::Value stale(Json::objectValue);
    stale["expectedSeq"] = seq - 1;
    stale["updates"] = parse(updates);
    CHECK_EQ(message(h->call("update_nodes", stale)),
             "update_nodes: expectedSeq conflict: requested " + std::to_string(seq - 1) + ", current seq is " +
                 std::to_string(seq) + ". Nothing changed; read get_nodes or get_tree and retry with the current seq.");
  }

  Json::Value preview = parse(R"({"treeId":"t","changedNodeIds":["a"],"unchangedNodeIds":["b"],"dryRun":true,
    "applied":false})");
  preview["seq"] = seq;
  CHECK_EQ(body(h->call("update_nodes", parse(R"({"dryRun":true,"updates":[{"nodeId":"a","label":"Alpha",
    "status":"complete"},{"nodeId":"b","status":"complete"}]})"))),
           preview);

  for (const auto& [updates, refusal] : std::vector<std::pair<const char*, std::string>>{
           {R"([{"nodeId":"a","description":"New.","appendDescription":"More."}])",
            "updates[0]: \"description\" and \"appendDescription\" are both given — pass one: description replaces the "
            "body, appendDescription joins onto it."},
           {R"([{"nodeId":"a","links":[],"addLinks":[{"url":"https://c.example/"}]}])",
            "updates[0]: \"links\" and \"addLinks\" are both given — pass one: links replaces the set, addLinks joins "
            "onto it."},
           {R"([])", "updates must contain 1 to 200 node patches"},
           {R"([{"nodeId":"a"}])",
            "updates[0] sets nothing — pass at least one of label, color, kind, description, appendDescription, icon, "
            "links, addLinks, opens, status."}}) {
    Json::Value call(Json::objectValue);
    call["updates"] = parse(updates);
    CHECK_EQ(message(h->call("update_nodes", call)), "update_nodes: " + refusal);
  }
  const Json::Value nullOpens = parse(R"({"updates":[{"nodeId":"a","opens":null}]})");
  const std::string patched = message(h->call("update_nodes", nullOpens));
  CHECK(h->call("update_nodes", nullOpens).isError);
  CHECK_EQ(message(h->call("update_nodes", nullOpens)), "update_nodes" + patched.substr(patched.find(": ")));
  CHECK_EQ(h->ops.byTree["t"].size(), rows);
  CHECK(h->trees.byId["t"] == stored);
  CHECK_EQ(body(h->call("get_progress", kNoArgs))["completed"], parse("[]"));
}

// The marks land after a tree op the call landed, which stands whatever becomes of the marks: a progress store that
// fails there does not fail the call. The reply says so in a fixed sentence, the call's own line is `ok`, and the
// failure is reported under its own name — one report, under the request's latch.
TEST(mcp_update_nodes_whose_marks_fail_after_a_tree_op_landed_says_so_and_reports_under_its_own_name) {
  struct Failures : FailureReporter {
    std::vector<std::string> reports;
    void report(const std::string&, const std::string&, const std::string&) override {}
    void reportWrite(const std::string& operation, const std::string& product, const std::string& door,
                     const std::string& outcome, const std::string&, const std::string& exceptionType) override {
      reports.push_back(operation + " " + product + " " + door + " " + outcome + " " + exceptionType);
    }
  };
  struct ReporterScope {
    std::shared_ptr<Failures> failures = std::make_shared<Failures>();
    ReporterScope() { installWriteReporter(failures); }
    ~ReporterScope() { installWriteReporter(nullptr); }
  } reporter;
  auto h = nodeTree();
  const Json::Int64 seq = body(h->call("get_tree", parse(R"({"includeGuides":false})")))["seq"].asInt64();
  CompositeToolHost gate(std::vector<ToolModule>{{h->tools, ""}});
  std::vector<std::string> lines;
  installWriteSink([&](const WriteCompletion& line) { lines.push_back(line.operation + " " + line.outcome); });

  h->progressRepo.writesFail = true;
  const Json::Value receipt = body(gate.callTool(
      "roadmap_update_nodes", parse(R"({"treeId":"t","updates":[{"nodeId":"a","label":"Alpha","status":"complete"}]})"),
      h->actor));
  installWriteSink({});
  h->progressRepo.writesFail = false;

  Json::Value expected = parse(R"({"treeId":"t","changedNodeIds":["a"],"unchangedNodeIds":[],"dryRun":false,
    "applied":true,"diagnosticsClean":true,"introducedDiagnostics":[],"progressApplied":false,
    "progressError":"The marks' outcome is uncertain. Read get_progress before retrying progress changes."})");
  expected["seq"] = seq + 1;
  CHECK_EQ(receipt, expected);
  CHECK_EQ(reporter.failures->reports,
           (std::vector<std::string>{std::string("roadmap.update_nodes.marks roadmap mcp failed ") +
                                     typeid(std::runtime_error).name()}));
  CHECK_EQ(lines, (std::vector<std::string>{"roadmap.update_nodes.marks failed", "mcp.roadmap_update_nodes ok"}));
  CHECK_EQ(body(h->call("get_nodes", parse(R"({"nodeIds":["a"],"fields":["id","label"]})")))["nodes"],
           parse(R"([{"id":"a","label":"Alpha"}])"));
  CHECK_EQ(body(h->call("get_progress", kNoArgs))["completed"], parse("[]"));
}

// When no tree op lands in the call — it sends no tree field, or only fields the node holds — its marks are the call,
// so a progress store that fails fails the call: an error reply in the server's words, the call's own line `failed`,
// its report under the call's name, and no line of the marks' own.
TEST(mcp_update_nodes_whose_marks_are_the_call_fails_with_them) {
  struct Failures : FailureReporter {
    std::vector<std::string> reports;
    void report(const std::string&, const std::string&, const std::string&) override {}
    void reportWrite(const std::string& operation, const std::string& product, const std::string& door,
                     const std::string& outcome, const std::string&, const std::string& exceptionType) override {
      reports.push_back(operation + " " + product + " " + door + " " + outcome + " " + exceptionType);
    }
  };
  struct ReporterScope {
    std::shared_ptr<Failures> failures = std::make_shared<Failures>();
    ReporterScope() { installWriteReporter(failures); }
    ~ReporterScope() { installWriteReporter(nullptr); }
  } reporter;
  const auto failing = [&](const char* tool, const char* arguments) {
    auto h = nodeTree();
    const std::size_t rows = h->ops.byTree["t"].size();
    CompositeToolHost gate(std::vector<ToolModule>{{h->tools, ""}});
    std::vector<std::string> lines;
    installWriteSink([&](const WriteCompletion& line) { lines.push_back(line.operation + " " + line.outcome); });
    reporter.failures->reports.clear();
    h->progressRepo.writesFail = true;
    const ToolResult result = gate.callTool(tool, parse(arguments), h->actor);
    installWriteSink({});
    h->progressRepo.writesFail = false;
    CHECK(result.isError);
    CHECK_EQ(h->ops.byTree["t"].size(), rows);
    CHECK_EQ(body(h->call("get_progress", kNoArgs))["completed"], parse("[]"));
    std::vector<std::string> said{message(result)};
    for (const std::string& line : lines) said.push_back(line);
    for (const std::string& report : reporter.failures->reports) said.push_back(report);
    return said;
  };
  const std::string type = typeid(std::runtime_error).name();
  for (const char* updates : {R"([{"nodeId":"a","status":"complete"}])",
                              R"([{"nodeId":"a","label":"A","description":"Old.","status":"complete"}])"}) {
    const std::string arguments = std::string(R"({"treeId":"t","updates":)") + updates + "}";
    CHECK_EQ(failing("roadmap_update_nodes", arguments.c_str()),
             (std::vector<std::string>{
                 "update_nodes: that call failed inside the server. The outcome may be uncertain; read the affected "
                 "records before retrying. The detail is in the server log.",
                 "mcp.roadmap_update_nodes failed", "mcp.roadmap_update_nodes roadmap mcp failed " + type}));
  }
}

// A mark on a node that opens a tree is refused in update_nodes row by row, in a sentence that names no tree, and listed in
// progressRefused. When the marks are the call and each was refused, nothing was written: the reply is no error, and the
// call completes as opens-a-tree. Beside a mark that lands, or a tree op, it is ok.
TEST(mcp_update_nodes_refuses_a_mark_on_a_node_that_opens_a_tree_row_by_row) {
  Harness h;
  h.trees.byId["t_sub"] = StoredTree{LooseGraph().exportState(), LegendState{}, {"Deep dive", {}}, 0, h.caller};
  CHECK_FALSE(h.call("import_subgraph", parse(R"({"nodes":[{"id":"idea","label":"Idea","opens":"t_sub"},{"id":"a","label":"A"}]})")).isError);
  CompositeToolHost gate(std::vector<ToolModule>{{h.tools, ""}});
  std::vector<std::string> lines;
  installWriteSink([&](const WriteCompletion& line) { lines.push_back(line.operation + " " + line.outcome); });
  const auto updateNodes = [&](const char* updates) {
    return gate.callTool("roadmap_update_nodes", parse(std::string(R"({"treeId":"t","updates":)") + updates + "}"), h.actor);
  };

  const ToolResult refused = updateNodes(R"([{"nodeId":"idea","status":"complete"}])");
  const ToolResult beside = updateNodes(R"([{"nodeId":"idea","status":"none"},{"nodeId":"a","status":"complete"}])");
  const ToolResult edited = updateNodes(R"([{"nodeId":"a","label":"A2"},{"nodeId":"idea","status":"complete"}])");
  installWriteSink({});

  const std::string refusedRow = R"({"nodeId":"idea","refused":"\"idea\" opens a tree: it is complete when that tree is and takes no mark of its own — mark the steps of the tree it opens"})";
  const std::string refusedSentence = R"("progressError":"Some requested progress marks nodes that open a tree, which take no mark of their own — each is complete when the tree it opens is; those ids are listed in progressRefused.")";
  CHECK_FALSE(refused.isError);
  CHECK_EQ(body(refused), parse(R"({"applied":true,"changedNodeIds":[],"diagnosticsClean":true,"dryRun":false,
    "introducedDiagnostics":[],"progress":[)" + refusedRow + R"(],"progressApplied":false,)" + refusedSentence +
                                R"(,"progressRefused":["idea"],"seq":1,"treeId":"t","unchanged":true,"unchangedNodeIds":["idea"]})"));
  CHECK_FALSE(beside.isError);
  CHECK_EQ(body(beside), parse(R"({"applied":true,"changedNodeIds":[],"diagnosticsClean":true,"dryRun":false,
    "introducedDiagnostics":[],"progress":[)" + refusedRow + R"(,{"nodeId":"a","status":"complete","prerequisitesMet":true}],
    "progressApplied":false,)" + refusedSentence +
                               R"(,"progressRefused":["idea"],"seq":1,"treeId":"t","unchanged":true,"unchangedNodeIds":["idea","a"]})"));
  CHECK_FALSE(edited.isError);
  CHECK_EQ(body(edited), parse(R"({"applied":true,"changedNodeIds":["a"],"diagnosticsClean":true,"dryRun":false,
    "introducedDiagnostics":[],"progress":[)" + refusedRow + R"(],"progressApplied":false,)" + refusedSentence +
                               R"(,"progressRefused":["idea"],"seq":2,"treeId":"t","unchangedNodeIds":["idea"]})"));
  CHECK_EQ(body(h.call("get_progress", kNoArgs)), parse(R"({"completed":["a"],"outOfOrder":[]})"));
  CHECK_EQ(lines, (std::vector<std::string>{"mcp.roadmap_update_nodes opens-a-tree", "mcp.roadmap_update_nodes ok",
                                            "mcp.roadmap_update_nodes ok"}));
}

// A `kind` that is not a string is no kind sent, so beside a mark it leaves the row a mark alone: on
// the caller's tree, and on another account's public tree, where a tree field would be refused.
TEST(mcp_update_nodes_takes_a_null_kind_beside_a_mark_as_no_tree_field) {
  auto h = nodeTree();
  const std::size_t rows = h->ops.byTree["t"].size();
  const Json::Int64 seq = body(h->call("get_tree", parse(R"({"includeGuides":false})")))["seq"].asInt64();
  Json::Value expected = parse(R"({"treeId":"t","changedNodeIds":[],"unchangedNodeIds":["a"],"dryRun":false,
    "applied":true,"unchanged":true,"diagnosticsClean":true,"introducedDiagnostics":[],
    "progress":[{"nodeId":"a","status":"complete","prerequisitesMet":true}]})");
  expected["seq"] = seq;
  CHECK_EQ(body(h->call("update_nodes", parse(R"({"updates":[{"nodeId":"a","kind":null,"status":"complete"}]})"))),
           expected);

  h->registry.setVisibility(TreeId{"t"}, Visibility::public_);
  const ToolCaller stranger{uid("stranger"), ToolScope::everything()};
  CHECK_EQ(body(h->tools.callTool("update_nodes",
                                  parse(R"({"treeId":"t","updates":[{"nodeId":"a","kind":null,"outOfOrder":null,
                                    "status":"complete"}]})"),
                                  stranger)),
           expected);
  CHECK_EQ(h->ops.byTree["t"].size(), rows);
}

namespace {

// Nodes a, b and c, and the one edge a → b.
std::unique_ptr<Harness> edgeTree() {
  auto h = std::make_unique<Harness>();
  CHECK_FALSE(h->call("import_subgraph", parse(R"({"nodes":[{"id":"a","label":"A"},{"id":"b","label":"B",
    "prerequisites":["a"]},{"id":"c","label":"C"}]})")).isError);
  return h;
}

// Each node's prerequisites, as get_tree answers them.
Json::Value prerequisitesOf(Harness& h) {
  Json::Value shape(Json::objectValue);
  shape["fields"] = list({"id", "prerequisites"});
  return body(h.call("get_tree", shape))["tree"]["nodes"];
}

// The op rows the log gained since `from`, each as its kind and payload.
Json::Value rowsSince(Harness& h, std::size_t from) {
  Json::Value rows(Json::arrayValue);
  const std::vector<AppliedOp>& ops = h.ops.byTree["t"];
  for (std::size_t i = from; i < ops.size(); ++i) {
    Json::Value row(Json::objectValue);
    row["seq"] = static_cast<Json::Int64>(ops[i].seq);
    row["kind"] = commandKind(ops[i].command);
    row["payload"] = commandPayload(ops[i].command);
    rows.append(row);
  }
  return rows;
}

}

// One edge added is one AddEdge op row under one seq, and the receipt names it beside the diagnostics: clean for an
// edge that closes nothing, and naming the cycle one closes.
TEST(mcp_change_edges_adds_one_edge_as_one_add_edge_row) {
  for (const auto& [args, receipt, rows] : std::vector<std::tuple<const char*, const char*, const char*>>{
           {R"({"add":[{"from":"b","to":"c"}]})",
            R"({"treeId":"t","applied":true,"dryRun":false,"seq":2,"addedEdges":[{"from":"b","to":"c"}],
              "removedEdges":[],"unchangedEdges":0,"diagnosticsClean":true,"introducedDiagnostics":[]})",
            R"([{"seq":2,"kind":"AddEdge","payload":{"from":"b","to":"c"}}])"},
           {R"({"add":[{"from":"b","to":"a"}]})",
            R"({"treeId":"t","applied":true,"dryRun":false,"seq":2,"addedEdges":[{"from":"b","to":"a"}],
              "removedEdges":[],"unchangedEdges":0,"diagnosticsClean":false,
              "introducedDiagnostics":["cycle among \"a\", \"b\""]})",
            R"([{"seq":2,"kind":"AddEdge","payload":{"from":"b","to":"a"}}])"}}) {
    auto h = edgeTree();
    const std::size_t before = h->ops.byTree["t"].size();
    CHECK_EQ(body(h->call("change_edges", parse(args))), parse(receipt));
    CHECK_EQ(rowsSince(*h, before), parse(rows));
  }
}

// A move — one edge removed and one added that keeps its source or its target, both landing — is the one command that
// moves an edge, as a lone change is its own command: ONE ReconnectEdge op row under one seq, which the Activity feed
// tells as a reroute naming the edge it now is.
TEST(mcp_change_edges_moves_an_edge_as_one_reconnect_edge_row) {
  for (const auto& [args, receipt, row, prerequisites, event] :
       std::vector<std::tuple<const char*, const char*, const char*, const char*, std::vector<std::string>>>{
           {R"({"remove":[{"from":"a","to":"b"}],"add":[{"from":"a","to":"c"}]})",
            R"({"treeId":"t","applied":true,"dryRun":false,"seq":2,"addedEdges":[{"from":"a","to":"c"}],
              "removedEdges":[{"from":"a","to":"b"}],"unchangedEdges":0,"diagnosticsClean":true,"introducedDiagnostics":[]})",
            R"([{"seq":2,"kind":"ReconnectEdge","payload":{"oldFrom":"a","oldTo":"b","newFrom":"a","newTo":"c"}}])",
            R"([{"id":"a","prerequisites":[]},{"id":"b","prerequisites":[]},{"id":"c","prerequisites":["a"]}])",
            {"2", "", "rerouted", "c", "C", "terracotta", "rerouted A → C"}},
           {R"({"remove":[{"from":"a","to":"b"}],"add":[{"from":"c","to":"b"}]})",
            R"({"treeId":"t","applied":true,"dryRun":false,"seq":2,"addedEdges":[{"from":"c","to":"b"}],
              "removedEdges":[{"from":"a","to":"b"}],"unchangedEdges":0,"diagnosticsClean":true,"introducedDiagnostics":[]})",
            R"([{"seq":2,"kind":"ReconnectEdge","payload":{"oldFrom":"a","oldTo":"b","newFrom":"c","newTo":"b"}}])",
            R"([{"id":"a","prerequisites":[]},{"id":"b","prerequisites":["c"]},{"id":"c","prerequisites":[]}])",
            {"2", "", "rerouted", "b", "B", "terracotta", "rerouted C → B"}}}) {
    auto h = edgeTree();
    const std::size_t before = h->ops.byTree["t"].size();
    CHECK_EQ(body(h->call("change_edges", parse(args))), parse(receipt));
    CHECK_EQ(rowsSince(*h, before), parse(row));
    CHECK_EQ(prerequisitesOf(*h), parse(prerequisites));
    const ActivityEvent moved = activityFeed(h->registry.open(TreeId{"t"})->snapshot(), h->ops.byTree["t"], 1).back();
    CHECK_EQ((std::vector<std::string>{std::to_string(moved.seq), moved.actor, moved.verb, moved.node.str(), moved.label,
                                       moved.kind, moved.summary}),
             event);
  }
}

// A removal and an addition that keep neither the source nor the target in its place are two changes, not a move: one
// Batch row of both, which the feed tells by its parts under the removal's subject.
TEST(mcp_change_edges_lands_a_removal_and_an_unrelated_addition_as_one_batch) {
  for (const char* args : {R"({"remove":[{"from":"a","to":"b"}],"add":[{"from":"c","to":"d"}]})",
                           R"({"remove":[{"from":"a","to":"b"}],"add":[{"from":"b","to":"c"}]})"}) {
    auto h = edgeTree();
    CHECK_FALSE(h->call("create_node", node("d", "D")).isError);
    const std::size_t before = h->ops.byTree["t"].size();
    const Json::Value added = parse(args)["add"][0];
    CHECK_FALSE(h->call("change_edges", parse(args)).isError);
    Json::Value rows = parse(R"([{"seq":3,"kind":"Batch","payload":{"commands":[
      {"kind":"RemoveEdge","payload":{"from":"a","to":"b"}},{"kind":"AddEdge","payload":{}}]}}])");
    rows[0]["payload"]["commands"][1]["payload"] = added;
    CHECK_EQ(rowsSince(*h, before), rows);
    const ActivityEvent changed = activityFeed(h->registry.open(TreeId{"t"})->snapshot(), h->ops.byTree["t"], 1).back();
    CHECK_EQ((std::vector<std::string>{changed.verb, changed.node.str(), changed.summary}),
             (std::vector<std::string>{"unlinked", "b", "unlinked 1 link and linked 1 link"}));
  }
}

// A move whose one half is an echo — the edge to add is held, or the edge to remove is absent — lands the other half
// alone, as its own command.
TEST(mcp_change_edges_lands_the_lone_half_of_a_move_as_itself) {
  for (const auto& [args, row] : std::vector<std::pair<const char*, const char*>>{
           {R"({"remove":[{"from":"a","to":"b"}],"add":[{"from":"a","to":"c"}]})",
            R"([{"seq":3,"kind":"RemoveEdge","payload":{"from":"a","to":"b"}}])"},
           {R"({"remove":[{"from":"b","to":"c"}],"add":[{"from":"a","to":"c"}]})",
            R"([])"},
           {R"({"remove":[{"from":"c","to":"b"}],"add":[{"from":"b","to":"c"}]})",
            R"([{"seq":3,"kind":"AddEdge","payload":{"from":"b","to":"c"}}])"}}) {
    auto h = edgeTree();
    CHECK_FALSE(h->call("change_edges", parse(R"({"add":[{"from":"a","to":"c"}]})")).isError);
    const std::size_t before = h->ops.byTree["t"].size();
    CHECK_FALSE(h->call("change_edges", parse(args)).isError);
    CHECK_EQ(rowsSince(*h, before), parse(row));
  }
}

// A move whose new edge names a node the tree does not hold lands nothing: the old edge stays and no op row is
// written. An edge to such a node is refused alone too.
TEST(mcp_a_change_edges_move_lands_whole_or_not_at_all) {
  auto h = edgeTree();
  const StoredTree stored = h->trees.byId["t"];
  const std::size_t rows = h->ops.byTree["t"].size();
  for (const char* args : {R"({"remove":[{"from":"a","to":"b"}],"add":[{"from":"a","to":"ghost"}]})",
                           R"({"add":[{"from":"a","to":"ghost"}]})"})
    CHECK_EQ(message(h->call("change_edges", parse(args))),
             std::string("change_edges: no node in this tree is named \"ghost\""));
  CHECK(h->trees.byId["t"] == stored);
  CHECK_EQ(h->ops.byTree["t"].size(), rows);
}

// Edges removed are a lone RemoveEdge row for one and one Batch for several; an edge the tree does not hold is no row
// of it, and the receipt counts it unchanged.
TEST(mcp_change_edges_removes_edges_as_remove_edge_rows) {
  for (const auto& [named, receipt, rows] : std::vector<std::tuple<const char*, const char*, const char*>>{
           {R"([{"from":"a","to":"b"}])",
            R"({"treeId":"t","applied":true,"dryRun":false,"seq":3,"addedEdges":[],"removedEdges":[{"from":"a","to":"b"}],
              "unchangedEdges":0,"diagnosticsClean":true,"introducedDiagnostics":[]})",
            R"([{"seq":3,"kind":"RemoveEdge","payload":{"from":"a","to":"b"}}])"},
           {R"([{"from":"a","to":"b"},{"from":"b","to":"c"},{"from":"x","to":"y"}])",
            R"({"treeId":"t","applied":true,"dryRun":false,"seq":3,"addedEdges":[],
              "removedEdges":[{"from":"a","to":"b"},{"from":"b","to":"c"}],"unchangedEdges":1,"diagnosticsClean":true,
              "introducedDiagnostics":[]})",
            R"([{"seq":3,"kind":"Batch","payload":{"commands":[{"kind":"RemoveEdge","payload":{"from":"a","to":"b"}},
              {"kind":"RemoveEdge","payload":{"from":"b","to":"c"}}]}}])"}}) {
    auto h = edgeTree();
    CHECK_FALSE(h->call("change_edges", parse(R"({"add":[{"from":"b","to":"c"}]})")).isError);
    const std::size_t before = h->ops.byTree["t"].size();
    Json::Value remove(Json::objectValue);
    remove["remove"] = parse(named);
    CHECK_EQ(body(h->call("change_edges", remove)), parse(receipt));
    CHECK_EQ(rowsSince(*h, before), parse(rows));
  }
}

// change_edges takes up to 500 edges in a call and refuses 501, naming the list.
TEST(mcp_change_edges_takes_up_to_500_edges_in_a_call) {
  auto h = edgeTree();
  const auto named = [](std::size_t count) {
    Json::Value rows(Json::arrayValue);
    for (std::size_t i = 0; i < count; ++i) rows.append(edge("a", ("absent-" + std::to_string(i)).c_str()));
    return rows;
  };
  Json::Value remove(Json::objectValue);
  remove["remove"] = named(500);
  CHECK_EQ(body(h->call("change_edges", remove))["unchangedEdges"].asUInt(), 500u);
  remove["remove"] = named(501);
  CHECK_EQ(message(h->call("change_edges", remove)), std::string("change_edges: remove has 501 items, max 500"));
}

// An edge whose node is deleted and an edge from a node to itself are removed by naming them, and the diagnostics clear.
TEST(mcp_change_edges_removes_a_dangling_and_a_self_edge_by_name) {
  auto h = edgeTree();
  CHECK_FALSE(h->call("change_edges", parse(R"({"add":[{"from":"c","to":"c"}]})")).isError);
  CHECK_FALSE(h->call("delete_node", parse(R"({"nodeId":"b"})")).isError);
  CHECK_EQ(body(h->call("get_diagnostics", kNoArgs))["dangling"].size(), 1u);
  CHECK_EQ(body(h->call("change_edges", parse(R"({"remove":[{"from":"a","to":"b"},{"from":"c","to":"c"}]})"))),
           parse(R"({"treeId":"t","applied":true,"dryRun":false,"seq":4,"addedEdges":[],
             "removedEdges":[{"from":"a","to":"b"},{"from":"c","to":"c"}],"unchangedEdges":0,"diagnosticsClean":true,
             "introducedDiagnostics":[]})"));
  CHECK(body(h->call("get_diagnostics", kNoArgs))["dangling"].empty());
}

// A tree at its edge cap refuses one edge more, saying change_edges removes edges; removing one in the same call makes
// room.
TEST(mcp_change_edges_refuses_an_edge_past_the_cap) {
  Harness h;
  LooseGraph graph;
  graph.createNode(NodeId{"a"}, "A", "", NodeColor::sky, std::nullopt, Hlc{1, 0, "seed"});
  graph.createNode(NodeId{"b"}, "B", "", NodeColor::sky, std::nullopt, Hlc{1, 0, "seed"});
  for (std::size_t i = 0; i < kMaxEdges; ++i) graph.addEdge(NodeId{"a"}, NodeId{"m-" + std::to_string(i)}, Hlc{2, 0, "seed"});
  h.trees.byId["t"] = StoredTree{graph.exportState(), LegendState{}, {"Full", {}}, 0, h.caller};
  CHECK_EQ(message(h.call("change_edges", parse(R"({"add":[{"from":"a","to":"b"}]})"))),
           std::string("change_edges: this tree would hold 20001 edges, max 20000 — remove edges with change_edges "
                       "before adding more"));
  CHECK_EQ(body(h.call("change_edges", parse(R"({"remove":[{"from":"a","to":"m-0"}],
    "add":[{"from":"a","to":"b"}]})")))["addedEdges"], parse(R"([{"from":"a","to":"b"}])"));
}

// An edge added that the tree holds, and one removed that it does not, write nothing and answer unchanged.
TEST(mcp_change_edges_writes_nothing_for_an_edge_held_or_absent) {
  auto h = edgeTree();
  const std::size_t rows = h->ops.byTree["t"].size();
  CHECK_EQ(body(h->call("change_edges", parse(R"({"add":[{"from":"a","to":"b"}],"remove":[{"from":"c","to":"a"}]})"))),
           parse(R"({"treeId":"t","applied":true,"dryRun":false,"seq":1,"addedEdges":[],"removedEdges":[],
             "unchangedEdges":2,"unchanged":true,"diagnosticsClean":true,"introducedDiagnostics":[]})"));
  CHECK_EQ(h->ops.byTree["t"].size(), rows);
}

// connect, disconnect and reconnect are retired, change_edges being the one edge tool: no declaration carries them, and
// a call to one is refused as a tool the server does not have, in the gate's own words, with nothing written.
TEST(mcp_the_retired_edge_tools_are_refused_as_unknown_tools) {
  auto h = edgeTree();
  const StoredTree stored = h->trees.byId["t"];
  const std::size_t rows = h->ops.byTree["t"].size();
  CompositeToolHost gate(std::vector<ToolModule>{{h->tools, ""}});
  for (const std::string name : {"connect", "disconnect", "reconnect"}) {
    for (const Json::Value& tool : h->tools.listTools(h->actor)) CHECK(tool["name"].asString() != name);
    const ToolResult refused = gate.callTool(name, parse(R"({"treeId":"t","from":"b","to":"c","oldFrom":"a",
      "oldTo":"b","newFrom":"a","newTo":"c"})"), h->actor);
    CHECK(refused.isError);
    CHECK_EQ(message(refused), name + ": no such tool on this server — call tools/list for the whole surface.");
  }
  CHECK(h->trees.byId["t"] == stored);
  CHECK_EQ(h->ops.byTree["t"].size(), rows);
}

// The lists the batch tools take are published whole — bounds, each item's properties, what an item requires, and no
// other key — so a caller is refused at the schema what the handler would refuse. Prose aside, every key is pinned.
TEST(mcp_the_batch_tools_publish_their_lists_whole) {
  Harness h;
  std::function<Json::Value(Json::Value)> shape = [&](Json::Value schema) {
    if (schema.isObject()) {
      if (schema.isMember("description") && schema["description"].isString()) schema.removeMember("description");
      for (const std::string& key : schema.getMemberNames()) schema[key] = shape(schema[key]);
    }
    if (schema.isArray())
      for (Json::ArrayIndex i = 0; i < schema.size(); ++i) schema[i] = shape(schema[i]);
    return schema;
  };
  std::map<std::string, Json::Value> lists;
  for (const Json::Value& tool : h.tools.listTools(h.actor)) {
    const Json::Value& properties = tool["inputSchema"]["properties"];
    for (const char* list : {"add", "remove", "updates", "nodeIds"})
      if (properties.isMember(list))  // through text, so a count reads the same whether it was built signed or not
        lists[tool["name"].asString() + "." + list] = parse(dump(shape(properties[list])));
  }
  const Json::Value edges = parse(R"({"type":"array","maxItems":500,"uniqueItems":true,"items":{"type":"object",
    "additionalProperties":false,"required":["from","to"],"properties":{"from":{"type":"string","maxLength":128},
    "to":{"type":"string","maxLength":128}}}})");
  const Json::Value links = parse(R"({"type":"array","maxItems":32,"items":{"type":"object","additionalProperties":false,
    "required":["url"],"properties":{"label":{"type":"string","maxLength":200},"url":{"type":"string","maxLength":2048}}}})");
  Json::Value addLinks = links;
  addLinks["minItems"] = 1;
  Json::Value updates = parse(R"({"type":"array","minItems":1,"maxItems":200,"items":{"type":"object",
    "additionalProperties":false,"required":["nodeId"],"properties":{
      "nodeId":{"type":"string","maxLength":128},"label":{"type":"string","maxLength":200},
      "color":{"type":"string","enum":["terracotta","olive","gold","brick","sky","plum"]},
      "kind":{"type":"string","maxLength":128},"description":{"type":"string","maxLength":16000},
      "appendDescription":{"type":"string","maxLength":16000},"icon":{"type":"string","maxLength":64},
      "opens":{"type":"string","maxLength":128},"status":{"type":"string","enum":["complete","none"]},
      "outOfOrder":{"type":"boolean"}}}})");
  updates["items"]["properties"]["links"] = links;
  updates["items"]["properties"]["addLinks"] = addLinks;
  CHECK_EQ(lists.at("change_edges.add"), edges);
  CHECK_EQ(lists.at("change_edges.remove"), edges);
  CHECK_EQ(lists.at("update_nodes.updates"), updates);
  CHECK_EQ(lists.at("delete_node.nodeIds"),
           parse(R"({"type":"array","minItems":1,"maxItems":200,"items":{"type":"string","maxLength":128}})"));
}

// A legend's order is the order its kinds were created or imported in: create_tree keeps the order it is sent, add_kind
// places a kind after the last, and an import places its new kinds after the last in batch order while a kind it
// re-sends keeps its place.
TEST(mcp_a_legends_order_is_the_order_its_kinds_were_created_or_imported_in) {
  Harness h;
  const auto order = [&](const char* tree) {
    Json::Value args(Json::objectValue);
    args["treeId"] = tree;
    args["kindFields"] = list({"id"});
    const Json::Value read = body(h.tools.callTool("get_tree", args, h.actor));
    std::vector<std::string> ids;
    for (const Json::Value& kind : read["tree"]["kinds"]) ids.push_back(kind["id"].asString());
    return ids;
  };
  CHECK_FALSE(h.call("import_subgraph", parse(R"({"nodes":[],"kinds":[{"id":"z","hue":"sky"},{"id":"y","hue":"plum"},
    {"id":"x","hue":"gold"}]})")).isError);
  CHECK_EQ(order("t"), (std::vector<std::string>{"z", "y", "x"}));
  CHECK_FALSE(h.call("add_kind", parse(R"({"id":"w","hue":"olive"})")).isError);
  CHECK_EQ(order("t"), (std::vector<std::string>{"z", "y", "x", "w"}));
  CHECK_FALSE(h.call("import_subgraph", parse(R"({"nodes":[],"kinds":[{"id":"v","hue":"brick"},{"id":"x","hue":"gold",
    "label":"Ex"}]})")).isError);
  CHECK_EQ(order("t"), (std::vector<std::string>{"z", "y", "x", "w", "v"}));

  const Json::Value created = body(h.tools.callTool(
      "create_tree", parse(R"({"title":"Ordered","kinds":[{"id":"q","hue":"sky"},{"id":"p","hue":"plum"}]})"), h.actor));
  CHECK_EQ(order(created["treeId"].asCString()), (std::vector<std::string>{"q", "p"}));
}

// rename_kind, describe_kind, recolor_kind and reorder_kinds are retired, update_kind being the one tool that changes a
// kind: no declaration carries them, and a call to one is refused as a tool the server does not have, in the gate's own
// words, with nothing written.
TEST(mcp_the_retired_kind_tools_are_refused_as_unknown_tools) {
  auto h = kindTree();
  const StoredTree stored = h->trees.byId["t"];
  const std::size_t rows = h->ops.byTree["t"].size();
  CompositeToolHost gate(std::vector<ToolModule>{{h->tools, ""}});
  for (const std::string name : {"rename_kind", "describe_kind", "recolor_kind", "reorder_kinds"}) {
    for (const Json::Value& tool : h->tools.listTools(h->actor)) CHECK(tool["name"].asString() != name);
    const ToolResult refused = gate.callTool(name, parse(R"({"treeId":"t","id":"k","label":"Kay","description":"B",
      "hue":"plum","order":["j","k"]})"), h->actor);
    CHECK(refused.isError);
    CHECK_EQ(message(refused), name + ": no such tool on this server — call tools/list for the whole surface.");
  }
  CHECK(h->trees.byId["t"] == stored);
  CHECK_EQ(h->ops.byTree["t"].size(), rows);
}

// rename_node, set_node_color, annotate_node, patch_nodes, move_node and set_progress are retired, update_nodes being
// the one tool that edits or marks nodes: no declaration carries them, and a call to one is refused as a tool the
// server does not have, in the gate's own words, with nothing written and no mark landed.
TEST(mcp_the_retired_node_and_progress_tools_are_refused_as_unknown_tools) {
  auto h = nodeTree();
  const StoredTree stored = h->trees.byId["t"];
  const std::size_t rows = h->ops.byTree["t"].size();
  CompositeToolHost gate(std::vector<ToolModule>{{h->tools, ""}});
  for (const std::string name : {"rename_node", "set_node_color", "annotate_node", "patch_nodes", "move_node",
                                 "set_progress"}) {
    for (const Json::Value& tool : h->tools.listTools(h->actor)) CHECK(tool["name"].asString() != name);
    const ToolResult refused = gate.callTool(name, parse(R"({"treeId":"t","nodeId":"a","label":"Alpha","color":"plum",
      "description":"New.","x":3,"y":4,"status":"complete","updates":[{"nodeId":"a","label":"Alpha","status":"complete"}]})"),
      h->actor);
    CHECK(refused.isError);
    CHECK_EQ(message(refused), name + ": no such tool on this server — call tools/list for the whole surface.");
  }
  CHECK(h->trees.byId["t"] == stored);
  CHECK_EQ(h->ops.byTree["t"].size(), rows);
  CHECK_EQ(body(h->call("get_progress", kNoArgs)), parse(R"({"completed":[],"outOfOrder":[]})"));
}

// A node's position is off the MCP surface: create_node takes no x or y, an import's node and an update_nodes row no
// position, and no read answers one. Each is refused at the gate in its own words, with nothing written.
TEST(mcp_a_node_position_is_refused_wherever_the_surface_took_or_answered_it) {
  auto h = nodeTree();
  const StoredTree stored = h->trees.byId["t"];
  const std::size_t rows = h->ops.byTree["t"].size();
  CompositeToolHost gate(std::vector<ToolModule>{{h->tools, ""}});
  const auto refusal = [&](const char* tool, const char* arguments) {
    Json::Value args = parse(arguments);
    args["treeId"] = "t";
    const ToolResult result = gate.callTool(tool, args, h->actor);
    CHECK(result.isError);
    return message(result);
  };

  CHECK_EQ(refusal("create_node", R"({"id":"n","label":"N","x":3,"y":4})"),
           std::string("create_node: unknown argument \"x\". This tool takes: color, description, icon, id, kind, "
                       "label, links, opens, parentId, prerequisites, treeId."));
  CHECK_EQ(refusal("import_subgraph", R"({"nodes":[{"id":"n","label":"N","position":{"x":3,"y":4}}]})"),
           std::string("import_subgraph: unknown argument \"nodes[0].position\". nodes[0] takes: color, description, "
                       "icon, id, kind, label, links, opens, order, prerequisites, seedStatus."));
  CHECK_EQ(refusal("update_nodes", R"({"updates":[{"nodeId":"a","position":{"x":3,"y":4}}]})"),
           std::string("update_nodes: unknown argument \"updates[0].position\". updates[0] takes: addLinks, "
                       "appendDescription, color, description, icon, kind, label, links, nodeId, opens, outOfOrder, "
                       "status."));
  const std::string readable = " \"position\" is not one of {id, label, icon, color, kind, order, prerequisites, "
                               "status, seedStatus, state, summary, description, links, opens, url}";
  CHECK_EQ(refusal("get_tree", R"({"fields":["id","position"]})"), "get_tree: fields[1]" + readable);
  CHECK_EQ(refusal("get_nodes", R"({"nodeIds":["a"],"fields":["id","position"]})"), "get_nodes: fields[1]" + readable);
  CHECK_EQ(refusal("find_nodes", R"({"query":"A","fields":["id","position"]})"), "find_nodes: fields[1]" + readable);
  CHECK(h->trees.byId["t"] == stored);
  CHECK_EQ(h->ops.byTree["t"].size(), rows);
}

// A node's position stays the domain's: a client's frame sets it, and no MCP write moves or clears it — an import that
// re-sends the node and an update_nodes row carry none.
TEST(mcp_a_position_a_client_set_survives_every_mcp_write_to_its_node) {
  Harness h;
  CHECK_FALSE(h.call("import_subgraph", parse(R"({"nodes":[{"id":"a","label":"A"}]})")).isError);
  h.registry.open(TreeId{"t"})->applyCommand(RepositionNode{NodeId{"a"}, Vec2{120, 60}}, h.clock.nowMs(), h.caller);
  const auto positionOfA = [&] {
    for (const NodeSpec& node : h.registry.open(TreeId{"t"})->snapshot().nodes)
      if (node.id == NodeId{"a"}) return node.position;
    return std::optional<Vec2>{};
  };
  REQUIRE((positionOfA() == std::optional<Vec2>(Vec2{120, 60})));

  CHECK_FALSE(h.call("import_subgraph", parse(R"({"nodes":[{"id":"a","label":"A2","icon":"star"}]})")).isError);
  CHECK_FALSE(h.call("update_nodes", asUpdate(parse(R"({"nodeId":"a","label":"A3","color":"plum"})"))).isError);
  CHECK((positionOfA() == std::optional<Vec2>(Vec2{120, 60})));
}

// An import's progress row still takes a node by the legacy `id`, which the schema publishes deprecated beside `nodeId`.
TEST(mcp_an_import_progress_row_takes_its_node_by_the_legacy_id) {
  Harness h;
  CHECK_FALSE(h.call("import_subgraph", parse(R"({"nodes":[{"id":"a","label":"A"}]})")).isError);
  CHECK_EQ(body(h.call("import_subgraph", parse(R"({"nodes":[],"progress":[{"id":"a","status":"complete"}]})")))["progress"],
           parse(R"([{"nodeId":"a","prerequisitesMet":true,"status":"complete"}])"));
  CHECK_EQ(body(h.call("get_progress", kNoArgs)), parse(R"({"completed":["a"],"outOfOrder":[]})"));
}

// get_progress answers the caller's marks on the nodes the tree holds, in every list: a mark on a node someone else
// deleted stays stored and is not answered, and shows again when the node comes back. On a tree the caller cannot read
// it answers none.
TEST(mcp_get_progress_answers_only_marks_on_nodes_the_tree_holds) {
  Harness h;
  CHECK_FALSE(h.call("import_subgraph", parse(R"({"nodes":[{"id":"a","label":"A"},{"id":"b","label":"B"},
    {"id":"c","label":"C"},{"id":"d","label":"D","prerequisites":["c"]}]})")).isError);
  h.registry.setVisibility(TreeId{"t"}, Visibility::public_);
  const ToolCaller stranger{uid("stranger"), ToolScope::everything()};
  const auto progressOf = [&] {
    return body(h.tools.callTool("get_progress", parse(R"({"treeId":"t","fields":["completed","cleared","outOfOrder"]})"),
                                 stranger));
  };
  CHECK_FALSE(h.tools.callTool("update_nodes", parse(R"({"treeId":"t","updates":[{"nodeId":"a","status":"complete"},
    {"nodeId":"b","status":"none"},{"nodeId":"d","status":"complete","outOfOrder":true}]})"), stranger).isError);
  CHECK_EQ(progressOf(), parse(R"({"completed":["a","d"],"cleared":["b"],"outOfOrder":["d"]})"));

  CHECK_FALSE(h.call("delete_node", parse(R"({"nodeIds":["b","d"]})")).isError);
  CHECK_EQ(progressOf(), parse(R"({"completed":["a"],"cleared":[],"outOfOrder":[]})"));

  CHECK_FALSE(h.call("import_subgraph", parse(R"({"nodes":[{"id":"d","label":"D"}]})")).isError);
  CHECK_EQ(progressOf(), parse(R"({"completed":["a","d"],"cleared":[],"outOfOrder":["d"]})"));

  h.registry.setVisibility(TreeId{"t"}, Visibility::private_);
  CHECK_EQ(progressOf(), parse(R"({"completed":[],"cleared":[],"outOfOrder":[]})"));
  CHECK_EQ(body(h.call("get_progress", parse(R"({"fields":["completed","cleared","outOfOrder"]})"))),
           parse(R"({"completed":[],"cleared":[],"outOfOrder":[]})"));
}

// get_health, tidy and prune are retired: no declaration carries them, and a call to one is refused as a tool the
// server does not have, in the gate's own words, with nothing written and no mark cleared.
TEST(mcp_the_retired_health_tidy_and_prune_tools_are_refused_as_unknown_tools) {
  auto h = nodeTree();
  CHECK_FALSE(h->call("update_nodes", parse(R"({"updates":[{"nodeId":"a","status":"complete"}]})")).isError);
  const StoredTree stored = h->trees.byId["t"];
  const std::size_t rows = h->ops.byTree["t"].size();
  CompositeToolHost gate(std::vector<ToolModule>{{h->tools, ""}});
  for (const std::string name : {"get_health", "tidy", "prune"}) {
    for (const Json::Value& tool : h->tools.listTools(h->actor)) CHECK(tool["name"].asString() != name);
    const ToolResult refused = gate.callTool(name, parse(R"({"treeId":"t"})"), h->actor);
    CHECK(refused.isError);
    CHECK_EQ(message(refused), name + ": no such tool on this server — call tools/list for the whole surface.");
  }
  CHECK(h->trees.byId["t"] == stored);
  CHECK_EQ(h->ops.byTree["t"].size(), rows);
  CHECK_EQ(body(h->call("get_progress", kNoArgs)), parse(R"({"completed":["a"],"outOfOrder":[]})"));
}

// The cross-branch flag is no field of a kind: add_kind, create_tree's kinds and an import's kinds refuse it as an
// unknown argument, and get_tree's kindFields as a field a kind does not have, each in the gate's own words with
// nothing written.
TEST(mcp_the_cross_branch_flag_is_refused_wherever_mcp_took_or_answered_it) {
  auto h = kindTree();
  const StoredTree stored = h->trees.byId["t"];
  const std::size_t trees = h->trees.byId.size();
  CompositeToolHost gate(std::vector<ToolModule>{{h->tools, ""}});
  const auto refusal = [&](const char* tool, const char* arguments) {
    const ToolResult result = gate.callTool(tool, parse(arguments), h->actor);
    CHECK(result.isError);
    return message(result);
  };

  CHECK_EQ(refusal("add_kind", R"({"treeId":"t","id":"x","hue":"plum","crossBranchExempt":true})"),
           std::string("add_kind: unknown argument \"crossBranchExempt\". This tool takes: description, hue, id, "
                       "label, treeId."));
  CHECK_EQ(refusal("create_tree", R"({"title":"T","kinds":[{"id":"x","hue":"plum","crossBranchExempt":true}]})"),
           std::string("create_tree: unknown argument \"kinds[0].crossBranchExempt\". kinds[0] takes: description, "
                       "hue, id, label."));
  CHECK_EQ(refusal("import_subgraph", R"({"treeId":"t","kinds":[{"id":"k","hue":"sky","crossBranchExempt":true}],
    "nodes":[]})"),
           std::string("import_subgraph: unknown argument \"kinds[0].crossBranchExempt\". kinds[0] takes: "
                       "description, hue, id, label."));
  CHECK_EQ(refusal("get_tree", R"({"treeId":"t","kindFields":["id","crossBranchExempt"]})"),
           std::string("get_tree: kindFields[1] \"crossBranchExempt\" is not one of {id, hue, label, description}"));
  CHECK(h->trees.byId["t"] == stored);
  CHECK_EQ(h->trees.byId.size(), trees);
}
