#include "products/roadmap/adapters/mcp/ReadShape.h"
#include "products/roadmap/adapters/mcp/RoadmapToolCatalog.h"
#include "products/roadmap/adapters/mcp/RoadmapResources.h"
#include "products/roadmap/adapters/mcp/ToolArgs.h"
#include "products/roadmap/domain/Command.h"
#include "test/products/roadmap/adapters/mcp/ToolsHarness.h"

#include "test/testing.h"

#include <cstddef>
#include <string>
#include <vector>

using namespace wm;
using namespace wm::test;

namespace {

std::string repeat(char c, std::size_t times) { return std::string(times, c); }

const Json::Value* toolNamed(const Json::Value& catalog, const std::string& name) {
  for (const Json::Value& tool : catalog)
    if (tool["name"].asString() == name) return &tool;
  return nullptr;
}

const std::vector<const char*> kNodeHandleTools = {"annotate_node", "rename_node", "set_node_color",
                                                   "move_node", "delete_node"};

Json::Value handleToolArgs(const std::string& tool) {
  Json::Value args(Json::objectValue);
  if (tool == "annotate_node") args["description"] = "a note";
  if (tool == "rename_node") args["label"] = "Renamed";
  if (tool == "set_node_color") args["color"] = "olive";
  if (tool == "move_node") {
    args["x"] = 4.0;
    args["y"] = 8.0;
  }
  return args;
}

}

// Every tool's grant level, pinned by name.
TEST(mcp_every_roadmap_tool_declares_the_grant_level_that_reaches_it) {
  const std::vector<ToolDeclaration> catalog = roadmapToolCatalog();
  std::vector<std::string> reads;
  std::vector<std::string> writes;
  std::vector<std::string> deletes;
  for (const ToolDeclaration& tool : catalog) {
    CHECK_EQ(tool.product, std::string("roadmap"));
    if (tool.access == Access::read) reads.push_back(tool.name());
    if (tool.access == Access::write) writes.push_back(tool.name());
    if (tool.access == Access::del) deletes.push_back(tool.name());
  }

  CHECK_EQ(reads, (std::vector<std::string>{"list_trees", "get_tree", "get_diagnostics", "get_health",
                                            "get_progress", "find_nodes"}));
  CHECK_EQ(deletes, (std::vector<std::string>{"delete_tree", "delete_node", "remove_kind"}));
  CHECK_EQ(writes, (std::vector<std::string>{
                       "create_tree", "create_node", "annotate_node", "rename_node", "set_node_color",
                       "move_node", "connect", "disconnect", "reconnect", "tidy", "add_kind",
                       "rename_kind", "describe_kind", "reorder_kinds", "recolor_kind", "set_progress",
                       "import_subgraph", "prune"}));
  CHECK_EQ(catalog.size(), std::size_t{27});
}

TEST(mcp_a_grant_without_delete_never_sees_the_three_destructive_tools) {
  Harness h;
  const ToolCaller author{h.caller, parseToolScope("roadmap:read roadmap:write")};
  const Json::Value visible = h.tools.listTools(author);

  CHECK_EQ(visible.size(), 24u);
  for (const char* destructive : {"delete_tree", "delete_node", "remove_kind"})
    CHECK(toolNamed(visible, destructive) == nullptr);
  for (const char* ordinary : {"get_tree", "create_node", "disconnect", "prune"})
    CHECK(toolNamed(visible, ordinary) != nullptr);

  const ToolCaller reader{h.caller, parseToolScope("roadmap:read")};
  CHECK_EQ(h.tools.listTools(reader).size(), 6u);
  const ToolCaller elsewhere{h.caller, parseToolScope("gym:read gym:write gym:delete")};
  CHECK_EQ(h.tools.listTools(elsewhere).size(), 0u);
}

TEST(mcp_a_missing_node_handle_names_nodeId_and_how_to_find_one) {
  Harness h;
  h.call("create_node", node("a", "A"));

  for (const char* tool : kNodeHandleTools) {
    ToolResult refused = h.call(tool, handleToolArgs(tool));
    CHECK(refused.isError);
    CHECK_EQ(message(refused),
             std::string(tool) +
                 ": missing required argument \"nodeId\". Call get_tree with fields "
                 "[\"id\",\"label\"] to list the ids this tree has.");
  }
}

