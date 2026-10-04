#include "platform/adapters/mcp/CompositeToolHost.h"
#include "platform/adapters/mcp/McpServer.h"
#include "platform/application/WriteObservation.h"
#include "products/gym/adapters/mcp/GymToolCatalog.h"
#include "products/roadmap/adapters/mcp/RoadmapToolCatalog.h"

#include "test/testing.h"

#include <algorithm>
#include <stdexcept>
#include <string>
#include <typeinfo>
#include <vector>

using namespace wm;

namespace {

struct FakeProduct : ToolHost {
  struct Call {
    std::string name;
    Json::Value args;
    std::string caller;
  };

  std::string product;
  std::vector<ToolDeclaration> catalog;
  std::vector<ToolRetirement> retired;
  std::vector<Call> calls;

  explicit FakeProduct(std::string named) : product(std::move(named)) {}

  void declare(const char* name, Access access, std::vector<const char*> properties) {
    Json::Value props(Json::objectValue);
    for (const char* property : properties) props[property] = Json::Value(Json::objectValue);
    Json::Value schema(Json::objectValue);
    schema["type"] = "object";
    schema["properties"] = props;
    schema["additionalProperties"] = false;

    Json::Value descriptor(Json::objectValue);
    descriptor["name"] = name;
    descriptor["description"] = std::string("the `") + name + "` tool";
    descriptor["inputSchema"] = schema;
    catalog.push_back(ToolDeclaration{descriptor, product, access});
  }

  std::vector<ToolDeclaration> declareTools() const override { return catalog; }
  std::vector<ToolRetirement> retiredTools() const override { return retired; }

  ToolResult callTool(const std::string& name, const Json::Value& arguments,
                      const ToolCaller& caller) override {
    calls.push_back({name, arguments, caller.user.str()});
    Json::Value out(Json::objectValue);
    out["ran"] = name;
    return ToolResult::json(out);
  }
};

FakeProduct roadmap() {
  FakeProduct product("roadmap");
  product.declare("get_tree", Access::read, {"treeId"});
  product.declare("create_node", Access::write, {"treeId", "label"});
  product.declare("delete_node", Access::del, {"treeId", "nodeId"});
  return product;
}

FakeProduct fakeGymProduct() {
  FakeProduct product("gym");
  product.declare("list_sessions", Access::read, {"limit"});
  product.declare("log_set", Access::write, {"sessionId", "reps"});
  product.declare("delete_session", Access::del, {"sessionId"});
  return product;
}

std::vector<std::string> namesIn(const Json::Value& tools) {
  std::vector<std::string> names;
  for (const Json::Value& tool : tools) names.push_back(tool["name"].asString());
  return names;
}

ToolCaller granted(const char* scope) { return ToolCaller{UserId{"u1"}, parseToolScope(scope)}; }

std::string message(const ToolResult& result) { return result.content[0]["text"].asString(); }

Json::Value args(std::vector<std::pair<const char*, const char*>> fields) {
  Json::Value out(Json::objectValue);
  for (const auto& field : fields) out[field.first] = field.second;
  return out;
}

}

TEST(composite_lists_every_connected_product_to_an_account_wide_grant) {
  FakeProduct r = roadmap();
  FakeProduct g = fakeGymProduct();
  CompositeToolHost surface(std::vector<ToolModule>{{r, "roadmap paragraph"}, {g, "gym paragraph"}});

  CHECK_EQ(namesIn(surface.listTools(granted(""))),
           (std::vector<std::string>{"roadmap_get_tree", "roadmap_create_node", "roadmap_delete_node", "gym_list_sessions",
                                     "gym_log_set", "gym_delete_session"}));
  CHECK_EQ(surface.products(), (std::vector<std::string>{"roadmap", "gym"}));
}

TEST(composite_shows_a_grant_only_the_products_it_names) {
  FakeProduct r = roadmap();
  FakeProduct g = fakeGymProduct();
  CompositeToolHost surface(std::vector<ToolModule>{{r, ""}, {g, ""}});

  CHECK_EQ(namesIn(surface.listTools(granted("gym:read gym:write"))),
           (std::vector<std::string>{"gym_list_sessions", "gym_log_set"}));
}

TEST(composite_hides_a_delete_tool_from_a_grant_that_did_not_name_delete) {
  FakeProduct g = fakeGymProduct();
  CompositeToolHost surface(std::vector<ToolModule>{{g, ""}});

  const std::vector<std::string> readWrite = namesIn(surface.listTools(granted("gym:read gym:write")));
  CHECK_EQ(readWrite, (std::vector<std::string>{"gym_list_sessions", "gym_log_set"}));
  CHECK_EQ(namesIn(surface.listTools(granted("gym:read gym:write gym:delete"))),
           (std::vector<std::string>{"gym_list_sessions", "gym_log_set", "gym_delete_session"}));
}

