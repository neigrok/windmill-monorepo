#include "application/ScopedToolHost.h"

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
    Json::Value ok(Json::objectValue);
    ok["ok"] = true;
    return ToolResult::json(ok);
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

  CHECK_EQ(inner.calls.size(), std::size_t{1});
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
