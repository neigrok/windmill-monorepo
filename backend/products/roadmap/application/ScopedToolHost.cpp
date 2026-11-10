#include "products/roadmap/application/ScopedToolHost.h"
#include "platform/application/WriteObservation.h"

#include <map>
#include <memory>
#include <optional>
#include <set>
#include <utility>

namespace wm {

namespace {
// What a tend is never offered, each with the sentence that refuses it if the agent names it anyway:
// the cross-tree reach a single-tree tend has no use for, and the guide, which the owner writes for
// every run to read.
const std::map<std::string, std::string>& withheldTools() {
  static const std::map<std::string, std::string> refusals{
      {"create_tree", "tending edits a single tree — create_tree is out of its reach"},
      {"list_trees", "tending edits a single tree — list_trees is out of its reach"},
      {"delete_tree", "tending edits a single tree — delete_tree is out of its reach"},
      {"describe_tree", "tending reads the tree's guide but cannot set it — describe_tree is out of its reach"}};
  return refusals;
}
}

ScopedToolHost::ScopedToolHost(ToolHost& inner, TreeId scope)
    : inner_(inner), scope_(std::move(scope)) {
  for (ToolDeclaration& tool : inner_.declareTools()) byName_.emplace(tool.name(), std::move(tool));
}

std::vector<ToolDeclaration> ScopedToolHost::declareTools() const {
  std::vector<ToolDeclaration> scoped;
  for (ToolDeclaration& tool : inner_.declareTools())
    if (!withheldTools().count(tool.name())) scoped.push_back(std::move(tool));
  return scoped;
}

ToolResult ScopedToolHost::callTool(const std::string& name, const Json::Value& arguments,
                                    const ToolCaller& caller) {
  // Refused before anything is observed: a withheld name is no write of the run's.
  if (const auto withheld = withheldTools().find(name); withheld != withheldTools().end())
    return ToolResult::failure(withheld->second);

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
      // The agent's own arguments are checked, before the forced treeId joins them.
      if (std::optional<std::string> unknown = undeclaredArgument(declared->second, arguments))
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
