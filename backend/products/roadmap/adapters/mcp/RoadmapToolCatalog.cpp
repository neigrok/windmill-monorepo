#include "products/roadmap/adapters/mcp/RoadmapToolCatalog.h"

#include "products/roadmap/adapters/mcp/ReadShape.h"
#include "products/roadmap/domain/Command.h"

#include <cstddef>
#include <set>
#include <string>
#include <utility>
#include <vector>

namespace wm {

namespace {

Json::Value str(const char* description) {
  Json::Value property(Json::objectValue);
  property["type"] = "string";
  property["description"] = description;
  return property;
}

Json::Value cappedStr(const char* description, std::size_t limit) {
  Json::Value property = str(description);
  property["maxLength"] = static_cast<Json::UInt64>(limit);
  return property;
}

Json::Value treeHandle() {
  return cappedStr("The roadmap (tree) id — list_trees discovers it.", kMaxIdLength);
}

Json::Value nodeHandle() {
  return cappedStr("The node id (legacy `id` is still accepted).", kMaxIdLength);
}

// The alias stays in the schema because every tool declares `additionalProperties: false`.
Json::Value legacyNodeHandle() {
  Json::Value property = cappedStr("Deprecated alias for `nodeId`.", kMaxIdLength);
  property["deprecated"] = true;
  return property;
}

Json::Value kindHandle() {
  return cappedStr("The kind id (`kindId` is accepted too).", kMaxIdLength);
}

Json::Value kindHandleAlias() {
  return cappedStr("Alias for `id`, the kind that already exists.", kMaxIdLength);
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

Json::Value strArray(const char* description, std::size_t itemLimit) {
  Json::Value item = str("");
  item["maxLength"] = static_cast<Json::UInt64>(itemLimit);
  Json::Value property(Json::objectValue);
  property["type"] = "array";
  property["items"] = item;
  property["description"] = description;
  return property;
}

Json::Value objArray(const char* description, Json::Value properties, std::vector<const char*> required) {
  Json::Value item(Json::objectValue);
  item["type"] = "object";
  item["properties"] = std::move(properties);
  Json::Value must(Json::arrayValue);
  for (const char* field : required) must.append(field);
  item["required"] = must;
  item["additionalProperties"] = false;  // enforced by CompositeToolHost, so a misnamed key is named, not dropped

  Json::Value property(Json::objectValue);
  property["type"] = "array";
  property["items"] = item;
  property["description"] = description;
  return property;
}

Json::Value fieldArray(const char* description, const std::vector<std::string>& legal) {
  Json::Value allowed(Json::arrayValue);
  for (const std::string& name : legal) allowed.append(name);
  Json::Value item(Json::objectValue);
  item["type"] = "string";
  item["enum"] = allowed;

  Json::Value property(Json::objectValue);
  property["type"] = "array";
  property["items"] = item;
  property["description"] = description;
  return property;
}

Json::Value boundedInt(const char* description, int smallest, int largest, int fallback) {
  Json::Value property(Json::objectValue);
  property["type"] = "integer";
  property["description"] = description;
  property["minimum"] = smallest;
  property["maximum"] = largest;
  property["default"] = fallback;
  return property;
}

Json::Value position(const char* description) {
  Json::Value fields(Json::objectValue);
  fields["x"] = num("Canvas x.");
  fields["y"] = num("Canvas y.");
  Json::Value property(Json::objectValue);
  property["type"] = "object";
  property["properties"] = fields;
  property["additionalProperties"] = false;
  property["description"] = description;
  return property;
}

Json::Value linkArray(const char* description) {
  Json::Value link(Json::objectValue);
  link["type"] = "object";
  Json::Value fields(Json::objectValue);
  fields["url"] = cappedStr("The link target (href).", kMaxLinkUrlLength);
  fields["label"] = cappedStr("Optional display text (defaults to the url).", kMaxLinkLabelLength);
  link["properties"] = fields;
  Json::Value required(Json::arrayValue);
  required.append("url");
  link["required"] = required;
  link["additionalProperties"] = false;

  Json::Value property(Json::objectValue);
  property["type"] = "array";
  property["items"] = link;
  property["maxItems"] = static_cast<Json::UInt64>(kMaxNodeLinks);
  property["description"] = description;
  return property;
}

// The two facts the wire annotations need that the grant level does not carry (ToolHost.h derives
// the rest). A bulk edit overwrites or removes many entries in one call and is declared destructive
// under a write grant. An idempotent write is one a resend with the same arguments leaves unchanged;
// create_tree and create_node mint an id, so a resend plants a second one.
const std::set<std::string> kBulkEdits = {"import_subgraph", "prune", "tidy"};
const std::set<std::string> kIdempotentWrites = {
    "delete_tree",  "annotate_node", "rename_node",   "set_node_color", "move_node",
    "connect",      "disconnect",    "reconnect",     "delete_node",    "tidy",
    "add_kind",     "rename_kind",   "describe_kind", "remove_kind",    "reorder_kinds",
    "recolor_kind", "set_progress",  "import_subgraph", "prune"};

// `read` answers questions, `write` changes the document, and `delete` destroys something a
// person authored. `delete` is never implied by `write`: a connection without that level does
// not see those tools in tools/list.
ToolDeclaration tool(const char* name, Access access, const char* description, Json::Value properties,
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
  ToolDeclaration declaration{std::move(descriptor), "roadmap", access};
  declaration.bulkEdit = kBulkEdits.count(name) > 0;
  declaration.idempotent = kIdempotentWrites.count(name) > 0;
  return declaration;
}

}

std::vector<ToolDeclaration> roadmapToolCatalog() {
  std::vector<ToolDeclaration> tools;

  {
    Json::Value p(Json::objectValue);
    p["title"] = cappedStr("Optional name for the new roadmap.", kMaxTitleChars);
    tools.push_back(tool("create_tree", Access::write,
        "Create a new empty roadmap that you own, seeded with the default legend "
        "(Build/Learn/Milestone). Optionally name it with `title`. Returns the new treeId — pass it "
        "to the other tools to start authoring.",
        p, {}));
  }
  {
    tools.push_back(tool("list_trees", Access::read,
        "List the roadmaps you own — one row each: id, title, total node count, how many you have "
        "completed, when it was planted (createdAt, epoch ms), when it last moved (updatedAt, epoch "
        "ms), and its dominant hue (dominantKind), newest activity first. Takes no arguments. Use it "
        "to discover the treeId the other tools need.",
        Json::Value(Json::objectValue), {}));
  }
  {
    Json::Value p(Json::objectValue);
    p["treeId"] = treeHandle();
    tools.push_back(tool("delete_tree", Access::del,
        "Delete a roadmap you own — a soft-delete: it stops appearing in list_trees and can no longer "
        "be read. Only the owner may delete; someone else's tree is refused.",
        p, {"treeId"}));
  }
  {
    Json::Value p(Json::objectValue);
    p["treeId"] = treeHandle();
    p["fields"] = fieldArray(
        "Which fields each node carries. Default {id, label, color, prerequisites} — the shape of "
        "the tree. Ask for description, links, position, order or icon when you need them; `kind` is "
        "the legend kind id whose hue the node wears, omitted on a node no kind claims; `status` "
        "is your own mark on each node (active/complete/none, always answered), `seedStatus` the "
        "document's authored baseline. `state` is what the tree DERIVES for you from prerequisites "
        "and your marks — locked · available · active · complete — the answer to \"what can I work "
        "on\"; `status` stays your raw mark. `summary` is the description's opening (200 characters "
        "counted as Unicode code points, cut at a word, ellipsized when cut) — ask for it to skim a "
        "whole tree's notes, and for `description` when you need one node's whole text.",
        nodeVocabulary().names());
    p["kindFields"] = fieldArray(
        "Which fields each legend kind carries. Default {id, hue, label}; `crossBranchExempt` is "
        "whether get_health leaves the kind's edges out of its cross-branch count.",
        kindVocabulary().names());
    p["includeEdges"] = boolean(
        "Also answer a top-level `edges` array of EVERY live edge in the tree as {from, to}, "
        "independent of node paging — the same list on whichever page you ask it, so ask once. "
        "A tree holding more than 6000 live edges answers `edgesOmitted` with the count instead of "
        "a cut list, whatever its node count. Default false.");
    p["limit"] = boundedInt("Most nodes to return in one page.", 1, kMaxLimit, kDefaultLimit);
    p["cursor"] = str("Resume token from a previous page's `nextCursor`. Omit for the first page.");
    tools.push_back(tool("get_tree", Access::read,
        "Read a roadmap's current document — title, its nodes and their prerequisite edges, and the "
        "ordered legend `kinds` — with the tree's op sequence number. Call this before editing to "
        "learn the node ids the other tools take, and the legend a node's color refers to. `count` "
        "is the tree's whole node count; when it exceeds one page a `nextCursor` comes back with it. "
        "`includeEdges: true` adds the whole tree's edge list beside the page.",
        p, {"treeId"}));
  }
  {
    Json::Value p(Json::objectValue);
    p["treeId"] = treeHandle();
    tools.push_back(tool("get_diagnostics", Access::read,
        "Report how the roadmap departs from a valid skill tree: cycles, dangling edges (an "
        "endpoint is missing), self-edges, and structural smells. Edits are never rejected, so an "
        "edit that forms a cycle still succeeds — this is how you find and fix it.",
        p, {"treeId"}));
  }
  {
    Json::Value p(Json::objectValue);
    p["treeId"] = treeHandle();
    tools.push_back(tool("get_health", Access::read,
        "Tidiness metrics for a structurally-valid roadmap: node/edge counts, cross-branch "
        "coupling, redundant (transitively implied) edges, average in-degree, and a 0–100 score "
        "(100 × (1 − 0.6 × crossBranch/weighed − 0.4 × redundant/weighed), where weighed is "
        "edgeCount − crossBranchExempt). Branches derive from "
        "colour: a node's branch is the run of same-hue trunk parents above it, so an edge joining "
        "two hues counts as `crossBranch` — unless either endpoint wears a kind marked "
        "`crossBranchExempt` (add_kind / describe_kind), in which case it is counted in "
        "`crossBranchExempt` instead and weighs nothing — out of the score's numerator and its "
        "denominator both, while `edgeCount` stays every live edge. Fails if the tree currently has "
        "cycles/dangling edges — fix those first.",
        p, {"treeId"}));
  }
  {
    Json::Value p(Json::objectValue);
    p["treeId"] = treeHandle();
    p["fields"] = fieldArray(
        "Which id lists to return. Default {completed, inProgress}; `cleared` (the tombstones a "
        "browser reconciles against) is available but rarely useful.",
        progressVocabulary().names());
    tools.push_back(tool("get_progress", Access::read,
        "The caller's private progress overlay for a roadmap: the node ids that are completed and "
        "those in progress. Per-user, separate from the shared structure.",
        p, {"treeId"}));
  }
  {
    Json::Value p(Json::objectValue);
    p["treeId"] = treeHandle();
    p["color"] = enumStr("Optional hue to match — a node's color is its kind.", kHues);
    p["kind"] = cappedStr("Optional legend kind id — matches nodes wearing that kind's hue.", kMaxIdLength);
    p["query"] = str("Optional case-insensitive substring matched against each node's id, label and "
                     "description. Matches come back best first: an exact id, then an id prefix, then "
                     "a label hit, then an id substring, then a description-only hit.");
    p["state"] = enumStr("Optional derived state to match — locked, available, active or complete, as "
                         "the tree derives it from prerequisites and your marks.", kNodeStates);
    p["fields"] = fieldArray(
        "Which fields each match carries. Default {id, label, color} — an index you pick edit targets "
        "out of. Ask for description, links, prerequisites, position, order or icon when you need them; "
        "`kind` is the legend kind id whose hue the node wears, omitted on a node no kind claims; "
        "`status` is your own mark on each node (active/complete/none, always answered), `seedStatus` "
        "the document's authored baseline. `state` is what the tree DERIVES for you from prerequisites "
        "and your marks — locked · available · active · complete — the answer to \"what can I work "
        "on\"; `status` stays your raw mark. `summary` is the description's opening (200 characters "
        "counted as Unicode code points, cut at a word, ellipsized when cut) — ask for it to skim a "
        "whole tree's notes, and for `description` when you need one node's whole text.",
        nodeVocabulary().names());
    p["limit"] = boundedInt("Most nodes to return in one page.", 1, kMaxLimit, kDefaultLimit);
    p["cursor"] = str("Resume token from a previous page's `nextCursor`. Omit for the first page.");
    tools.push_back(tool("find_nodes", Access::read,
        "Search a roadmap's nodes. Every filter you set must match (AND): `color` or `kind` pin a hue, "
        "`state` pins the derived state — `find_nodes {state: \"available\"}` is the frontier: what "
        "you can work on right now, in one call — and `query` is a case-insensitive substring over id + "
        "label + description, best match first — so pasting an id you already know finds that node, at "
        "the top. Omit all filters to list every node. `count` is everything that matched, not the size "
        "of the page you got; when more remain a `nextCursor` comes back with it.",
        p, {"treeId"}));
  }
  {
    Json::Value p(Json::objectValue);
    p["treeId"] = treeHandle();
    p["label"] = cappedStr("The node's display label.", kMaxNodeLabelLength);
    p["icon"] = cappedStr("Optional icon name/emoji.", kMaxIconLength);
    p["color"] = enumStr("Optional branch color (default terracotta).", kHues);
    p["prerequisites"] = strArray("Optional ids of existing nodes that unlock this one — one edge per id.",
                                  kMaxIdLength);
    p["parentId"] = cappedStr("Optional single prerequisite (a convenience alias folded into prerequisites).",
                              kMaxIdLength);
    p["x"] = num("Optional canvas x.");
    p["y"] = num("Optional canvas y.");
    p["description"] = cappedStr("Optional annotation body — notes about the node.",
                                 kMaxNodeDescriptionLength);
    p["links"] = linkArray("Optional external references (docs, PRs, designs).");
    p["id"] = cappedStr("Optional id to PROPOSE for the new node; minted from the label if omitted. "
                        "(`nodeId` names a node that already exists and is not accepted here.)",
                        kMaxIdLength);
    tools.push_back(tool("create_node", Access::write,
        "Add a node to the roadmap. Only `label` is required; icon, color, position (x,y), a set of "
        "`prerequisites` (nodes that unlock this one), a `description`, and `links` are optional. "
        "Returns the node id.",
        p, {"treeId", "label"}));
  }
  {
    Json::Value p(Json::objectValue);
    p["treeId"] = treeHandle();
    p["nodeId"] = nodeHandle();
    p["id"] = legacyNodeHandle();
    p["description"] = cappedStr("The annotation body (omit to leave it unchanged).",
                                 kMaxNodeDescriptionLength);
    p["links"] = linkArray("The node's external references — replaces the existing set (omit to leave unchanged).");
    tools.push_back(tool("annotate_node", Access::write,
        "Set a node's free annotation: its `description` and/or `links`. Each field is optional — an "
        "omitted field is left untouched; `links` replaces the whole set when given — but at least "
        "one must be given.",
        p, {"treeId", "nodeId"}));
  }
  {
    Json::Value p(Json::objectValue);
    p["treeId"] = treeHandle();
    p["nodeId"] = nodeHandle();
    p["id"] = legacyNodeHandle();
    p["label"] = cappedStr("The new label.", kMaxNodeLabelLength);
    tools.push_back(tool("rename_node", Access::write, "Change a node's label.", p, {"treeId", "nodeId", "label"}));
  }
  {
    Json::Value p(Json::objectValue);
    p["treeId"] = treeHandle();
    p["nodeId"] = nodeHandle();
    p["id"] = legacyNodeHandle();
    p["color"] = enumStr("The new color.", kHues);
    tools.push_back(tool("set_node_color", Access::write, "Set a node's color (its branch/category tint).", p,
                      {"treeId", "nodeId", "color"}));
  }
  {
    Json::Value p(Json::objectValue);
    p["treeId"] = treeHandle();
    p["nodeId"] = nodeHandle();
    p["id"] = legacyNodeHandle();
    p["x"] = num("Canvas x.");
    p["y"] = num("Canvas y.");
    tools.push_back(tool("move_node", Access::write, "Set a node's canvas position (x, y).", p,
                      {"treeId", "nodeId", "x", "y"}));
  }
  {
    Json::Value p(Json::objectValue);
    p["treeId"] = treeHandle();
    p["from"] = cappedStr("The prerequisite node id.", kMaxIdLength);
    p["to"] = cappedStr("The node it unlocks.", kMaxIdLength);
    tools.push_back(tool("connect", Access::write,
        "Add a prerequisite edge from `from` to `to` — `from` must be completed before `to`. "
        "Idempotent; may form a cycle (surfaced by get_diagnostics, never rejected).",
        p, {"treeId", "from", "to"}));
  }
  {
    Json::Value p(Json::objectValue);
    p["treeId"] = treeHandle();
    p["from"] = cappedStr("The prerequisite node id (single form, with `to`).", kMaxIdLength);
    p["to"] = cappedStr("The node it unlocks (single form, with `from`).", kMaxIdLength);
    Json::Value endpoints(Json::objectValue);
    endpoints["from"] = cappedStr("The prerequisite node id.", kMaxIdLength);
    endpoints["to"] = cappedStr("The node it unlocks.", kMaxIdLength);
    Json::Value edges = objArray("Batch form: the edges to remove, each named once.", endpoints, {"from", "to"});
    edges["items"]["additionalProperties"] = false;
    edges["minItems"] = 1;
    edges["maxItems"] = static_cast<Json::UInt64>(kMaxDisconnectEdges);
    p["edges"] = edges;
    tools.push_back(tool("disconnect", Access::write,
        "Remove prerequisite edges. Two forms, exactly one per call: a single `from`+`to`, or "
        "`edges: [{from, to}]` (1 to 500). The whole list lands as ONE op under one seq, or not at "
        "all: a malformed row or a repeated edge changes nothing and is named. An edge the tree does "
        "not hold is a no-op, never a refusal; the receipt's `removed` counts the edges that were "
        "actually present.",
        p, {"treeId"}));
  }
  {
    Json::Value p(Json::objectValue);
    p["treeId"] = treeHandle();
    p["oldFrom"] = cappedStr("Current edge source.", kMaxIdLength);
    p["oldTo"] = cappedStr("Current edge target.", kMaxIdLength);
    p["newFrom"] = cappedStr("New edge source.", kMaxIdLength);
    p["newTo"] = cappedStr("New edge target.", kMaxIdLength);
    tools.push_back(tool("reconnect", Access::write,
        "Atomically move an edge: remove (oldFrom→oldTo) and add (newFrom→newTo) as one op / one "
        "undo step.",
        p, {"treeId", "oldFrom", "oldTo", "newFrom", "newTo"}));
  }
  {
    Json::Value p(Json::objectValue);
    p["treeId"] = treeHandle();
    p["nodeId"] = nodeHandle();
    p["id"] = legacyNodeHandle();
    Json::Value nodeIds = strArray("Batch form: the node ids to delete, each named once.", kMaxIdLength);
    nodeIds["minItems"] = 1;
    nodeIds["maxItems"] = static_cast<Json::UInt64>(kMaxDeleteNodeIds);
    p["nodeIds"] = nodeIds;
    p["prune"] = boolean(
        "If true, also remove every edge touching a deleted node (both directions) and clear your "
        "own progress marks on them, in the same op. Default false: those edges stay and are "
        "reported in introducedDiagnostics as dangling.");
    tools.push_back(tool("delete_node", Access::del,
        "Delete nodes (tombstone). Two forms, exactly one per call: a single `nodeId`, or `nodeIds` "
        "(1 to 200). Every id must name a present node — one missing or already-deleted id refuses "
        "the whole call, naming each, and nothing is applied. The deletions land as ONE op under one "
        "seq. A deleted node's children detach into roots; nothing is re-tethered. With `prune: "
        "true` the edges the delete dangles and your marks on the deleted nodes go with it — that "
        "cleanup is part of the delete and needs no write grant beyond the delete grant. The receipt "
        "carries `ids`, `pruned: {edges, progress}` (0s when prune is false or nothing dangled), and "
        "`id` for the single form.",
        p, {"treeId"}));
  }
  {
    Json::Value p(Json::objectValue);
    p["treeId"] = treeHandle();
    tools.push_back(tool("tidy", Access::write,
        "Transitive reduction: drop edges already implied by a longer path, as one op. A "
        "semantics-preserving cleanup that every collaborator converges on.",
        p, {"treeId"}));
  }
  {
    Json::Value p(Json::objectValue);
    p["treeId"] = treeHandle();
    p["id"] = cappedStr("The kind id (stable, unique within the tree's legend).", kMaxIdLength);
    p["hue"] = enumStr("The kind's hue — unique per kind; at most 6 kinds per tree.", kHues);
    p["label"] = cappedStr("Optional label — set inline so the kind lands in one op.", kMaxKindLabelLength);
    p["description"] = cappedStr("Optional description — the generator's sorting brief.",
                                 kMaxKindDescriptionLength);
    p["crossBranchExempt"] = boolean(
        "Optional, default false: get_health leaves every edge touching a node of this kind out of "
        "its cross-branch count — for a kind whose whole point is to interleave with the others.");
    tools.push_back(tool("add_kind", Access::write,
        "Add a legend kind: a named, described hue. The hue must be free (unique per kind) and the "
        "legend must have fewer than 6 kinds. `label`, `description` and `crossBranchExempt` may be "
        "set inline, or later with rename_kind / describe_kind.",
        p, {"treeId", "id", "hue"}));
  }
  {
    Json::Value p(Json::objectValue);
    p["treeId"] = treeHandle();
    p["id"] = kindHandle();
    p["kindId"] = kindHandleAlias();
    p["label"] = cappedStr("The kind's label (sentence-case, one or two words; \"\" = unlabeled).",
                           kMaxKindLabelLength);
    tools.push_back(tool("rename_kind", Access::write, "Set a legend kind's label.", p, {"treeId", "id", "label"}));
  }
  {
    Json::Value p(Json::objectValue);
    p["treeId"] = treeHandle();
    p["id"] = kindHandle();
    p["kindId"] = kindHandleAlias();
    p["description"] = cappedStr("The kind's description (plain text; the generator's sorting brief).",
                                 kMaxKindDescriptionLength);
    p["crossBranchExempt"] = boolean(
        "Whether get_health leaves every edge touching a node of this kind out of its cross-branch "
        "count. Omit to leave it as it is.");
    tools.push_back(tool("describe_kind", Access::write,
        "Set a legend kind's `description`, its `crossBranchExempt` flag, or both; a field you omit "
        "keeps its value.",
        p, {"treeId", "id"}));
  }
  {
    Json::Value p(Json::objectValue);
    p["treeId"] = treeHandle();
    p["id"] = kindHandle();
    p["kindId"] = kindHandleAlias();
    tools.push_back(tool("remove_kind", Access::del,
        "Remove a legend kind. Rejected while any node still wears its hue — recolor or repaint those "
        "nodes first.",
        p, {"treeId", "id"}));
  }
  {
    Json::Value p(Json::objectValue);
    p["treeId"] = treeHandle();
    p["order"] = strArray("The kind ids in the desired order (legend order = generation priority).",
                          kMaxIdLength);
    tools.push_back(tool("reorder_kinds", Access::write, "Reorder the legend. The first kind is the generation fallback.",
                      p, {"treeId", "order"}));
  }
  {
    Json::Value p(Json::objectValue);
    p["treeId"] = treeHandle();
    p["id"] = kindHandle();
    p["kindId"] = kindHandleAlias();
    p["hue"] = enumStr("The new hue — must be free (not owned by another kind).", kHues);
    tools.push_back(tool("recolor_kind", Access::write,
        "Atomically change a kind's hue and repaint every node wearing the old hue to the new one, as "
        "one op / one undo step.",
        p, {"treeId", "id", "hue"}));
  }
  {
    Json::Value updateFields(Json::objectValue);
    updateFields["nodeId"] = nodeHandle();
    updateFields["id"] = legacyNodeHandle();
    updateFields["status"] = enumStr("active, complete, or none (clear).", kStatuses);

    Json::Value p(Json::objectValue);
    p["treeId"] = treeHandle();
    p["nodeId"] = nodeHandle();
    p["id"] = legacyNodeHandle();
    p["status"] = enumStr("active, complete, or none (clear).", kStatuses);
    p["updates"] = objArray(
        "Bulk form: a list of {nodeId, status}. Resolves order internally, so completing a subtree "
        "out of dependency order no longer misreports prerequisitesMet. Pass this OR a single "
        "nodeId+status, never both.",
        updateFields, {"nodeId", "status"});
    tools.push_back(tool("set_progress", Access::write,
        "Set the caller's progress. Pass a single `nodeId`+`status`, or a bulk `updates` list. Unknown "
        "node ids are rejected (no orphan rows). Advisory only — marking complete with unmet "
        "prerequisites still records and reports prerequisitesMet:false, judged against the committed "
        "batch (not each write's instant).",
        p, {"treeId"}));
  }
  {
    Json::Value p(Json::objectValue);
    p["treeId"] = treeHandle();
    Json::Value nodeFields(Json::objectValue);
    nodeFields["id"] = cappedStr("The id this node WILL have: one already in the tree is overwritten, "
                                 "a new one is added.", kMaxIdLength);
    nodeFields["label"] = cappedStr("The node's display label.", kMaxNodeLabelLength);
    nodeFields["icon"] = cappedStr("Optional icon name/emoji.", kMaxIconLength);
    nodeFields["color"] = enumStr("Optional branch color (default terracotta).", kHues);
    nodeFields["order"] = str("Optional sibling order key, as get_tree returns it.");
    nodeFields["prerequisites"] = strArray(
        "Ids of the nodes that unlock this one. For a node already in the tree, `prerequisiteMode` "
        "says whether these are added to its existing prerequisites or become the whole list.",
        kMaxIdLength);
    nodeFields["position"] = position(
        "Optional canvas position {x, y}. Optional because the web canvas lays the tree out from its "
        "structure and never reads a stored position.");
    nodeFields["seedStatus"] = enumStr(
        "Optional authored baseline carried in the document — what every reader sees before their own "
        "marks. Your own progress is not this: pass it in `progress[]`.", kStatuses);
    nodeFields["description"] = cappedStr("Optional annotation body.", kMaxNodeDescriptionLength);
    nodeFields["links"] = linkArray("Optional external references.");

    Json::Value kindFields(Json::objectValue);
    kindFields["id"] = cappedStr("The kind id.", kMaxIdLength);
    kindFields["hue"] = enumStr("The kind's hue — unique per kind, at most 6 kinds per tree.", kHues);
    kindFields["label"] = cappedStr("Optional label.", kMaxKindLabelLength);
    kindFields["description"] = cappedStr("Optional sorting brief.", kMaxKindDescriptionLength);
    kindFields["crossBranchExempt"] = boolean("Optional, default false: get_health leaves this kind's edges "
                                              "out of its cross-branch count.");

    Json::Value progressFields(Json::objectValue);
    progressFields["nodeId"] = nodeHandle();
    progressFields["id"] = legacyNodeHandle();
    progressFields["status"] = enumStr("active, complete, or none (clear).", kStatuses);

    p["nodes"] = objArray("The nodes to import — the shape get_tree returns when you ask it for those "
                          "fields. Pass [] to import only kinds or progress.",
                          nodeFields, {"id"});
    p["kinds"] = objArray("Optional legend kinds. Omit to leave the legend untouched.",
                          kindFields, {"id", "hue"});
    p["progress"] = objArray("Optional carried progress, applied over the imported nodes. `nodeId` here "
                             "names a node that exists once the import lands; a row naming none is "
                             "reported back in progressSkipped, not silently dropped.",
                             progressFields, {"nodeId", "status"});
    p["prerequisiteMode"] = enumStr(
        "How a node already in the tree meets the `prerequisites` you send for it. `merge` (the "
        "default) UNIONS them with the prerequisites it already has — an edge you leave out survives, "
        "and is listed in the receipt's keptEdges. `replace` makes your list the whole list: every "
        "live prerequisite edge into that node you did not name is removed in the same batch, and "
        "the receipt counts them as removedEdges. New nodes and nodes not in the batch are untouched "
        "either way.",
        kPrerequisiteModes);
    p["tombstone"] = strArray(
        "Ids to delete in this same batch, at the same seq as the upserts: each node goes, every "
        "edge touching it in either direction goes, and your own progress on it is cleared. Every id "
        "must exist and must not also be in nodes[] — otherwise the whole call is refused, naming "
        "each offending id, and nothing is applied. At most 500 per call.",
        kMaxIdLength);
    p["tombstone"]["maxItems"] = static_cast<Json::UInt64>(kMaxTombstones);
    p["dryRun"] = boolean(
        "If true, report collisions, keptEdges, what would be tombstoned (and any progressSkipped) "
        "and change nothing.");
    tools.push_back(tool("import_subgraph", Access::write,
        "Bulk-apply a whole roadmap slice — the shape get_tree returns ({nodes[], kinds[]}, plus an "
        "optional progress[]); to copy a tree faithfully, read it with every field named in `fields` "
        "first, since get_tree answers with a projection — but a node carries `seedStatus`, never "
        "`status`: that one is your own mark, and travels in progress[]. The graft is ONE op; a "
        "carried progress[] is applied after it as ordinary overlay writes. The batch is atomic "
        "against malformed input — a bad field, a repeated id, or a tombstone id that does not exist "
        "changes nothing and names the offending element — but never against a merely untidy result "
        "(a dangling edge lands and is reported in introducedDiagnostics). Upsert by id: an incoming "
        "id already present is overwritten (reported in nodeCollisions/kindCollisions) — its scalar "
        "fields are replaced, and its prerequisites are UNIONED with the ones it already has unless "
        "prerequisiteMode is \"replace\"; a new id is added; the tree's title is not touched. The "
        "only removals are the ones you ask for: `tombstone` ids, and under \"replace\" the "
        "prerequisite edges your batch does not name. `position` is optional — the web canvas lays "
        "the tree out from its structure. The receipt counts what the batch carried — `nodes`, "
        "`edges` (the prerequisites across them), `kinds` — so check `edges` against what you meant "
        "to send; keptEdges/keptEdgeCount name the pre-existing edges into re-sent nodes that "
        "survived a merge, removedEdges counts what a replace dropped, and tombstoned counts the "
        "nodes and edges the tombstones took. Pass dryRun to preview all of that and change nothing. "
        "This collapses hundreds of create/connect/delete calls into one.",
        p, {"treeId", "nodes"}));
  }
  {
    Json::Value p(Json::objectValue);
    p["treeId"] = treeHandle();
    tools.push_back(tool("prune", Access::write,
        "Garbage-collect the roadmap: drop dangling and self edges (edges no valid DAG keeps) in one "
        "op, and clear the caller's progress rows for nodes no longer in the tree. Returns how many of "
        "each it removed.",
        p, {"treeId"}));
  }

  return tools;
}

}