TEST(composite_refuses_an_out_of_scope_tool_before_the_product_sees_it) {
  FakeProduct g = fakeGymProduct();
  CompositeToolHost surface(std::vector<ToolModule>{{g, ""}});

  const ToolResult refused =
      surface.callTool("delete_session", args({{"sessionId", "s1"}}), granted("gym:read gym:write"));
  CHECK(refused.isError);
  CHECK_EQ(message(refused),
           std::string("delete_session: this connection was not granted gym:delete, so it cannot run "
                       "this tool. Reconnect and approve that level."));
  CHECK_EQ(g.calls.size(), std::size_t{0});
}

TEST(composite_runs_a_tool_the_grant_covers_and_passes_the_caller_through) {
  FakeProduct g = fakeGymProduct();
  CompositeToolHost surface(std::vector<ToolModule>{{g, ""}});

  const ToolResult ran = surface.callTool("gym_log_set", args({{"sessionId", "s1"}, {"reps", "5"}}),
                                          granted("gym:write"));
  CHECK_FALSE(ran.isError);
  REQUIRE_EQ(g.calls.size(), std::size_t{1});
  CHECK_EQ(g.calls[0].name, std::string("log_set"));
  CHECK_EQ(g.calls[0].caller, std::string("u1"));
  CHECK_EQ(g.calls[0].args["reps"].asString(), std::string("5"));
}

TEST(composite_routes_each_name_to_the_product_that_declared_it) {
  FakeProduct r = roadmap();
  FakeProduct g = fakeGymProduct();
  CompositeToolHost surface(std::vector<ToolModule>{{r, ""}, {g, ""}});

  surface.callTool("roadmap_get_tree", args({{"treeId", "t"}}), granted(""));
  surface.callTool("gym_list_sessions", Json::Value(Json::objectValue), granted(""));
  REQUIRE_EQ(r.calls.size(), std::size_t{1});
  REQUIRE_EQ(g.calls.size(), std::size_t{1});
  CHECK_EQ(r.calls[0].name, std::string("get_tree"));
  CHECK_EQ(g.calls[0].name, std::string("list_sessions"));
}

TEST(composite_owns_the_whole_server_answer_for_a_name_nothing_declared) {
  FakeProduct r = roadmap();
  CompositeToolHost surface(std::vector<ToolModule>{{r, ""}});

  const ToolResult missing = surface.callTool("frobnicate", Json::Value(Json::objectValue), granted(""));
  CHECK(missing.isError);
  CHECK_EQ(message(missing),
           std::string("frobnicate: no such tool on this server — call tools/list for the whole surface."));
  CHECK_EQ(r.calls.size(), std::size_t{0});
}

// The composite resolves names against the catalogs it was built from, so a retired name answers with the product's own sentence.
Json::Value annotations(const char* title, bool readOnly, bool destructive, bool idempotent) {
  Json::Value out(Json::objectValue);
  out["title"] = title;
  out["readOnlyHint"] = readOnly;
  out["destructiveHint"] = destructive;
  out["idempotentHint"] = idempotent;
  out["openWorldHint"] = false;
  return out;
}

Json::Value meta(const char* product, const char* access) {
  Json::Value out(Json::objectValue);
  out["product"] = product;
  out["access"] = access;
  return out;
}