TEST(mcp_nodeId_is_canonical_and_the_legacy_id_is_still_accepted) {
  Harness h;
  h.call("create_node", node("a", "A"));

  for (const char* tool : kNodeHandleTools) {
    Json::Value canonical = handleToolArgs(tool);
    canonical["nodeId"] = "a";
    ToolResult byHandle = h.call(tool, canonical);
    CHECK_FALSE(byHandle.isError);
    CHECK(body(byHandle)["applied"].asBool());

    h.call("create_node", node("a", "A"));
    Json::Value legacy = handleToolArgs(tool);
    legacy["id"] = "a";
    ToolResult byAlias = h.call(tool, legacy);
    CHECK_FALSE(byAlias.isError);
    CHECK(body(byAlias)["applied"].asBool());
    h.call("create_node", node("a", "A"));
  }

  CHECK_FALSE(h.call("set_progress", mark("a", "complete")).isError);
  Json::Value legacyMark(Json::objectValue);
  legacyMark["id"] = "a";
  legacyMark["status"] = "active";
  ToolResult marked = h.call("set_progress", legacyMark);
  CHECK_FALSE(marked.isError);
  CHECK_EQ(body(marked)["nodeId"].asString(), std::string("a"));
  CHECK_EQ(body(marked)["status"].asString(), std::string("active"));
}

TEST(mcp_the_catalog_publishes_nodeId_and_keeps_id_as_a_deprecated_alias) {
  Harness h;
  const Json::Value catalog = h.tools.listTools(h.actor);

  for (const char* name : kNodeHandleTools) {
    const Json::Value* tool = toolNamed(catalog, name);
    REQUIRE(tool != nullptr);
    const Json::Value& schema = (*tool)["inputSchema"];
    CHECK_EQ(schema["properties"]["nodeId"]["type"].asString(), std::string("string"));
    CHECK_EQ(schema["properties"]["nodeId"]["description"].asString(),
             std::string("The node id (legacy `id` is still accepted)."));
    CHECK(schema["properties"]["id"]["deprecated"].asBool());
    bool requiresHandle = false;
    for (const Json::Value& field : schema["required"])
      if (field.asString() == "nodeId") requiresHandle = true;
    CHECK(requiresHandle);
    for (const Json::Value& field : schema["required"]) CHECK(field.asString() != std::string("id"));
  }

  const Json::Value* progress = toolNamed(catalog, "set_progress");
  REQUIRE(progress != nullptr);
  const Json::Value& marks = (*progress)["inputSchema"]["properties"];
  CHECK_EQ(marks["nodeId"]["type"].asString(), std::string("string"));
  CHECK(marks["id"]["deprecated"].asBool());
  const Json::Value& row = marks["updates"]["items"];
  CHECK_EQ(row["type"].asString(), std::string("object"));
  CHECK_EQ(row["properties"]["nodeId"]["type"].asString(), std::string("string"));
  CHECK(row["properties"]["id"]["deprecated"].asBool());
  REQUIRE_EQ(row["required"].size(), 2u);
  CHECK_EQ(row["required"][0].asString(), std::string("nodeId"));
  CHECK_EQ(row["required"][1].asString(), std::string("status"));

  const Json::Value* import = toolNamed(catalog, "import_subgraph");
  REQUIRE(import != nullptr);
  const Json::Value& arrays = (*import)["inputSchema"]["properties"];
  CHECK_EQ(arrays["nodes"]["items"]["required"][0].asString(), std::string("id"));
  CHECK_EQ(arrays["nodes"]["items"]["properties"]["description"]["maxLength"].asUInt64(), 4000u);
  CHECK_EQ(arrays["kinds"]["items"]["required"][0].asString(), std::string("id"));
  CHECK_EQ(arrays["kinds"]["items"]["required"][1].asString(), std::string("hue"));
  CHECK_EQ(arrays["progress"]["items"]["required"][0].asString(), std::string("nodeId"));

  const Json::Value* reconnect = toolNamed(catalog, "reconnect");
  REQUIRE(reconnect != nullptr);
  for (const char* endpoint : {"oldFrom", "oldTo", "newFrom", "newTo"})
    CHECK_EQ((*reconnect)["inputSchema"]["properties"][endpoint]["maxLength"].asUInt64(), 128u);
  const Json::Value* creation = toolNamed(catalog, "create_node");
  REQUIRE(creation != nullptr);
  CHECK_EQ((*creation)["inputSchema"]["properties"]["parentId"]["maxLength"].asUInt64(), 128u);
  CHECK_EQ((*creation)["inputSchema"]["properties"]["prerequisites"]["items"]["maxLength"].asUInt64(), 128u);
  const Json::Value* reorder = toolNamed(catalog, "reorder_kinds");
  REQUIRE(reorder != nullptr);
  CHECK_EQ((*reorder)["inputSchema"]["properties"]["order"]["items"]["maxLength"].asUInt64(), 128u);
  const Json::Value* search = toolNamed(catalog, "find_nodes");
  REQUIRE(search != nullptr);
  CHECK_EQ((*search)["inputSchema"]["properties"]["kind"]["maxLength"].asUInt64(), 128u);
  const Json::Value* planting = toolNamed(catalog, "create_tree");
  REQUIRE(planting != nullptr);
  CHECK_EQ((*planting)["inputSchema"]["properties"]["title"]["maxLength"].asUInt64(), 200u);

  const Json::Value* create = toolNamed(catalog, "create_node");
  REQUIRE(create != nullptr);
  CHECK_FALSE((*create)["inputSchema"]["properties"]["id"].isMember("deprecated"));
  CHECK_FALSE((*create)["inputSchema"]["properties"].isMember("nodeId"));
}

