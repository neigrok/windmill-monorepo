#include "platform/adapters/mcp/CompositeToolHost.h"

#include <algorithm>
#include <optional>
#include <stdexcept>
#include <utility>

namespace wm {

namespace {

// The properties a tool declares, comma-joined — what a refusal offers instead of the key it just
// rejected. An agent cannot look at an example and recover the way a person reading docs can, so a
// refusal that names only the mistake costs a whole round trip.
std::string declaredArguments(const Json::Value& inputSchema) {
  std::string out;
  for (const std::string& property : inputSchema["properties"].getMemberNames()) {
    if (!out.empty()) out += ", ";
    out += property;
  }
  return out.empty() ? "no arguments" : out;
}

// An argument the schema never declared. `additionalProperties:false` has been published on every
// tool from the start and enforced by nothing, so this is the promise finally being kept — the
// misnamed key is named, not dropped.
std::optional<std::string> unknownArgument(const Json::Value& inputSchema, const Json::Value& arguments) {
  if (!arguments.isObject()) return std::nullopt;  // the host answers a wrong-shape body, naming its type
  const Json::Value& properties = inputSchema["properties"];
  for (const std::string& key : arguments.getMemberNames()) {
    if (properties.isMember(key)) continue;
    return "unknown argument \"" + key + "\". This tool takes: " + declaredArguments(inputSchema) + ".";
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
    return ToolResult::failure(name + ": this connection was not granted " + declared.product + ":" +
                               toString(declared.access) +
                               ", so it cannot run this tool. Reconnect and approve that level.");
  if (std::optional<std::string> unknown = unknownArgument(declared.descriptor["inputSchema"], arguments))
    return ToolResult::failure(name + ": " + *unknown);

  return tool.host->callTool(name, arguments, caller);
}

ServerInfo windmillServerInfo(const CompositeToolHost& tools, const std::string& build) {
  std::string connected;
  for (const std::string& product : tools.products()) {
    if (!connected.empty()) connected += ", ";
    connected += product;
  }

  // The one sentence a scoped surface has to carry: a short tools/list is an answer, not a fault.
  // Without it an agent that was granted read and asked for write reads the missing tool as a broken
  // server and retries, or invents a workaround, instead of telling its human to reconnect.
  std::string instructions =
      "Windmill is one account behind several self-growth products. This connection reaches: " +
      (connected.empty() ? std::string("nothing — no product is wired into this server") : connected) +
      ". Your grant is per product and per level (read, write, delete), so tools/list is the whole "
      "surface this connection may use — a tool you cannot see is a level that was not granted, not a "
      "tool that is missing; ask your human to reconnect and approve it.";
  // The stamp is short the way a human quotes a commit, and it is said in the same breath as the
  // catalog rule: a tool your session lists that this build no longer declares is a session older
  // than the deploy, not a server older than the repo.
  const std::string stamp = build.substr(0, 7);
  if (!stamp.empty())
    instructions += " This server is build " + stamp +
                    "; a tools/list your session cached before that build may name tools it no "
                    "longer declares — reconnect rather than concluding the server is old.";
  if (!tools.instructions().empty()) instructions += "\n\n" + tools.instructions();

  return {"windmill", stamp.empty() ? "0.1.0" : "0.1.0+" + stamp, std::move(instructions)};
}

}
