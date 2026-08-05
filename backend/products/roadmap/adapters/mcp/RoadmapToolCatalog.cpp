#include "products/roadmap/adapters/mcp/RoadmapToolCatalog.h"

#include "products/roadmap/adapters/mcp/ReadShape.h"
#include "products/roadmap/domain/Command.h"

#include <cstddef>
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

// A string with a published cap. The cap exists either way — the tool refuses past it — and a
// client can only pre-validate what the schema states, so it is stated.
Json::Value cappedStr(const char* description, std::size_t limit) {
  Json::Value property = str(description);
  property["maxLength"] = static_cast<Json::UInt64>(limit);
  return property;
}

// The roadmap's handle, on every tree-scoped tool.
Json::Value treeHandle() {
  return cappedStr("The roadmap (tree) id — list_trees discovers it.", kMaxIdLength);
}

// The handle of a node that already exists, canonical on every tool that takes one.
Json::Value nodeHandle() {
  return cappedStr("The node id (legacy `id` is still accepted).", kMaxIdLength);
}

// …and that legacy spelling, still read but no longer canonical. It stays in the schema because
// every tool declares `additionalProperties: false`: a client that dropped it from the published
// properties would have its own validator reject the alias before the server ever saw it.
Json::Value legacyNodeHandle() {
  Json::Value property = cappedStr("Deprecated alias for `nodeId`.", kMaxIdLength);
  property["deprecated"] = true;
  return property;
}

// A legend kind's handle. Kinds keep `id` as the published property — all six *_kind tools spell
// it alike, so there is no sibling split to guess — but `kindId` is accepted too, so an agent
// that learned "<thing>Id names a thing that exists" from the node tools is never wrong.
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

// An array of objects, publishing the shape of one. Separate from strArray because the difference
// is not cosmetic: a caller that believes `items` is a string sends strings, and the request dies
// at the parser with a bare transport error naming no field. A schema is the only thing an agent
// has — it cannot look at an example and recover the way a person reading docs can — so it states
// what each item requires, which is exactly what the tool enforces.
Json::Value objArray(const char* description, Json::Value properties, std::vector<const char*> required) {
  Json::Value item(Json::objectValue);
  item["type"] = "object";
  item["properties"] = std::move(properties);
  Json::Value must(Json::arrayValue);
  for (const char* field : required) must.append(field);
  item["required"] = must;

  Json::Value property(Json::objectValue);
  property["type"] = "array";
  property["items"] = item;
  property["description"] = description;
  return property;
}

// A read's `fields` argument, carrying its shape's whole vocabulary as the item `enum` — a
// client can only pre-validate what the schema states, so the legal set is stated.
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

// A canvas position, as get_tree returns it and as an import may carry it.
Json::Value position(const char* description) {
  Json::Value fields(Json::objectValue);
  fields["x"] = num("Canvas x.");
  fields["y"] = num("Canvas y.");
  Json::Value property(Json::objectValue);
  property["type"] = "object";
  property["properties"] = fields;
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

  Json::Value property(Json::objectValue);
  property["type"] = "array";
  property["items"] = link;
  property["maxItems"] = static_cast<Json::UInt64>(kMaxNodeLinks);
  property["description"] = description;
  return property;
}

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

}