TEST(mcp_create_node_refuses_the_handle_of_an_existing_node) {
  Harness h;
  Json::Value args(Json::objectValue);
  args["label"] = "Renderer";
  args["nodeId"] = "renderer";
  ToolResult refused = h.call("create_node", args);
  CHECK(refused.isError);
  CHECK_EQ(message(refused),
           std::string("create_node: \"nodeId\" names a node that already exists — the id you "
                       "propose for a NEW node is \"id\", and is minted from the label when you "
                       "omit it."));

  Json::Value kind(Json::objectValue);
  kind["kindId"] = "infra";
  kind["hue"] = "sky";
  ToolResult kindRefused = h.call("add_kind", kind);
  CHECK(kindRefused.isError);
  CHECK_EQ(message(kindRefused),
           std::string("add_kind: \"kindId\" names a kind that already exists — the id you propose "
                       "for a NEW kind is \"id\"."));
}

TEST(mcp_an_over_long_description_names_the_size_and_the_max) {
  Harness h;
  h.call("create_node", node("a", "A"));

  Json::Value args(Json::objectValue);
  args["nodeId"] = "a";
  args["description"] = repeat('x', 4613);
  ToolResult refused = h.call("annotate_node", args);
  CHECK(refused.isError);
  CHECK_EQ(message(refused), std::string("annotate_node: description is 4613 characters, max 4000"));

  const Json::Value catalog = h.tools.listTools(h.actor);
  const Json::Value* annotate = toolNamed(catalog, "annotate_node");
  REQUIRE(annotate != nullptr);
  CHECK_EQ((*annotate)["inputSchema"]["properties"]["description"]["maxLength"].asUInt64(), 4000u);
}

TEST(mcp_an_unknown_enum_value_enumerates_the_legal_set) {
  Harness h;
  h.call("create_node", node("a", "A"));

  Json::Value status(Json::objectValue);
  status["nodeId"] = "a";
  status["status"] = "finished";
  ToolResult badStatus = h.call("set_progress", status);
  CHECK(badStatus.isError);
  CHECK_EQ(message(badStatus),
           std::string("set_progress: status \"finished\" is not one of {active, complete, none}"));

  Json::Value updates(Json::arrayValue);
  updates.append(mark("a", "finished"));
  Json::Value batch(Json::objectValue);
  batch["updates"] = updates;
  ToolResult badRow = h.call("set_progress", batch);
  CHECK(badRow.isError);
  CHECK_EQ(message(badRow),
           std::string("set_progress: updates[0].status \"finished\" is not one of "
                       "{active, complete, none}"));

  Json::Value color(Json::objectValue);
  color["nodeId"] = "a";
  color["color"] = "chartreuse";
  ToolResult badColor = h.call("set_node_color", color);
  CHECK(badColor.isError);
  CHECK_EQ(message(badColor),
           std::string("set_node_color: color \"chartreuse\" is not one of "
                       "{terracotta, olive, gold, brick, sky, plum}"));

  ToolResult badFilter = h.call("find_nodes", with("color", "chartreuse"));
  CHECK(badFilter.isError);
  CHECK_EQ(message(badFilter),
           std::string("find_nodes: color \"chartreuse\" is not one of "
                       "{terracotta, olive, gold, brick, sky, plum}"));
}

