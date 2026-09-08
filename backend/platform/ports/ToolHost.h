#pragma once

#include "platform/adapters/json/JsonText.h"
#include "platform/domain/ToolScope.h"

#include <json/json.h>

#include <cctype>
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

// What a product authors for one tool, and the facts the wire annotations and the grant gate are
// both derived from. `wire()` is the `tools/list` entry an agent reads: the descriptor plus the MCP
// `annotations` block and a `_meta` naming the product and level — derived here, once, so no
// product can declare a tool without them.
struct ToolDeclaration {
  Json::Value descriptor;  // {name, description, inputSchema}, as the catalog wrote it
  std::string product;     // whose grant reaches it: the `product` half of `gym:delete`
  Access access;
  bool bulkEdit = false;    // a `write` that overwrites or removes many entries in one call
  bool idempotent = false;  // a write the same arguments leave unchanged the second time
  bool proposal = false;    // a `delete`-level tool that only PROPOSES the removal, for a human to apply

  std::string name() const { return descriptor.get("name", "").asString(); }

  // A delete-level tool destroys by definition, a bulk edit destroys under a write grant, and a
  // proposal destroys nothing: the grant buys the right to ask.
  bool destructive() const { return !proposal && (access == Access::del || bulkEdit); }

  // "Roadmap · Get tree": the product word first, so a client's search groups one product's tools.
  std::string title() const {
    if (descriptor["title"].isString()) return descriptor["title"].asString();
    std::string word = product;
    if (!word.empty()) word[0] = static_cast<char>(std::toupper(static_cast<unsigned char>(word[0])));
    std::string human = name();
    for (char& c : human) c = c == '_' ? ' ' : c;
    if (!human.empty()) human[0] = static_cast<char>(std::toupper(static_cast<unsigned char>(human[0])));
    return word + " · " + human;
  }

  Json::Value wire() const {
    Json::Value annotations(Json::objectValue);
    annotations["title"] = title();
    annotations["readOnlyHint"] = access == Access::read;
    annotations["destructiveHint"] = destructive();
    annotations["idempotentHint"] = access == Access::read || idempotent;
    annotations["openWorldHint"] = false;  // every tool reaches the caller's own account and nothing beyond it

    Json::Value meta(Json::objectValue);
    meta["product"] = product;
    meta["access"] = toString(access);

    Json::Value out = descriptor;
    out["title"] = title();
    out["annotations"] = annotations;
    out["_meta"] = meta;
    return out;
  }
};

// The one refusal a name no live catalog declares gets, wherever the gate stands: the composite
// for the whole server, and a scoped host for the catalog it was handed.
inline std::string noSuchToolSentence() {
  return "no such tool on this server — call tools/list for the whole surface.";
}

// A retired tool name and the answer an agent calling it should read; `replacement` is empty when
// nothing took over.
struct ToolRetirement {
  std::string name;
  std::string replacement;
  std::string sentence;
};

// A key `tool`'s schema does not declare, at any depth the schema closes with
// `additionalProperties:false` — nested objects and array items included — named by its JSON path
// and the keys that place takes; nullopt when every key is declared. Every host that dispatches a
// call runs this before the tool sees the arguments, so a misnamed argument is refused on the MCP
// wire and inside a tend alike, never dropped in silence.
std::optional<std::string> undeclaredArgument(const ToolDeclaration& tool, const Json::Value& arguments);

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

  // Filtered from the same declarations the dispatcher gates on, each in its wire shape.
  Json::Value listTools(const ToolCaller& caller) const {
    Json::Value tools(Json::arrayValue);
    for (const ToolDeclaration& tool : declareTools())
      if (caller.scope.allows(tool.product, tool.access)) tools.append(tool.wire());
    return tools;
  }
};

}
