#pragma once

#include "domain/Ids.h"
#include "ports/ToolHost.h"

#include <string>

namespace wm {

// A tend edits ONE existing tree, so the agent is pinned to it: every tool call has its `treeId`
// forced to the scope — an injected node label can never redirect an edit to another of the
// caller's trees — and the tools that reach ACROSS trees (create a new one, list them all, delete
// a whole one) are dropped from the catalog and refused if named anyway. The prompt-injection risk
// is real: a public tree the caller tends carries node labels the agent reads as context, and
// without this a hijacked run could act on every tree the caller owns. With it, even a hijacked
// run can only touch the tree it was asked to tend, and can neither mint nor destroy trees.
class ScopedToolHost : public ToolHost {
public:
  ScopedToolHost(ToolHost& inner, TreeId scope);

  Json::Value listTools() const override;
  ToolResult callTool(const std::string& name, const Json::Value& arguments, const UserId& caller) override;

private:
  ToolHost& inner_;
  TreeId scope_;
};

}