TEST(mcp_a_malformed_import_item_names_its_path_and_its_type) {
  Harness h;

  Json::Value encoded(Json::arrayValue);
  encoded.append("{\"id\":\"a\",\"label\":\"A\"}");
  Json::Value args(Json::objectValue);
  args["nodes"] = encoded;
  ToolResult refused = h.call("import_subgraph", args);
  CHECK(refused.isError);
  CHECK_EQ(message(refused),
           std::string("import_subgraph: nodes[0] must be an object, got string. Each item is a "
                       "JSON object, not a JSON-encoded string."));

  Json::Value nodes(Json::arrayValue);
  nodes.append(node("a", "A"));
  Json::Value nameless = node("", "B");
  nodes.append(nameless);
  Json::Value missingId(Json::objectValue);
  missingId["nodes"] = nodes;
  ToolResult blank = h.call("import_subgraph", missingId);
  CHECK(blank.isError);
  CHECK_EQ(message(blank),
           std::string("import_subgraph: argument \"nodes[1].id\" must be a non-empty string, got \"\""));

  Json::Value deep(Json::arrayValue);
  Json::Value oversized = node("c", "C");
  oversized["description"] = repeat('y', 5000);
  deep.append(oversized);
  Json::Value capped(Json::objectValue);
  capped["nodes"] = deep;
  ToolResult refusedCap = h.call("import_subgraph", capped);
  CHECK(refusedCap.isError);
  CHECK_EQ(message(refusedCap),
           std::string("import_subgraph: nodes[0].description is 5000 characters, max 4000"));

  Json::Value hue(Json::arrayValue);
  Json::Value kind(Json::objectValue);
  kind["id"] = "infra";
  kind["hue"] = "cerulean";
  hue.append(kind);
  Json::Value legend(Json::objectValue);
  legend["nodes"] = Json::Value(Json::arrayValue);
  legend["kinds"] = hue;
  ToolResult refusedHue = h.call("import_subgraph", legend);
  CHECK(refusedHue.isError);
  CHECK_EQ(message(refusedHue),
           std::string("import_subgraph: kinds[0].hue \"cerulean\" is not one of "
                       "{terracotta, olive, gold, brick, sky, plum}"));
}

TEST(mcp_an_imported_node_carries_a_seed_status_and_never_the_callers_mark) {
  Harness h;

  Json::Value marked = node("a", "A");
  marked["status"] = "complete";
  Json::Value nodes(Json::arrayValue);
  nodes.append(marked);
  Json::Value args(Json::objectValue);
  args["nodes"] = nodes;
  ToolResult refused = h.call("import_subgraph", args);
  CHECK(refused.isError);
  CHECK_EQ(message(refused),
           std::string("import_subgraph: nodes[0].status is your own mark on this surface, not the "
                       "document's — the authored baseline every reader sees is \"seedStatus\", and "
                       "your own progress goes in \"progress\": [{nodeId, status}]."));

  Json::Value wrong = node("a", "A");
  wrong["seedStatus"] = "shipped";
  Json::Value seeded(Json::arrayValue);
  seeded.append(wrong);
  Json::Value seedArgs(Json::objectValue);
  seedArgs["nodes"] = seeded;
  ToolResult misspelled = h.call("import_subgraph", seedArgs);
  CHECK(misspelled.isError);
  CHECK_EQ(message(misspelled),
           std::string("import_subgraph: nodes[0].seedStatus \"shipped\" is not one of "
                       "{active, complete, none}"));

  const Json::Value catalog = h.tools.listTools(h.actor);
  const Json::Value* import = toolNamed(catalog, "import_subgraph");
  REQUIRE(import != nullptr);
  const Json::Value& carried = (*import)["inputSchema"]["properties"]["nodes"]["items"]["properties"];
  REQUIRE_EQ(carried["seedStatus"]["enum"].size(), 3u);
  CHECK_EQ(carried["seedStatus"]["enum"][0].asString(), std::string("active"));
  CHECK_FALSE(carried.isMember("status"));
}

TEST(mcp_a_wrong_type_fails_the_call_and_never_the_request) {
  Harness h;
  h.call("create_node", node("a", "A"));

  Json::Value label(Json::objectValue);
  label["label"] = 7;
  ToolResult wrongType = h.call("create_node", label);
  CHECK(wrongType.isError);
  CHECK_EQ(message(wrongType), std::string("create_node: argument \"label\" must be a string, got number"));

  Json::Value moved(Json::objectValue);
  moved["nodeId"] = "a";
  moved["x"] = "left";
  moved["y"] = 3.0;
  ToolResult wrongNumber = h.call("move_node", moved);
  CHECK(wrongNumber.isError);
  CHECK_EQ(message(wrongNumber), std::string("move_node: argument \"x\" must be a number, got string"));

  Json::Value notAList(Json::objectValue);
  notAList["nodes"] = "everything";
  ToolResult refused = h.call("import_subgraph", notAList);
  CHECK(refused.isError);
  CHECK_EQ(message(refused),
           std::string("import_subgraph: argument \"nodes\" must be an array of objects, got string"));

  // Arguments that are not an object at all: jsoncpp throws on a keyed read, and that throw must never reach the transport.
  ToolResult notAnObject = h.tools.callTool("get_tree", Json::Value("t"), h.actor);
  CHECK(notAnObject.isError);
  CHECK_EQ(message(notAnObject),
           std::string("get_tree: arguments must be a JSON object of this tool's named arguments, "
                       "got string"));

  Json::Value links(Json::arrayValue);
  links.append(42);
  Json::Value annotated(Json::objectValue);
  annotated["nodeId"] = "a";
  annotated["links"] = links;
  ToolResult badLink = h.call("annotate_node", annotated);
  CHECK(badLink.isError);
  CHECK_EQ(message(badLink),
           std::string("annotate_node: links[0] must be an object {url, label?} or a url string, "
                       "got number"));
}

