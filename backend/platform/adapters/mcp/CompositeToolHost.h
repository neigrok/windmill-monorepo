#pragma once

#include "platform/adapters/mcp/McpServer.h"
#include "platform/ports/ToolHost.h"

#include <cstddef>
#include <map>
#include <string>
#include <vector>

namespace wm {

// One product's registration at the composition root: the host that serves its tools and the
// paragraph it wants in the initialize handshake. The product NAME is not repeated here — it rides on
// each declaration, so there is exactly one place a product is spelled and no way for the two to
// disagree about which grant reaches a tool. The handshake paragraph rides here and the resource
// catalog does not, because the paragraph is one document several products must SHARE — someone has
// to compose it — while resources/list is a plain concatenation the engine already takes by injection.
struct ToolModule {
  ToolHost& host;
  std::string instructions;
};

// Every connected product's tools behind the single seam McpServer binds — and the gate. This is
// where a grant is enforced, above the domain and below no one: a name outside the caller's scope is
// refused here, naming the level that was not granted, and the same scope filters the catalog through
// ToolHost::listTools, so the tools a connection can see and the tools it can call are one answer.
//
// Two things it refuses outright. A duplicate tool name across products is a CONSTRUCTION failure,
// not a runtime coin flip about which product answers a call. And an argument no schema declares is
// refused before dispatch: every tool publishes `additionalProperties:false` and nothing enforced it,
// so a misnamed key was dropped in silence and the write answered success — which cost an entire
// import's edges under a description promising the batch was atomic against malformed input. The
// composite is the one place holding every schema, so that check is written once for every tool.
class CompositeToolHost : public ToolHost {
public:
  explicit CompositeToolHost(const std::vector<ToolModule>& modules);

  std::vector<ToolDeclaration> declareTools() const override;
  ToolResult callTool(const std::string& name, const Json::Value& arguments,
                      const ToolCaller& caller) override;

  // The products actually served, in registration order — what `scopes_supported` is derived from,
  // so the authorization server cannot advertise a grant no tool honours.
  const std::vector<std::string>& products() const { return products_; }
  const std::string& instructions() const { return instructions_; }

private:
  struct Registered {
    ToolDeclaration declaration;
    ToolHost* host;
  };

  std::vector<Registered> tools_;
  std::map<std::string, std::size_t> byName_;  // tool name -> index into tools_, built once at boot
  std::vector<std::string> products_;
  std::string instructions_;
};

// The initialize handshake for a server that speaks for several products. Product-neutral in its
// frame and product-supplied in its content — the same injection seam the resource catalog already
// uses — because a handshake describing skill trees to a client connected for its training log is
// the plainest kind of wrong answer.
ServerInfo windmillServerInfo(const CompositeToolHost& tools);

}
