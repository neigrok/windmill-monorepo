#include "platform/adapters/mcp/CompositeToolHost.h"

#include <algorithm>
#include <optional>
#include <stdexcept>
#include <utility>

namespace wm {

namespace {

// The properties an object schema declares, comma-joined — what a refusal offers instead of the key
// it rejected.
std::string declaredKeys(const Json::Value& schema) {
  std::string out;
  for (const std::string& property : schema["properties"].getMemberNames()) {
    if (!out.empty()) out += ", ";
    out += property;
  }
  return out.empty() ? "no arguments" : out;
}

// A key no schema declares, at any depth `additionalProperties:false` reaches: every object the
// schema closes is checked against its `properties`, every array's items are walked, and the
// offending key is named by its JSON path (`nodes[3].deleted`) rather than dropped. An object the
// schema leaves open, and a value of a shape the schema does not describe, pass through untouched —
// the tool answers those itself, naming the type.
std::optional<std::string> undeclaredKey(const Json::Value& schema, const Json::Value& value,
                                         const std::string& path) {
  if (value.isObject()) {
    const Json::Value& properties = schema["properties"];
    const bool closed = schema["additionalProperties"].isBool() && !schema["additionalProperties"].asBool();
    for (const std::string& key : value.getMemberNames()) {
      const std::string here = path.empty() ? key : path + "." + key;
      if (!properties.isMember(key)) {
        if (!closed) continue;
        return "unknown argument \"" + here + "\". " + (path.empty() ? std::string("This tool") : path) +
               " takes: " + declaredKeys(schema) + ".";
      }
      if (std::optional<std::string> bad = undeclaredKey(properties[key], value[key], here)) return bad;
    }
    return std::nullopt;
  }
  if (value.isArray() && schema.isMember("items")) {
    for (Json::ArrayIndex i = 0; i < value.size(); ++i) {
      if (std::optional<std::string> bad =
              undeclaredKey(schema["items"], value[i], path + "[" + std::to_string(i) + "]"))
        return bad;
    }
  }
  return std::nullopt;
}

}  // namespace

CompositeToolHost::CompositeToolHost(const std::vector<ToolModule>& modules) {
  for (const ToolModule& module : modules) {
    if (!module.instructions.empty()) {
      if (!instructions_.empty()) instructions_ += "\n\n";
      instructions_ += module.instructions;
    }
    for (ToolDeclaration& declaration : module.host.declareTools()) {
      const std::string name = declaration.name();
      const auto [entry, fresh] = byName_.emplace(name, tools_.size());
      if (!fresh)
        throw std::invalid_argument("two products declare the MCP tool \"" + name + "\": " +
                                    tools_[entry->second].declaration.product + " and " +
                                    declaration.product +
                                    " — one name must answer for exactly one product");
      if (std::find(products_.begin(), products_.end(), declaration.product) == products_.end())
        products_.push_back(declaration.product);
      tools_.push_back(Registered{std::move(declaration), &module.host});
    }
    for (ToolRetirement& retirement : module.host.retiredTools())
      retired_.emplace(retirement.name, std::move(retirement));
  }

  // Checked after every module is in, because the live tool a retirement collides with — or the
  // replacement it points at — may belong to a module registered later.
  for (const auto& [name, retirement] : retired_) {
    if (byName_.count(name))
      throw std::invalid_argument("the MCP tool \"" + name + "\" is declared by " +
                                  tools_[byName_.at(name)].declaration.product +
                                  " and retired at the same time — a retired name must never shadow "
                                  "a live one");
    if (!retirement.replacement.empty() && !byName_.count(retirement.replacement))
      throw std::invalid_argument("the retired MCP tool \"" + name + "\" names \"" +
                                  retirement.replacement +
                                  "\" as its replacement, and no product declares that tool");
  }
}

std::vector<ToolRetirement> CompositeToolHost::retiredTools() const {
  std::vector<ToolRetirement> all;
  all.reserve(retired_.size());
  for (const auto& entry : retired_) all.push_back(entry.second);
  return all;
}

std::vector<ToolDeclaration> CompositeToolHost::declareTools() const {
  std::vector<ToolDeclaration> all;
  all.reserve(tools_.size());
  for (const Registered& tool : tools_) all.push_back(tool.declaration);
  return all;
}

ToolResult CompositeToolHost::callTool(const std::string& name, const Json::Value& arguments,
                                       const ToolCaller& caller) {
  const auto entry = byName_.find(name);
  if (entry == byName_.end()) {
    // Not scope-gated: the caller already knows the name, and the sentence names what took over.
    const auto retired = retired_.find(name);
    if (retired != retired_.end()) return ToolResult::failure(name + ": " + retired->second.sentence);
    return ToolResult::failure(name + ": no such tool on this server — call tools/list for the whole "
                                      "surface.");
  }

  const Registered& tool = tools_[entry->second];
  const ToolDeclaration& declared = tool.declaration;
  if (!caller.scope.allows(declared.product, declared.access))
    return ToolResult::failure(name + ": " + notGrantedSentence(declared.product, declared.access));
  if (std::optional<std::string> unknown = undeclaredKey(declared.descriptor["inputSchema"], arguments, ""))
    return ToolResult::failure(name + ": " + *unknown);

  return tool.host->callTool(name, arguments, caller);
}

ServerInfo windmillServerInfo(const CompositeToolHost& tools, const std::string& build) {
  std::string connected;
  for (const std::string& product : tools.products()) {
    if (!connected.empty()) connected += ", ";
    connected += product;
  }

  std::string instructions =
      "Windmill is one account behind several self-growth products. This connection reaches: " +
      (connected.empty() ? std::string("nothing — no product is wired into this server") : connected) +
      ". Your grant is per product and per level (read, write, delete), so tools/list is the whole "
      "surface this connection may use — a tool you cannot see is a level that was not granted, not a "
      "tool that is missing; ask your human to reconnect and approve it. Windmill never gates a call "
      "on human approval: a call this server accepts runs the moment it arrives, and an answer that "
      "reads \"No approval received\" or \"awaiting approval\" is your own client's permission prompt, "
      "not this server. Every read is declared readOnlyHint, so a client can stop prompting on reads; "
      "every tool that deletes or edits in bulk is declared destructiveHint, and a tool that only "
      "proposes a removal for your human to apply is not.";
  const std::string stamp = build.substr(0, 7);
  if (!stamp.empty())
    instructions += " This server is build " + stamp +
                    "; a tools/list your session cached before that build may name tools it no "
                    "longer declares — reconnect rather than concluding the server is old.";
  if (!tools.instructions().empty()) instructions += "\n\n" + tools.instructions();

  return {"windmill", stamp.empty() ? "0.1.0" : "0.1.0+" + stamp, std::move(instructions)};
}

}