TEST(composite_lists_every_tool_in_its_wire_shape_with_annotations_derived_from_its_declaration) {
  FakeProduct r = roadmap();
  r.declare("prune", Access::write, {"treeId"});
  r.catalog.back().bulkEdit = true;
  r.catalog.back().idempotent = true;
  r.declare("rename_node", Access::write, {"treeId", "nodeId", "label"});
  r.catalog.back().idempotent = true;
  CompositeToolHost surface(std::vector<ToolModule>{{r, ""}});

  const Json::Value tools = surface.listTools(granted(""));
  REQUIRE_EQ(tools.size(), 5u);
  for (const Json::Value& tool : tools) {
    const auto entry = std::find_if(r.catalog.begin(), r.catalog.end(),
        [&](const ToolDeclaration& d) { return d.product + "_" + d.name() == tool["name"].asString(); });
    REQUIRE(entry != r.catalog.end());
    const ToolDeclaration& declared = *entry;
    CHECK_EQ(tool["description"].asString(), "the `" + tool["name"].asString() + "` tool");
    CHECK_EQ(tool["inputSchema"], declared.descriptor["inputSchema"]);
    CHECK_EQ(tool["title"], tool["annotations"]["title"]);
    CHECK_EQ(tool.getMemberNames(),
             (std::vector<std::string>{"_meta", "annotations", "description", "inputSchema", "name", "title"}));
  }
  CHECK_EQ(tools[0]["annotations"], annotations("Roadmap · Get tree", true, false, true));
  CHECK_EQ(tools[0]["_meta"], meta("roadmap", "read"));
  CHECK_EQ(tools[1]["annotations"], annotations("Roadmap · Create node", false, false, false));
  CHECK_EQ(tools[1]["_meta"], meta("roadmap", "write"));
  CHECK_EQ(tools[2]["annotations"], annotations("Roadmap · Delete node", false, true, false));
  CHECK_EQ(tools[2]["_meta"], meta("roadmap", "delete"));
  CHECK_EQ(tools[3]["annotations"], annotations("Roadmap · Prune", false, true, true));
  CHECK_EQ(tools[3]["_meta"], meta("roadmap", "write"));
  CHECK_EQ(tools[4]["annotations"], annotations("Roadmap · Rename node", false, false, true));
  CHECK_EQ(tools[4]["_meta"], meta("roadmap", "write"));

  // The dispatcher gates on the declaration, so the wire keys are never mistaken for arguments.
  const ToolResult ran = surface.callTool("prune", args({{"treeId", "t1"}}), granted(""));
  CHECK_FALSE(ran.isError);
  CHECK_EQ(r.calls.size(), std::size_t{1});
}

TEST(composite_answers_a_retired_name_with_the_products_sentence_and_never_calls_it) {
  FakeProduct g = fakeGymProduct();
  g.retired.push_back(ToolRetirement{"save_routine", "log_set",
                                     "retired on 2026-08-12. Use log_set instead."});
  CompositeToolHost surface(std::vector<ToolModule>{{g, ""}});

  const ToolResult retired =
      surface.callTool("save_routine", args({{"routineId", "r1"}}), granted("gym:read"));
  CHECK(retired.isError);
  CHECK_EQ(message(retired), std::string("save_routine: retired on 2026-08-12. Use log_set instead."));
  CHECK_EQ(g.calls.size(), std::size_t{0});
  CHECK_EQ(namesIn(surface.listTools(granted(""))),
           (std::vector<std::string>{"gym_list_sessions", "gym_log_set", "gym_delete_session"}));
  CHECK_EQ(message(surface.callTool("frobnicate", Json::Value(Json::objectValue), granted(""))),
           std::string("frobnicate: no such tool on this server — call tools/list for the whole surface."));
  const std::vector<ToolRetirement> all = surface.retiredTools();
  REQUIRE_EQ(all.size(), std::size_t{2});
  CHECK_EQ(all[0].name, std::string("gym_save_routine"));
  CHECK_EQ(all[0].replacement, std::string("gym_log_set"));
  CHECK_EQ(all[0].sentence, std::string("retired on 2026-08-12. Use gym_log_set instead."));
  CHECK_EQ(all[1].name, std::string("save_routine"));
}

TEST(composite_refuses_to_construct_when_a_retired_name_is_a_live_tool_of_any_module) {
  FakeProduct r = roadmap();
  FakeProduct g = fakeGymProduct();
  g.retired.push_back(ToolRetirement{"get_tree", "list_sessions", "retired."});

  bool threw = false;
  std::string detail;
  try {
    CompositeToolHost surface(std::vector<ToolModule>{{r, ""}, {g, ""}});
  } catch (const std::invalid_argument& error) {
    threw = true;
    detail = error.what();
  }
  CHECK(threw);
  CHECK_EQ(detail, std::string("the MCP tool \"get_tree\" is both declared and retired"));
}

TEST(composite_refuses_to_construct_when_a_replacement_is_not_a_live_tool) {
  FakeProduct g = fakeGymProduct();
  g.retired.push_back(ToolRetirement{"save_routine", "propose_routine_change", "retired."});

  bool threw = false;
  std::string detail;
  try {
    CompositeToolHost surface(std::vector<ToolModule>{{g, ""}});
  } catch (const std::invalid_argument& error) {
    threw = true;
    detail = error.what();
  }
  CHECK(threw);
  CHECK_EQ(detail, std::string("the retired MCP tool \"save_routine\" names \"propose_routine_change\" "
                               "as its replacement, and its product does not declare that tool"));
}

