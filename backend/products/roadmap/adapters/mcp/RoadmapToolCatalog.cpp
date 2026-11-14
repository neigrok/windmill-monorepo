#include "products/roadmap/adapters/mcp/RoadmapToolCatalog.h"

#include "products/roadmap/adapters/mcp/ReadShape.h"

#include <set>
#include <string>
#include <utility>
#include <vector>

namespace wm {

namespace {

// Every connection is handed this catalogue before its first call, so it says only what a call cannot be formed
// without (README, What the catalogue says). A description is written where a name, a type and an enum do not say what
// to send; a limit where the server does not refuse past it in a sentence naming it.
Json::Value typed(const char* type, const char* description = nullptr) {
  Json::Value schema(Json::objectValue);
  schema["type"] = type;
  if (description) schema["description"] = description;
  return schema;
}

template <typename Names>
Json::Value oneOf(const Names& legal, const char* description = nullptr) {
  Json::Value schema = typed("string", description);
  for (const auto& name : legal) schema["enum"].append(name);
  return schema;
}

Json::Value listOf(Json::Value item, const char* description = nullptr) {
  Json::Value schema = typed("array", description);
  schema["items"] = std::move(item);
  return schema;
}

// An object that takes the keys it declares and no other: CompositeToolHost enforces that, so a misnamed key is
// named, not dropped.
Json::Value object(Json::Value properties, const std::vector<const char*>& required) {
  Json::Value schema = typed("object");
  schema["properties"] = std::move(properties);
  schema["required"] = Json::Value(Json::arrayValue);
  for (const char* field : required) schema["required"].append(field);
  schema["additionalProperties"] = false;
  return schema;
}

// The parameters more than one tool takes. Each is built here, so it reads the same wherever it appears.

// `id` where `nodeId` is the published spelling. It stays declared because every tool refuses an undeclared key.
Json::Value deprecatedNodeHandle() {
  Json::Value schema = typed("string");
  schema["deprecated"] = true;
  return schema;
}

Json::Value kind() { return typed("string", "A legend kind's id, standing for the hue that kind wears."); }

Json::Value icon() { return typed("string", "An icon name or an emoji; \"\" for none."); }

Json::Value opens() { return typed("string", "The id of a tree you own for this node to open; \"\" for none."); }

Json::Value prerequisites() {
  return listOf(typed("string"), "Ids of the nodes that must be complete before this one unlocks.");
}

Json::Value links() {
  Json::Value link(Json::objectValue);
  link["url"] = typed("string");
  link["label"] = typed("string");
  return listOf(object(link, {"url"}));
}

Json::Value branches() {
  return listOf(typed("string"), "Ids of the subtrees you mean to hide along with the steps that own them.");
}

// The tree revision a write is made against, as every read and receipt answers it.
Json::Value expectedSeq() {
  return typed("integer", "The `seq` you last read; the call is refused when the tree has moved past it.");
}

// One progress mark as a call sends it: an update_nodes row and an import's `progress` row carry the same two, read
// by one parse.
Json::Value status() {
  return oneOf(kStatuses, "Your own mark. A node that opens a tree takes none: it is complete when that tree is.");
}

Json::Value outOfOrder() {
  return typed("boolean", "True to say this completion comes before the node's prerequisites on purpose.");
}

// A legend as a call sends it, whole to create_tree and joined by an import.
Json::Value legendKinds() {
  Json::Value entry(Json::objectValue);
  entry["id"] = typed("string");
  entry["hue"] = oneOf(kHues);
  entry["label"] = typed("string");
  entry["description"] = typed("string");
  return listOf(object(entry, {"id", "hue"}));
}

template <typename Field>
Json::Value fields(const Vocabulary<Field>& vocabulary) {
  return listOf(oneOf(vocabulary.names()),
                "The fields to return. A field not asked for is left out, whatever it holds.");
}

Json::Value limit() {
  Json::Value schema = typed("integer");
  schema["default"] = kDefaultLimit;
  return schema;
}

Json::Value cursor() { return typed("string", "The `nextCursor` of the page before."); }

// What update_nodes and change_edges both answer; each adds its own keys.
Json::Value batchReceipt() {
  Json::Value properties(Json::objectValue);
  properties["treeId"] = typed("string");
  properties["seq"] = typed("integer");
  for (const char* flag : {"applied", "dryRun", "unchanged", "saved", "diagnosticsClean"})
    properties[flag] = typed("boolean");
  properties["saveError"] = typed("string");
  properties["introducedDiagnostics"] = listOf(typed("string"));
  return object(properties, {"treeId", "seq", "applied", "dryRun"});
}

// The two facts the wire annotations need that the grant level does not carry (ToolHost.h derives
// the rest). A destructive write removes wholesale under a write grant: import_subgraph tombstones
// nodes and, under "replace", drops the edges a node's list does not name. update_nodes and
// change_edges are the everyday edits and are not destructive: the op log keeps what they overwrite,
// a removed edge is re-added by naming it, and a client that stops to confirm each of them teaches
// people to click through the warning the delete-level tools need. An idempotent write is one a
// resend with the same arguments leaves unchanged; create_tree and create_node mint an id, so a
// resend plants a second one.
const std::set<std::string> kDestructiveWrites = {"import_subgraph"};
const std::set<std::string> kIdempotentWrites = {
    "delete_tree", "update_tree", "delete_node", "add_kind", "remove_kind", "update_kind", "import_subgraph",
    "change_edges"};

// `read` answers questions, `write` changes the document, and `delete` destroys something a
// person authored. `delete` is never implied by `write`: a connection without that level does
// not see those tools in tools/list.
ToolDeclaration tool(const char* name, Access access, const char* description, Json::Value properties,
                     const std::vector<const char*>& required) {
  Json::Value descriptor(Json::objectValue);
  descriptor["name"] = name;
  descriptor["description"] = description;
  descriptor["inputSchema"] = object(std::move(properties), required);
  ToolDeclaration declaration{std::move(descriptor), kRoadmapProduct, access};
  declaration.destructiveWrite = kDestructiveWrites.count(name) > 0;
  declaration.idempotent = kIdempotentWrites.count(name) > 0;
  return declaration;
}

// Every tool but the two that work the registry names the tree it works on.
ToolDeclaration treeTool(const char* name, Access access, const char* description, Json::Value properties,
                         std::vector<const char*> required) {
  properties["treeId"] = typed("string");
  required.insert(required.begin(), "treeId");
  return tool(name, access, description, std::move(properties), required);
}

}

std::vector<ToolDeclaration> roadmapToolCatalog() {
  std::vector<ToolDeclaration> tools;

  {
    Json::Value p(Json::objectValue);
    p["nodeIds"] = listOf(typed("string"));
    p["fields"] = fields(nodeVocabulary());
    ToolDeclaration declaration = treeTool("get_nodes", Access::read,
        "Read nodes by exact id, in the order asked. Use it when you know the ids; get_tree pages the whole roadmap "
        "and find_nodes searches it.",
        p, {"nodeIds"});
    Json::Value answered(Json::objectValue);
    answered["treeId"] = typed("string");
    answered["seq"] = typed("integer");
    answered["nodes"] = listOf(typed("object"));
    answered["missingNodeIds"] = listOf(typed("string"));
    declaration.descriptor["outputSchema"] = object(answered, {"treeId", "seq", "nodes", "missingNodeIds"});
    tools.push_back(std::move(declaration));
  }
  {
    Json::Value row(Json::objectValue);
    row["nodeId"] = typed("string");
    row["label"] = typed("string");
    row["icon"] = icon();
    row["description"] = typed("string");
    row["appendDescription"] = typed("string", "Text added after a blank line.");
    row["color"] = oneOf(kHues);
    row["kind"] = kind();
    row["links"] = links();
    row["addLinks"] = links();
    row["opens"] = opens();
    row["status"] = status();
    row["outOfOrder"] = outOfOrder();
    Json::Value p(Json::objectValue);
    p["updates"] = listOf(object(row, {"nodeId"}));
    p["expectedSeq"] = expectedSeq();
    p["dryRun"] = typed("boolean");
    ToolDeclaration declaration = treeTool("update_nodes", Access::write,
        "Edit existing nodes and set your own progress marks on them, many rows in one call. A field sent replaces "
        "what the node holds and a field left out stays; `appendDescription` and `addLinks` add to it instead.",
        p, {"updates"});

    // One object for both rows, a recorded mark and a refused one, rather than a oneOf that not every client reads.
    Json::Value mark(Json::objectValue);
    mark["nodeId"] = typed("string");
    mark["status"] = oneOf(kStatuses);
    for (const char* flag : {"prerequisitesMet", "acknowledged", "unchanged"}) mark[flag] = typed("boolean");
    mark["refused"] = typed("string");
    Json::Value receipt = batchReceipt();
    Json::Value& answered = receipt["properties"];
    answered["pointerDiagnosticsUnavailable"] = typed("boolean");
    answered["progress"] = listOf(object(mark, {"nodeId"}));
    answered["progressRefused"] = listOf(typed("string"));
    answered["progressApplied"] = typed("boolean");
    answered["progressError"] = typed("string");
    for (const char* partition : {"changedNodeIds", "unchangedNodeIds"}) {
      answered[partition] = listOf(typed("string"));
      receipt["required"].append(partition);
    }
    declaration.descriptor["outputSchema"] = receipt;
    tools.push_back(std::move(declaration));
  }
  {
    Json::Value edge(Json::objectValue);
    edge["from"] = typed("string");
    edge["to"] = typed("string");
    const Json::Value edges = listOf(object(edge, {"from", "to"}));
    Json::Value p(Json::objectValue);
    p["add"] = edges;
    p["remove"] = edges;
    p["expectedSeq"] = expectedSeq();
    p["dryRun"] = typed("boolean");
    ToolDeclaration declaration = treeTool("change_edges", Access::write,
        "Add and remove prerequisite edges between existing nodes in one step: an edge runs `from` a prerequisite `to` "
        "the node it unlocks. To move an edge, remove the old one and add the new one in the same call.",
        p, {});

    Json::Value receipt = batchReceipt();
    for (const char* changed : {"addedEdges", "removedEdges"}) {
      receipt["properties"][changed] = edges;
      receipt["required"].append(changed);
    }
    receipt["properties"]["unchangedEdges"] = typed("integer");
    receipt["required"].append("unchangedEdges");
    declaration.descriptor["outputSchema"] = receipt;
    tools.push_back(std::move(declaration));
  }
  {
    Json::Value p(Json::objectValue);
    p["title"] = typed("string");
    p["kinds"] = legendKinds();
    tools.push_back(tool("create_tree", Access::write,
        "Create an empty roadmap that you own. Send `kinds` to plant your own legend in place of the default one.",
        p, {}));
  }
  {
    tools.push_back(tool("list_trees", Access::read,
        "List the roadmaps you own, most recently active first, each with the id the other tools take as `treeId`.",
        Json::Value(Json::objectValue), {}));
  }
  {
    tools.push_back(treeTool("delete_tree", Access::del,
        "Delete a roadmap you own, every subtree under it, and the steps of your other roadmaps that open it. This "
        "cannot be undone.",
        Json::Value(Json::objectValue), {}));
  }
  {
    Json::Value p(Json::objectValue);
    p["fields"] = fields(nodeVocabulary());
    p["kindFields"] = listOf(oneOf(kindVocabulary().names()));
    p["includeEdges"] = typed("boolean");
    p["includeGuides"] = typed("boolean");
    p["limit"] = limit();
    p["cursor"] = cursor();
    tools.push_back(treeTool("get_tree", Access::read,
        "Read a roadmap: its title, guides, legend and a page of its nodes, with the `seq` it stands at. Call it "
        "before editing to learn node ids, and read the guides before working the tree.",
        p, {}));
  }
  {
    Json::Value p(Json::objectValue);
    p["title"] = typed("string");
    p["guide"] = typed("string", "The whole guide, replacing the one the roadmap has; \"\" clears it.");
    tools.push_back(treeTool("update_tree", Access::write,
        "Rename a roadmap with `title`, set its guide with `guide`, or both. The guide is a plain-text note on what "
        "the roadmap is and how to work it, shown to everyone who reads it.",
        p, {}));
  }
  {
    Json::Value p(Json::objectValue);
    p["includePointers"] = typed(
        "boolean", "On a roadmap you own, also report loops and dead ends among the trees its nodes open.");
    tools.push_back(treeTool("get_diagnostics", Access::read,
        "Report what is wrong with a roadmap's graph: cycles, dangling edges, self-edges and smells. Edits that break "
        "the graph are accepted, so read this after structural edits and repair what it lists.",
        p, {}));
  }
  {
    Json::Value p(Json::objectValue);
    p["fields"] = fields(progressVocabulary());
    tools.push_back(treeTool("get_progress", Access::read,
        "Read your own progress on a roadmap: the ids of the nodes you have completed. For progress beside each node, "
        "ask get_tree or find_nodes for the `status` or `state` field.",
        p, {}));
  }
  {
    Json::Value p(Json::objectValue);
    p["color"] = oneOf(kHues);
    p["kind"] = kind();
    p["query"] = typed("string", "Text to find in a node's id, label or description, in any case.");
    p["state"] = oneOf(kNodeStates);
    p["fields"] = fields(nodeVocabulary());
    p["limit"] = limit();
    p["cursor"] = cursor();
    tools.push_back(treeTool("find_nodes", Access::read,
        "Search a roadmap's nodes by hue, kind, state or text, best match first; every filter set must match. "
        "`state: \"available\"` answers what you can work on now. Use it to find nodes without reading the whole "
        "roadmap.",
        p, {}));
  }
  {
    Json::Value p(Json::objectValue);
    p["id"] = typed("string", "The id to give the node; made from the label when left out.");
    p["label"] = typed("string");
    p["icon"] = icon();
    p["color"] = oneOf(kHues);
    p["kind"] = kind();
    p["prerequisites"] = prerequisites();
    p["parentId"] = typed("string", "One prerequisite, added to `prerequisites`.");
    p["description"] = typed("string");
    p["links"] = links();
    p["opens"] = opens();
    tools.push_back(treeTool("create_node", Access::write,
        "Add one node to a roadmap. Name a `kind` or `color` when the legend has no terracotta kind. For many nodes, "
        "or nodes with edges among them, import_subgraph does it in one call.",
        p, {"label"}));
  }
  {
    Json::Value p(Json::objectValue);
    p["nodeId"] = typed("string");
    p["id"] = deprecatedNodeHandle();
    p["nodeIds"] = listOf(typed("string"));
    p["prune"] = typed("boolean", "Also remove every edge that touches a deleted node.");
    p["branches"] = branches();
    tools.push_back(treeTool("delete_node", Access::del,
        "Delete one node with `nodeId` or several with `nodeIds`; your marks on them are cleared. Edges that touch "
        "them stay, dangling, unless `prune` is true, and a step that owns a subtree hides that subtree with it.",
        p, {}));
  }
  {
    Json::Value p(Json::objectValue);
    p["id"] = typed("string");
    p["hue"] = oneOf(kHues);
    p["label"] = typed("string");
    p["description"] = typed("string");
    tools.push_back(treeTool("add_kind", Access::write,
        "Add a kind to a roadmap's legend: a named hue that nodes are filed under. update_kind changes one later.",
        p, {"id", "hue"}));
  }
  {
    Json::Value p(Json::objectValue);
    p["id"] = typed("string");
    p["kindId"] = typed("string", "Alias of `id`.");
    tools.push_back(treeTool("remove_kind", Access::del,
        "Remove a kind from a roadmap's legend, once no node wears its hue.",
        p, {"id"}));
  }
  {
    Json::Value p(Json::objectValue);
    p["id"] = typed("string");
    p["label"] = typed("string");
    p["description"] = typed("string");
    p["hue"] = oneOf(kHues);
    tools.push_back(treeTool("update_kind", Access::write,
        "Change a legend kind's label, description or hue. A new hue repaints every node that wears the old one.",
        p, {"id"}));
  }
  {
    Json::Value node(Json::objectValue);
    node["id"] = typed("string");
    node["label"] = typed("string");
    node["icon"] = icon();
    node["color"] = oneOf(kHues);
    node["kind"] = kind();
    node["order"] = typed("string", "The sibling order key get_tree returns.");
    node["prerequisites"] = prerequisites();
    node["seedStatus"] = oneOf(
        kStatuses, "The baseline every reader sees before their own marks; your own marks go in `progress`.");
    node["description"] = typed("string");
    node["links"] = links();
    node["opens"] = opens();
    Json::Value mark(Json::objectValue);
    mark["nodeId"] = typed("string");
    mark["id"] = deprecatedNodeHandle();
    mark["status"] = status();
    mark["outOfOrder"] = outOfOrder();
    Json::Value p(Json::objectValue);
    p["nodes"] = listOf(
        object(node, {"id"}),
        "Nodes as get_tree returns them; a new one names a `kind` or `color` when the legend has no terracotta kind.");
    p["kinds"] = legendKinds();
    p["progress"] = listOf(object(mark, {"nodeId", "status"}));
    p["prerequisiteMode"] = oneOf(
        kPrerequisiteModes,
        "merge, the default, adds the prerequisites sent to the ones a node has; replace removes the ones not sent.");
    p["tombstone"] = listOf(
        typed("string"), "Ids of nodes to delete in this call, with every edge that touches them and your marks on them.");
    p["branches"] = branches();
    p["expectedSeq"] = expectedSeq();
    p["dryRun"] = typed("boolean");
    tools.push_back(treeTool("import_subgraph", Access::write,
        "Create or update many nodes, their prerequisite edges and legend kinds in one step, matched by id. A field "
        "sent replaces what the roadmap holds and a field left out keeps it; only `tombstone` and `prerequisiteMode` "
        "\"replace\" remove anything.",
        p, {"nodes"}));
  }

  return tools;
}

}
