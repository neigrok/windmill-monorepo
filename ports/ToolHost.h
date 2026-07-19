#pragma once

#include "domain/Ids.h"

#include <json/json.h>

#include <string>

namespace wm {

// The result of one tool invocation, in MCP's `tools/call` shape. `content` is the array
// of blocks the model reads (we emit a single text block); `structured` mirrors it as
// machine-readable JSON (structuredContent), null when absent. `isError` marks a
// tool-level failure — reported inside the result so the model sees it, not as a
// JSON-RPC transport error.
struct ToolResult {
  Json::Value content{Json::arrayValue};
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

  // text = compact dump, structured = value
  static ToolResult json(const Json::Value& value) {
    Json::StreamWriterBuilder builder;
    builder["indentation"] = "";
    ToolResult out = text(Json::writeString(builder, value));
    out.structured = value;
    return out;
  }

  static ToolResult failure(const std::string& message) {
    ToolResult out = text(message);
    out.isError = true;
    return out;
  }
};

// The catalog and executor of the server's tools — the one seam the protocol engine
// drives. RoadmapTools is the production implementation; tests substitute a fake.
struct ToolHost {
  virtual ~ToolHost() = default;
  virtual Json::Value listTools() const = 0;  // the `tools/list` "tools" array
  // `caller` is the authenticated account the transport resolved for this request (an OAuth
  // token's user over HTTP, the configured user over stdio) — every edit acts as them.
  virtual ToolResult callTool(const std::string& name, const Json::Value& arguments, const UserId& caller) = 0;
};

}