TEST(composite_accepts_a_retirement_with_no_replacement) {
  FakeProduct g = fakeGymProduct();
  g.retired.push_back(ToolRetirement{"get_preferences", "", "retired, and nothing replaced it."});
  CompositeToolHost surface(std::vector<ToolModule>{{g, ""}});

  const ToolResult retired =
      surface.callTool("get_preferences", Json::Value(Json::objectValue), granted(""));
  CHECK(retired.isError);
  CHECK_EQ(message(retired), std::string("get_preferences: retired, and nothing replaced it."));
  CHECK_EQ(g.calls.size(), std::size_t{0});
}

TEST(composite_shared_local_names_require_the_product_prefix) {
  FakeProduct r = roadmap();
  FakeProduct g = fakeGymProduct();
  g.declare("get_tree", Access::read, {"treeId"});
  CompositeToolHost surface(std::vector<ToolModule>{{r, ""}, {g, ""}});
  CHECK(surface.callTool("get_tree", args({{"treeId", "t"}}), granted("")).isError);
  CHECK_FALSE(surface.callTool("roadmap_get_tree", args({{"treeId", "t"}}), granted("")).isError);
  CHECK_FALSE(surface.callTool("gym_get_tree", args({{"treeId", "t"}}), granted("")).isError);
  CHECK_EQ(r.calls.size(), 1u);
  CHECK_EQ(g.calls.size(), 1u);
}

TEST(composite_refuses_an_argument_no_schema_declares_and_names_it) {
  FakeProduct r = roadmap();
  CompositeToolHost surface(std::vector<ToolModule>{{r, ""}});

  Json::Value withStrayKey = args({{"treeId", "t"}, {"label", "Step"}});
  withStrayKey["edges"] = Json::Value(Json::arrayValue);
  const ToolResult refused = surface.callTool("create_node", withStrayKey, granted(""));
  CHECK(refused.isError);
  CHECK_EQ(message(refused),
           std::string("create_node: unknown argument \"edges\". This tool takes: label, treeId."));
  CHECK_EQ(r.calls.size(), std::size_t{0});
}

TEST(composite_lets_every_declared_argument_through_untouched) {
  FakeProduct r = roadmap();
  CompositeToolHost surface(std::vector<ToolModule>{{r, ""}});

  const ToolResult ran = surface.callTool("create_node", args({{"treeId", "t"}, {"label", "Step"}}),
                                          granted(""));
  CHECK_FALSE(ran.isError);
  REQUIRE_EQ(r.calls.size(), std::size_t{1});
  CHECK_EQ(r.calls[0].args["label"].asString(), std::string("Step"));
}

TEST(composite_checks_the_grant_before_the_schema) {
  FakeProduct g = fakeGymProduct();
  CompositeToolHost surface(std::vector<ToolModule>{{g, ""}});

  Json::Value bad(Json::objectValue);
  bad["nonsense"] = 1;
  const ToolResult refused = surface.callTool("delete_session", bad, granted("gym:read"));
  CHECK(refused.isError);
  CHECK(message(refused).find("was not granted gym:delete") != std::string::npos);
}

TEST(windmill_server_info_names_the_connected_products_and_carries_their_paragraphs) {
  FakeProduct r = roadmap();
  FakeProduct g = fakeGymProduct();
  CompositeToolHost surface(std::vector<ToolModule>{{r, "Roadmaps are skill trees."}, {g, "A gym log."}});

  const ServerInfo info = windmillServerInfo(surface);
  CHECK_EQ(info.name, std::string("windmill"));
  CHECK(info.instructions.find("Connected: roadmap, gym.") != std::string::npos);
  CHECK(info.instructions.find("tools/list reflects this connection's grants.") != std::string::npos);
  CHECK(info.instructions.find("Roadmaps are skill trees.") != std::string::npos);
  CHECK(info.instructions.find("A gym log.") != std::string::npos);
  CHECK_EQ(info.version, std::string("0.1.0"));
  CHECK(info.instructions.find("build") == std::string::npos);
}

// The deployed sha identifies the catalog in semver build metadata.
TEST(windmill_server_info_dates_the_catalog_with_the_deployed_build) {
  FakeProduct r = roadmap();
  CompositeToolHost surface(std::vector<ToolModule>{{r, ""}});

  const ServerInfo info = windmillServerInfo(surface, "e86762e0d1c2b3a4f5");
  CHECK_EQ(info.version, std::string("0.1.0+e86762e"));
}

