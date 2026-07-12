#include "adapters/mcp/RoadmapTools.h"

#include "adapters/json/CommandJson.h"
#include "adapters/json/TreeJson.h"
#include "application/TreeRoom.h"
#include "domain/SkillTree.h"
#include "domain/TreeHealth.h"

#include <cctype>
#include <mutex>
#include <optional>
#include <set>
#include <string>
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

ToolResult readTree(RoomRegistry& registry, const TreeId& tree) {
  return withRoom(registry, tree, [&](TreeRoom& room) {
    Json::Value out(Json::objectValue);
    out["seq"] = static_cast<Json::Int64>(room.head());
    out["tree"] = toJson(room.snapshot());
    return ToolResult::json(out);
  });
}

ToolResult readDiagnostics(RoomRegistry& registry, const TreeId& tree) {
  return withRoom(registry, tree,
                  [&](TreeRoom& room) { return ToolResult::json(toJson(room.diagnose())); });
}

ToolResult readHealth(RoomRegistry& registry, const TreeId& tree) {
  return withRoom(registry, tree, [&](TreeRoom& room) -> ToolResult {
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

ToolResult applyEdit(RoomRegistry& registry, const TreeId& tree, const std::string& kind,
                     Json::Value payload, const Hlc& hlc, const UserId& actor, bool mintId) {
  return withRoom(registry, tree, [&](TreeRoom& room) -> ToolResult {
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

    std::string opId = "mcp-" + std::to_string(hlc.physicalMs) + "-" + std::to_string(hlc.counter);
    std::optional<Applied> applied = room.submit(Incoming{opId, std::move(*command), hlc, actor});
    registry.persist(tree);  // flush trees.document so the web reader sees this edit

    Json::Value out(Json::objectValue);
    out["applied"] = applied.has_value();
    if (applied) {
      out["seq"] = static_cast<Json::Int64>(applied->op.seq);
      out["opId"] = opId;
    }
    out["diagnosticsClean"] = room.diagnose().clean();
    if (payload.isMember("id")) out["id"] = payload["id"];
    return ToolResult::json(out);
  });
}

ToolResult writeProgress(RoomRegistry& registry, ProgressService& progress, const TreeId& tree,
                         const Json::Value& args, const Hlc& hlc, const UserId& user) {
  NodeId node{args.get("nodeId", "").asString()};
  std::optional<ProgressStatus> status = parseProgressStatus(args.get("status", "").asString());
  if (node.empty() || !status)
    return ToolResult::failure("set_progress needs nodeId and status in {active, complete, none}");

  std::vector<NodeId> prerequisites;
  {
    std::lock_guard<std::mutex> lock(registry.strandFor(tree));
    try {
      prerequisites = registry.open(tree).prerequisitesOf(node);
    } catch (const std::exception& error) {
      return ToolResult::failure(error.what());
    }
  }

  ProgressOutcome outcome = progress.setStatus(prerequisites, tree, user, node, *status, hlc);
  Json::Value out(Json::objectValue);
  out["nodeId"] = node.str();
  out["status"] = args.get("status", "").asString();
  out["prerequisitesMet"] = outcome.prerequisitesMet;
  return ToolResult::json(out);
}

}  // namespace

RoadmapTools::RoadmapTools(RoomRegistry& registry, ProgressService& progress, Clock& clock,
                           UserId caller)
    : registry_(registry), progress_(progress), clock_(clock), caller_(std::move(caller)) {}

Hlc RoadmapTools::nextStamp() {
  std::lock_guard<std::mutex> lock(stampMutex_);
  std::uint64_t ms = clock_.nowMs();
  if (ms > lastMs_) {
    lastMs_ = ms;
    counter_ = 0;
  } else {
    ++counter_;
  }
  return Hlc{lastMs_, counter_, caller_.str()};
}

Json::Value RoadmapTools::listTools() const {
  const char* treeId = "The roadmap (tree) id.";
  Json::Value tools(Json::arrayValue);

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
    p["label"] = str("The node's display label.");
    p["icon"] = str("Optional icon name/emoji.");
    p["color"] = enumStr("Optional branch color (default terracotta).",
                         {"terracotta", "olive", "gold", "brick", "sky", "plum"});
    p["parentId"] = str("Optional prerequisite: an existing node that unlocks this one.");
    p["x"] = num("Optional canvas x.");
    p["y"] = num("Optional canvas y.");
    p["id"] = str("Optional explicit id; minted from the label if omitted.");
    tools.append(tool("create_node",
        "Add a node to the roadmap. Only `label` is required; icon, color, position (x,y) and a "
        "parentId (a prerequisite that unlocks this node) are optional. Returns the node id.",
        p, {"treeId", "label"}));
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
    tools.append(tool("add_kind",
        "Add a legend kind: a named, described hue. The hue must be free (unique per kind) and the "
        "legend must have fewer than 6 kinds. Label/description start empty — set them with "
        "rename_kind / describe_kind.",
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
    Json::Value p(Json::objectValue);
    p["treeId"] = str(treeId);
    p["nodeId"] = str("The node id.");
    p["status"] = enumStr("active, complete, or none (clear).", {"active", "complete", "none"});
    tools.append(tool("set_progress",
        "Set the caller's progress on a node. Advisory only — marking complete with unmet "
        "prerequisites still records and reports prerequisitesMet:false.",
        p, {"treeId", "nodeId", "status"}));
  }

  return tools;
}

ToolResult RoadmapTools::callTool(const std::string& name, const Json::Value& arguments) {
  TreeId tree{arguments.get("treeId", "").asString()};
  if (tree.empty()) return ToolResult::failure("missing required argument: treeId");

  if (name == "get_tree")        return readTree(registry_, tree);
  if (name == "get_diagnostics") return readDiagnostics(registry_, tree);
  if (name == "get_health")      return readHealth(registry_, tree);
  if (name == "get_progress")    return readProgress(progress_, tree, caller_);
  if (name == "set_progress")
    return writeProgress(registry_, progress_, tree, arguments, nextStamp(), caller_);

  if (std::optional<std::string> kind = commandKindFor(name))
    return applyEdit(registry_, tree, *kind, arguments, nextStamp(), caller_, name == "create_node");

  return ToolResult::failure("unknown tool: " + name);
}

}