// 17 significant digits quotes back what IEEE stored.
TEST(mcp_a_number_is_quoted_back_as_the_caller_wrote_it) {
  Harness h;
  Json::Value fraction(Json::objectValue);
  fraction["limit"] = 0.1;
  ToolResult refused = h.call("find_nodes", fraction);
  CHECK(refused.isError);
  CHECK_EQ(message(refused),
           std::string("find_nodes: argument \"limit\" must be a number between 1 and 1000, got 0.1"));

  Json::Value big(Json::objectValue);
  big["limit"] = 1e300;
  ToolResult huge = h.call("find_nodes", big);
  CHECK(huge.isError);
  CHECK_EQ(message(huge),
           std::string("find_nodes: argument \"limit\" must be a number between 1 and 1000, got 1e+300"));
}

TEST(mcp_a_missing_tree_id_names_it_and_the_way_to_find_one) {
  Harness h;
  ToolResult refused = h.tools.callTool("get_tree", Json::Value(Json::objectValue), h.actor);
  CHECK(refused.isError);
  CHECK_EQ(message(refused),
           std::string("get_tree: missing required argument \"treeId\". Call list_trees to see the "
                       "roadmaps you own and their ids."));

  ToolResult unknown = h.tools.callTool("frobnicate", with("treeId", "t"), h.actor);
  CHECK(unknown.isError);
  CHECK_EQ(message(unknown),
           std::string("frobnicate: no such roadmap tool — call tools/list for the surface this "
                       "connection may use."));
}

TEST(mcp_a_progress_mark_on_a_missing_node_names_the_id_and_the_next_move) {
  Harness h;
  ToolResult refused = h.call("set_progress", mark("ghost", "complete"));
  CHECK(refused.isError);
  CHECK_EQ(message(refused),
           std::string("set_progress: no node in this tree is named ghost. Call get_tree with "
                       "fields [\"id\",\"label\"] to list the ids this tree has."));

  ToolResult neither = h.call("set_progress", kNoArgs);
  CHECK(neither.isError);
  CHECK_EQ(message(neither),
           std::string("set_progress: missing required argument \"nodeId\" (or an \"updates\" batch "
                       "of {nodeId, status}). Call get_tree with fields [\"id\",\"label\"] to list "
                       "the ids this tree has."));
}

TEST(mcp_a_silent_no_op_is_refused_by_name) {
  Harness h;
  h.call("create_node", node("a", "A"));

  ToolResult nothing = h.call("annotate_node", with("nodeId", "a"));
  CHECK(nothing.isError);
  CHECK_EQ(message(nothing),
           std::string("annotate_node: nothing to set — pass \"description\", \"links\", or both."));

  Json::Value halfPosition(Json::objectValue);
  halfPosition["label"] = "Half";
  halfPosition["x"] = 3.0;
  ToolResult half = h.call("create_node", halfPosition);
  CHECK(half.isError);
  CHECK_EQ(message(half),
           std::string("create_node: arguments \"x\" and \"y\" go together — a position needs both."));
}

TEST(mcp_every_tool_failure_names_the_tool_exactly_once) {
  Harness h;
  const std::vector<const char*> tools = {"get_tree",      "get_progress", "find_nodes", "create_node",
                                          "annotate_node", "rename_node",  "move_node",  "delete_node",
                                          "set_node_color", "connect",     "disconnect", "reconnect",
                                          "add_kind",      "rename_kind",  "describe_kind",
                                          "remove_kind",   "reorder_kinds", "recolor_kind",
                                          "set_progress",  "import_subgraph"};
  for (const char* name : tools) {
    Json::Value nonsense(Json::objectValue);
    nonsense["fields"] = 12;
    ToolResult refused = h.call(name, nonsense);
    CHECK(refused.isError);
    const std::string said = message(refused);
    const std::string prefix = std::string(name) + ": ";
    CHECK_EQ(said.rfind(prefix, 0), 0u);
    // A caller-controlled value quoted back may legitimately contain the tool name, so the invariant is about the prefix only.
    CHECK_EQ(said.substr(prefix.size()).rfind(prefix, 0), std::string::npos);
    CHECK_EQ(said.find("invalid arguments"), std::string::npos);
    CHECK_EQ(said.find("bad request"), std::string::npos);
    CHECK_EQ(said.find("is empty"), std::string::npos);
  }
}

