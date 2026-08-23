#pragma once

#include "products/roadmap/domain/Ids.h"
#include "platform/ports/ToolHost.h"

#include <string>
#include <vector>

namespace wm {

// A tend edits ONE existing tree, so the agent is pinned to it: every tool call has its `treeId`
// forced to the scope, and the tools that reach ACROSS trees (create a new one, list them all,
// delete a whole one) are dropped from the catalog and refused if named anyway. Even a hijacked run
// can only touch the tree it was asked to tend, and can neither mint nor destroy trees.
//
// This is NOT the grant gate, and the two are stacked rather than merged: CompositeToolHost narrows
// by what a CREDENTIAL was granted, this narrows by what a RUN was asked to do. A tend is wired to
// roadmap's host directly and never to the composite.
class ScopedToolHost : public ToolHost {
public:
  ScopedToolHost(ToolHost& inner, TreeId scope);

  std::vector<ToolDeclaration> declareTools() const override;
  ToolResult callTool(const std::string& name, const Json::Value& arguments, const ToolCaller& caller) override;

  // The nodes THIS tend planted, in call order — captured at the tool boundary as each create lands,
  // so it is exactly what the agent made. The authoritative set the receipt's Undo reverts.
  const std::vector<std::string>& createdNodeIds() const { return created_; }

private:
  ToolHost& inner_;
  TreeId scope_;
  std::vector<std::string> created_;
};

}
