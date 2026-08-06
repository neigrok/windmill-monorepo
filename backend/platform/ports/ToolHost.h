#pragma once

#include "platform/domain/ToolScope.h"

#include <json/json.h>

#include <string>
#include <vector>

namespace wm {

// The result of one tool invocation, in MCP's `tools/call` shape. `content` is the array
// of blocks the model reads (we emit a single text block) — the primary channel, and the
// one every client understands. `payload` is that same answer unserialized, for the hosts
// in this process that read a result rather than ship it (a tend reads back the seq it
// wrote); it never reaches the wire. `structured` is MCP's structuredContent, which the
// spec pairs with a declared `outputSchema` — left null unless a tool declares one, since
// otherwise it is the whole answer sent a second time. `isError` marks a tool-level
// failure — reported inside the result so the model sees it, not as a JSON-RPC transport
// error.
struct ToolResult {
  Json::Value content{Json::arrayValue};
  Json::Value payload{Json::nullValue};
  Json::Value structured{Json::nullValue};
  bool isError = false;

  static ToolResult text(const std::string& body) {
    ToolResult out;
    Json::Value block(Json::objectValue);
    block["type"] = "text";
    block["text"] = body;
    out.content.append(block);
    return out;
  }

  // content = compact dump, payload = value, structuredContent = nothing
  static ToolResult json(const Json::Value& value) {
    Json::StreamWriterBuilder builder;
    builder["indentation"] = "";
    ToolResult out = text(Json::writeString(builder, value));
    out.payload = value;
    return out;
  }

  static ToolResult failure(const std::string& message) {
    ToolResult out = text(message);
    out.isError = true;
    return out;
  }
};

// One tool as the host serving it declares it: the `tools/list` entry an agent reads, plus the two
// facts a grant is checked against. The classification rides BESIDE the description rather than in a
// side table because the two are the same promise told twice — a tool whose sentence says it deletes
// and whose row says it writes would hand out the reach nobody approved.
struct ToolDeclaration {
  Json::Value descriptor;  // {name, description, inputSchema} — the wire shape, verbatim
  std::string product;     // whose grant reaches it: the `product` half of `gym:delete`
  Access access;

  std::string name() const { return descriptor.get("name", "").asString(); }
};

// The catalog and executor of a product's tools — the one seam the protocol engine drives. A module
// declares its whole surface and never its own gate: the gate is one decision, taken above every
// module by CompositeToolHost, which is what McpServer binds.
struct ToolHost {
  virtual ~ToolHost() = default;

  virtual std::vector<ToolDeclaration> declareTools() const = 0;

  // `caller` is the account the transport authenticated (an OAuth token's user over HTTP, the
  // configured user over stdio) together with what that credential was granted — every edit acts as
  // the account, within the grant.
  virtual ToolResult callTool(const std::string& name, const Json::Value& arguments,
                              const ToolCaller& caller) = 0;

  // The `tools/list` array this caller's grant may see. Concrete and shared on purpose: one filter
  // rule, read from the same declarations the dispatcher gates on, so a catalog can never advertise a
  // tool the next call would refuse.
  Json::Value listTools(const ToolCaller& caller) const {
    Json::Value tools(Json::arrayValue);
    for (const ToolDeclaration& tool : declareTools())
      if (caller.scope.allows(tool.product, tool.access)) tools.append(tool.descriptor);
    return tools;
  }
};

}
