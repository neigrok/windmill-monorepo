#include "products/roadmap/application/ScopedToolHost.h"

#include "test/testing.h"

#include <algorithm>
#include <string>
#include <vector>

using namespace wm;

namespace {

// Records every call and answers a canned catalog spanning both single-tree tools and the
// cross-tree reach the scope must strip.
struct RecordingToolHost : ToolHost {
  struct Call {
    std::string name;
    Json::Value args;
    std::string caller;
  };
  std::vector<Call> calls;

  Json::Value listTools() const override {
    Json::Value tools(Json::arrayValue);
    for (const char* name : {"get_tree", "create_node", "delete_tree", "list_trees", "create_tree"}) {
      Json::Value entry(Json::objectValue);
      entry["name"] = name;
      tools.append(entry);
    }
    return tools;
  }

  ToolResult callTool(const std::string& name, const Json::Value& arguments, const UserId& caller) override {
    calls.push_back({name, arguments, caller.str()});
    Json::Value out(Json::objectValue);
    out["ok"] = true;
    // Mirror applyEdit: EVERY single-node edit echoes the id it touched (create, rename, recolor),
    // so the recorder must key on the tool name, not the mere presence of an id.
    if (name == "create_node" || name == "rename_node") out["id"] = arguments.get("id", "minted").asString();
    if (name == "import_subgraph") out["nodeCollisions"] = Json::Value(Json::arrayValue);  // nothing pre-existing
    return ToolResult::json(out);
  }
};

bool has(const std::vector<std::string>& names, const std::string& name) {
  return std::find(names.begin(), names.end(), name) != names.end();
}

std::vector<std::string> toolNames(const Json::Value& tools) {
  std::vector<std::string> names;
  for (const Json::Value& tool : tools) names.push_back(tool["name"].asString());
  return names;
}

}

TEST(scoped_tool_host_drops_the_cross_tree_tools_from_the_catalog) {
  RecordingToolHost inner;
  ScopedToolHost scoped(inner, TreeId{"t_target"});
  const std::vector<std::string> names = toolNames(scoped.listTools());
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
  scoped.callTool("create_node", args, UserId{"u1"});

  REQUIRE_EQ(inner.calls.size(), std::size_t{1});
  CHECK_EQ(inner.calls[0].name, std::string("create_node"));
  CHECK_EQ(inner.calls[0].args["treeId"].asString(), std::string("t_target"));  // redirected home
  CHECK_EQ(inner.calls[0].args["label"].asString(), std::string("New step"));   // other args intact
  CHECK_EQ(inner.calls[0].caller, std::string("u1"));                           // caller passes through
}

TEST(scoped_tool_host_refuses_a_cross_tree_tool_without_reaching_the_inner_host) {
  RecordingToolHost inner;
  ScopedToolHost scoped(inner, TreeId{"t_target"});
  const ToolResult deleted = scoped.callTool("delete_tree", Json::Value(Json::objectValue), UserId{"u1"});
  CHECK(deleted.isError);
  CHECK_EQ(inner.calls.size(), std::size_t{0});  // the destructive call never reached the real host
}

TEST(scoped_tool_host_records_exactly_the_nodes_the_tend_planted) {
  RecordingToolHost inner;
  ScopedToolHost scoped(inner, TreeId{"t_target"});
  const UserId u{"u1"};

  Json::Value a(Json::objectValue); a["id"] = "n1"; scoped.callTool("create_node", a, u);
  Json::Value b(Json::objectValue); b["id"] = "n2"; scoped.callTool("create_node", b, u);
  // A rename echoes an id too (applyEdit does), but it created nothing — it must NOT be recorded.
  Json::Value renamed(Json::objectValue); renamed["id"] = "existing"; scoped.callTool("rename_node", renamed, u);
  // import_subgraph plants every incoming node that wasn't already there (no collisions here).
  Json::Value imp(Json::objectValue);
  Json::Value nodes(Json::arrayValue);
  Json::Value n3(Json::objectValue); n3["id"] = "n3"; nodes.append(n3);
  Json::Value n4(Json::objectValue); n4["id"] = "n4"; nodes.append(n4);
  imp["nodes"] = nodes;
  scoped.callTool("import_subgraph", imp, u);

  CHECK_EQ(scoped.createdNodeIds(), (std::vector<std::string>{"n1", "n2", "n3", "n4"}));
}
