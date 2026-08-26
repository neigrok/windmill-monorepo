#pragma once

#include "platform/adapters/json/JsonText.h"
#include "platform/domain/ToolScope.h"

#include <json/json.h>

#include <optional>
#include <string>
#include <vector>

namespace wm {

// MCP `tools/call` shape. `content` is the blocks the model reads. `payload` is the same answer
// unserialized for in-process hosts and never reaches the wire. `structured` is structuredContent,
// left null unless the tool declares an outputSchema. `isError` is a tool-level failure, reported
// inside the result rather than as a JSON-RPC error.
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
    ToolResult out = text(dump(value));
    out.payload = value;
    return out;
  }

  static ToolResult failure(const std::string& message) {
    ToolResult out = text(message);
    out.isError = true;
    return out;
  }
};

// The `tools/list` entry an agent reads, plus the two facts a grant is checked against.
struct ToolDeclaration {
  Json::Value descriptor;  // {name, description, inputSchema} — the wire shape, verbatim
  std::string product;     // whose grant reaches it: the `product` half of `gym:delete`
  Access access;

  std::string name() const { return descriptor.get("name", "").asString(); }
};

// A retired tool name and the answer an agent calling it should read; `replacement` is empty when
// nothing took over.
struct ToolRetirement {
  std::string name;
  std::string replacement;
  std::string sentence;
};

// A module declares its whole surface and never its own gate: CompositeToolHost gates above it.
struct ToolHost {
  virtual ~ToolHost() = default;

  virtual std::vector<ToolDeclaration> declareTools() const = 0;

  // Every edit acts as `caller`'s account, within the grant that account's credential carries.
  virtual ToolResult callTool(const std::string& name, const Json::Value& arguments,
                              const ToolCaller& caller) = 0;

  virtual std::vector<ToolRetirement> retiredTools() const { return {}; }

  // Consult only after a name misses the live catalog: a retired name must never shadow a live one.
  std::optional<ToolRetirement> retirement(const std::string& name) const {
    for (ToolRetirement& retired : retiredTools())
      if (retired.name == name) return retired;
    return std::nullopt;
  }

  // Filtered from the same declarations the dispatcher gates on.
  Json::Value listTools(const ToolCaller& caller) const {
    Json::Value tools(Json::arrayValue);
    for (const ToolDeclaration& tool : declareTools())
      if (caller.scope.allows(tool.product, tool.access)) tools.append(tool.descriptor);
    return tools;
  }
};

}