// A null is how many clients serialise an unset optional: this module reads one as "not given", the decoder reads presence.
TEST(mcp_a_null_argument_is_absent_and_never_a_command_to_clear) {
  Harness h;
  Json::Value seed = node("a", "A");
  Json::Value links(Json::arrayValue);
  Json::Value link(Json::objectValue);
  link["url"] = "https://spec";
  links.append(link);
  seed["links"] = links;
  seed["description"] = "the note";
  h.call("create_node", seed);

  Json::Value annotated(Json::objectValue);
  annotated["nodeId"] = "a";
  annotated["description"] = "a new note";
  annotated["links"] = Json::nullValue;  // "I am not setting links" — not "delete them"
  CHECK_FALSE(h.call("annotate_node", annotated).isError);

  Json::Value read(Json::objectValue);
  read["fields"] = list({"id", "description", "links", "position"});
  const Json::Value a = body(h.call("get_tree", read))["tree"]["nodes"][0];
  CHECK_EQ(a["description"].asString(), std::string("a new note"));
  REQUIRE_EQ(a["links"].size(), 1u);
  CHECK_EQ(a["links"][0]["url"].asString(), std::string("https://spec"));

  // …and a null position is no position, rather than the origin every node would stack on.
  Json::Value planted(Json::objectValue);
  planted["id"] = "b";
  planted["label"] = "B";
  planted["x"] = Json::nullValue;
  planted["y"] = Json::nullValue;
  CHECK_FALSE(h.call("create_node", planted).isError);
  const Json::Value nodes = body(h.call("get_tree", read))["tree"]["nodes"];
  for (const Json::Value& n : nodes)
    if (n["id"].asString() == "b") CHECK_FALSE(n.isMember("position"));
}

TEST(mcp_dry_run_is_a_boolean_and_a_preview_never_writes) {
  Harness h;
  Json::Value nodes(Json::arrayValue);
  nodes.append(node("a", "A"));

  Json::Value stringy(Json::objectValue);
  stringy["nodes"] = nodes;
  stringy["dryRun"] = "yes";
  ToolResult refused = h.call("import_subgraph", stringy);
  CHECK(refused.isError);
  CHECK_EQ(message(refused),
           std::string("import_subgraph: argument \"dryRun\" must be a boolean, got string"));
  CHECK_EQ(body(h.call("get_tree", kNoArgs))["tree"]["nodes"].size(), 0u);  // nothing was written

  Json::Value spelled(Json::objectValue);
  spelled["nodes"] = nodes;
  spelled["dryRun"] = "true";
  CHECK(h.call("import_subgraph", spelled).isError);
  CHECK_EQ(body(h.call("get_tree", kNoArgs))["tree"]["nodes"].size(), 0u);
}

TEST(mcp_import_refuses_a_legend_it_could_not_repair) {
  Harness h;
  Json::Value kinds(Json::arrayValue);
  Json::Value build(Json::objectValue);
  build["id"] = "build";
  build["hue"] = "sky";
  Json::Value learn(Json::objectValue);
  learn["id"] = "learn";
  learn["hue"] = "sky";  // the same hue: unrepairable once it lands, so it never lands
  kinds.append(build);
  kinds.append(learn);
  Json::Value args(Json::objectValue);
  args["nodes"] = Json::Value(Json::arrayValue);
  args["kinds"] = kinds;

  ToolResult refused = h.call("import_subgraph", args);
  CHECK(refused.isError);
  CHECK_EQ(message(refused),
           std::string("import_subgraph: kinds[1].hue \"sky\" already belongs to kind \"build\" — "
                       "a hue names one kind, so pick a free one"));
  CHECK_EQ(body(h.call("get_tree", kNoArgs))["tree"]["kinds"].size(), 0u);

  Json::Value first(Json::objectValue);
  first["id"] = "build";
  first["hue"] = "sky";
  CHECK_FALSE(h.call("add_kind", first).isError);
  Json::Value second(Json::arrayValue);
  second.append(learn);
  Json::Value later(Json::objectValue);
  later["nodes"] = Json::Value(Json::arrayValue);
  later["kinds"] = second;
  CHECK(h.call("import_subgraph", later).isError);

  Json::Value again(Json::arrayValue);
  again.append(first);
  Json::Value repeat(Json::objectValue);
  repeat["nodes"] = Json::Value(Json::arrayValue);
  repeat["kinds"] = again;
  CHECK_FALSE(h.call("import_subgraph", repeat).isError);
}

