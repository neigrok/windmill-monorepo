#include "products/roadmap/application/ScopedToolHost.h"

#include "test/testing.h"

#include <algorithm>
#include <initializer_list>
#include <string>
#include <vector>

using namespace wm;

namespace {

struct RecordingToolHost : ToolHost {
  struct Call {
    std::string name;
    Json::Value args;
    std::string caller;
  };
  std::vector<Call> calls;

  std::vector<ToolDeclaration> declareTools() const override {
    std::vector<ToolDeclaration> tools;
    for (const char* name : {"get_tree", "create_node", "delete_tree", "list_trees", "create_tree"}) {
      Json::Value entry(Json::objectValue);
      entry["name"] = name;
      tools.push_back(ToolDeclaration{entry, "roadmap", Access::write});
    }
    return tools;
  }

  ToolResult callTool(const std::string& name, const Json::Value& arguments, const ToolCaller& caller) override {
    calls.push_back({name, arguments, caller.user.str()});
    Json::Value out(Json::objectValue);
    out["ok"] = true;
    // Mirror applyEdit: EVERY single-node edit echoes the id it touched, so the recorder keys on the tool name.
    if (name == "create_node" || name == "rename_node") out["id"] = arguments.get("id", "minted").asString();
    if (name == "import_subgraph") out["nodeCollisions"] = Json::Value(Json::arrayValue);  // nothing pre-existing
    return ToolResult::json(out);
  }
};

// The catalog as RoadmapTools really declares it: every object closed, so a stray key has a name.
struct ClosedSchemaToolHost : RecordingToolHost {
  static Json::Value closedObject(std::initializer_list<const char*> keys) {
    Json::Value schema(Json::objectValue);
    schema["type"] = "object";
    schema["properties"] = Json::Value(Json::objectValue);
    for (const char* key : keys) schema["properties"][key]["type"] = "string";
    schema["additionalProperties"] = false;
    return schema;
  }

  std::vector<ToolDeclaration> declareTools() const override {
    Json::Value create(Json::objectValue);
    create["name"] = "create_node";
    create["inputSchema"] = closedObject({"treeId", "label"});

    Json::Value item = closedObject({"id", "position"});
    item["properties"]["position"] = closedObject({"x", "y"});
    Json::Value import(Json::objectValue);
    import["name"] = "import_subgraph";
    import["inputSchema"] = closedObject({"treeId", "nodes"});
    import["inputSchema"]["properties"]["nodes"]["type"] = "array";
    import["inputSchema"]["properties"]["nodes"]["items"] = item;

    return {ToolDeclaration{create, "roadmap", Access::write}, ToolDeclaration{import, "roadmap", Access::write}};
  }
};

std::string message(const ToolResult& result) { return result.content[0]["text"].asString(); }

bool has(const std::vector<std::string>& names, const std::string& name) {
  return std::find(names.begin(), names.end(), name) != names.end();
}

std::vector<std::string> toolNames(const std::vector<ToolDeclaration>& tools) {
  std::vector<std::string> names;
  for (const ToolDeclaration& tool : tools) names.push_back(tool.name());
  return names;
}

// A tend runs as the account on itself, so the grant is never what narrows it — one tree is.
ToolCaller tender(const char* user) { return ToolCaller{UserId{user}, ToolScope::everything()}; }

}

TEST(scoped_tool_host_drops_the_cross_tree_tools_from_the_catalog) {
  RecordingToolHost inner;
  ScopedToolHost scoped(inner, TreeId{"t_target"});
  const std::vector<std::string> names = toolNames(scoped.declareTools());
  CHECK(has(names, "get_tree"));       // single-tree tools survive
  CHECK(has(names, "create_node"));
  CHECK_FALSE(has(names, "create_tree"));  // every cross-tree reach is gone
  CHECK_FALSE(has(names, "list_trees"));
  CHECK_FALSE(has(names, "delete_tree"));
}

TEST(scoped_tool_host_forces_the_target_tree_id_over_any_the_agent_supplied) {
  RecordingToolHost inner;
  ScopedToolHost scoped(inner, TreeId{"t_target"});
  Json::Value args(Json::objectValue);
  args["treeId"] = "t_someone_elses";  // an injected redirect to another tree
  args["label"] = "New step";
  scoped.callTool("create_node", args, tender("u1"));

  REQUIRE_EQ(inner.calls.size(), std::size_t{1});
  CHECK_EQ(inner.calls[0].name, std::string("create_node"));
  CHECK_EQ(inner.calls[0].args["treeId"].asString(), std::string("t_target"));  // redirected home
  CHECK_EQ(inner.calls[0].args["label"].asString(), std::string("New step"));   // other args intact
  CHECK_EQ(inner.calls[0].caller, std::string("u1"));                           // caller passes through
}