namespace {

// nodes[] of closed {id, position{x, y}} objects, and one `meta` object the schema leaves open.
FakeProduct importer() {
  FakeProduct product("roadmap");
  Json::Value position(Json::objectValue);
  position["type"] = "object";
  position["properties"]["x"] = Json::Value(Json::objectValue);
  position["properties"]["y"] = Json::Value(Json::objectValue);
  position["additionalProperties"] = false;
  Json::Value item(Json::objectValue);
  item["type"] = "object";
  item["properties"]["id"] = Json::Value(Json::objectValue);
  item["properties"]["position"] = position;
  item["additionalProperties"] = false;
  Json::Value nodes(Json::objectValue);
  nodes["type"] = "array";
  nodes["items"] = item;
  Json::Value meta(Json::objectValue);
  meta["type"] = "object";

  Json::Value props(Json::objectValue);
  props["treeId"] = Json::Value(Json::objectValue);
  props["nodes"] = nodes;
  props["meta"] = meta;
  Json::Value schema(Json::objectValue);
  schema["type"] = "object";
  schema["properties"] = props;
  schema["additionalProperties"] = false;
  Json::Value descriptor(Json::objectValue);
  descriptor["name"] = "import_subgraph";
  descriptor["description"] = "the import tool";
  descriptor["inputSchema"] = schema;
  product.catalog.push_back(ToolDeclaration{descriptor, "roadmap", Access::write});
  return product;
}

Json::Value nodeItem(const char* id) {
  Json::Value n(Json::objectValue);
  n["id"] = id;
  return n;
}

}

TEST(composite_refuses_a_nested_key_no_schema_declares_and_names_its_path) {
  FakeProduct r = importer();
  CompositeToolHost surface(std::vector<ToolModule>{{r, ""}});

  Json::Value stray = nodeItem("b");
  stray["deleted"] = true;
  Json::Value call = args({{"treeId", "t"}});
  call["nodes"].append(nodeItem("a"));
  call["nodes"].append(stray);
  const ToolResult refused = surface.callTool("import_subgraph", call, granted(""));
  CHECK(refused.isError);
  CHECK_EQ(message(refused),
           std::string("import_subgraph: unknown argument \"nodes[1].deleted\". nodes[1] takes: id, position."));
  CHECK_EQ(r.calls.size(), std::size_t{0});

  Json::Value deep = args({{"treeId", "t"}});
  Json::Value placed = nodeItem("a");
  placed["position"]["x"] = 1;
  placed["position"]["z"] = 2;
  deep["nodes"].append(placed);
  CHECK_EQ(message(surface.callTool("import_subgraph", deep, granted(""))),
           std::string("import_subgraph: unknown argument \"nodes[0].position.z\". nodes[0].position "
                       "takes: x, y."));
  CHECK_EQ(r.calls.size(), std::size_t{0});
}

TEST(composite_walks_only_what_a_schema_closes_and_passes_the_rest_through) {
  FakeProduct r = importer();
  CompositeToolHost surface(std::vector<ToolModule>{{r, ""}});

  Json::Value call = args({{"treeId", "t"}});
  Json::Value placed = nodeItem("a");
  placed["position"]["x"] = 1;
  placed["position"]["y"] = 2;
  call["nodes"].append(placed);
  call["nodes"].append("not-an-object");  // a wrong-shape item is the tool's to refuse, by type
  call["meta"]["anything"] = "goes";      // an open object keeps every key
  const ToolResult ran = surface.callTool("import_subgraph", call, granted(""));
  CHECK_FALSE(ran.isError);
  REQUIRE_EQ(r.calls.size(), std::size_t{1});
  CHECK_EQ(r.calls[0].args["nodes"][0]["position"]["y"].asInt(), 2);
  CHECK_EQ(r.calls[0].args["nodes"][1].asString(), std::string("not-an-object"));
  CHECK_EQ(r.calls[0].args["meta"]["anything"].asString(), std::string("goes"));
}

TEST(composite_aliases_and_canonical_names_share_permissions_and_do_not_rewrite_arguments) {
  FakeProduct r = roadmap();
  CompositeToolHost surface(std::vector<ToolModule>{{r, "Call get_tree before create_node."}});
  CHECK_EQ(surface.instructions(), std::string("Call roadmap_get_tree before roadmap_create_node."));
  const Json::Value input = args({{"treeId", "t"}, {"label", "get_tree and create_node"}});
  for (const char* name : {"create_node", "roadmap_create_node"}) {
    CHECK(surface.callTool(name, input, granted("roadmap:read")).isError);
    CHECK_FALSE(surface.callTool(name, input, granted("roadmap:write")).isError);
  }
  REQUIRE_EQ(r.calls.size(), 2u);
  CHECK_EQ(r.calls[0].name, std::string("create_node"));
  CHECK_EQ(r.calls[0].args, input);
  CHECK_EQ(r.calls[1].args, input);
  CHECK(surface.callTool("gym_create_node", input, granted("")).isError);
}