Json::Value roadmapToolCatalog() {
  Json::Value tools(Json::arrayValue);

  {
    Json::Value p(Json::objectValue);
    p["title"] = cappedStr("Optional name for the new roadmap.", kMaxTitleChars);
    tools.append(tool("create_tree",
        "Create a new empty roadmap that you own, seeded with the default legend "
        "(Build/Learn/Milestone). Optionally name it with `title`. Returns the new treeId — pass it "
        "to the other tools to start authoring.",
        p, {}));
  }
  {
    tools.append(tool("list_trees",
        "List the roadmaps you own — one row each: id, title, total node count, how many you have "
        "completed, when it was planted (createdAt, epoch ms), when it last moved (updatedAt, epoch "
        "ms), and its dominant hue (dominantKind), newest activity first. Takes no arguments. Use it "
        "to discover the treeId the other tools need.",
        Json::Value(Json::objectValue), {}));
  }
  {
    Json::Value p(Json::objectValue);
    p["treeId"] = treeHandle();
    tools.append(tool("delete_tree",
        "Delete a roadmap you own — a soft-delete: it stops appearing in list_trees and can no longer "
        "be read. Only the owner may delete; someone else's tree is refused.",
        p, {"treeId"}));
  }
  {
    Json::Value p(Json::objectValue);
    p["treeId"] = treeHandle();
    p["fields"] = fieldArray(
        "Which fields each node carries. Default {id, label, color, prerequisites} — the shape of "
        "the tree. Ask for description, links, position, order or icon when you need them; `status` "
        "is your own mark on each node (active/complete/none, always answered), `seedStatus` the "
        "document's authored baseline.",
        nodeVocabulary().names());
    p["kindFields"] = fieldArray(
        "Which fields each legend kind carries. Default {id, hue, label}.", kindVocabulary().names());
    p["limit"] = boundedInt("Most nodes to return in one page.", 1, kMaxLimit, kDefaultLimit);
    p["cursor"] = str("Resume token from a previous page's `nextCursor`. Omit for the first page.");
    tools.append(tool("get_tree",
        "Read a roadmap's current document — title, its nodes and their prerequisite edges, and the "
        "ordered legend `kinds` — with the tree's op sequence number. Call this before editing to "
        "learn the node ids the other tools take, and the legend a node's color refers to. `count` "
        "is the tree's whole node count; when it exceeds one page a `nextCursor` comes back with it.",
        p, {"treeId"}));
  }
  {
    Json::Value p(Json::objectValue);
    p["treeId"] = treeHandle();
    tools.append(tool("get_diagnostics",
        "Report how the roadmap departs from a valid skill tree: cycles, dangling edges (an "
        "endpoint is missing), self-edges, and structural smells. Edits are never rejected, so an "
        "edit that forms a cycle still succeeds — this is how you find and fix it.",
        p, {"treeId"}));
  }
  {
    Json::Value p(Json::objectValue);
    p["treeId"] = treeHandle();
    tools.append(tool("get_health",
        "Tidiness metrics for a structurally-valid roadmap: node/edge counts, cross-branch "
        "coupling, redundant (transitively implied) edges, average in-degree, and a 0–100 score. "
        "Fails if the tree currently has cycles/dangling edges — fix those first.",
        p, {"treeId"}));
  }
  {
    Json::Value p(Json::objectValue);
    p["treeId"] = treeHandle();
    p["fields"] = fieldArray(
        "Which id lists to return. Default {completed, inProgress}; `cleared` (the tombstones a "
        "browser reconciles against) is available but rarely useful.",
        progressVocabulary().names());
    tools.append(tool("get_progress",
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
    p["fields"] = fieldArray(
        "Which fields each match carries. Default {id, label, color} — an index you pick edit targets "
        "out of. Ask for description, links, prerequisites, position, order or icon when you need them; "
        "`status` is your own mark on each node (active/complete/none, always answered), `seedStatus` "
        "the document's authored baseline.",
        nodeVocabulary().names());
    p["limit"] = boundedInt("Most nodes to return in one page.", 1, kMaxLimit, kDefaultLimit);
    p["cursor"] = str("Resume token from a previous page's `nextCursor`. Omit for the first page.");
    tools.append(tool("find_nodes",
        "Search a roadmap's nodes. Every filter you set must match (AND): `color` or `kind` pin a hue, "
        "`query` is a case-insensitive substring over id + label + description, best match first — so "
        "pasting an id you already know finds that node, at the top. Omit all filters to list every "
        "node. `count` is everything that matched, not the size of the page you got; when more remain a "
        "`nextCursor` comes back with it.",
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
    tools.append(tool("create_node",
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
    tools.append(tool("annotate_node",
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
    tools.append(tool("rename_node", "Change a node's label.", p, {"treeId", "nodeId", "label"}));
  }
  {
    Json::Value p(Json::objectValue);
    p["treeId"] = treeHandle();
    p["nodeId"] = nodeHandle();
    p["id"] = legacyNodeHandle();
    p["color"] = enumStr("The new color.", kHues);
    tools.append(tool("set_node_color", "Set a node's color (its branch/category tint).", p,
                      {"treeId", "nodeId", "color"}));
  }
  {
    Json::Value p(Json::objectValue);
    p["treeId"] = treeHandle();
    p["nodeId"] = nodeHandle();
    p["id"] = legacyNodeHandle();
    p["x"] = num("Canvas x.");
    p["y"] = num("Canvas y.");
    tools.append(tool("move_node", "Set a node's canvas position (x, y).", p,
                      {"treeId", "nodeId", "x", "y"}));
  }
  {
    Json::Value p(Json::objectValue);
    p["treeId"] = treeHandle();
    p["from"] = cappedStr("The prerequisite node id.", kMaxIdLength);
    p["to"] = cappedStr("The node it unlocks.", kMaxIdLength);
    tools.append(tool("connect",
        "Add a prerequisite edge from `from` to `to` — `from` must be completed before `to`. "
        "Idempotent; may form a cycle (surfaced by get_diagnostics, never rejected).",
        p, {"treeId", "from", "to"}));
  }
  {
    Json::Value p(Json::objectValue);
    p["treeId"] = treeHandle();
    p["from"] = cappedStr("The prerequisite node id.", kMaxIdLength);
    p["to"] = cappedStr("The node it unlocks.", kMaxIdLength);
    tools.append(tool("disconnect", "Remove the prerequisite edge from `from` to `to`.", p,
                      {"treeId", "from", "to"}));
  }
  {
    Json::Value p(Json::objectValue);
    p["treeId"] = treeHandle();
    p["oldFrom"] = cappedStr("Current edge source.", kMaxIdLength);
    p["oldTo"] = cappedStr("Current edge target.", kMaxIdLength);
    p["newFrom"] = cappedStr("New edge source.", kMaxIdLength);
    p["newTo"] = cappedStr("New edge target.", kMaxIdLength);
    tools.append(tool("reconnect",
        "Atomically move an edge: remove (oldFrom→oldTo) and add (newFrom→newTo) as one op / one "
        "undo step.",
        p, {"treeId", "oldFrom", "oldTo", "newFrom", "newTo"}));
  }
  {
    Json::Value p(Json::objectValue);
    p["treeId"] = treeHandle();
    p["nodeId"] = nodeHandle();
    p["id"] = legacyNodeHandle();
    tools.append(tool("delete_node",
        "Delete a node (tombstone). Its edges go inert and its children detach into roots; nothing "
        "is re-tethered. Reversible via undo.",
        p, {"treeId", "nodeId"}));
  }
  {
    Json::Value p(Json::objectValue);
    p["treeId"] = treeHandle();
    tools.append(tool("tidy",
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
    tools.append(tool("add_kind",
        "Add a legend kind: a named, described hue. The hue must be free (unique per kind) and the "
        "legend must have fewer than 6 kinds. `label` and `description` may be set inline, or later "
        "with rename_kind / describe_kind.",
        p, {"treeId", "id", "hue"}));
  }
  {
    Json::Value p(Json::objectValue);
    p["treeId"] = treeHandle();
    p["id"] = kindHandle();
    p["kindId"] = kindHandleAlias();
    p["label"] = cappedStr("The kind's label (sentence-case, one or two words; \"\" = unlabeled).",
                           kMaxKindLabelLength);
    tools.append(tool("rename_kind", "Set a legend kind's label.", p, {"treeId", "id", "label"}));
  }
  {
    Json::Value p(Json::objectValue);
    p["treeId"] = treeHandle();
    p["id"] = kindHandle();
    p["kindId"] = kindHandleAlias();
    p["description"] = cappedStr("The kind's description (plain text; the generator's sorting brief).",
                                 kMaxKindDescriptionLength);
    tools.append(tool("describe_kind", "Set a legend kind's description.", p, {"treeId", "id", "description"}));
  }
  {
    Json::Value p(Json::objectValue);
    p["treeId"] = treeHandle();
    p["id"] = kindHandle();
    p["kindId"] = kindHandleAlias();
    tools.append(tool("remove_kind",
        "Remove a legend kind. Rejected while any node still wears its hue — recolor or repaint those "
        "nodes first.",
        p, {"treeId", "id"}));
  }
  {
    Json::Value p(Json::objectValue);
    p["treeId"] = treeHandle();
    p["order"] = strArray("The kind ids in the desired order (legend order = generation priority).",
                          kMaxIdLength);
    tools.append(tool("reorder_kinds", "Reorder the legend. The first kind is the generation fallback.",
                      p, {"treeId", "order"}));
  }
  {
    Json::Value p(Json::objectValue);
    p["treeId"] = treeHandle();
    p["id"] = kindHandle();
    p["kindId"] = kindHandleAlias();
    p["hue"] = enumStr("The new hue — must be free (not owned by another kind).", kHues);
    tools.append(tool("recolor_kind",
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
    tools.append(tool("set_progress",
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
    nodeFields["prerequisites"] = strArray("Ids of the nodes that unlock this one.", kMaxIdLength);
    nodeFields["position"] = position("Optional canvas position {x, y}.");
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
    p["dryRun"] = boolean("If true, report collisions (and any progressSkipped) and change nothing.");
    tools.append(tool("import_subgraph",
        "Bulk-apply a whole roadmap slice — the shape get_tree returns ({nodes[], kinds[]}, plus an "
        "optional progress[]); to copy a tree faithfully, read it with every field named in `fields` "
        "first, since get_tree answers with a projection — but a node carries `seedStatus`, never "
        "`status`: that one is your own mark, and travels in progress[]. The graft is ONE op; a "
        "carried progress[] is applied after it as ordinary overlay writes. The batch is atomic "
        "against malformed input — a bad field or a repeated id changes nothing and names the "
        "offending element — but never against a merely untidy result (a dangling edge lands and is "
        "reported in introducedDiagnostics). Upsert by id: an incoming id already present is "
        "overwritten (reported in nodeCollisions/kindCollisions), a new id is added; nothing is "
        "removed, and the tree's title is not touched. Pass dryRun to preview the collisions and "
        "change nothing. This collapses hundreds of create/connect calls into one.",
        p, {"treeId", "nodes"}));
  }
  {
    Json::Value p(Json::objectValue);
    p["treeId"] = treeHandle();
    tools.append(tool("prune",
        "Garbage-collect the roadmap: drop dangling and self edges (edges no valid DAG keeps) in one "
        "op, and clear the caller's progress rows for nodes no longer in the tree. Returns how many of "
        "each it removed.",
        p, {"treeId"}));
  }

  return tools;
}

}