TEST(scoped_tool_host_refuses_a_cross_tree_tool_without_reaching_the_inner_host) {
  RecordingToolHost inner;
  ScopedToolHost scoped(inner, TreeId{"t_target"});
  const ToolResult deleted = scoped.callTool("delete_tree", Json::Value(Json::objectValue), tender("u1"));
  CHECK(deleted.isError);
  CHECK_EQ(inner.calls.size(), std::size_t{0});
}

TEST(scoped_tool_host_records_exactly_the_nodes_the_tend_planted) {
  RecordingToolHost inner;
  ScopedToolHost scoped(inner, TreeId{"t_target"});
  const ToolCaller u = tender("u1");

  Json::Value a(Json::objectValue); a["id"] = "n1"; scoped.callTool("create_node", a, u);
  Json::Value b(Json::objectValue); b["id"] = "n2"; scoped.callTool("create_node", b, u);
  Json::Value renamed(Json::objectValue); renamed["id"] = "existing"; scoped.callTool("rename_node", renamed, u);
  Json::Value imp(Json::objectValue);
  Json::Value nodes(Json::arrayValue);
  Json::Value n3(Json::objectValue); n3["id"] = "n3"; nodes.append(n3);
  Json::Value n4(Json::objectValue); n4["id"] = "n4"; nodes.append(n4);
  imp["nodes"] = nodes;
  scoped.callTool("import_subgraph", imp, u);

  CHECK_EQ(scoped.createdNodeIds(), (std::vector<std::string>{"n1", "n2", "n3", "n4"}));
}

// The same refusal the MCP wire gives (CompositeToolHostTest pins the identical sentence): a tend's
// misnamed argument is named, not dropped.
TEST(scoped_tool_host_refuses_an_unknown_top_level_argument_before_the_inner_host) {
  ClosedSchemaToolHost inner;
  ScopedToolHost scoped(inner, TreeId{"t_target"});
  Json::Value args(Json::objectValue);
  args["label"] = "Step";
  args["edges"] = Json::Value(Json::arrayValue);

  const ToolResult refused = scoped.callTool("create_node", args, tender("u1"));
  CHECK(refused.isError);
  CHECK_EQ(message(refused),
           std::string("create_node: unknown argument \"edges\". This tool takes: label, treeId."));
  CHECK_EQ(inner.calls.size(), std::size_t{0});
  CHECK(scoped.createdNodeIds().empty());
}

TEST(scoped_tool_host_refuses_an_unknown_nested_argument_by_its_json_path) {
  ClosedSchemaToolHost inner;
  ScopedToolHost scoped(inner, TreeId{"t_target"});
  Json::Value args(Json::objectValue);
  Json::Value fine(Json::objectValue); fine["id"] = "a";
  Json::Value stray(Json::objectValue); stray["id"] = "b"; stray["deleted"] = true;
  args["nodes"].append(fine);
  args["nodes"].append(stray);

  const ToolResult refused = scoped.callTool("import_subgraph", args, tender("u1"));
  CHECK(refused.isError);
  CHECK_EQ(message(refused),
           std::string("import_subgraph: unknown argument \"nodes[1].deleted\". nodes[1] takes: id, position."));
  CHECK_EQ(inner.calls.size(), std::size_t{0});

  Json::Value deep(Json::objectValue);
  Json::Value placed(Json::objectValue); placed["id"] = "a";
  placed["position"]["x"] = "1";
  placed["position"]["z"] = "2";
  deep["nodes"].append(placed);
  CHECK_EQ(message(scoped.callTool("import_subgraph", deep, tender("u1"))),
           std::string("import_subgraph: unknown argument \"nodes[0].position.z\". nodes[0].position takes: x, y."));
  CHECK_EQ(inner.calls.size(), std::size_t{0});
}

TEST(scoped_tool_host_lets_a_declared_argument_through_and_still_forces_the_tree) {
  ClosedSchemaToolHost inner;
  ScopedToolHost scoped(inner, TreeId{"t_target"});
  Json::Value args(Json::objectValue);
  args["label"] = "Step";

  const ToolResult ran = scoped.callTool("create_node", args, tender("u1"));
  CHECK_FALSE(ran.isError);
  REQUIRE_EQ(inner.calls.size(), std::size_t{1});
  CHECK_EQ(inner.calls[0].args["label"].asString(), std::string("Step"));
  CHECK_EQ(inner.calls[0].args["treeId"].asString(), std::string("t_target"));
}
