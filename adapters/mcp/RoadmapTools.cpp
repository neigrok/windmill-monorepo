#include "adapters/mcp/RoadmapTools.h"

#include "adapters/json/CommandJson.h"
#include "adapters/json/TreeJson.h"
#include "application/TreeRoom.h"
#include "domain/Access.h"
#include "domain/NodeQuery.h"
#include "domain/SkillTree.h"
#include "domain/TreeHealth.h"

#include <cctype>
#include <mutex>
#include <optional>
#include <set>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

namespace wm {

namespace {

// --- Tool schema builders (JSON Schema for each tool's `inputSchema`). ---------------

Json::Value str(const char* description) {
  Json::Value property(Json::objectValue);
  property["type"] = "string";
  property["description"] = description;
  return property;
}

Json::Value num(const char* description) {
  Json::Value property(Json::objectValue);
  property["type"] = "number";
  property["description"] = description;
  return property;
}

Json::Value boolean(const char* description) {
  Json::Value property(Json::objectValue);
  property["type"] = "boolean";
  property["description"] = description;
  return property;
}

Json::Value enumStr(const char* description, std::vector<const char*> values) {
  Json::Value property = str(description);
  Json::Value allowed(Json::arrayValue);
  for (const char* value : values) allowed.append(value);
  property["enum"] = allowed;
  return property;
}

Json::Value strArray(const char* description) {
  Json::Value property(Json::objectValue);
  property["type"] = "array";
  property["items"] = str("");
  property["description"] = description;
  return property;
}

Json::Value linkArray(const char* description) {
  Json::Value link(Json::objectValue);
  link["type"] = "object";
  Json::Value fields(Json::objectValue);
  fields["url"] = str("The link target (href).");
  fields["label"] = str("Optional display text (defaults to the url).");
  link["properties"] = fields;
  Json::Value required(Json::arrayValue);
  required.append("url");
  link["required"] = required;

  Json::Value property(Json::objectValue);
  property["type"] = "array";
  property["items"] = link;
  property["description"] = description;
  return property;
}

const std::vector<const char*> kHues = {"terracotta", "olive", "gold", "brick", "sky", "plum"};

Json::Value tool(const char* name, const char* description, Json::Value properties,
                 std::vector<const char*> required) {
  Json::Value schema(Json::objectValue);
  schema["type"] = "object";
  schema["properties"] = std::move(properties);
  Json::Value req(Json::arrayValue);
  for (const char* field : required) req.append(field);
  schema["required"] = req;
  schema["additionalProperties"] = false;

  Json::Value descriptor(Json::objectValue);
  descriptor["name"] = name;
  descriptor["description"] = description;
  descriptor["inputSchema"] = schema;
  return descriptor;
}

// A URL-ish slug for an auto-minted node id: lowercase alphanumerics, other runs to '-'.
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
  if (tool == "disconnect")     return "RemoveEdge";
  if (tool == "reconnect")      return "ReconnectEdge";
  if (tool == "delete_node")    return "DeleteNode";
  if (tool == "tidy")           return "TransitiveReduction";
  if (tool == "add_kind")       return "AddKind";
  if (tool == "rename_kind")    return "RenameKind";
  if (tool == "describe_kind")  return "DescribeKind";
  if (tool == "remove_kind")    return "RemoveKind";
  if (tool == "reorder_kinds")  return "ReorderKinds";
  if (tool == "recolor_kind")   return "RecolorKind";
  return std::nullopt;
}

// Every room-touching tool holds the tree's strand, opens the room, and turns a
// "no such tree" (or any open failure) into a tool-level error instead of a throw.
template <typename Fn>
ToolResult withRoom(RoomRegistry& registry, const TreeId& tree, Fn&& fn) {
  std::lock_guard<std::mutex> lock(registry.strandFor(tree));
  try {
    return fn(registry.open(tree));
  } catch (const std::exception& error) {
    return ToolResult::failure(error.what());
  }
}

ToolResult readTree(RoomRegistry& registry, const TreeId& tree, const std::optional<UserId>& caller) {
  return withRoom(registry, tree, [&](TreeRoom& room) -> ToolResult {
    // Byte-identical to the absent message (RoomRegistry::open throws the same) — a private
    // tree must be indistinguishable from one that does not exist, or the id is an oracle.
    if (!canRead(caller, room.owner(), room.visibility())) return ToolResult::failure("no such tree \"" + tree.str() + "\"");
    Json::Value out(Json::objectValue);
    out["seq"] = static_cast<Json::Int64>(room.head());
    out["tree"] = toJson(room.snapshot());
    return ToolResult::json(out);
  });
}

ToolResult readDiagnostics(RoomRegistry& registry, const TreeId& tree, const std::optional<UserId>& caller) {
  return withRoom(registry, tree, [&](TreeRoom& room) -> ToolResult {
    // Byte-identical to the absent message (RoomRegistry::open throws the same) — a private
    // tree must be indistinguishable from one that does not exist, or the id is an oracle.
    if (!canRead(caller, room.owner(), room.visibility())) return ToolResult::failure("no such tree \"" + tree.str() + "\"");
    return ToolResult::json(toJson(room.diagnose()));
  });
}

ToolResult readHealth(RoomRegistry& registry, const TreeId& tree, const std::optional<UserId>& caller) {
  return withRoom(registry, tree, [&](TreeRoom& room) -> ToolResult {
    // Byte-identical to the absent message (RoomRegistry::open throws the same) — a private
    // tree must be indistinguishable from one that does not exist, or the id is an oracle.
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

ToolResult readProgress(ProgressService& progress, const TreeId& tree, const UserId& user) {
  return ToolResult::json(toJson(progress.progressOf(tree, user)));
}

ToolResult findNodes(RoomRegistry& registry, const TreeId& tree, const Json::Value& args,
                     const std::optional<UserId>& caller) {
  return withRoom(registry, tree, [&](TreeRoom& room) -> ToolResult {
    // Byte-identical to the absent message (RoomRegistry::open throws the same) — a private
    // tree must be indistinguishable from one that does not exist, or the id is an oracle.
    if (!canRead(caller, room.owner(), room.visibility())) return ToolResult::failure("no such tree \"" + tree.str() + "\"");
    NodeFilter filter;
    if (args.isMember("color") && args["color"].isString()) {
      filter.color = parseColor(args["color"].asString());
      if (!filter.color) return ToolResult::failure("unknown color: " + args["color"].asString());
    }
    if (args.isMember("kind") && args["kind"].isString() && !args["kind"].asString().empty())
      filter.kind = KindId{args["kind"].asString()};
    filter.query = args.get("query", "").asString();

    Json::Value nodes(Json::arrayValue);
    for (const NodeSpec& node : selectNodes(room.snapshot(), filter)) nodes.append(nodeToJson(node));
    Json::Value out(Json::objectValue);
    out["count"] = nodes.size();
    out["nodes"] = nodes;
    return ToolResult::json(out);
  });
}

ToolResult applyEdit(RoomRegistry& registry, const TreeId& tree, const std::string& kind,
                     Json::Value payload, Clock& clock, const UserId& actor, bool mintId) {
  return withRoom(registry, tree, [&](TreeRoom& room) -> ToolResult {
    if (room.owner() && *room.owner() != actor)
      return ToolResult::failure("this tree belongs to another account");
    if (mintId && payload.get("id", "").asString().empty()) {
      std::set<std::string> present;
      for (const NodeSpec& node : room.snapshot().nodes) present.insert(node.id.str());
      std::string base = slugify(payload.get("label", "").asString());
      std::string id = base;
      for (int n = 2; present.count(id); ++n) id = base + "-" + std::to_string(n);
      payload["id"] = id;
    }

    std::optional<Command> command = commandFromJson(kind, payload);
    if (!command) return ToolResult::failure("invalid arguments for " + kind);
    if (std::optional<std::string> reason = room.validate(*command)) return ToolResult::failure(*reason);

    Seq seq = room.applyCommand(*command, clock.nowMs(), actor);
    if (!room.owner()) registry.claim(tree, actor);  // first authenticated writer claims the tree
    registry.persist(tree);  // flush the dirty rows so the web reader sees this edit

    Json::Value out(Json::objectValue);
    out["applied"] = true;
    out["seq"] = static_cast<Json::Int64>(seq);
    out["diagnosticsClean"] = room.diagnose().clean();
    if (payload.isMember("id")) out["id"] = payload["id"];
    return ToolResult::json(out);
  });
}

// The shared write path for both set_progress and an import's carried progress. Under the
// strand it rejects (or, for a best-effort import, drops) unknown node ids, reads each node's
// prerequisites, and mints one clock stamp per mark; then applies the batch order-safe (§9)
// and echoes each mark to the caller's live sessions. Fills `results` with a row per applied
// mark; returns a failure message only when an unknown id is rejected.
std::optional<std::string> applyProgressBatch(
    RoomRegistry& registry, ProgressService& progress, PresenceBus& bus, const TreeId& tree,
    Clock& clock, const UserId& user, const std::vector<std::pair<NodeId, ProgressStatus>>& requested,
    bool rejectUnknown, Json::Value& results) {
  std::vector<ProgressMark> marks;
  {
    std::lock_guard<std::mutex> lock(registry.strandFor(tree));
    TreeRoom& room = registry.open(tree);
    // Progress is a per-user overlay, not an edit — so it isn't owner-gated — but marking a
    // node against someone else's PRIVATE tree would confirm which node ids exist (and their
    // prerequisite shape). Deny it exactly as an absent tree does: private ⇒ owner-only.
    if (!canRead(user, room.owner(), room.visibility()))
      throw std::runtime_error("no such tree \"" + tree.str() + "\"");
    std::string unknown;
    for (const auto& [node, status] : requested) {
      if (!room.hasNode(node)) { if (!unknown.empty()) unknown += ", "; unknown += node.str(); continue; }
      marks.push_back({node, status, room.prerequisitesOf(node), room.nextStamp(clock.nowMs())});
    }
    if (rejectUnknown && !unknown.empty()) return "no such node(s): " + unknown;
  }

  std::vector<ProgressOutcome> outcomes = progress.setStatuses(tree, user, marks);
  results = Json::Value(Json::arrayValue);
  for (std::size_t i = 0; i < marks.size(); ++i) {
    bus.broadcastProgress(tree, user, marks[i].node, marks[i].status);  // live in the caller's web sessions
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
  bool bulk = args.isMember("updates") && args["updates"].isArray();
  std::vector<std::pair<NodeId, ProgressStatus>> requested;
  if (bulk) {
    for (const Json::Value& u : args["updates"]) {
      NodeId node{u.get("nodeId", "").asString()};
      std::optional<ProgressStatus> status = parseProgressStatus(u.get("status", "").asString());
      if (node.empty() || !status)
        return ToolResult::failure("each update needs nodeId and status in {active, complete, none}");
      requested.emplace_back(node, *status);
    }
  } else {
    NodeId node{args.get("nodeId", "").asString()};
    std::optional<ProgressStatus> status = parseProgressStatus(args.get("status", "").asString());
    if (node.empty() || !status)
      return ToolResult::failure("set_progress needs nodeId and status in {active, complete, none}, or an updates[] batch");
    requested.emplace_back(node, *status);
  }
  if (requested.empty()) return ToolResult::failure("set_progress had nothing to do");

  Json::Value results;
  try {
    if (std::optional<std::string> error =
            applyProgressBatch(registry, progress, bus, tree, clock, user, requested, true, results))
      return ToolResult::failure(*error);
  } catch (const std::exception& error) {
    return ToolResult::failure(error.what());
  }
  if (bulk) {
    Json::Value out(Json::objectValue);
    out["results"] = results;
    return ToolResult::json(out);
  }
  return ToolResult::json(results[0]);  // a singular call keeps its flat {nodeId, status, prerequisitesMet}
}

ToolResult importSubgraph(RoomRegistry& registry, ProgressService& progress, PresenceBus& bus,
                          const TreeId& tree, const Json::Value& args, Clock& clock, const UserId& actor) {
  TreeData incoming = treeFromJson(args, tree);  // the get_tree shape: title?, nodes[], kinds[]
  bool dryRun = (args["dryRun"].isBool() && args["dryRun"].asBool()) ||
                (args["dryRun"].isString() && args["dryRun"].asString() == "true");

  ToolResult grafted = withRoom(registry, tree, [&](TreeRoom& room) -> ToolResult {
    // A read gate before the write gate: an UNOWNED private tree is claimable by first-write,
    // but its dry-run collision list would leak its node/kind ids to a non-reader first.
    if (!canRead(actor, room.owner(), room.visibility()))
      return ToolResult::failure("no such tree \"" + tree.str() + "\"");
    if (room.owner() && *room.owner() != actor)
      return ToolResult::failure("this tree belongs to another account");

    TreeData current = room.snapshot();  // collision = an incoming id already present (an upsert overwrites it)
    std::set<std::string> presentNodes, presentKinds;
    for (const NodeSpec& n : current.nodes) presentNodes.insert(n.id.str());
    for (const Kind& k : current.kinds) presentKinds.insert(k.id.str());

    Json::Value nodeCollisions(Json::arrayValue), kindCollisions(Json::arrayValue);
    for (const NodeSpec& n : incoming.nodes)
      if (presentNodes.count(n.id.str())) nodeCollisions.append(n.id.str());
    for (const Kind& k : incoming.kinds)
      if (presentKinds.count(k.id.str())) kindCollisions.append(k.id.str());

    Json::Value out(Json::objectValue);
    out["nodes"] = static_cast<int>(incoming.nodes.size());
    out["kinds"] = static_cast<int>(incoming.kinds.size());
    out["nodeCollisions"] = nodeCollisions;
    out["kindCollisions"] = kindCollisions;
    out["newNodes"] = static_cast<int>(incoming.nodes.size()) - nodeCollisions.size();
    out["newKinds"] = static_cast<int>(incoming.kinds.size()) - kindCollisions.size();
    if (dryRun) {  // report what would collide, change nothing (§7 dry-run)
      out["dryRun"] = true;
      return ToolResult::json(out);
    }

    Seq seq = room.importTree(incoming, clock.nowMs(), actor);
    if (!room.owner()) registry.claim(tree, actor);  // first authenticated writer claims the tree
    registry.persist(tree);
    out["imported"] = true;
    out["seq"] = static_cast<Json::Int64>(seq);
    out["diagnosticsClean"] = room.diagnose().clean();
    return ToolResult::json(out);
  });
  if (grafted.isError || dryRun || !(args.isMember("progress") && args["progress"].isArray()))
    return grafted;

  std::vector<std::pair<NodeId, ProgressStatus>> requested;  // carried progress, applied over the imported nodes
  for (const Json::Value& u : args["progress"]) {
    NodeId node{u.get("nodeId", "").asString()};
    std::optional<ProgressStatus> status = parseProgressStatus(u.get("status", "").asString());
    if (!node.empty() && status) requested.emplace_back(node, *status);
  }
  if (!requested.empty()) {
    Json::Value results;
    applyProgressBatch(registry, progress, bus, tree, clock, actor, requested, false, results);  // skip unknowns
    grafted.structured["progress"] = results;
    return ToolResult::json(grafted.structured);
  }
  return grafted;
}

ToolResult pruneTree(RoomRegistry& registry, ProgressService& progress, const TreeId& tree,
                     Clock& clock, const UserId& actor) {
  ToolResult cleaned = withRoom(registry, tree, [&](TreeRoom& room) -> ToolResult {
    if (room.owner() && *room.owner() != actor)
      return ToolResult::failure("this tree belongs to another account");

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
      progress.setStatus({}, tree, actor, node, ProgressStatus::none, room.nextStamp(clock.nowMs()));

    Json::Value out(Json::objectValue);
    out["prunedEdges"] = prunedEdges;
    out["prunedProgress"] = static_cast<int>(orphans.size());
    out["seq"] = static_cast<Json::Int64>(seq);
    out["diagnosticsClean"] = room.diagnose().clean();
    return ToolResult::json(out);
  });
  return cleaned;
}

ToolResult createTree(TreeRegistry& registry, const UserId& caller, const std::string& title) {
  TreeData initial;
  initial.title = title;  // an agent plants a blank tree, then authors it with the edit tools
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
  if (outcome == TreeRegistry::Removal::notFound) return ToolResult::failure("no such tree");
  if (outcome == TreeRegistry::Removal::notOwner)
    return ToolResult::failure("this tree belongs to another account");
  Json::Value out(Json::objectValue);
  out["deleted"] = true;
  out["id"] = tree.str();
  return ToolResult::json(out);
}

}  // namespace

RoadmapTools::RoadmapTools(RoomRegistry& registry, ProgressService& progress, Clock& clock,
                           TreeRegistry& treeRegistry, PresenceBus& bus)
    : registry_(registry), progress_(progress), clock_(clock), treeRegistry_(treeRegistry), bus_(bus) {}

Json::Value RoadmapTools::listTools() const {
  const char* treeId = "The roadmap (tree) id.";
  Json::Value tools(Json::arrayValue);

  {
    Json::Value p(Json::objectValue);
    p["title"] = str("Optional name for the new roadmap.");
    tools.append(tool("create_tree",
        "Create a new empty roadmap that you own, seeded with the default legend "
        "(Build/Learn/Milestone). Optionally name it with `title`. Returns the new treeId — pass it "
        "to the other tools to start authoring.",
        p, {}));
  }
  {
    tools.append(tool("list_trees",
        "List the roadmaps you own — one row each: id, title, total node count, how many you have "
        "completed, when it last moved (updatedAt, epoch ms), and its dominant hue (dominantKind), "
        "newest activity first. Takes no arguments. Use it to discover the treeId the other tools need.",
        Json::Value(Json::objectValue), {}));
  }
  {
    Json::Value p(Json::objectValue);
    p["treeId"] = str(treeId);
    tools.append(tool("delete_tree",
        "Delete a roadmap you own — a soft-delete: it stops appearing in list_trees and can no longer "
        "be read. Only the owner may delete; someone else's tree is refused.",
        p, {"treeId"}));
  }
  {
    Json::Value p(Json::objectValue);
    p["treeId"] = str(treeId);
    tools.append(tool("get_tree",
        "Read a roadmap's current document — title, every node (id, label, icon, color, position) "
        "and its prerequisite edges, and the ordered legend `kinds` (each a hue with a label and "
        "description) — with the tree's op sequence number. Call this before editing to learn the "
        "node ids the other tools take, and the legend a node's color refers to.",
        p, {"treeId"}));
  }
  {
    Json::Value p(Json::objectValue);
    p["treeId"] = str(treeId);
    tools.append(tool("get_diagnostics",
        "Report how the roadmap departs from a valid skill tree: cycles, dangling edges (an "
        "endpoint is missing), self-edges, and structural smells. Edits are never rejected, so an "
        "edit that forms a cycle still succeeds — this is how you find and fix it.",
        p, {"treeId"}));
  }
  {
    Json::Value p(Json::objectValue);
    p["treeId"] = str(treeId);
    tools.append(tool("get_health",
        "Tidiness metrics for a structurally-valid roadmap: node/edge counts, cross-branch "
        "coupling, redundant (transitively implied) edges, average in-degree, and a 0–100 score. "
        "Fails if the tree currently has cycles/dangling edges — fix those first.",
        p, {"treeId"}));
  }
  {
    Json::Value p(Json::objectValue);
    p["treeId"] = str(treeId);
    tools.append(tool("get_progress",
        "The caller's private progress overlay for a roadmap: the node ids that are completed and "
        "those in progress. Per-user, separate from the shared structure.",
        p, {"treeId"}));
  }
  {
    Json::Value p(Json::objectValue);
    p["treeId"] = str(treeId);
    p["color"] = enumStr("Optional hue to match — a node's color is its kind.",
                         {"terracotta", "olive", "gold", "brick", "sky", "plum"});
    p["kind"] = str("Optional legend kind id — matches nodes wearing that kind's hue.");
    p["query"] = str("Optional case-insensitive substring matched against each node's label and description.");
    tools.append(tool("find_nodes",
        "Search a roadmap's nodes. Every filter you set must match (AND): `color` or `kind` pin a hue, "
        "`query` is a case-insensitive substring over label + description. Omit all filters to list every "
        "node. Returns the matching nodes (same shape as get_tree) and a count.",
        p, {"treeId"}));
  }
  {
    Json::Value p(Json::objectValue);
    p["treeId"] = str(treeId);
    p["label"] = str("The node's display label.");
    p["icon"] = str("Optional icon name/emoji.");
    p["color"] = enumStr("Optional branch color (default terracotta).",
                         {"terracotta", "olive", "gold", "brick", "sky", "plum"});
    p["prerequisites"] = strArray("Optional ids of existing nodes that unlock this one — one edge per id.");
    p["parentId"] = str("Optional single prerequisite (a convenience alias folded into prerequisites).");
    p["x"] = num("Optional canvas x.");
    p["y"] = num("Optional canvas y.");
    p["description"] = str("Optional annotation body — notes about the node.");
    p["links"] = linkArray("Optional external references (docs, PRs, designs).");
    p["id"] = str("Optional explicit id; minted from the label if omitted.");
    tools.append(tool("create_node",
        "Add a node to the roadmap. Only `label` is required; icon, color, position (x,y), a set of "
        "`prerequisites` (nodes that unlock this one), a `description`, and `links` are optional. "
        "Returns the node id.",
        p, {"treeId", "label"}));
  }
  {
    Json::Value p(Json::objectValue);
    p["treeId"] = str(treeId);
    p["id"] = str("The node id.");
    p["description"] = str("The annotation body (omit to leave it unchanged).");
    p["links"] = linkArray("The node's external references — replaces the existing set (omit to leave unchanged).");
    tools.append(tool("annotate_node",
        "Set a node's free annotation: its `description` and/or `links`. Each field is optional — an "
        "omitted field is left untouched; `links` replaces the whole set when given.",
        p, {"treeId", "id"}));
  }
  {
    Json::Value p(Json::objectValue);
    p["treeId"] = str(treeId);
    p["id"] = str("The node id.");
    p["label"] = str("The new label.");
    tools.append(tool("rename_node", "Change a node's label.", p, {"treeId", "id", "label"}));
  }
  {
    Json::Value p(Json::objectValue);
    p["treeId"] = str(treeId);
    p["id"] = str("The node id.");
    p["color"] = enumStr("The new color.", {"terracotta", "olive", "gold", "brick", "sky", "plum"});
    tools.append(tool("set_node_color", "Set a node's color (its branch/category tint).", p,
                      {"treeId", "id", "color"}));
  }
  {
    Json::Value p(Json::objectValue);
    p["treeId"] = str(treeId);
    p["id"] = str("The node id.");
    p["x"] = num("Canvas x.");
    p["y"] = num("Canvas y.");
    tools.append(tool("move_node", "Set a node's canvas position (x, y).", p, {"treeId", "id", "x", "y"}));
  }
  {
    Json::Value p(Json::objectValue);
    p["treeId"] = str(treeId);
    p["from"] = str("The prerequisite node id.");
    p["to"] = str("The node it unlocks.");
    tools.append(tool("connect",
        "Add a prerequisite edge from `from` to `to` — `from` must be completed before `to`. "
        "Idempotent; may form a cycle (surfaced by get_diagnostics, never rejected).",
        p, {"treeId", "from", "to"}));
  }
  {
    Json::Value p(Json::objectValue);
    p["treeId"] = str(treeId);
    p["from"] = str("The prerequisite node id.");
    p["to"] = str("The node it unlocks.");
    tools.append(tool("disconnect", "Remove the prerequisite edge from `from` to `to`.", p,
                      {"treeId", "from", "to"}));
  }
  {
    Json::Value p(Json::objectValue);
    p["treeId"] = str(treeId);
    p["oldFrom"] = str("Current edge source.");
    p["oldTo"] = str("Current edge target.");
    p["newFrom"] = str("New edge source.");
    p["newTo"] = str("New edge target.");
    tools.append(tool("reconnect",
        "Atomically move an edge: remove (oldFrom→oldTo) and add (newFrom→newTo) as one op / one "
        "undo step.",
        p, {"treeId", "oldFrom", "oldTo", "newFrom", "newTo"}));
  }
  {
    Json::Value p(Json::objectValue);
    p["treeId"] = str(treeId);
    p["id"] = str("The node id.");
    tools.append(tool("delete_node",
        "Delete a node (tombstone). Its edges go inert and its children detach into roots; nothing "
        "is re-tethered. Reversible via undo.",
        p, {"treeId", "id"}));
  }
  {
    Json::Value p(Json::objectValue);
    p["treeId"] = str(treeId);
    tools.append(tool("tidy",
        "Transitive reduction: drop edges already implied by a longer path, as one op. A "
        "semantics-preserving cleanup that every collaborator converges on.",
        p, {"treeId"}));
  }
  {
    Json::Value p(Json::objectValue);
    p["treeId"] = str(treeId);
    p["id"] = str("The kind id (stable, unique within the tree's legend).");
    p["hue"] = enumStr("The kind's hue — unique per kind; at most 6 kinds per tree.", kHues);
    p["label"] = str("Optional label (≤24 chars) — set inline so the kind lands in one op.");
    p["description"] = str("Optional description (≤80 chars) — the generator's sorting brief.");
    tools.append(tool("add_kind",
        "Add a legend kind: a named, described hue. The hue must be free (unique per kind) and the "
        "legend must have fewer than 6 kinds. `label` and `description` may be set inline, or later "
        "with rename_kind / describe_kind.",
        p, {"treeId", "id", "hue"}));
  }
  {
    Json::Value p(Json::objectValue);
    p["treeId"] = str(treeId);
    p["id"] = str("The kind id.");
    p["label"] = str("The kind's label (≤24 chars, sentence-case, one or two words; \"\" = unlabeled).");
    tools.append(tool("rename_kind", "Set a legend kind's label.", p, {"treeId", "id", "label"}));
  }
  {
    Json::Value p(Json::objectValue);
    p["treeId"] = str(treeId);
    p["id"] = str("The kind id.");
    p["description"] = str("The kind's description (≤80 chars, plain text; the generator's sorting brief).");
    tools.append(tool("describe_kind", "Set a legend kind's description.", p, {"treeId", "id", "description"}));
  }
  {
    Json::Value p(Json::objectValue);
    p["treeId"] = str(treeId);
    p["id"] = str("The kind id.");
    tools.append(tool("remove_kind",
        "Remove a legend kind. Rejected while any node still wears its hue — recolor or repaint those "
        "nodes first.",
        p, {"treeId", "id"}));
  }
  {
    Json::Value p(Json::objectValue);
    p["treeId"] = str(treeId);
    p["order"] = strArray("The kind ids in the desired order (legend order = generation priority).");
    tools.append(tool("reorder_kinds", "Reorder the legend. The first kind is the generation fallback.",
                      p, {"treeId", "order"}));
  }
  {
    Json::Value p(Json::objectValue);
    p["treeId"] = str(treeId);
    p["id"] = str("The kind id.");
    p["hue"] = enumStr("The new hue — must be free (not owned by another kind).", kHues);
    tools.append(tool("recolor_kind",
        "Atomically change a kind's hue and repaint every node wearing the old hue to the new one, as "
        "one op / one undo step.",
        p, {"treeId", "id", "hue"}));
  }
  {
    Json::Value update(Json::objectValue);
    update["type"] = "object";
    Json::Value updateFields(Json::objectValue);
    updateFields["nodeId"] = str("The node id.");
    updateFields["status"] = enumStr("active, complete, or none (clear).", {"active", "complete", "none"});
    update["properties"] = updateFields;
    Json::Value updateRequired(Json::arrayValue);
    updateRequired.append("nodeId");
    updateRequired.append("status");
    update["required"] = updateRequired;

    Json::Value p(Json::objectValue);
    p["treeId"] = str(treeId);
    p["nodeId"] = str("The node id (singular form).");
    p["status"] = enumStr("active, complete, or none (clear).", {"active", "complete", "none"});
    Json::Value updates(Json::objectValue);
    updates["type"] = "array";
    updates["items"] = update;
    updates["description"] = "Bulk form: a list of {nodeId, status}. Resolves order internally, so completing "
                             "a subtree out of dependency order no longer misreports prerequisitesMet.";
    p["updates"] = updates;
    tools.append(tool("set_progress",
        "Set the caller's progress. Pass a single `nodeId`+`status`, or a bulk `updates` list. Unknown "
        "node ids are rejected (no orphan rows). Advisory only — marking complete with unmet "
        "prerequisites still records and reports prerequisitesMet:false, judged against the committed "
        "batch (not each write's instant).",
        p, {"treeId"}));
  }
  {
    Json::Value p(Json::objectValue);
    p["treeId"] = str(treeId);
    p["nodes"] = strArray("The nodes to import — each {id, label, icon?, color?, prerequisites?, "
                          "description?, links?}, the same shape get_tree returns.");
    p["kinds"] = strArray("Optional legend kinds — each {id, hue, label?, description?}. Omit to leave "
                          "the legend untouched.");
    p["progress"] = strArray("Optional carried progress — a list of {nodeId, status} applied over the "
                             "imported nodes (unknown ids skipped).");
    p["dryRun"] = boolean("If true, report collisions and change nothing.");
    tools.append(tool("import_subgraph",
        "Bulk-apply a whole roadmap slice in one op — the shape get_tree returns ({title?, nodes[], "
        "kinds[]}, plus optional progress[]). Upsert by id: an incoming id already present is "
        "overwritten (reported in nodeCollisions/kindCollisions), a new id is added; nothing is removed. "
        "Pass dryRun to preview the collisions first. This collapses hundreds of create/connect calls "
        "into one.",
        p, {"treeId", "nodes"}));
  }
  {
    Json::Value p(Json::objectValue);
    p["treeId"] = str(treeId);
    tools.append(tool("prune",
        "Garbage-collect the roadmap: drop dangling and self edges (edges no valid DAG keeps) in one "
        "op, and clear the caller's progress rows for nodes no longer in the tree. Returns how many of "
        "each it removed.",
        p, {"treeId"}));
  }

  return tools;
}

ToolResult RoadmapTools::callTool(const std::string& name, const Json::Value& arguments, const UserId& caller) {
  if (name == "create_tree")
    return createTree(treeRegistry_, caller, arguments.get("title", "").asString());  // no treeId
  if (name == "list_trees") return listRegistry(treeRegistry_, caller);  // registry-wide: no treeId

  TreeId tree{arguments.get("treeId", "").asString()};
  if (tree.empty()) return ToolResult::failure("missing required argument: treeId");

  // The MCP caller is an authenticated account (an OAuth token's user over HTTP, the
  // configured user over stdio); an empty id reads as anonymous for the read gate.
  std::optional<UserId> reader = caller.empty() ? std::nullopt : std::optional<UserId>(caller);

  if (name == "delete_tree")     return removeTree(treeRegistry_, tree, caller);
  if (name == "get_tree")        return readTree(registry_, tree, reader);
  if (name == "get_diagnostics") return readDiagnostics(registry_, tree, reader);
  if (name == "get_health")      return readHealth(registry_, tree, reader);
  if (name == "get_progress")    return readProgress(progress_, tree, caller);
  if (name == "find_nodes")      return findNodes(registry_, tree, arguments, reader);
  if (name == "set_progress")
    return writeProgress(registry_, progress_, bus_, tree, arguments, clock_, caller);
  if (name == "import_subgraph")
    return importSubgraph(registry_, progress_, bus_, tree, arguments, clock_, caller);
  if (name == "prune")
    return pruneTree(registry_, progress_, tree, clock_, caller);

  if (std::optional<std::string> kind = commandKindFor(name))
    return applyEdit(registry_, tree, *kind, arguments, clock_, caller, name == "create_node");

  return ToolResult::failure("unknown tool: " + name);
}

}
