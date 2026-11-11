#include "products/roadmap/application/ScopedToolHost.h"
#include "platform/application/WriteObservation.h"

#include <map>
#include <memory>
#include <optional>
#include <set>
#include <utility>

namespace wm {

namespace {
// What a tend is never offered, each with the sentence that refuses it if the agent names it anyway.
// A tool goes by its name: the cross-tree reach a single-tree tend has no use for, and the guide,
// which the owner writes for every run to read. A word goes wherever a tool's schema carries it, as
// an argument's key or as a value an enum lists, so a field that reaches another tree is named here
// once and is gone from every tool that takes it or answers it.
struct Withheld {
  std::map<std::string, std::string> tools;
  std::map<std::string, std::string> words;
};

const Withheld& withheld() {
  static const Withheld reach{
      {{"create_tree", "tending edits a single tree — create_tree is out of its reach"},
       {"list_trees", "tending edits a single tree — list_trees is out of its reach"},
       {"delete_tree", "tending edits a single tree — delete_tree is out of its reach"},
       {"describe_tree", "tending reads the tree's guide but cannot set it — describe_tree is out of its reach"}},
      {{"opens", "tending edits a single tree — the tree a node opens is out of its reach"}}};
  return reach;
}

// `schema` as a tend is handed it: no withheld word among its properties or its enums, at any depth.
Json::Value offeredSchema(Json::Value schema) {
  if (!schema.isObject()) return schema;
  if (schema.isMember("enum")) {
    Json::Value listed(Json::arrayValue);
    for (const Json::Value& value : schema["enum"])
      if (!value.isString() || !withheld().words.count(value.asString())) listed.append(value);
    schema["enum"] = listed;
  }
  if (schema.isMember("properties")) {
    for (const auto& [word, sentence] : withheld().words) schema["properties"].removeMember(word);
    for (const std::string& key : schema["properties"].getMemberNames())
      schema["properties"][key] = offeredSchema(schema["properties"][key]);
  }
  if (schema.isMember("items")) schema["items"] = offeredSchema(schema["items"]);
  return schema;
}

// The tool as a tend is handed it, which is also what its arguments are judged against.
ToolDeclaration offered(ToolDeclaration tool) {
  if (tool.descriptor.isMember("inputSchema"))
    tool.descriptor["inputSchema"] = offeredSchema(tool.descriptor["inputSchema"]);
  return tool;
}

// The sentence for a withheld word `value` names where `schema` carries it — a key it declares, or a
// value its enum lists — or nullopt.
std::optional<std::string> withheldWord(const Json::Value& schema, const Json::Value& value) {
  if (!schema.isObject()) return std::nullopt;
  const std::map<std::string, std::string>& words = withheld().words;
  if (value.isString()) {
    const auto word = words.find(value.asString());
    if (word == words.end()) return std::nullopt;
    for (const Json::Value& listed : schema["enum"])
      if (listed == value) return word->second;
    return std::nullopt;
  }
  if (value.isObject()) {
    const Json::Value& properties = schema["properties"];
    for (const std::string& key : value.getMemberNames()) {
      if (!properties.isObject() || !properties.isMember(key)) continue;
      if (const auto word = words.find(key); word != words.end()) return word->second;
      if (std::optional<std::string> refusal = withheldWord(properties[key], value[key])) return refusal;
    }
  }
  if (value.isArray())
    for (const Json::Value& item : value)
      if (std::optional<std::string> refusal = withheldWord(schema["items"], item)) return refusal;
  return std::nullopt;
}
}

ScopedToolHost::ScopedToolHost(ToolHost& inner, TreeId scope)
    : inner_(inner), scope_(std::move(scope)) {
  for (ToolDeclaration& tool : inner_.declareTools()) byName_.emplace(tool.name(), std::move(tool));
}

std::vector<ToolDeclaration> ScopedToolHost::declareTools() const {
  std::vector<ToolDeclaration> scoped;
  for (ToolDeclaration& tool : inner_.declareTools()) {
    if (!withheld().tools.count(tool.name())) scoped.push_back(offered(std::move(tool)));
  }
  return scoped;
}

ToolResult ScopedToolHost::callTool(const std::string& name, const Json::Value& arguments,
                                    const ToolCaller& caller) {
  // Refused before anything is observed: a withheld name is no write of the run's.
  if (const auto tool = withheld().tools.find(name); tool != withheld().tools.end())
    return ToolResult::failure(tool->second);

  const auto declaration = byName_.find(name);
  std::unique_ptr<WriteObservation> observation;
  std::unique_ptr<WriteContext> context;
  if (declaration != byName_.end() && declaration->second.access != Access::read) {
    observation = std::make_unique<WriteObservation>("roadmap." + declaration->first, "roadmap", "Coach");
    context = std::make_unique<WriteContext>(*observation);
  }
  try {
    const ToolResult result = [&]() {
      const auto declared = byName_.find(name);
      if (declared == byName_.end()) return ToolResult::failure(name + ": " + noSuchToolSentence());
      // The agent's own arguments are checked, before the forced treeId joins them: a withheld word
      // first, in the sentence that says why, then a key the tool as offered does not declare.
      if (std::optional<std::string> refusal =
              withheldWord(std::as_const(declared->second.descriptor)["inputSchema"], arguments))
        return ToolResult::failure(*refusal);
      if (std::optional<std::string> unknown = undeclaredArgument(offered(declared->second), arguments))
        return ToolResult::failure(name + ": " + *unknown);
      // Force the target: whatever treeId the agent supplied (or was steered to supply) is overwritten,
      // so the edit can only ever land on the tree being tended.
      Json::Value scopedArgs = arguments;
      scopedArgs["treeId"] = scope_.str();
      ToolResult result = inner_.callTool(name, scopedArgs, caller);

      // Record what this call planted, from the tool's own result. create_node echoes the one id it
      // minted; import_subgraph plants every incoming node that wasn't already there. Only those two
      // CREATE, so a modify tool's echoed id is never captured.
      if (!result.isError) {
        if (name == "create_node") {
          const std::string id = result.payload.get("id", "").asString();
          if (!id.empty()) created_.push_back(id);
        } else if (name == "import_subgraph" && !result.payload.get("dryRun", Json::Value(false)).asBool()) {
          std::set<std::string> collided;
          for (const Json::Value& c : result.payload["nodeCollisions"]) collided.insert(c.asString());
          for (const Json::Value& node : scopedArgs["nodes"]) {
            const std::string id = node.get("id", "").asString();
            if (!id.empty() && !collided.count(id)) created_.push_back(id);
          }
        }
      }
      return result;
    }();
    if (observation) observation->finish(toolWriteOutcome(result));
    return result;
  } catch (const std::exception& error) {
    if (observation) observation->fail(error);
    throw;
  } catch (...) {
    if (observation) observation->failUnknown();
    throw;
  }
}

}
