#include "platform/adapters/mcp/CompositeToolHost.h"

#include <algorithm>
#include <optional>
#include <stdexcept>
#include <utility>

namespace wm {

namespace {

std::string toolReferences(const std::string& source, const std::map<std::string, std::string>& names) {
  std::string out;
  for (std::size_t begin = 0; begin < source.size();) {
    const unsigned char first = static_cast<unsigned char>(source[begin]);
    if (!std::isalnum(first) && first != '_') {
      out += source[begin++];
      continue;
    }
    std::size_t end = begin + 1;
    while (end < source.size() && (std::isalnum(static_cast<unsigned char>(source[end])) || source[end] == '_')) ++end;
    const std::string word = source.substr(begin, end - begin);
    const auto replacement = names.find(word);
    const bool explicitTool = word.find('_') != std::string::npos ||
        (begin > 0 && source[begin - 1] == '`') || (end < source.size() && source[end] == '(');
    out += replacement == names.end() || !explicitTool ? word : replacement->second;
    begin = end;
  }
  return out;
}

void describeCanonicalTools(Json::Value& schema, const std::map<std::string, std::string>& names) {
  if (!schema.isObject()) return;
  if (schema.isMember("description") && schema["description"].isString()) schema["description"] = toolReferences(schema["description"].asString(), names);
  for (const char* key : {"inputSchema", "outputSchema", "items", "additionalProperties", "propertyNames",
                          "contains", "not", "if", "then", "else"})
    if (schema.isMember(key)) describeCanonicalTools(schema[key], names);
  for (const char* key : {"properties", "patternProperties", "$defs", "definitions", "dependentSchemas"}) {
    if (!schema.isMember(key) || !schema[key].isObject()) continue;
    for (const std::string& child : schema[key].getMemberNames()) describeCanonicalTools(schema[key][child], names);
  }
  for (const char* key : {"allOf", "anyOf", "oneOf", "prefixItems"}) {
    if (!schema.isMember(key) || !schema[key].isArray()) continue;
    for (Json::Value& child : schema[key]) describeCanonicalTools(child, names);
  }
}

}

CompositeToolHost::CompositeToolHost(const std::vector<ToolModule>& modules) {
  std::map<std::string, std::vector<std::size_t>> localNames;
  for (const ToolModule& module : modules) {
    for (ToolDeclaration& declaration : module.host.declareTools()) {
      const std::string local = declaration.name();
      const std::string canonical = declaration.product + "_" + local;
      if (!byName_.emplace(canonical, tools_.size()).second)
        throw std::invalid_argument("two products declare the canonical MCP tool \"" + canonical + "\"");
      localNames[local].push_back(tools_.size());
      if (std::find(products_.begin(), products_.end(), declaration.product) == products_.end())
        products_.push_back(declaration.product);
      tools_.push_back(Registered{std::move(declaration), &module.host, canonical});
    }
  }
  for (const auto& [name, matches] : localNames) {
    if (byName_.count(name))
      throw std::invalid_argument("the MCP compatibility alias \"" + name + "\" collides with a canonical tool name");
    if (matches.size() != 1) continue;
    byName_.emplace(name, matches.front());
  }

  for (const ToolModule& module : modules) {
    const auto references = referencesFor(module.host);
    if (!module.instructions.empty()) {
      if (!instructions_.empty()) instructions_ += "\n\n";
      instructions_ += toolReferences(module.instructions, references);
    }
    for (ToolRetirement retirement : module.host.retiredTools()) {
      const std::string local = retirement.name;
      std::string product;
      for (const Registered& tool : tools_) {
        if (tool.host != &module.host) continue;
        if (product.empty()) product = tool.declaration.product;
        if (product != tool.declaration.product)
          throw std::invalid_argument("a module with retired MCP tools must own exactly one product");
      }
      if (product.empty()) throw std::invalid_argument("a module with retired MCP tools must declare its product");
      if (!retirement.replacement.empty()) {
        const auto replacement = byName_.find(product + "_" + retirement.replacement);
        if (replacement == byName_.end() || tools_[replacement->second].host != &module.host ||
            tools_[replacement->second].publicName != product + "_" + retirement.replacement)
          throw std::invalid_argument("the retired MCP tool \"" + local + "\" names \"" + retirement.replacement +
                                     "\" as its replacement, and its product does not declare that tool");
      }
      for (const std::string& name : {local, product + "_" + local}) {
        if (byName_.count(name) || localNames.count(name))
          throw std::invalid_argument("the MCP tool \"" + name + "\" is both declared and retired");
        ToolRetirement alias = retirement;
        alias.name = name;
        if (name != local) {
          if (!alias.replacement.empty()) alias.replacement = product + "_" + alias.replacement;
          alias.sentence = toolReferences(alias.sentence, references);
        }
        if (!retired_.emplace(name, std::move(alias)).second)
          throw std::invalid_argument("two modules retire the MCP tool \"" + name + "\"");
      }
    }
  }
}

std::vector<ToolRetirement> CompositeToolHost::retiredTools() const {
  std::vector<ToolRetirement> all;
  all.reserve(retired_.size());
  for (const auto& entry : retired_) all.push_back(entry.second);
  return all;
}

std::map<std::string, std::string> CompositeToolHost::referencesFor(const ToolHost& host) const {
  std::map<std::string, std::string> references;
  for (const Registered& tool : tools_)
    if (byName_.count(tool.declaration.name())) references.emplace(tool.declaration.name(), tool.publicName);
  for (const Registered& tool : tools_)
    if (tool.host == &host) references[tool.declaration.name()] = tool.publicName;
  return references;
}

std::vector<ToolDeclaration> CompositeToolHost::declareTools() const {
  std::vector<ToolDeclaration> all;
  all.reserve(tools_.size());
  for (const Registered& tool : tools_) {
    ToolDeclaration publicTool = tool.declaration;
    publicTool.descriptor["title"] = tool.declaration.title();
    publicTool.descriptor["name"] = tool.publicName;
    describeCanonicalTools(publicTool.descriptor, referencesFor(*tool.host));
    all.push_back(std::move(publicTool));
  }
  return all;
}

ToolResult CompositeToolHost::callTool(const std::string& name, const Json::Value& arguments,
                                       const ToolCaller& caller) {
  const auto entry = byName_.find(name);
  if (entry == byName_.end()) {
    // Not scope-gated: the caller already knows the name, and the sentence names what took over.
    const auto retired = retired_.find(name);
    if (retired != retired_.end()) return ToolResult::failure(name + ": " + retired->second.sentence);
    return ToolResult::failure(name + ": " + noSuchToolSentence());
  }

  const Registered& tool = tools_[entry->second];
  const ToolDeclaration& declared = tool.declaration;
  if (!caller.scope.allows(declared.product, declared.access))
    return ToolResult::failure(name + ": " + notGrantedSentence(declared.product, declared.access));
  if (std::optional<std::string> unknown = undeclaredArgument(declared, arguments))
    return ToolResult::failure(name + ": " + *unknown);

  return tool.host->callTool(declared.name(), arguments, caller);
}

ServerInfo windmillServerInfo(const CompositeToolHost& tools, const std::string& build) {
  std::string connected;
  for (const std::string& product : tools.products()) {
    if (!connected.empty()) connected += ", ";
    connected += product;
  }

  std::string instructions =
      "Use the user's stated goals, preferences, constraints and earlier answers. Read relevant app "
      "state before recommending or making changes. Ask only for missing information that materially "
      "affects the result; do not ask people to repeat known context or invent their answers. Keep "
      "explanations clear, concise, friendly and grounded in what the app records.\n\n"
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
