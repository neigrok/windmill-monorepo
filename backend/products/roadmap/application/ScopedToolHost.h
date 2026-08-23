#pragma once

#include "products/roadmap/domain/Ids.h"
#include "platform/ports/ToolHost.h"

#include <string>
#include <vector>

namespace wm {

// A tend edits ONE existing tree, so the agent is pinned to it: every tool call has its `treeId`
// forced to the scope, and the tools that reach ACROSS trees are dropped from the catalog and
// refused if named anyway. Even a hijacked run can only touch the tree it was asked to tend.
//
// NOT the grant gate: CompositeToolHost narrows by what a CREDENTIAL was granted, this by what a RUN
// was asked to do. A tend is wired to roadmap's host directly, never to the composite.
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
