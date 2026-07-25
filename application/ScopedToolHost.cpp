#include "application/ScopedToolHost.h"

#include <set>
#include <utility>

namespace wm {

namespace {
// The reach a single-tree tend has no use for and an injected prompt would most want: minting a
// tree, enumerating the caller's trees, or deleting a whole one. Dropped from the catalog the
// agent sees, and refused if it names one anyway.
const std::set<std::string>& crossTreeTools() {
  static const std::set<std::string> names{"create_tree", "list_trees", "delete_tree"};
  return names;
}
}

ScopedToolHost::ScopedToolHost(ToolHost& inner, TreeId scope)
    : inner_(inner), scope_(std::move(scope)) {}

Json::Value ScopedToolHost::listTools() const {
  Json::Value scoped(Json::arrayValue);
  for (const Json::Value& tool : inner_.listTools())
    if (crossTreeTools().find(tool.get("name", "").asString()) == crossTreeTools().end())
      scoped.append(tool);
  return scoped;
}

ToolResult ScopedToolHost::callTool(const std::string& name, const Json::Value& arguments,
                                    const UserId& caller) {
  if (crossTreeTools().find(name) != crossTreeTools().end())
    return ToolResult::failure("tending edits a single tree — " + name + " is out of its reach");
  // Force the target: whatever treeId the agent supplied (or was steered to supply) is overwritten,
  // so the edit can only ever land on the tree being tended.
  Json::Value scopedArgs = arguments;
  scopedArgs["treeId"] = scope_.str();
  ToolResult result = inner_.callTool(name, scopedArgs, caller);

  // Record what this call planted, from the tool's own result — so the tend's Undo reverts exactly
  // the agent's additions and never a step someone else touched. create_node echoes the one id it
  // minted; import_subgraph plants every incoming node that wasn't already there (its result names
  // the collisions that already existed). Modify tools (rename, recolor) also echo an id, so this
  // captures only the two that CREATE — never the id of a step the agent merely changed.
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
