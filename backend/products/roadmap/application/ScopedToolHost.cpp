#include "products/roadmap/application/ScopedToolHost.h"

#include <set>
#include <utility>

namespace wm {

namespace {
// The cross-tree reach a single-tree tend has no use for. Dropped from the catalog the agent sees,
// and refused if it names one anyway.
const std::set<std::string>& crossTreeTools() {
  static const std::set<std::string> names{"create_tree", "list_trees", "delete_tree"};
  return names;
}
}

ScopedToolHost::ScopedToolHost(ToolHost& inner, TreeId scope)
    : inner_(inner), scope_(std::move(scope)) {}

std::vector<ToolDeclaration> ScopedToolHost::declareTools() const {
  std::vector<ToolDeclaration> scoped;
  for (ToolDeclaration& tool : inner_.declareTools())
    if (crossTreeTools().find(tool.name()) == crossTreeTools().end()) scoped.push_back(std::move(tool));
  return scoped;
}

ToolResult ScopedToolHost::callTool(const std::string& name, const Json::Value& arguments,
                                    const ToolCaller& caller) {
  if (crossTreeTools().find(name) != crossTreeTools().end())
    return ToolResult::failure("tending edits a single tree — " + name + " is out of its reach");
  // Force the target: whatever treeId the agent supplied (or was steered to supply) is overwritten,
  // so the edit can only ever land on the tree being tended.
  Json::Value scopedArgs = arguments;
  scopedArgs["treeId"] = scope_.str();
  ToolResult result = inner_.callTool(name, scopedArgs, caller);

  // Record what this call planted, from the tool's own result. create_node echoes the one id it
  // minted; import_subgraph plants every incoming node that wasn't already there. Only those two
  // CREATE, so a modify tool's echoed id is never captured.
  if (!result.isError) {
    if (name == "create_node") {
      const std::string id = result.payload.get("id", "").asString();
      if (!id.empty()) created_.push_back(id);
    } else if (name == "import_subgraph" && !result.payload.get("dryRun", Json::Value(false)).asBool()) {
      std::set<std::string> collided;
      for (const Json::Value& c : result.payload["nodeCollisions"]) collided.insert(c.asString());
      for (const Json::Value& node : scopedArgs["nodes"]) {
        const std::string id = node.get("id", "").asString();
        if (!id.empty() && !collided.count(id)) created_.push_back(id);
      }
    }
  }
  return result;
}

}
