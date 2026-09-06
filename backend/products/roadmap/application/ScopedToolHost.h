#pragma once

#include "products/roadmap/domain/Ids.h"
#include "platform/ports/ToolHost.h"

#include <map>
#include <string>
#include <vector>

namespace wm {

// Pins a tend's agent to one tree: every tool call's `treeId` is forced to the scope, and tools that
// reach across trees are dropped from the catalog and refused if named anyway. A name the inner
// catalog does not declare, and an argument the tool's schema does not declare, are refused here
// with the sentences the MCP wire gives, because a tend never passes through CompositeToolHost.
// Retired names are not consulted: a tend's agent reads the catalog it was handed, never an older
// one.
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
  std::map<std::string, ToolDeclaration> byName_;  // the inner catalog, indexed once at construction
  std::vector<std::string> created_;
};

}
