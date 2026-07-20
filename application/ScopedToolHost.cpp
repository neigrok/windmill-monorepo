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
  return inner_.callTool(name, scopedArgs, caller);
}

}