TEST(composite_rejects_canonical_alias_collisions_and_duplicate_retirements) {
  FakeProduct r = roadmap();
  FakeProduct g = fakeGymProduct();
  g.declare("roadmap_get_tree", Access::read, {});
  bool collision = false;
  try { CompositeToolHost surface({{r, ""}, {g, ""}}); }
  catch (const std::invalid_argument&) { collision = true; }
  CHECK(collision);
  r.retired = {{"old", "get_tree", "Use get_tree."}, {"old", "get_tree", "Use get_tree."}};
  bool duplicate = false;
  try { CompositeToolHost surface({{r, ""}}); }
  catch (const std::invalid_argument&) { duplicate = true; }
  CHECK(duplicate);
}

TEST(composite_carries_output_schemas_and_structured_results) {
  FakeProduct r = roadmap();
  r.catalog[0].descriptor["outputSchema"]["type"] = "object";
  CompositeToolHost surface({{r, ""}});
  CHECK_EQ(surface.listTools(granted(""))[0]["outputSchema"], r.catalog[0].descriptor["outputSchema"]);
}

TEST(composite_qualifies_each_products_help_without_rewriting_schema_literals) {
  FakeProduct r("roadmap");
  FakeProduct g("gym");
  r.declare("get_items", Access::read, {"choice"});
  g.declare("get_items", Access::read, {});
  Json::Value literal(Json::objectValue);
  literal["description"] = "get_items";
  r.catalog[0].descriptor["inputSchema"]["properties"]["choice"]["enum"].append(literal);
  CompositeToolHost surface({{r, "Call get_items."}, {g, "Call get_items."}});
  CHECK_EQ(surface.instructions(), std::string("Call roadmap_get_items.\n\nCall gym_get_items."));
  const Json::Value catalog = surface.listTools(granted(""));
  CHECK_EQ(catalog[0]["description"].asString(), std::string("the `roadmap_get_items` tool"));
  CHECK_EQ(catalog[1]["description"].asString(), std::string("the `gym_get_items` tool"));
  CHECK_EQ(catalog[0]["inputSchema"]["properties"]["choice"]["enum"][0], literal);
}

TEST(composite_retirement_replacement_must_be_an_exact_local_tool) {
  FakeProduct r("roadmap");
  r.declare("roadmap_new_tool", Access::read, {});
  r.retired = {{"old", "new_tool", "Use new_tool."}};
  bool refused = false;
  try { CompositeToolHost surface({{r, ""}}); }
  catch (const std::invalid_argument&) { refused = true; }
  CHECK(refused);
}

TEST(composite_preserves_natural_verbs_and_qualifies_explicit_tool_references) {
  FakeProduct r("roadmap");
  FakeProduct g("gym");
  r.declare("connect", Access::write, {});
  g.declare("get_session", Access::read, {});
  CompositeToolHost surface({{r, "Use `connect` or connect(from,to). Keep descriptions tidy."},
      {g, "Make changes systematically: connect each adjustment to the goal. Call get_session."}});
  CHECK_EQ(surface.instructions(), std::string(
      "Use `roadmap_connect` or roadmap_connect(from,to). Keep descriptions tidy.\n\n"
      "Make changes systematically: connect each adjustment to the goal. Call gym_get_session."));
}

namespace {
struct McpWriteCapture : FailureReporter {
  std::vector<WriteCompletion> lines;
  std::vector<std::string> issues;
  McpWriteCapture() {
    installWriteSink([this](const WriteCompletion& line) { lines.push_back(line); });
  }
  ~McpWriteCapture() {
    installWriteSink({});
    installWriteReporter({});
  }
  void report(const std::string& kind, const std::string& operation, const std::string& detail) override {
    issues.push_back(kind + " " + operation + " " + detail);
  }
};

struct EngineWriteProduct : FakeProduct {
  EngineWriteProduct() : FakeProduct("gym") { declare("write", Access::write, {}); }
  ToolResult callTool(const std::string&, const Json::Value&, const ToolCaller&) override {
    observeWrite("gym.server_call", "gym", "server-origin", [] {
      observeWrite("sync.admit", "gym", "sync", [] {
        observeWrite("sync.command.gym.start", "gym", "command", [] { markCurrentWrite(); });
      });
    });
    return ToolResult::json(Json::Value(Json::objectValue));
  }
};
}

