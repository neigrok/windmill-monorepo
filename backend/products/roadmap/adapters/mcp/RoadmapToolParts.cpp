#include "products/roadmap/adapters/mcp/RoadmapToolParts.h"

#include "platform/domain/ToolScope.h"
#include "products/roadmap/adapters/mcp/RoadmapToolCatalog.h"
#include "products/roadmap/adapters/mcp/ToolArgs.h"
#include "products/roadmap/domain/Command.h"

#include <map>
#include <stdexcept>

namespace wm {

std::string writeRefusalSentence(WriteRefusal refusal) {
  if (refusal == WriteRefusal::nobodysTree)
    return std::string(truthOf(refusal)) + ". You can still read it with get_tree, and copy it into "
                                          "a roadmap of your own with create_tree then import_subgraph.";
  return std::string(truthOf(refusal)) + ". Call list_trees to see the roadmaps you own.";
}

ToolResult kindRefused(const KindRefusal& refusal) {
  switch (refusal.reason) {
    case KindRefusal::Reason::unknownKind: return ToolResult::failure(refusal.sentence, "kind-unknown");
    case KindRefusal::Reason::hueMismatch: return ToolResult::failure(refusal.sentence, "kind-hue-mismatch");
    case KindRefusal::Reason::unnamedHue: return ToolResult::failure(refusal.sentence, "kind-unnamed");
  }
  return ToolResult::failure(refusal.sentence);
}

std::optional<std::string> commandKindFor(const std::string& tool) {
  if (tool == "create_node")    return "CreateNode";
  if (tool == "add_kind")       return "AddKind";
  if (tool == "remove_kind")    return "RemoveKind";
  return std::nullopt;
}

bool namesAnExistingKind(const std::string& tool) {
  return tool == "remove_kind";
}

std::optional<std::string> checkAnnotation(const Json::Value& node, const std::string& prefix) {
  if (std::optional<std::string> bad = optionalString(node["description"], prefix + "description"))
    return bad;
  return optionalLinks(node["links"], prefix + "links");
}

std::optional<std::string> optionalKind(const Json::Value& value, const std::string& path) {
  if (value.isNull()) return std::nullopt;
  return requireString(value, path, Empty::rejected, kMaxIdLength);
}

Json::Value progressStatusArgument(const Json::Value& value) {
  if (!value.isString()) return value;
  const auto status = parseProgressStatus(value.asString());
  if (!status) return value;
  return progressStatusName(*status);
}

std::optional<std::string> checkExpectedSeq(const Json::Value& args) {
  if (args.isMember("expectedSeq") && (!args["expectedSeq"].isInt64() || args["expectedSeq"].asInt64() < 0))
    return "expectedSeq must be a non-negative integer from get_tree or get_nodes";
  return std::nullopt;
}

std::optional<std::string> checkImportedNode(const Json::Value& node, const std::string& path) {
  if (!node.isObject()) return path + " must be an object, got " + typeName(node);
  if (std::optional<std::string> bad = requireString(node["id"], path + ".id", Empty::rejected, kMaxIdLength))
    return bad;
  if (std::optional<std::string> bad = optionalString(node["label"], path + ".label")) return bad;
  if (std::optional<std::string> bad = optionalString(node["icon"], path + ".icon")) return bad;
  if (std::optional<std::string> bad = optionalOneOf(node["color"], path + ".color", kHues)) return bad;
  if (std::optional<std::string> bad = optionalKind(node["kind"], path + ".kind")) return bad;
  if (std::optional<std::string> bad = optionalOneOf(progressStatusArgument(node["seedStatus"]), path + ".seedStatus", kStatuses))
    return bad;
  if (!node["status"].isNull()) return path + kSeedStatusMoved;
  if (std::optional<std::string> bad = optionalString(node["order"], path + ".order")) return bad;
  if (std::optional<std::string> bad = optionalStrings(node["prerequisites"], path + ".prerequisites", kMaxIdLength))
    return bad;
  if (std::optional<std::string> bad = optionalString(node["opens"], path + ".opens", kMaxIdLength)) {
    // A read answers `opens` as an object, so a node sent back as it was read is told which part of it to send.
    if (node["opens"].isObject()) return *bad + ". Send the id alone: the treeId inside the opens that a read answers.";
    return bad;
  }
  return checkAnnotation(node, path + ".");
}

void answerRefusedPointers(const std::vector<NodeId>& refused, Json::Value& receipt) {
  if (refused.empty()) return;
  Json::Value ids(Json::arrayValue);
  for (const NodeId& step : refused) ids.append(step.str());
  receipt["opensRefused"] = ids;
  receipt["opensError"] =
      "Some steps own a subtree, which each opens whatever its opens holds: their opens was left as it was and the rest "
      "of the call applied — those ids are listed in opensRefused. To open another roadmap from this tree, set opens on "
      "a step that owns no subtree.";
}

std::optional<std::string> prepareEdit(const std::string& tool, Json::Value& payload) {
  // Strip nulls: commandFromJson reads presence with isMember, so `links: null` would empty a node's links.
  for (const std::string& key : payload.getMemberNames())
    if (payload[key].isNull()) payload.removeMember(key);

  // Read through the const overload: jsoncpp's mutable operator[] CREATES the member it probes.
  const Json::Value& args = payload;

  if (namesAnExistingKind(tool)) {
    std::string kind;
    if (std::optional<std::string> bad = requireHandle(args, kKindHandle, "", kind)) return bad;
    payload["id"] = kind;
  }

  if (tool == "create_node") {
    if (!args[kNodeHandle.published].isNull())
      return "\"nodeId\" names a node that already exists — the id you propose for a NEW node "
             "is \"id\", and is minted from the label when you omit it.";
    if (std::optional<std::string> bad = requireString(args["label"], "label", Empty::rejected)) return bad;
    if (std::optional<std::string> bad = optionalString(args["id"], "id", kMaxIdLength)) return bad;
    if (std::optional<std::string> bad = optionalString(args["icon"], "icon")) return bad;
    if (std::optional<std::string> bad = optionalOneOf(args["color"], "color", kHues)) return bad;
    if (std::optional<std::string> bad = optionalKind(args["kind"], "kind")) return bad;
    if (std::optional<std::string> bad = optionalStrings(args["prerequisites"], "prerequisites", kMaxIdLength))
      return bad;
    if (std::optional<std::string> bad = optionalString(args["parentId"], "parentId", kMaxIdLength))
      return bad;
    if (std::optional<std::string> bad = optionalString(args["opens"], "opens", kMaxIdLength)) return bad;
    // A created node opens the tree this call names and no other: the pointer is always written, so
    // an id a deleted node held brings none of that node's pointer back.
    if (args["opens"].isNull()) payload["opens"] = "";
    return checkAnnotation(args, "");
  }
  if (tool == "add_kind") {
    if (!args[kKindHandle.alias].isNull())
      return "\"kindId\" names a kind that already exists — the id you propose for a NEW kind "
             "is \"id\".";
    if (std::optional<std::string> bad = requireString(args["id"], "id", Empty::rejected, kMaxIdLength))
      return bad;
    if (std::optional<std::string> bad = requireOneOf(args["hue"], "hue", kHues)) return bad;
    if (std::optional<std::string> bad = optionalString(args["label"], "label", kMaxKindLabelLength))
      return bad;
    return optionalString(args["description"], "description", kMaxKindDescriptionLength);
  }
  return std::nullopt;  // remove_kind takes its handle alone
}

std::string quotedList(const std::vector<std::string>& ids) {
  std::string out;
  for (const std::string& id : ids) {
    if (!out.empty()) out += ", ";
    out += "\"" + id + "\"";
  }
  return out;
}

std::variant<std::set<TreeId>, std::string> branchesOf(const Json::Value& args, std::size_t cap) {
  if (std::optional<std::string> bad = optionalStrings(args["branches"], "branches", kMaxIdLength)) return *bad;
  if (args["branches"].size() > cap)
    return "branches has " + std::to_string(args["branches"].size()) + " items, max " + std::to_string(cap);
  std::set<TreeId> branches;
  for (const Json::Value& branch : args["branches"]) branches.emplace(branch.asString());
  return branches;
}

void fellShort(Json::Value& receipt, const std::string& sentence) {
  const std::string said = receipt.get("progressError", "").asString();
  receipt["progressApplied"] = false;
  receipt["progressError"] = said.empty() ? sentence : said + " " + sentence;
}

std::variant<RequestedMark, std::string> readMark(const Json::Value& row, const std::string& path) {
  const std::string field = path + ".";
  std::string node;
  if (std::optional<std::string> bad = requireHandle(row, kNodeHandle, path, node)) return *bad;
  if (std::optional<std::string> bad = requireOneOf(progressStatusArgument(row["status"]), field + "status", kStatuses))
    return *bad;
  const ProgressStatus status = *parseProgressStatus(row["status"].asString());
  if (std::optional<std::string> bad = optionalBool(row["outOfOrder"], field + "outOfOrder")) return *bad;
  const bool outOfOrder = row["outOfOrder"].asBool();
  if (outOfOrder && status != ProgressStatus::complete)
    return "argument \"" + field + "outOfOrder\" acknowledges completing a node before its prerequisites, so it " +
           "rides status \"complete\" only, got \"" + progressStatusName(status) + "\"";
  return RequestedMark{NodeId{node}, status, outOfOrder};
}

std::optional<std::string> checkKinds(const Json::Value& kinds, std::size_t limit) {
  if (std::optional<std::string> bad = optionalObjects(kinds, "kinds", limit)) return bad;
  std::map<std::string, Json::ArrayIndex> kindIdAt;
  for (Json::ArrayIndex i = 0; i < kinds.size(); ++i) {
    const std::string path = "kinds[" + std::to_string(i) + "]";
    if (std::optional<std::string> bad = requireString(kinds[i]["id"], path + ".id", Empty::rejected, kMaxIdLength))
      return bad;
    if (std::optional<std::string> bad = requireOneOf(kinds[i]["hue"], path + ".hue", kHues)) return bad;
    if (std::optional<std::string> bad = optionalString(kinds[i]["label"], path + ".label", kMaxKindLabelLength))
      return bad;
    if (std::optional<std::string> bad =
            optionalString(kinds[i]["description"], path + ".description", kMaxKindDescriptionLength))
      return bad;
    const auto [seen, fresh] = kindIdAt.emplace(kinds[i]["id"].asString(), i);
    if (!fresh)
      return path + ".id \"" + seen->first + "\" is already used by kinds[" + std::to_string(seen->second) +
             "] — an id names one kind per batch";
  }
  return std::nullopt;
}

std::optional<std::string> checkImport(const Json::Value& args) {
  if (args["nodes"].isNull())
    return "missing required argument \"nodes\". Pass \"nodes\": [] to import only kinds or progress.";
  // Two rows under one id is malformed, not an upsert: which wins is order-dependent.
  if (std::optional<std::string> bad = optionalObjects(args["nodes"], "nodes")) return bad;
  std::map<std::string, Json::ArrayIndex> nodeIdAt;
  for (Json::ArrayIndex i = 0; i < args["nodes"].size(); ++i) {
    const std::string path = "nodes[" + std::to_string(i) + "]";
    if (std::optional<std::string> bad = checkImportedNode(args["nodes"][i], path)) return bad;
    const auto [seen, fresh] = nodeIdAt.emplace(args["nodes"][i]["id"].asString(), i);
    if (!fresh)
      return path + ".id \"" + seen->first + "\" is already used by nodes[" +
             std::to_string(seen->second) + "] — an id names one node per batch";
  }

  // Each description is within its own cap by here; the batch is bounded as a whole, since the
  // graft is one frame every subscriber receives entire.
  std::size_t descriptionBytes = 0;
  for (const Json::Value& node : args["nodes"])
    if (node["description"].isString()) descriptionBytes += node["description"].asString().size();
  if (descriptionBytes > kMaxImportDescriptionBytes)
    return "nodes carries " + std::to_string(descriptionBytes) + " bytes of description text, " +
           std::to_string(descriptionBytes - kMaxImportDescriptionBytes) + " over the " +
           std::to_string(kMaxImportDescriptionBytes) + "-byte cap one call may carry — split the import";

  if (std::optional<std::string> bad = checkKinds(args["kinds"], 0)) return bad;

  if (std::optional<std::string> bad = optionalObjects(args["progress"], "progress", kMaxProgressUpdates)) return bad;

  if (!args["dryRun"].isNull() && !args["dryRun"].isBool())
    return "argument \"dryRun\" must be a boolean, got " + typeName(args["dryRun"]);
  if (std::optional<std::string> bad =
          optionalOneOf(args["prerequisiteMode"], "prerequisiteMode", kPrerequisiteModes))
    return bad;

  if (std::optional<std::string> bad = optionalStrings(args["tombstone"], "tombstone", kMaxIdLength)) return bad;
  if (args["tombstone"].size() > kMaxTombstones)
    return "tombstone has " + std::to_string(args["tombstone"].size()) + " items, max " +
           std::to_string(kMaxTombstones);
  // An id is upserted or tombstoned, never both; and no upserted node may hang off a node this call
  // deletes. Every offender is named, so one round-trip fixes the batch.
  std::set<std::string> tombstoned;
  for (const Json::Value& id : args["tombstone"]) tombstoned.insert(id.asString());
  std::vector<std::string> both;
  for (const std::string& id : tombstoned) if (nodeIdAt.count(id)) both.push_back(id);
  if (!both.empty())
    return "tombstone names " + quotedList(both) +
           ", which nodes[] also carries — an id is upserted or tombstoned, never both";
  for (Json::ArrayIndex i = 0; i < args["nodes"].size(); ++i)
    for (const Json::Value& prereq : args["nodes"][i]["prerequisites"])
      if (tombstoned.count(prereq.asString()))
        return "nodes[" + std::to_string(i) + "].prerequisites names \"" + prereq.asString() +
               "\", which tombstone deletes in this same call — drop it from one of them";
  return std::nullopt;
}

std::optional<std::string> deleteTargets(const Json::Value& args, std::vector<NodeId>& out) {
  const bool single = !args[kNodeHandle.published].isNull() || !args[kNodeHandle.alias].isNull();
  const bool batch = !args["nodeIds"].isNull();
  if (!single && !batch)
    return "missing required argument \"nodeId\" (or a \"nodeIds\" list of 1 to " +
           std::to_string(kMaxDeleteNodeIds) + " ids). " + kNodeHandle.hint;
  if (single && batch)
    return "pass a single \"nodeId\" or a \"nodeIds\" list, not both — one form names what this call "
           "deletes.";
  if (single) {
    std::string node;
    if (std::optional<std::string> bad = requireHandle(args, kNodeHandle, "", node)) return bad;
    out = {NodeId{node}};
    return std::nullopt;
  }
  if (std::optional<std::string> bad = optionalStrings(args["nodeIds"], "nodeIds", kMaxIdLength)) return bad;
  if (args["nodeIds"].empty())
    return "argument \"nodeIds\" is an empty list — pass at least one id to delete.";
  if (args["nodeIds"].size() > kMaxDeleteNodeIds)
    return "nodeIds has " + std::to_string(args["nodeIds"].size()) + " items, max " +
           std::to_string(kMaxDeleteNodeIds);
  std::map<std::string, Json::ArrayIndex> seenAt;
  for (Json::ArrayIndex i = 0; i < args["nodeIds"].size(); ++i) {
    const auto [seen, fresh] = seenAt.emplace(args["nodeIds"][i].asString(), i);
    if (!fresh)
      return "nodeIds[" + std::to_string(i) + "] \"" + seen->first + "\" is already used by nodeIds[" +
             std::to_string(seen->second) + "] — an id names one node per batch";
    out.emplace_back(seen->first);
  }
  return std::nullopt;
}

std::string subtreeRefusalSentence(SubtreeRefusal refusal, const TreeId& tree, const NodeId& step) {
  switch (refusal) {
    case SubtreeRefusal::noSuchTree: return "no such tree \"" + tree.str() + "\"";
    case SubtreeRefusal::notYours: return writeRefusalSentence(WriteRefusal::notYours);
    case SubtreeRefusal::nobodysTree: return writeRefusalSentence(WriteRefusal::nobodysTree);
    case SubtreeRefusal::stepGone:
      return "no node in this tree is named " + quotedList({step.str()}) + ". " + kNodeHandle.hint;
    case SubtreeRefusal::depthLimit:
      return "subtrees go at most " + std::to_string(kMaxTreeDepth) + " levels below their roadmap, and this tree sits " +
             std::to_string(kMaxTreeDepth) + " levels below it already";
    case SubtreeRefusal::stepOpensATree:
      return "step " + quotedList({step.str()}) + " opens a roadmap of yours: clear its opens with update_nodes "
             "before it holds a subtree";
    case SubtreeRefusal::savePending:
      return "this roadmap's last change is still being saved: try again. Nothing was created.";
  }
  throw std::logic_error("an unknown subtree refusal");
}

}
