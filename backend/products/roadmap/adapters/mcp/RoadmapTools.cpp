#include "products/roadmap/adapters/mcp/RoadmapTools.h"

#include "products/roadmap/adapters/json/CommandJson.h"
#include "products/roadmap/adapters/json/TreeJson.h"
#include "products/roadmap/adapters/mcp/EditReceipt.h"
#include "products/roadmap/adapters/mcp/ReadShape.h"
#include "products/roadmap/adapters/mcp/RoadmapToolCatalog.h"
#include "products/roadmap/adapters/mcp/ToolArgs.h"
#include "products/roadmap/application/TreeRoom.h"
#include "platform/domain/Access.h"
#include "products/roadmap/domain/Command.h"
#include "products/roadmap/domain/NodeQuery.h"
#include "products/roadmap/domain/SkillTree.h"
#include "products/roadmap/domain/TreeHealth.h"
#include "products/roadmap/domain/UnlockRules.h"

#include <cctype>
#include <iostream>
#include <map>
#include <mutex>
#include <optional>
#include <set>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

namespace wm {

namespace {

constexpr char kSeedStatusMoved[] =
    ".status is your own mark on this surface, not the document's — the authored baseline every "
    "reader sees is \"seedStatus\", and your own progress goes in \"progress\": [{nodeId, status}].";

std::string writeRefusalSentence(WriteRefusal refusal) {
  if (refusal == WriteRefusal::nobodysTree)
    return std::string(truthOf(refusal)) + ". You can still read it with get_tree, and copy it into "
                                          "a roadmap of your own with create_tree then import_subgraph.";
  return std::string(truthOf(refusal)) + ". Call list_trees to see the roadmaps you own.";
}

std::string slugify(const std::string& label) {
  std::string out;
  bool dash = false;
  for (unsigned char c : label) {
    if (std::isalnum(c)) {
      out += static_cast<char>(std::tolower(c));
      dash = false;
    } else if (!out.empty() && !dash) {
      out += '-';
      dash = true;
    }
  }
  while (!out.empty() && out.back() == '-') out.pop_back();
  return out.empty() ? "node" : out;
}

std::optional<std::string> commandKindFor(const std::string& tool) {
  if (tool == "create_node")    return "CreateNode";
  if (tool == "annotate_node")  return "AnnotateNode";
  if (tool == "rename_node")    return "RenameNode";
  if (tool == "set_node_color") return "SetNodeColor";
  if (tool == "move_node")      return "RepositionNode";
  if (tool == "connect")        return "AddEdge";
  if (tool == "reconnect")      return "ReconnectEdge";
  if (tool == "tidy")           return "TransitiveReduction";
  if (tool == "add_kind")       return "AddKind";
  if (tool == "rename_kind")    return "RenameKind";
  if (tool == "describe_kind")  return "DescribeKind";
  if (tool == "remove_kind")    return "RemoveKind";
  if (tool == "reorder_kinds")  return "ReorderKinds";
  if (tool == "recolor_kind")   return "RecolorKind";
  return std::nullopt;
}

bool namesAnExistingNode(const std::string& tool) {
  return tool == "annotate_node" || tool == "rename_node" || tool == "set_node_color" ||
         tool == "move_node";
}

bool namesAnExistingKind(const std::string& tool) {
  return tool == "rename_kind" || tool == "describe_kind" || tool == "remove_kind" ||
         tool == "recolor_kind";
}

// `prefix` is blank at the top level and "nodes[3]." inside a list.
std::optional<std::string> checkAnnotation(const Json::Value& node, const std::string& prefix) {
  if (std::optional<std::string> bad =
          optionalString(node["description"], prefix + "description", kMaxNodeDescriptionLength))
    return bad;
  return optionalLinks(node["links"], prefix + "links");
}

// The graft path never runs the domain's validate(), so the caps are checked here or nowhere.
std::optional<std::string> checkImportedNode(const Json::Value& node, const std::string& path) {
  if (!node.isObject()) return path + " must be an object, got " + typeName(node);
  if (std::optional<std::string> bad = requireString(node["id"], path + ".id", Empty::rejected, kMaxIdLength))
    return bad;
  if (std::optional<std::string> bad = optionalString(node["label"], path + ".label", kMaxNodeLabelLength))
    return bad;
  if (std::optional<std::string> bad = optionalString(node["icon"], path + ".icon", kMaxIconLength)) return bad;
  if (std::optional<std::string> bad = optionalOneOf(node["color"], path + ".color", kHues)) return bad;
  if (std::optional<std::string> bad = optionalOneOf(node["seedStatus"], path + ".seedStatus", kStatuses))
    return bad;
  if (!node["status"].isNull()) return path + kSeedStatusMoved;
  if (std::optional<std::string> bad = optionalString(node["order"], path + ".order")) return bad;
  if (std::optional<std::string> bad = optionalStrings(node["prerequisites"], path + ".prerequisites", kMaxIdLength))
    return bad;
  if (std::optional<std::string> bad = optionalObject(node["position"], path + ".position")) return bad;
  if (node["position"].isObject()) {
    if (std::optional<std::string> bad = optionalNumber(node["position"]["x"], path + ".position.x"))
      return bad;
    if (std::optional<std::string> bad = optionalNumber(node["position"]["y"], path + ".position.y"))
      return bad;
  }
  return checkAnnotation(node, path + ".");
}

// Both `nodeId` and `id` land on payload["id"]; runs before commandFromJson decodes.
std::optional<std::string> prepareEdit(const std::string& tool, Json::Value& payload) {
  // Strip nulls: commandFromJson reads presence with isMember, so `links: null` would empty a node's links.
  for (const std::string& key : payload.getMemberNames())
    if (payload[key].isNull()) payload.removeMember(key);

  // Read through the const overload: jsoncpp's mutable operator[] CREATES the member it probes.
  const Json::Value& args = payload;

  if (namesAnExistingNode(tool)) {
    std::string node;
    if (std::optional<std::string> bad = requireHandle(args, kNodeHandle, "", node)) return bad;
    payload["id"] = node;
  }
  if (namesAnExistingKind(tool)) {
    std::string kind;
    if (std::optional<std::string> bad = requireHandle(args, kKindHandle, "", kind)) return bad;
    payload["id"] = kind;
  }

  if (tool == "create_node") {
    if (!args[kNodeHandle.published].isNull())
      return "\"nodeId\" names a node that already exists — the id you propose for a NEW node "
             "is \"id\", and is minted from the label when you omit it.";
    if (std::optional<std::string> bad =
            requireString(args["label"], "label", Empty::rejected, kMaxNodeLabelLength))
      return bad;
    if (std::optional<std::string> bad = optionalString(args["id"], "id", kMaxIdLength)) return bad;
    if (std::optional<std::string> bad = optionalString(args["icon"], "icon", kMaxIconLength)) return bad;
    if (std::optional<std::string> bad = optionalOneOf(args["color"], "color", kHues)) return bad;
    if (std::optional<std::string> bad = optionalStrings(args["prerequisites"], "prerequisites", kMaxIdLength))
      return bad;
    if (std::optional<std::string> bad = optionalString(args["parentId"], "parentId", kMaxIdLength))
      return bad;
    if (std::optional<std::string> bad = optionalNumber(args["x"], "x")) return bad;
    if (std::optional<std::string> bad = optionalNumber(args["y"], "y")) return bad;
    if (args["x"].isNull() != args["y"].isNull())
      return "arguments \"x\" and \"y\" go together — a position needs both.";
    return checkAnnotation(args, "");
  }
  if (tool == "annotate_node") {
    if (args["description"].isNull() && args["links"].isNull())
      return "nothing to set — pass \"description\", \"links\", or both.";
    return checkAnnotation(args, "");
  }
  if (tool == "rename_node")
    return requireString(args["label"], "label", Empty::allowed, kMaxNodeLabelLength);
  if (tool == "set_node_color") return requireOneOf(args["color"], "color", kHues);
  if (tool == "move_node") {
    if (std::optional<std::string> bad = requireNumber(args["x"], "x")) return bad;
    return requireNumber(args["y"], "y");
  }
  if (tool == "connect") {
    if (std::optional<std::string> bad = requireString(args["from"], "from", Empty::rejected, kMaxIdLength))
      return bad;
    return requireString(args["to"], "to", Empty::rejected, kMaxIdLength);
  }
  if (tool == "reconnect") {
    for (const char* endpoint : {"oldFrom", "oldTo", "newFrom", "newTo"})
      if (std::optional<std::string> bad =
              requireString(args[endpoint], endpoint, Empty::rejected, kMaxIdLength))
        return bad;
    return std::nullopt;
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
  if (tool == "rename_kind")
    return requireString(args["label"], "label", Empty::allowed, kMaxKindLabelLength);
  if (tool == "describe_kind")
    return requireString(args["description"], "description", Empty::allowed, kMaxKindDescriptionLength);
  if (tool == "remove_kind") return std::nullopt;  // its handle is all it takes
  if (tool == "reorder_kinds") {
    if (args["order"].isNull())
      return "missing required argument \"order\" — the kind ids in the order you want them";
    return optionalStrings(args["order"], "order", kMaxIdLength);
  }
  if (tool == "recolor_kind") return requireOneOf(args["hue"], "hue", kHues);
  return std::nullopt;  // tidy takes nothing beyond treeId
}

// Holds the tree's strand and opens the room; an absent tree becomes a tool-level error.
template <typename Fn>
ToolResult withRoom(RoomRegistry& registry, const TreeId& tree, Fn&& fn) {
  std::lock_guard<std::mutex> lock(registry.strandFor(tree));
  TreeRoom* room = registry.open(tree);
  if (!room) return ToolResult::failure("no such tree \"" + tree.str() + "\"");
  return fn(*room);
}

// States are derived over the whole tree: a prerequisite may sit off the page.
NodeReadContext readContextFor(ProgressService& progress, const TreeId& tree, const std::optional<UserId>& caller,
                               const std::vector<NodeSpec>& nodes, const NodeFields& fields, bool filtersOnState) {
  const bool needsStates = fields.count(NodeField::state) || filtersOnState;
  const bool needsMarks = fields.count(NodeField::status) || needsStates;
  NodeReadContext context;
  if (needsMarks && caller) context.marks = progress.progressOf(tree, *caller);
  if (needsStates) context.states = UnlockRules::derive(nodes, context.marks);
  return context;
}

ToolResult readTree(RoomRegistry& registry, ProgressService& progress, const TreeId& tree,
                    const Json::Value& args, const std::optional<UserId>& caller) {
  return withRoom(registry, tree, [&](TreeRoom& room) -> ToolResult {
    // Byte-identical to the absent message, or the id is an existence oracle.
    if (!canRead(caller, room.owner(), room.visibility())) return ToolResult::failure("no such tree \"" + tree.str() + "\"");

    std::string error;
    std::optional<NodeFields> nodeFields =
        nodeVocabulary().parse(args["fields"], "fields", kGetTreeFields, error);
    if (!nodeFields) return ToolResult::failure(error);
    std::optional<KindFields> kindFields =
        kindVocabulary().parse(args["kindFields"], "kindFields", kLegendFields, error);
    if (!kindFields) return ToolResult::failure(error);

    const TreeData data = room.snapshot();
    std::optional<Page> page = pageOf(data.nodes, args, error);
    if (!page) return ToolResult::failure(error);

    const NodeReadContext context = readContextFor(progress, tree, caller, data.nodes, *nodeFields, false);
    Json::Value nodes(Json::arrayValue);
    for (std::size_t i = page->begin; i < page->end; ++i)
      nodes.append(projectNode(data.nodes[i], *nodeFields, context));
    Json::Value kinds(Json::arrayValue);
    for (const Kind& kind : data.kinds) kinds.append(projectKind(kind, *kindFields));

    Json::Value document(Json::objectValue);
    document["id"] = data.id.str();
    document["title"] = data.title;
    document["nodes"] = nodes;
    document["kinds"] = kinds;

    Json::Value out(Json::objectValue);
    out["seq"] = static_cast<Json::Int64>(room.head());
    out["count"] = static_cast<Json::UInt64>(data.nodes.size());  // the whole tree, not this page
    if (!page->nextCursor.empty()) out["nextCursor"] = page->nextCursor;
    out["tree"] = document;
    return ToolResult::json(out);
  });
}

ToolResult readDiagnostics(RoomRegistry& registry, const TreeId& tree, const std::optional<UserId>& caller) {
  return withRoom(registry, tree, [&](TreeRoom& room) -> ToolResult {
    if (!canRead(caller, room.owner(), room.visibility())) return ToolResult::failure("no such tree \"" + tree.str() + "\"");
    return ToolResult::json(toJson(room.diagnose()));
  });
}

ToolResult readHealth(RoomRegistry& registry, const TreeId& tree, const std::optional<UserId>& caller) {
  return withRoom(registry, tree, [&](TreeRoom& room) -> ToolResult {
    if (!canRead(caller, room.owner(), room.visibility())) return ToolResult::failure("no such tree \"" + tree.str() + "\"");
    if (!room.diagnose().clean())
      return ToolResult::failure(
          "tree has cycles/dangling/self-edges; health needs a valid DAG — call get_diagnostics");
    try {
      Health health = TreeHealth::assess(SkillTree(room.snapshot()));
      Json::Value out(Json::objectValue);
      out["nodeCount"] = health.nodeCount;
      out["edgeCount"] = health.edgeCount;
      out["crossBranch"] = health.crossBranch;
      out["redundant"] = health.redundant;
      out["avgInDegree"] = health.avgInDegree;
      out["score"] = health.score;
      return ToolResult::json(out);
    } catch (const std::exception& error) {
      return ToolResult::failure(error.what());
    }
  });
}

ToolResult readProgress(ProgressService& progress, const TreeId& tree, const Json::Value& args,
                        const UserId& user) {
  std::string error;
  std::optional<ProgressFields> fields =
      progressVocabulary().parse(args["fields"], "fields", kProgressFields, error);
  if (!fields) return ToolResult::failure(error);
  return ToolResult::json(projectProgress(progress.progressOf(tree, user), *fields));
}

ToolResult findNodes(RoomRegistry& registry, ProgressService& progress, const TreeId& tree,
                     const Json::Value& args, const std::optional<UserId>& caller) {
  return withRoom(registry, tree, [&](TreeRoom& room) -> ToolResult {
    if (!canRead(caller, room.owner(), room.visibility())) return ToolResult::failure("no such tree \"" + tree.str() + "\"");
    if (std::optional<std::string> bad = optionalOneOf(args["color"], "color", kHues))
      return ToolResult::failure(*bad);
    if (std::optional<std::string> bad = optionalString(args["kind"], "kind", kMaxIdLength))
      return ToolResult::failure(*bad);
    if (std::optional<std::string> bad = optionalString(args["query"], "query"))
      return ToolResult::failure(*bad);
    if (std::optional<std::string> bad = optionalOneOf(args["state"], "state", kNodeStates))
      return ToolResult::failure(*bad);

    NodeFilter filter;
    if (args["color"].isString()) filter.color = parseColor(args["color"].asString());
    if (args["kind"].isString() && !args["kind"].asString().empty())
      filter.kind = KindId{args["kind"].asString()};
    filter.query = args.get("query", "").asString();
    std::optional<NodeState> state;
    if (args["state"].isString()) state = parseNodeState(args["state"].asString());

    std::string error;
    std::optional<NodeFields> fields = nodeVocabulary().parse(args["fields"], "fields", kFindNodesFields, error);
    if (!fields) return ToolResult::failure(error);

    // selectNodes must stay pure in (tree, filter) or a cursor stops resuming: the state filter runs after it.
    const TreeData data = room.snapshot();
    const NodeReadContext context = readContextFor(progress, tree, caller, data.nodes, *fields, state.has_value());
    std::vector<NodeSpec> matches = selectNodes(data, filter);
    if (state)
      std::erase_if(matches, [&](const NodeSpec& node) { return context.states.at(node.id) != *state; });
    std::optional<Page> page = pageOf(matches, args, error);
    if (!page) return ToolResult::failure(error);

    Json::Value nodes(Json::arrayValue);
    for (std::size_t i = page->begin; i < page->end; ++i)
      nodes.append(projectNode(matches[i], *fields, context));
    Json::Value out(Json::objectValue);
    out["count"] = static_cast<Json::UInt64>(matches.size());  // everything that matched, not this page
    out["nodes"] = nodes;
    if (!page->nextCursor.empty()) out["nextCursor"] = page->nextCursor;
    return ToolResult::json(out);
  });
}

ToolResult applyEdit(RoomRegistry& registry, const TreeId& tree, const std::string& tool,
                     Json::Value payload, Clock& clock, const UserId& actor) {
  const std::string kind = *commandKindFor(tool);
  if (std::optional<std::string> bad = prepareEdit(tool, payload)) return ToolResult::failure(*bad);

  return withRoom(registry, tree, [&](TreeRoom& room) -> ToolResult {
    // Read gate first, answering as an absent tree does, then the write gate: the owner alone.
    if (!canRead(actor, room.owner(), room.visibility()))
      return ToolResult::failure("no such tree \"" + tree.str() + "\"");
    if (std::optional<WriteRefusal> refusal = writeRefusalFor(actor, room.owner()))
      return ToolResult::failure(writeRefusalSentence(*refusal));
    if (tool == "create_node" && payload.get("id", "").asString().empty()) {
      std::set<std::string> present;
      for (const NodeSpec& node : room.snapshot().nodes) present.insert(node.id.str());
      std::string base = slugify(payload.get("label", "").asString());
      std::string id = base;
      for (int n = 2; present.count(id); ++n) id = base + "-" + std::to_string(n);
      payload["id"] = id;
    }

    // Unreachable by construction: prepareEdit has already refused everything the decode can.
    std::optional<Command> command = commandFromJson(kind, payload);
    if (!command)
      return ToolResult::failure("the arguments passed every published check but no " + kind +
                                 " could be built from them — that is a server bug, please report it.");
    if (std::optional<std::string> reason = room.validate(*command)) return ToolResult::failure(*reason);

    // Bracketed under the strand, so whatever the tree gains between these reads, this gained.
    const TreeDiagnostics before = room.diagnose();
    Seq seq = room.applyCommand(*command, clock.nowMs(), actor);
    registry.persist(tree);  // flush the dirty rows so the web reader sees this edit

    Json::Value out(Json::objectValue);
    out["applied"] = true;
    out["seq"] = static_cast<Json::Int64>(seq);
    answerDiagnostics(before, room.diagnose(), out);
    if (payload.isMember("id")) out["id"] = payload["id"];
    return ToolResult::json(out);
  });
}

std::optional<std::string> applyProgressBatch(
    RoomRegistry& registry, ProgressService& progress, PresenceBus& bus, const TreeId& tree,
    Clock& clock, const UserId& user, const std::vector<std::pair<NodeId, ProgressStatus>>& requested,
    bool rejectUnknown, Json::Value& results, Json::Value& skipped) {
  // Both out-params are set at entry, so an early return still leaves them as empty arrays.
  results = Json::Value(Json::arrayValue);
  skipped = Json::Value(Json::arrayValue);  // ids naming no node in the tree
  std::vector<ProgressWrite> marks;
  {
    std::lock_guard<std::mutex> lock(registry.strandFor(tree));
    TreeRoom* room = registry.open(tree);
    // Not owner-gated (a per-user overlay), but private stays owner-only: a mark would confirm which ids exist.
    if (!room || !canRead(user, room->owner(), room->visibility()))
      return "no such tree \"" + tree.str() + "\"";  // byte-identical to every other absent message
    for (const auto& [node, status] : requested) {
      if (!room->hasNode(node)) { skipped.append(node.str()); continue; }
      marks.push_back({node, status, room->prerequisitesOf(node), room->nextStamp(clock.nowMs())});
    }
    // set_progress rejects an unknown id; an import skips it into `skipped`, its graft landed.
    if (rejectUnknown && !skipped.empty()) {
      std::string names;
      for (const Json::Value& id : skipped) { if (!names.empty()) names += ", "; names += id.asString(); }
      return "no node in this tree is named " + names +
             ". Call get_tree with fields [\"id\",\"label\"] to list the ids this tree has.";
    }
  }

  const std::uint64_t receivedAtMs = clock.nowMs();
  std::vector<ProgressOutcome> outcomes = progress.setStatuses(tree, user, marks, receivedAtMs);
  // One echo for the whole batch, not one frame per node.
  Progress recorded;
  for (std::size_t i = 0; i < marks.size(); ++i)
    if (outcomes[i].applied) recorded.record(marks[i].node, ProgressMark{marks[i].status, marks[i].at, receivedAtMs});
  bus.broadcastProgress(tree, user, recorded);
  for (std::size_t i = 0; i < marks.size(); ++i) {
    Json::Value row(Json::objectValue);
    row["nodeId"] = marks[i].node.str();
    row["status"] = progressStatusName(outcomes[i].status);
    row["prerequisitesMet"] = outcomes[i].prerequisitesMet;
    results.append(row);
  }
  return std::nullopt;
}

ToolResult writeProgress(RoomRegistry& registry, ProgressService& progress, PresenceBus& bus,
                         const TreeId& tree, const Json::Value& args, Clock& clock, const UserId& user) {
  const bool single = !args[kNodeHandle.published].isNull() || !args[kNodeHandle.alias].isNull();
  const bool bulk = !args["updates"].isNull();
  if (!single && !bulk)
    return ToolResult::failure(
        "missing required argument \"nodeId\" (or an \"updates\" batch of {nodeId, status}). "
        "Call get_tree with fields [\"id\",\"label\"] to list the ids this tree has.");
  if (single && bulk)
    return ToolResult::failure(
        "pass a single \"nodeId\"+\"status\" or an \"updates\" batch, not both — the single mark "
        "would be dropped.");

  std::vector<std::pair<NodeId, ProgressStatus>> requested;
  if (bulk) {
    if (std::optional<std::string> bad = requireObjects(args["updates"], "updates"))
      return ToolResult::failure(*bad);
    for (Json::ArrayIndex i = 0; i < args["updates"].size(); ++i) {
      const std::string row = "updates[" + std::to_string(i) + "]";
      std::string node;
      if (std::optional<std::string> bad = requireHandle(args["updates"][i], kNodeHandle, row, node))
        return ToolResult::failure(*bad);
      if (std::optional<std::string> bad =
              requireOneOf(args["updates"][i]["status"], row + ".status", kStatuses))
        return ToolResult::failure(*bad);
      requested.emplace_back(NodeId{node}, *parseProgressStatus(args["updates"][i]["status"].asString()));
    }
    if (requested.empty()) return ToolResult::failure("argument \"updates\" is an empty list — pass "
                                                      "at least one {nodeId, status} to mark.");
  } else {
    std::string node;
    if (std::optional<std::string> bad = requireHandle(args, kNodeHandle, "", node))
      return ToolResult::failure(*bad);
    if (std::optional<std::string> bad = requireOneOf(args["status"], "status", kStatuses))
      return ToolResult::failure(*bad);
    requested.emplace_back(NodeId{node}, *parseProgressStatus(args["status"].asString()));
  }

  Json::Value results, skipped;
  if (std::optional<std::string> error =
          applyProgressBatch(registry, progress, bus, tree, clock, user, requested, true, results, skipped))
    return ToolResult::failure(*error);
  if (bulk) {
    Json::Value out(Json::objectValue);
    out["results"] = results;
    return ToolResult::json(out);
  }
  return ToolResult::json(results[0]);  // a singular call keeps its flat {nodeId, status, prerequisitesMet}
}

// `"a", "b", "c"` — every offender in one sentence, so one round-trip fixes the batch.
std::string quotedList(const std::vector<std::string>& ids) {
  std::string out;
  for (const std::string& id : ids) {
    if (!out.empty()) out += ", ";
    out += "\"" + id + "\"";
  }
  return out;
}

// Checked before treeFromJson reads it: the decoder indexes each item as an object.
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

  if (std::optional<std::string> bad = optionalObjects(args["kinds"], "kinds")) return bad;
  std::map<std::string, Json::ArrayIndex> kindIdAt;
  for (Json::ArrayIndex i = 0; i < args["kinds"].size(); ++i) {
    const std::string path = "kinds[" + std::to_string(i) + "]";
    if (std::optional<std::string> bad =
            requireString(args["kinds"][i]["id"], path + ".id", Empty::rejected, kMaxIdLength))
      return bad;
    if (std::optional<std::string> bad = requireOneOf(args["kinds"][i]["hue"], path + ".hue", kHues))
      return bad;
    if (std::optional<std::string> bad =
            optionalString(args["kinds"][i]["label"], path + ".label", kMaxKindLabelLength))
      return bad;
    if (std::optional<std::string> bad = optionalString(args["kinds"][i]["description"],
                                                        path + ".description", kMaxKindDescriptionLength))
      return bad;
    const auto [seen, fresh] = kindIdAt.emplace(args["kinds"][i]["id"].asString(), i);
    if (!fresh)
      return path + ".id \"" + seen->first + "\" is already used by kinds[" +
             std::to_string(seen->second) + "] — an id names one kind per batch";
  }

  if (std::optional<std::string> bad = optionalObjects(args["progress"], "progress")) return bad;
  for (Json::ArrayIndex i = 0; i < args["progress"].size(); ++i) {
    const std::string row = "progress[" + std::to_string(i) + "]";
    std::string node;
    if (std::optional<std::string> bad = requireHandle(args["progress"][i], kNodeHandle, row, node))
      return bad;
    if (std::optional<std::string> bad =
            requireOneOf(args["progress"][i]["status"], row + ".status", kStatuses))
      return bad;
  }

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

// A duplicate hue is unrepairable once it lands.
std::optional<std::string> checkMergedLegend(const std::vector<Kind>& current,
                                             const std::vector<Kind>& incoming) {
  std::set<std::string> replaced;
  for (const Kind& kind : incoming) replaced.insert(kind.id.str());

  std::map<NodeColor, KindId> hueOwner;
  std::size_t size = 0;
  for (const Kind& kind : current) {
    if (replaced.count(kind.id.str())) continue;  // the incoming row overwrites this one
    hueOwner[kind.hue] = kind.id;
    ++size;
  }
  for (Json::ArrayIndex i = 0; i < incoming.size(); ++i) {
    const Kind& kind = incoming[i];
    auto owner = hueOwner.find(kind.hue);
    if (owner != hueOwner.end() && owner->second != kind.id)
      return "kinds[" + std::to_string(i) + "].hue \"" + std::string(toString(kind.hue)) +
             "\" already belongs to kind \"" + owner->second.str() +
             "\" — a hue names one kind, so pick a free one";
    hueOwner[kind.hue] = kind.id;
    ++size;
  }
  if (size > kMaxKinds)
    return "this import would leave " + std::to_string(size) + " kinds in the legend, max " +
           std::to_string(kMaxKinds);
  return std::nullopt;
}

ToolResult importSubgraph(RoomRegistry& registry, ProgressService& progress, PresenceBus& bus,
                          const TreeId& tree, const Json::Value& args, Clock& clock, const UserId& actor) {
  if (std::optional<std::string> bad = checkImport(args)) return ToolResult::failure(*bad);

  std::optional<TreeData> parsed = treeFromJson(args, tree);  // the get_tree shape: nodes[], kinds[]
  if (!parsed) return ToolResult::failure("this import's nodes or kinds carry a field of the wrong type");
  Graft graft;
  graft.document = *std::move(parsed);
  // `seedStatus` is this surface's name for the codec's `status`, folded over it here by id.
  std::map<std::string, std::string> seeds;
  for (const Json::Value& node : args["nodes"])
    if (node["seedStatus"].isString()) seeds[node["id"].asString()] = node["seedStatus"].asString();
  for (NodeSpec& node : graft.document.nodes) {
    auto seed = seeds.find(node.id.str());
    if (seed != seeds.end()) node.status = seed->second;
  }
  const bool replace = args["prerequisiteMode"].asString() == "replace";
  graft.prerequisites = replace ? PrerequisiteMode::replace : PrerequisiteMode::merge;
  for (const Json::Value& id : args["tombstone"]) graft.tombstones.emplace_back(id.asString());
  const bool dryRun = args["dryRun"].asBool();

  ToolResult grafted = withRoom(registry, tree, [&](TreeRoom& room) -> ToolResult {
    // Read gate before the write gate: a dry run's collision list would leak ids to a non-reader.
    if (!canRead(actor, room.owner(), room.visibility()))
      return ToolResult::failure("no such tree \"" + tree.str() + "\"");
    if (std::optional<WriteRefusal> refusal = writeRefusalFor(actor, room.owner()))
      return ToolResult::failure(writeRefusalSentence(*refusal));

    // A tombstone must name a node that is there: every miss is named, and nothing is applied.
    std::vector<std::string> missing;
    for (const NodeId& id : graft.tombstones) if (!room.hasNode(id)) missing.push_back(id.str());
    if (!missing.empty())
      return ToolResult::failure("tombstone names " + quotedList(missing) +
                                 ", which this tree does not hold. " + kNodeHandle.hint);

    // A graft mints no Command, so the tree caps are checked here, before the dry-run branch.
    if (std::optional<Admission> refusal = room.admit(graft))
      return ToolResult::failure(refusal->reason);

    const TreeData& incoming = graft.document;
    TreeData current = room.snapshot();  // collision = an incoming id already present (an upsert overwrites it)
    if (std::optional<std::string> bad = checkMergedLegend(current.kinds, incoming.kinds))
      return ToolResult::failure(*bad);
    std::set<std::string> presentNodes, presentKinds;
    for (const NodeSpec& n : current.nodes) presentNodes.insert(n.id.str());
    for (const Kind& k : current.kinds) presentKinds.insert(k.id.str());

    Json::Value nodeCollisions(Json::arrayValue), kindCollisions(Json::arrayValue);
    for (const NodeSpec& n : incoming.nodes)
      if (presentNodes.count(n.id.str())) nodeCollisions.append(n.id.str());
    for (const Kind& k : incoming.kinds)
      if (presentKinds.count(k.id.str())) kindCollisions.append(k.id.str());

    // Counts the edges the batch carried, so a graft whose prerequisites never landed reads as 0.
    int edges = 0;
    for (const NodeSpec& n : incoming.nodes) edges += static_cast<int>(n.prerequisites.size());

    // What the join does beyond the upsert, read before it lands: the edges a merge leaves standing
    // on a re-sent node (how a cycle gets in), the edges a replace drops, and what the tombstones take.
    const GraftFootprint footprint = room.footprintOf(graft);

    Json::Value out(Json::objectValue);
    out["nodes"] = static_cast<int>(incoming.nodes.size());
    out["edges"] = edges;
    out["kinds"] = static_cast<int>(incoming.kinds.size());
    out["nodeCollisions"] = nodeCollisions;
    out["kindCollisions"] = kindCollisions;
    out["newNodes"] = static_cast<int>(incoming.nodes.size()) - nodeCollisions.size();
    out["newKinds"] = static_cast<int>(incoming.kinds.size()) - kindCollisions.size();
    out["prerequisiteMode"] = replace ? "replace" : "merge";
    answerKeptEdges(footprint.keptEdges, out);
    if (replace) out["removedEdges"] = static_cast<Json::UInt64>(footprint.replacedEdges.size());
    Json::Value tombstoned(Json::objectValue);
    tombstoned["nodes"] = static_cast<Json::UInt64>(footprint.tombstonedNodes.size());
    tombstoned["edges"] = static_cast<Json::UInt64>(footprint.tombstonedEdges.size());
    out["tombstoned"] = tombstoned;
    if (dryRun) {
      out["dryRun"] = true;
      Json::Value tombstone(Json::arrayValue);
      for (const NodeId& id : footprint.tombstonedNodes) tombstone.append(id.str());
      out["tombstone"] = tombstone;
      // Carried progress naming no node the graft would leave behind.
      if (args["progress"].isArray()) {
        std::set<std::string> afterGraft = presentNodes;
        for (const NodeSpec& n : incoming.nodes) afterGraft.insert(n.id.str());
        for (const NodeId& id : footprint.tombstonedNodes) afterGraft.erase(id.str());
        Json::Value skipped(Json::arrayValue);
        for (const Json::Value& u : args["progress"]) {
          const Json::Value& handle =
              u[kNodeHandle.published].isNull() ? u[kNodeHandle.alias] : u[kNodeHandle.published];
          if (!afterGraft.count(handle.asString())) skipped.append(handle.asString());
        }
        if (!skipped.empty()) out["progressSkipped"] = skipped;
      }
      return ToolResult::json(out);
    }

    // A graft can dangle an edge per node it carries; the receipt says which of them are new.
    const TreeDiagnostics before = room.diagnose();
    Seq seq = room.importTree(graft, clock.nowMs(), actor);
    registry.persist(tree);
    // The caller's own marks on a tombstoned node: cleared to none, the way prune clears an orphan.
    Progress overlay = progress.progressOf(tree, actor);
    for (const NodeId& node : footprint.tombstonedNodes) {
      if (!overlay.completed.count(node) && !overlay.inProgress.count(node)) continue;
      progress.setStatus({}, tree, actor, node, ProgressStatus::none, room.nextStamp(clock.nowMs()), clock.nowMs());
    }
    out["imported"] = true;
    out["seq"] = static_cast<Json::Int64>(seq);
    answerDiagnostics(before, room.diagnose(), out);
    return ToolResult::json(out);
  });
  if (grafted.isError || dryRun || !(args.isMember("progress") && args["progress"].isArray()))
    return grafted;

  std::vector<std::pair<NodeId, ProgressStatus>> requested;
  for (const Json::Value& u : args["progress"]) {
    const Json::Value& handle =
        u[kNodeHandle.published].isNull() ? u[kNodeHandle.alias] : u[kNodeHandle.published];
    requested.emplace_back(NodeId{handle.asString()}, *parseProgressStatus(u["status"].asString()));
  }
  if (!requested.empty()) {
    // The graft has committed: a throw from the best-effort overlay must not reach callTool's catch.
    try {
      Json::Value results, skipped;
      applyProgressBatch(registry, progress, bus, tree, clock, actor, requested, false, results, skipped);
      grafted.payload["progress"] = results;
      if (!skipped.empty()) grafted.payload["progressSkipped"] = skipped;
    } catch (const std::exception&) { /* the graft stands; the carried progress simply didn't land */ }
    return ToolResult::json(grafted.payload);
  }
  return grafted;
}

ToolResult pruneTree(RoomRegistry& registry, ProgressService& progress, const TreeId& tree,
                     Clock& clock, const UserId& actor) {
  ToolResult cleaned = withRoom(registry, tree, [&](TreeRoom& room) -> ToolResult {
    if (!canRead(actor, room.owner(), room.visibility()))
      return ToolResult::failure("no such tree \"" + tree.str() + "\"");
    if (std::optional<WriteRefusal> refusal = writeRefusalFor(actor, room.owner()))
      return ToolResult::failure(writeRefusalSentence(*refusal));

    TreeDiagnostics before = room.diagnose();
    int prunedEdges = static_cast<int>(before.dangling.size() + before.selfEdges.size());

    // Orphaned overlay rows: the caller's progress on nodes no longer in the tree — cleared to none.
    Progress overlay = progress.progressOf(tree, actor);
    std::vector<NodeId> orphans;
    for (const NodeId& node : overlay.completed) if (!room.hasNode(node)) orphans.push_back(node);
    for (const NodeId& node : overlay.inProgress) if (!room.hasNode(node)) orphans.push_back(node);

    Seq seq = room.head();
    if (prunedEdges > 0) {
      seq = room.applyCommand(PruneDangling{}, clock.nowMs(), actor);
      registry.persist(tree);
    }
    for (const NodeId& node : orphans)
      progress.setStatus({}, tree, actor, node, ProgressStatus::none, room.nextStamp(clock.nowMs()), clock.nowMs());

    Json::Value out(Json::objectValue);
    out["prunedEdges"] = prunedEdges;
    out["prunedProgress"] = static_cast<int>(orphans.size());
    out["seq"] = static_cast<Json::Int64>(seq);
    answerDiagnostics(before, room.diagnose(), out);  // a GC only ever removes: always empty
    return ToolResult::json(out);
  });
  return cleaned;
}

std::string quotedList(const std::vector<std::string>& names) {
  std::string out;
  for (const std::string& name : names) {
    if (!out.empty()) out += ", ";
    out += "\"" + name + "\"";
  }
  return out;
}

// One `nodeId` (or its `id` alias) or a `nodeIds` list, never both, never neither.
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

// Every id is checked before any is applied, and the deletions — with the edges they dangle, when
// asked — land as one frame under one seq: the tree is never seen between them.
ToolResult deleteNodes(RoomRegistry& registry, ProgressService& progress, const TreeId& tree,
                       const Json::Value& args, Clock& clock, const UserId& actor) {
  std::vector<NodeId> targets;
  if (std::optional<std::string> bad = deleteTargets(args, targets)) return ToolResult::failure(*bad);
  if (!args["prune"].isNull() && !args["prune"].isBool())
    return ToolResult::failure("argument \"prune\" must be a boolean, got " + typeName(args["prune"]));
  const bool prune = args["prune"].asBool();
  const bool single = args["nodeIds"].isNull();

  return withRoom(registry, tree, [&](TreeRoom& room) -> ToolResult {
    if (!canRead(actor, room.owner(), room.visibility()))
      return ToolResult::failure("no such tree \"" + tree.str() + "\"");
    if (std::optional<WriteRefusal> refusal = writeRefusalFor(actor, room.owner()))
      return ToolResult::failure(writeRefusalSentence(*refusal));

    std::vector<std::string> missing;
    for (const NodeId& node : targets)
      if (!room.hasNode(node)) missing.push_back(node.str());
    if (!missing.empty())
      return ToolResult::failure("no node in this tree is named " + quotedList(missing) +
                                 " — nothing was deleted. " + kNodeHandle.hint);

    std::vector<Command> commands;
    for (const NodeId& node : targets) commands.push_back(DeleteNode{node});
    const std::vector<Edge> dangled = prune ? room.edgesTouching(targets) : std::vector<Edge>{};
    for (const Edge& edge : dangled) commands.push_back(RemoveEdge{edge.from, edge.to});
    for (const Command& command : commands)
      if (std::optional<std::string> reason = room.validate(command)) return ToolResult::failure(*reason);

    // The caller's own marks on what is going: cleared to none, as prune clears an orphan's.
    std::vector<NodeId> orphans;
    if (prune) {
      const Progress overlay = progress.progressOf(tree, actor);
      for (const NodeId& node : targets)
        if (overlay.completed.count(node) || overlay.inProgress.count(node)) orphans.push_back(node);
    }

    const TreeDiagnostics before = room.diagnose();
    Seq seq = room.applyCommands(commands, clock.nowMs(), actor);
    registry.persist(tree);
    for (const NodeId& node : orphans)
      progress.setStatus({}, tree, actor, node, ProgressStatus::none, room.nextStamp(clock.nowMs()), clock.nowMs());

    Json::Value ids(Json::arrayValue);
    for (const NodeId& node : targets) ids.append(node.str());
    Json::Value pruned(Json::objectValue);
    pruned["edges"] = static_cast<int>(dangled.size());
    pruned["progress"] = static_cast<int>(orphans.size());

    Json::Value out(Json::objectValue);
    out["applied"] = true;
    out["seq"] = static_cast<Json::Int64>(seq);
    answerDiagnostics(before, room.diagnose(), out);
    if (single) out["id"] = targets.front().str();
    out["ids"] = ids;
    out["pruned"] = pruned;
    return ToolResult::json(out);
  });
}

// One `from`+`to` pair or an `edges` list of them, never both, never neither.
std::optional<std::string> disconnectTargets(const Json::Value& args, std::vector<Edge>& out) {
  const bool single = !args["from"].isNull() || !args["to"].isNull();
  const bool batch = !args["edges"].isNull();
  if (!single && !batch)
    return "missing required arguments \"from\" and \"to\" (or an \"edges\" list of {from, to}, 1 to " +
           std::to_string(kMaxDisconnectEdges) + " edges). Call get_tree with fields "
           "[\"id\",\"prerequisites\"] to list the edges this tree has.";
  if (single && batch)
    return "pass a single \"from\"+\"to\" or an \"edges\" list, not both — one form names what this call "
           "removes.";
  if (single) {
    if (std::optional<std::string> bad = requireString(args["from"], "from", Empty::rejected, kMaxIdLength))
      return bad;
    if (std::optional<std::string> bad = requireString(args["to"], "to", Empty::rejected, kMaxIdLength))
      return bad;
    out = {Edge{NodeId{args["from"].asString()}, NodeId{args["to"].asString()}}};
    return std::nullopt;
  }
  if (std::optional<std::string> bad = optionalObjects(args["edges"], "edges", kMaxDisconnectEdges)) return bad;
  if (args["edges"].empty())
    return "argument \"edges\" is an empty list — pass at least one {from, to} to remove.";
  std::map<Edge, Json::ArrayIndex> seenAt;
  for (Json::ArrayIndex i = 0; i < args["edges"].size(); ++i) {
    const std::string row = "edges[" + std::to_string(i) + "]";
    const Json::Value& item = args["edges"][i];
    if (std::optional<std::string> bad = requireString(item["from"], row + ".from", Empty::rejected, kMaxIdLength))
      return bad;
    if (std::optional<std::string> bad = requireString(item["to"], row + ".to", Empty::rejected, kMaxIdLength))
      return bad;
    const Edge edge{NodeId{item["from"].asString()}, NodeId{item["to"].asString()}};
    const auto [seen, fresh] = seenAt.emplace(edge, i);
    if (!fresh)
      return row + " repeats edges[" + std::to_string(seen->second) + "] (\"" + edge.from.str() + "\" -> \"" +
             edge.to.str() + "\") — an edge is named once per batch";
    out.push_back(edge);
  }
  return std::nullopt;
}

// An edge the tree does not hold is a no-op, per edge; the whole list lands under one seq.
ToolResult disconnectEdges(RoomRegistry& registry, const TreeId& tree, const Json::Value& args, Clock& clock,
                           const UserId& actor) {
  std::vector<Edge> targets;
  if (std::optional<std::string> bad = disconnectTargets(args, targets)) return ToolResult::failure(*bad);

  return withRoom(registry, tree, [&](TreeRoom& room) -> ToolResult {
    if (!canRead(actor, room.owner(), room.visibility()))
      return ToolResult::failure("no such tree \"" + tree.str() + "\"");
    if (std::optional<WriteRefusal> refusal = writeRefusalFor(actor, room.owner()))
      return ToolResult::failure(writeRefusalSentence(*refusal));

    std::vector<Command> commands;
    int removed = 0;
    for (const Edge& edge : targets) {
      commands.push_back(RemoveEdge{edge.from, edge.to});
      if (room.hasEdge(edge.from, edge.to)) ++removed;
    }
    for (const Command& command : commands)
      if (std::optional<std::string> reason = room.validate(command)) return ToolResult::failure(*reason);

    const TreeDiagnostics before = room.diagnose();
    Seq seq = room.applyCommands(commands, clock.nowMs(), actor);
    registry.persist(tree);

    Json::Value out(Json::objectValue);
    out["applied"] = true;
    out["seq"] = static_cast<Json::Int64>(seq);
    answerDiagnostics(before, room.diagnose(), out);
    out["removed"] = removed;
    return ToolResult::json(out);
  });
}

ToolResult createTree(TreeRegistry& registry, const UserId& caller, const std::string& title) {
  TreeData initial;
  initial.title = title;
  Json::Value out(Json::objectValue);
  out["treeId"] = registry.create(caller, initial).str();
  return ToolResult::json(out);
}

ToolResult listRegistry(TreeRegistry& registry, const UserId& caller) {
  Json::Value trees(Json::arrayValue);
  for (const TreeSummary& summary : registry.list(caller)) trees.append(toJson(summary));
  Json::Value out(Json::objectValue);
  out["trees"] = trees;
  return ToolResult::json(out);
}

ToolResult removeTree(TreeRegistry& registry, const TreeId& tree, const UserId& caller) {
  TreeRegistry::Removal outcome = registry.remove(tree, caller);
  if (outcome == TreeRegistry::Removal::notFound)
    return ToolResult::failure("no such tree \"" + tree.str() + "\"");
  if (outcome == TreeRegistry::Removal::notYours)
    return ToolResult::failure(writeRefusalSentence(WriteRefusal::notYours));
  if (outcome == TreeRegistry::Removal::nobodysTree)
    return ToolResult::failure(writeRefusalSentence(WriteRefusal::nobodysTree));
  Json::Value out(Json::objectValue);
  out["deleted"] = true;
  out["id"] = tree.str();
  return ToolResult::json(out);
}

}  // namespace

RoadmapTools::RoadmapTools(RoomRegistry& registry, ProgressService& progress, Clock& clock,
                           TreeRegistry& treeRegistry, PresenceBus& bus)
    : registry_(registry), progress_(progress), clock_(clock), treeRegistry_(treeRegistry), bus_(bus) {}

std::vector<ToolDeclaration> RoadmapTools::declareTools() const { return roadmapToolCatalog(); }

// Every failure names the tool it came from, exactly once.
ToolResult RoadmapTools::callTool(const std::string& name, const Json::Value& arguments,
                                  const ToolCaller& caller) {
  try {
    ToolResult outcome = dispatch(name, arguments, caller.user);
    if (!outcome.isError) return outcome;
    return ToolResult::failure(name + ": " + outcome.content[0]["text"].asString());
  } catch (const std::bad_alloc&) {
    throw;  // not a tool failure: an exhausted process must die rather than answer
  } catch (const std::exception& error) {
    // Detail goes to the log, never the model's context; stderr, because on stdio transport stdout
    // is the protocol channel.
    std::cerr << "mcp tool " << name << " failed: " << error.what() << "\n";
    return ToolResult::failure(name + ": that call failed inside the server. Nothing was changed; "
                               "the detail is in the server log.");
  }
}

ToolResult RoadmapTools::dispatch(const std::string& name, const Json::Value& arguments, const UserId& caller) {
  // jsoncpp throws when a key is asked of something that is not an object.
  if (!arguments.isObject())
    return ToolResult::failure("arguments must be a JSON object of this tool's named arguments, got " +
                               typeName(arguments));

  if (name == "create_tree") {
    if (std::optional<std::string> bad = optionalString(arguments["title"], "title"))
      return ToolResult::failure(*bad);
    return createTree(treeRegistry_, caller, arguments.get("title", "").asString());
  }
  if (name == "list_trees") return listRegistry(treeRegistry_, caller);

  if (arguments["treeId"].isNull() ||
      (arguments["treeId"].isString() && arguments["treeId"].asString().empty()))
    return ToolResult::failure("missing required argument \"treeId\". Call list_trees to see the "
                               "roadmaps you own and their ids.");
  if (std::optional<std::string> bad =
          requireString(arguments["treeId"], "treeId", Empty::rejected, kMaxIdLength))
    return ToolResult::failure(*bad);
  TreeId tree{arguments["treeId"].asString()};

  // An empty caller id reads as anonymous for the read gate.
  std::optional<UserId> reader = caller.empty() ? std::nullopt : std::optional<UserId>(caller);

  if (name == "delete_tree")     return removeTree(treeRegistry_, tree, caller);
  if (name == "get_tree")        return readTree(registry_, progress_, tree, arguments, reader);
  if (name == "get_diagnostics") return readDiagnostics(registry_, tree, reader);
  if (name == "get_health")      return readHealth(registry_, tree, reader);
  if (name == "get_progress")    return readProgress(progress_, tree, arguments, caller);
  if (name == "find_nodes")      return findNodes(registry_, progress_, tree, arguments, reader);
  if (name == "set_progress")
    return writeProgress(registry_, progress_, bus_, tree, arguments, clock_, caller);
  if (name == "import_subgraph")
    return importSubgraph(registry_, progress_, bus_, tree, arguments, clock_, caller);
  if (name == "prune")
    return pruneTree(registry_, progress_, tree, clock_, caller);
  if (name == "delete_node")
    return deleteNodes(registry_, progress_, tree, arguments, clock_, caller);
  if (name == "disconnect")
    return disconnectEdges(registry_, tree, arguments, clock_, caller);

  if (commandKindFor(name)) return applyEdit(registry_, tree, name, arguments, clock_, caller);

  // The whole-server "no such tool" answer belongs to CompositeToolHost.
  return ToolResult::failure("no such roadmap tool — call tools/list for the surface this connection "
                             "may use.");
}

}
