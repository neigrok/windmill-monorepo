#pragma once

#include "products/roadmap/domain/Ids.h"
#include "platform/ports/ToolHost.h"

#include <string>
#include <vector>

namespace wm {

// Pins a tend's agent to one tree: every tool call's `treeId` is forced to the scope, and tools that
// reach across trees are dropped from the catalog and refused if named anyway.
class ScopedToolHost : public ToolHost {
public:
  ScopedToolHost(ToolHost& inner, TreeId scope);

  std::vector<ToolDeclaration> declareTools() const override;
  ToolResult callTool(const std::string& name, const Json::Value& arguments, const ToolCaller& caller) override;

  // The nodes THIS tend planted, in call order, captured at the tool boundary as each create lands.
  // The authoritative set the receipt's Undo reverts.
  const std::vector<std::string>& createdNodeIds() const { return created_; }

private:
  ToolHost& inner_;
  TreeId scope_;
  std::vector<std::string> created_;
};

}