TEST(mcp_an_import_with_no_nodes_names_the_way_through) {
  Harness h;
  Json::Value kinds(Json::arrayValue);
  Json::Value kind(Json::objectValue);
  kind["id"] = "build";
  kind["hue"] = "sky";
  kinds.append(kind);

  Json::Value legendOnly(Json::objectValue);
  legendOnly["kinds"] = kinds;
  ToolResult refused = h.call("import_subgraph", legendOnly);
  CHECK(refused.isError);
  CHECK_EQ(message(refused),
           std::string("import_subgraph: missing required argument \"nodes\". Pass \"nodes\": [] "
                       "to import only kinds or progress."));

  legendOnly["nodes"] = Json::Value(Json::arrayValue);
  CHECK_FALSE(h.call("import_subgraph", legendOnly).isError);
  CHECK_EQ(body(h.call("get_tree", kNoArgs))["tree"]["kinds"].size(), 1u);

  const Json::Value catalog = h.tools.listTools(h.actor);
  const Json::Value* import = toolNamed(catalog, "import_subgraph");
  REQUIRE(import != nullptr);
  CHECK_FALSE((*import)["inputSchema"]["properties"].isMember("title"));
  CHECK_EQ((*import)["inputSchema"]["description"].asString().find("title?"), std::string::npos);
}

TEST(mcp_set_progress_refuses_two_routes_at_once) {
  Harness h;
  h.call("create_node", node("a", "A"));
  h.call("create_node", node("b", "B"));

  Json::Value updates(Json::arrayValue);
  updates.append(mark("b", "complete"));
  Json::Value both = mark("a", "complete");
  both["updates"] = updates;

  ToolResult refused = h.call("set_progress", both);
  CHECK(refused.isError);
  CHECK_EQ(message(refused),
           std::string("set_progress: pass a single \"nodeId\"+\"status\" or an \"updates\" batch, "
                       "not both — the single mark would be dropped."));
  CHECK_EQ(body(h.call("get_progress", kNoArgs))["completed"].size(), 0u);
}

TEST(mcp_a_kind_handle_is_read_under_either_spelling) {
  Harness h;
  Json::Value kind(Json::objectValue);
  kind["id"] = "build";
  kind["hue"] = "sky";
  h.call("add_kind", kind);

  CHECK_FALSE(h.call("rename_kind", [] {
                Json::Value args(Json::objectValue);
                args["kindId"] = "build";
                args["label"] = "Build";
                return args;
              }())
                  .isError);
  Json::Value byId(Json::objectValue);
  byId["id"] = "build";
  byId["description"] = "the making of things";
  CHECK_FALSE(h.call("describe_kind", byId).isError);

  Json::Value args(Json::objectValue);
  args["kindFields"] = list({"id", "label", "description"});
  const Json::Value legend = body(h.call("get_tree", args))["tree"]["kinds"][0];
  CHECK_EQ(legend["label"].asString(), std::string("Build"));
  CHECK_EQ(legend["description"].asString(), std::string("the making of things"));

  Json::Value missing(Json::objectValue);
  missing["label"] = "Nameless";
  ToolResult refused = h.call("rename_kind", missing);
  CHECK(refused.isError);
  CHECK_EQ(message(refused),
           std::string("rename_kind: missing required argument \"id\". Call get_tree and read "
                       "`kinds` to list this legend's ids."));

  const Json::Value catalog = h.tools.listTools(h.actor);
  for (const char* name : {"rename_kind", "describe_kind", "remove_kind", "recolor_kind"}) {
    const Json::Value* tool = toolNamed(catalog, name);
    REQUIRE(tool != nullptr);
    CHECK(( *tool)["inputSchema"]["properties"].isMember("kindId"));
    CHECK(( *tool)["inputSchema"]["properties"].isMember("id"));
  }
}

TEST(mcp_a_legend_refusal_names_the_hue_its_holder_and_the_limit) {
  Harness h;
  Json::Value build(Json::objectValue);
  build["id"] = "build";
  build["hue"] = "sky";
  h.call("add_kind", build);

  Json::Value clash(Json::objectValue);
  clash["id"] = "learn";
  clash["hue"] = "sky";
  ToolResult taken = h.call("add_kind", clash);
  CHECK(taken.isError);
  CHECK_EQ(message(taken),
           std::string("add_kind: hue \"sky\" already belongs to kind \"build\" — a hue names one "
                       "kind, so pick a free one"));

  ToolResult twice = h.call("add_kind", build);
  CHECK(twice.isError);
  CHECK_EQ(message(twice), std::string("add_kind: kind \"build\" already exists in this legend"));

  ToolResult ghost = h.call("remove_kind", with("id", "ghost"));
  CHECK(ghost.isError);
  CHECK_EQ(message(ghost), std::string("remove_kind: no kind \"ghost\" in this legend"));

  Json::Value worn = node("a", "A");
  worn["color"] = "sky";
  h.call("create_node", worn);
  ToolResult inUse = h.call("remove_kind", with("id", "build"));
  CHECK(inUse.isError);
  CHECK_EQ(message(inUse),
           std::string("remove_kind: kind \"build\" is in use — 1 node(s) still wear hue \"sky\"; "
                       "recolor them first"));

  const std::vector<const char*> rest = {"olive", "gold", "brick", "plum", "terracotta"};
  for (const char* hue : rest) {
    Json::Value more(Json::objectValue);
    more["id"] = hue;
    more["hue"] = hue;
    CHECK_FALSE(h.call("add_kind", more).isError);
  }
  Json::Value seventh(Json::objectValue);
  seventh["id"] = "seventh";
  seventh["hue"] = "sky";
  ToolResult full = h.call("add_kind", seventh);
  CHECK(full.isError);
  CHECK_EQ(message(full),
           std::string("add_kind: the legend is full (6 of 6 kinds) — remove a kind before adding "
                       "another"));
}