TEST(composite_mcp_dispatcher_promotes_declared_write_tool_over_transport_to_one_info_completion) {
  McpWriteCapture capture;
  EngineWriteProduct product;
  CompositeToolHost surface({{product, ""}});
  McpServer dispatcher(surface, {"windmill", "test", ""});
  WriteObservation transport("mcp.transport", "platform", "mcp");
  WriteContext context(transport);
  Json::Value message(Json::objectValue);
  message["jsonrpc"] = "2.0";
  message["id"] = "PRIVATE-ID";
  message["method"] = "tools/call";
  message["params"]["name"] = "gym_write";
  message["params"]["arguments"] = Json::Value(Json::objectValue);
  const auto result = dispatcher.handle(message, granted("gym:write"));
  REQUIRE(result.has_value());
  CHECK_FALSE((*result)["result"]["isError"].asBool());
  CHECK_EQ((*result)["id"].asString(), "PRIVATE-ID");
  transport.finish();
  REQUIRE_EQ(capture.lines.size(), 5u);
  CHECK_EQ(capture.lines[3].operation, "mcp.gym_write");
  CHECK_EQ(capture.lines[3].severity, WriteSeverity::info);
  CHECK_EQ(capture.lines[4].operation, "mcp.transport");
  CHECK_EQ(capture.lines[4].severity, WriteSeverity::debug);
  for (std::size_t i = 0; i != 3; ++i) CHECK_EQ(capture.lines[i].severity, WriteSeverity::debug);
  for (const auto& completion : capture.lines) CHECK_EQ(completion.requestId, transport.requestId());
  CHECK_EQ(std::count_if(capture.lines.begin(), capture.lines.end(), [](const auto& completion) {
    return completion.severity == WriteSeverity::info;
  }), 1);
  CHECK_EQ(transport.writeCount(), 1u);
}

TEST(composite_mcp_write_refusal_keeps_warn_when_transport_success_is_debug) {
  McpWriteCapture capture;
  FakeProduct product = fakeGymProduct();
  CompositeToolHost surface({{product, ""}});
  McpServer dispatcher(surface, {"windmill", "test", ""});
  WriteObservation transport("mcp.transport", "platform", "mcp");
  WriteContext context(transport);
  Json::Value message(Json::objectValue);
  message["id"] = 1;
  message["method"] = "tools/call";
  message["params"]["name"] = "gym_delete_session";
  message["params"]["arguments"]["sessionId"] = "PRIVATE-WORKOUT";
  const auto result = dispatcher.handle(message, granted("gym:read"));
  REQUIRE(result.has_value());
  CHECK((*result)["result"]["isError"].asBool());
  transport.finish();
  REQUIRE_EQ(capture.lines.size(), 2u);
  CHECK_EQ(capture.lines[0].operation, "mcp.gym_delete_session");
  CHECK_EQ(capture.lines[0].outcome, "not-granted");
  CHECK_EQ(capture.lines[0].severity, WriteSeverity::warn);
  CHECK_EQ(capture.lines[1].severity, WriteSeverity::debug);
  CHECK(capture.issues.empty());
}

TEST(composite_tool_called_by_coach_retains_the_coach_info_owner) {
  McpWriteCapture capture;
  EngineWriteProduct product;
  CompositeToolHost surface({{product, ""}});
  WriteObservation coach("ask.run", "gym", "coach");
  WriteContext context(coach);
  CHECK_FALSE(surface.callTool("gym_write", Json::Value(Json::objectValue), granted("gym:write")).isError);
  coach.finish();
  REQUIRE_EQ(capture.lines.size(), 5u);
  for (std::size_t i = 0; i != 4; ++i) CHECK_EQ(capture.lines[i].severity, WriteSeverity::debug);
  CHECK_EQ(capture.lines[4].operation, "ask.run");
  CHECK_EQ(capture.lines[4].severity, WriteSeverity::info);
}

TEST(composite_mcp_initialize_and_session_delete_keep_their_transport_info_completions) {
  McpWriteCapture capture;
  FakeProduct product = fakeGymProduct();
  CompositeToolHost surface({{product, ""}});
  McpServer dispatcher(surface, {"windmill", "test", ""});
  {
    WriteObservation transport("mcp.transport", "platform", "mcp");
    WriteContext context(transport);
    Json::Value message(Json::objectValue);
    message["id"] = 1;
    message["method"] = "initialize";
    const auto result = dispatcher.handle(message, granted("gym:write"));
    REQUIRE(result.has_value());
    CHECK_EQ((*result)["result"]["serverInfo"]["name"].asString(), "windmill");
    transport.finish();
  }
  {
    WriteObservation transport("mcp.session.delete", "platform", "mcp");
    transport.finish();
  }
  REQUIRE_EQ(capture.lines.size(), 2u);
  CHECK_EQ(capture.lines[0].operation, "mcp.transport");
  CHECK_EQ(capture.lines[0].severity, WriteSeverity::info);
  CHECK_EQ(capture.lines[1].operation, "mcp.session.delete");
  CHECK_EQ(capture.lines[1].severity, WriteSeverity::info);
  CHECK(capture.lines[0].requestId != capture.lines[1].requestId);
}

