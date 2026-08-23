#pragma once

#include "platform/adapters/mcp/McpServer.h"
#include "platform/ports/ToolHost.h"

#include <cstddef>
#include <map>
#include <string>
#include <vector>

namespace wm {

// One product's registration at the composition root: the host that serves its tools and the
// paragraph it wants in the initialize handshake. The product name rides on each declaration instead.
struct ToolModule {
  ToolHost& host;
  std::string instructions;
};

// Every connected product's tools behind the single seam McpServer binds — and the grant gate. A
// name outside the caller's scope is refused here, naming the level that was not granted, and the
// same scope filters the catalog through ToolHost::listTools, so what a connection can see and what
// it can call are one answer.
//
// A duplicate tool name across products is a CONSTRUCTION failure. An argument no schema declares is
// refused before dispatch: every tool publishes `additionalProperties:false` and this is where it is enforced.
class CompositeToolHost : public ToolHost {
public:
  explicit CompositeToolHost(const std::vector<ToolModule>& modules);

  std::vector<ToolDeclaration> declareTools() const override;
  std::vector<ToolRetirement> retiredTools() const override;
  ToolResult callTool(const std::string& name, const Json::Value& arguments,
                      const ToolCaller& caller) override;

  // The products actually served, in registration order — what `scopes_supported` is derived from.
  const std::vector<std::string>& products() const { return products_; }
  const std::string& instructions() const { return instructions_; }

private:
  struct Registered {
    ToolDeclaration declaration;
    ToolHost* host;
  };

  std::vector<Registered> tools_;
  std::map<std::string, std::size_t> byName_;  // tool name -> index into tools_, built once at boot
  std::map<std::string, ToolRetirement> retired_;  // consulted only after byName_ misses
  std::vector<std::string> products_;
  std::string instructions_;
};

// The initialize handshake for a server speaking for several products: product-neutral frame,
// product-supplied content.
// `build` is the deployed commit (empty on a laptop), riding in `serverInfo.version` as semver
// build metadata and named in the instructions.
ServerInfo windmillServerInfo(const CompositeToolHost& tools, const std::string& build = "");

}