TEST(mcp_every_write_tool_denies_a_private_tree_exactly_as_it_denies_an_absent_one) {
  Harness h;
  h.trees.byId["priv"] = StoredTree{LooseGraph().exportState(), LegendState{}, {"Theirs", {}},
                                    0, fake::uid("someone"), Visibility::private_};

  const std::vector<const char*> writes = {"create_node", "annotate_node", "rename_node",
                                           "set_node_color", "move_node",  "delete_node",
                                           "connect",       "disconnect",  "reconnect",
                                           "tidy",          "add_kind",    "rename_kind",
                                           "describe_kind", "remove_kind", "reorder_kinds",
                                           "recolor_kind",  "prune",       "import_subgraph",
                                           "set_progress",  "delete_tree"};
  for (const char* name : writes) {
    Json::Value args(Json::objectValue);
    args["label"] = "x";
    args["id"] = "a";
    args["color"] = "olive";
    args["hue"] = "olive";
    args["description"] = "x";
    args["status"] = "complete";
    args["x"] = 1.0;
    args["y"] = 2.0;
    args["from"] = "a";
    args["to"] = "b";
    args["oldFrom"] = "a";
    args["oldTo"] = "b";
    args["newFrom"] = "a";
    args["newTo"] = "c";
    args["order"] = list({"a"});
    args["nodes"] = Json::Value(Json::arrayValue);

    Json::Value denied = args;
    denied["treeId"] = "priv";
    Json::Value absent = args;
    absent["treeId"] = "nope";
    ToolResult onPrivate = h.tools.callTool(name, denied, h.actor);
    ToolResult onAbsent = h.tools.callTool(name, absent, h.actor);
    CHECK(onPrivate.isError);
    CHECK(onAbsent.isError);
    CHECK_EQ(message(onPrivate), std::string(name) + ": no such tree \"priv\"");
    CHECK_EQ(message(onAbsent), std::string(name) + ": no such tree \"nope\"");
  }
}

TEST(mcp_the_quickstart_resource_says_what_the_surface_does) {
  Harness h;
  const std::vector<McpResource> catalog = roadmapResources();
  REQUIRE_EQ(catalog.size(), 1u);
  CHECK_EQ(catalog[0].uri, std::string("windmill://quickstart"));
  CHECK_EQ(catalog[0].mimeType, std::string("text/markdown"));

  const std::string& text = catalog[0].text;
  CHECK(text.find("`connect(from, to)` means `from` must be complete before `to` is unlocked.") !=
        std::string::npos);
  CHECK(text.find("prerequisite first") != std::string::npos);
  CHECK(text.find(kNodeHandle.published) != std::string::npos);
  CHECK(text.find(std::to_string(kMaxNodeDescriptionLength) + " characters") != std::string::npos);
  CHECK(text.find("max " + std::to_string(kMaxLimit)) != std::string::npos);

  const Json::Value tools = h.tools.listTools(h.actor);
  for (const char* named : {"list_trees", "get_tree", "find_nodes", "get_progress", "get_diagnostics",
                            "create_node", "connect", "import_subgraph", "set_progress"}) {
    CHECK(text.find(named) != std::string::npos);
    CHECK(toolNamed(tools, named) != nullptr);
  }

  for (const char* claim : {"introducedDiagnostics", "seedStatus", "id, label and description",
                            "find_nodes {state: \"available\"}"})
    CHECK(text.find(claim) != std::string::npos);

  h.call("create_node", node("a", "A"));
  Json::Value rename(Json::objectValue);
  rename["nodeId"] = "a";
  rename["label"] = "A renamed";
  const Json::Value receipt = body(h.call("rename_node", rename));
  CHECK_EQ(keys(receipt),
           (std::vector<std::string>{"applied", "diagnosticsClean", "id", "introducedDiagnostics", "seq"}));

  Json::Value read(Json::objectValue);
  read["fields"] = list({"id", "status", "seedStatus"});
  const Json::Value found = body(h.call("find_nodes", read))["nodes"][0];
  CHECK_EQ(keys(found), (std::vector<std::string>{"id", "status"}));
  CHECK_EQ(found["status"].asString(), std::string("none"));
}