TEST(composite_observes_every_registered_product_write_tool_and_compatibility_alias) {
  McpWriteCapture capture;
  FakeProduct r("roadmap");
  r.catalog = roadmapToolCatalog();
  FakeProduct g("gym");
  g.catalog = wm::gym::gymToolCatalog();
  g.declare("future_write", Access::write, {});
  CompositeToolHost surface({{r, ""}, {g, ""}});
  std::size_t writes = 0;
  for (const auto& tool : surface.declareTools()) {
    const auto before = capture.lines.size();
    const auto result = surface.callTool(tool.name(), Json::Value(Json::objectValue), granted(""));
    CHECK_FALSE(result.isError);
    if (tool.access == Access::read) {
      CHECK_EQ(capture.lines.size(), before);
      continue;
    }
    ++writes;
    REQUIRE_EQ(capture.lines.size(), before + 1);
    CHECK_EQ(capture.lines.back().operation, "mcp." + tool.name());
    CHECK_EQ(capture.lines.back().product, tool.product);
    CHECK_EQ(capture.lines.back().door, std::string("mcp"));
    CHECK_EQ(capture.lines.back().outcome, std::string("ok"));
    CHECK_FALSE(capture.lines.back().requestId.empty());
    const std::string local = tool.name().substr(tool.product.size() + 1);
    CHECK_FALSE(surface.callTool(local, Json::Value(Json::objectValue), granted("")).isError);
    CHECK_EQ(capture.lines.back().operation, "mcp." + tool.name());
  }
  CHECK(writes >= 30);
  CHECK(capture.issues.empty());
}

TEST(composite_observes_write_refusals_without_creating_issues_or_logging_arguments) {
  McpWriteCapture capture;
  FakeProduct g = fakeGymProduct();
  CompositeToolHost surface({{g, ""}});
  const auto refused = surface.callTool("delete_session", args({{"sessionId", "PRIVATE WORKOUT TEXT"}}),
                                        granted("gym:read"));
  CHECK(refused.isError);
  CHECK_EQ(toolWriteOutcome(refused), std::string("not-granted"));
  const auto invalid = surface.callTool("log_set", args({{"PRIVATE TOKEN", "PRIVATE TEXT"}}), granted("gym:write"));
  CHECK(invalid.isError);
  CHECK_EQ(toolWriteOutcome(invalid), std::string("invalid-arguments"));
  REQUIRE_EQ(capture.lines.size(), std::size_t{2});
  CHECK_EQ(capture.lines[0].operation, std::string("mcp.gym_delete_session"));
  CHECK_EQ(capture.lines[0].outcome, std::string("not-granted"));
  CHECK_EQ(capture.lines[1].operation, std::string("mcp.gym_log_set"));
  CHECK_EQ(capture.lines[1].outcome, std::string("invalid-arguments"));
  CHECK(capture.issues.empty());
}

TEST(composite_reports_compiled_write_exception_once_and_rethrows_without_message_in_issue) {
  struct BrokenHost : FakeProduct {
    BrokenHost() : FakeProduct("gym") { declare("write", Access::write, {}); }
    ToolResult callTool(const std::string&, const Json::Value&, const ToolCaller&) override {
      throw std::runtime_error("PRIVATE CONTENT AND TOKEN");
    }
  } broken;
  auto capture = std::make_shared<McpWriteCapture>();
  installWriteReporter(capture);
  CompositeToolHost surface({{broken, ""}});
  bool threw = false;
  try { surface.callTool("gym_write", Json::Value(Json::objectValue), granted("")); }
  catch (const std::runtime_error& error) {
    threw = true;
    CHECK_EQ(std::string(error.what()), std::string("PRIVATE CONTENT AND TOKEN"));
  }
  CHECK(threw);
  REQUIRE_EQ(capture->lines.size(), std::size_t{1});
  REQUIRE_EQ(capture->issues.size(), std::size_t{1});
  CHECK_EQ(capture->lines[0].operation, std::string("mcp.gym_write"));
  CHECK_EQ(capture->lines[0].outcome, std::string("failed"));
  CHECK(capture->issues[0].find(capture->lines[0].requestId) != std::string::npos);
  CHECK(capture->issues[0].find(typeid(std::runtime_error).name()) != std::string::npos);
  CHECK(capture->issues[0].find("PRIVATE") == std::string::npos);
  installWriteReporter({});
}
