#include "products/roadmap/adapters/mcp/RoadmapTools.h"

#include "products/roadmap/adapters/json/CommandJson.h"
#include "products/roadmap/adapters/json/TreeJson.h"
#include "products/roadmap/adapters/mcp/EditReceipt.h"
#include "products/roadmap/adapters/mcp/ReadShape.h"
#include "products/roadmap/adapters/mcp/ToolArgs.h"
#include "products/roadmap/application/TreeRoom.h"
#include "platform/domain/Access.h"
#include "products/roadmap/domain/Command.h"
#include "products/roadmap/domain/NodeQuery.h"
#include "products/roadmap/domain/SkillTree.h"
#include "products/roadmap/domain/TreeHealth.h"

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

// The two published vocabularies, shared by the schemas that advertise them and the checks that
// refuse against them — a legal set stated in one place cannot drift from the one enforced.
const std::vector<const char*> kHues = {"terracotta", "olive", "gold", "brick", "sky", "plum"};
const std::vector<const char*> kStatuses = {"active", "complete", "none"};

// `status` used to name an imported node's authored baseline, and now names the caller's own
// mark everywhere else on this surface. A node that carried one where the other was meant would
// publish a private mark into the document (or lose it) without a word, so the older spelling is
// refused by name rather than guessed at — exactly as create_node refuses `nodeId`.
constexpr char kSeedStatusMoved[] =
    ".status is your own mark on this surface, not the document's — the authored baseline every "
    "reader sees is \"seedStatus\", and your own progress goes in \"progress\": [{nodeId, status}].";

// The two refusals that are about who you are rather than what you sent, so they say what to do
// next instead of naming an argument — and they are two, not one, because the truths differ.
// A tree SOMEONE ELSE owns is in that account's list_trees, so naming that tool is a real
// remedy. A tree NOBODY owns — the seeded demo, a legacy row nothing mints any more — is in no
// account's list at all (listOwnedBy keys on owner_id), so pointing at list_trees would send the
// caller looking for something that cannot be there. The honest sentence says the tree has no
// owner, and names the path that does exist: read it, and copy it into a roadmap of your own.
constexpr char kNotYours[] = "this tree belongs to another account. Call list_trees to see the "
                             "roadmaps you own.";
constexpr char kNobodysTree[] = "no account owns this tree, so it cannot be edited. You can still "
                                "read it with get_tree, and copy it into a roadmap of your own "
                                "with create_tree then import_subgraph.";

// Which of the two a refused write has earned. The gate is canWrite either way; this only picks
// the sentence, so the two can never drift into naming the same case.
const char* writeRefusal(const std::optional<UserId>& owner) {
  if (!owner) return kNobodysTree;
  return kNotYours;
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

// The tools whose subject is a node that ALREADY exists — the ones that take `nodeId` (and still
// read the legacy `id`). create_node is not among them: the id it takes is one it proposes.
bool namesAnExistingNode(const std::string& tool) {
  return tool == "annotate_node" || tool == "rename_node" || tool == "set_node_color" ||
         tool == "move_node" || tool == "delete_node";
}

// …and the same question for a legend kind. add_kind is not among them, for the same reason
// create_node is not among the node tools.
bool namesAnExistingKind(const std::string& tool) {
  return tool == "rename_kind" || tool == "describe_kind" || tool == "remove_kind" ||
         tool == "recolor_kind";
}

// A node's free annotation, wherever it is authored: create_node, annotate_node, an import's
// nodes[]. `prefix` is blank at the top level and "nodes[3]." inside a list.
std::optional<std::string> checkAnnotation(const Json::Value& node, const std::string& prefix) {
  if (std::optional<std::string> bad =
          optionalString(node["description"], prefix + "description", kMaxNodeDescriptionLength))
    return bad;
  return optionalLinks(node["links"], prefix + "links");
}

// One incoming node of an import. The graft path does not run the domain's validate(), so the
// caps every other authoring tool obeys are checked right here or not at all.
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
  if (node["position"].isObject()) {  // read its leaves only once it IS an object, never on trust
    if (std::optional<std::string> bad = optionalNumber(node["position"]["x"], path + ".position.x"))
      return bad;
    if (std::optional<std::string> bad = optionalNumber(node["position"]["y"], path + ".position.y"))
      return bad;
  }
  return checkAnnotation(node, path + ".");
}

// What each edit tool requires of its arguments — the one place that contract is written down —
// and where the node handle is normalized: `nodeId` and the legacy `id` both land on
// payload["id"], the key commandFromJson reads. Checked BEFORE that decode, because
// commandFromJson answers a bare yes/no on purpose: it is also the op-log replay decoder
// (adapters/postgres/PgOpLog) and must stay one there. The domain's validate() remains the
// authority on what is admitted; this is the authority on what the caller is told.
std::optional<std::string> prepareEdit(const std::string& tool, Json::Value& payload) {
  // These checks read a null as "not given"; commandFromJson reads presence with isMember. Left
  // to disagree, `links: null` reaches AnnotateNode as "replace the set with []" and DESTROYS a
  // node's links, and `x: null, y: null` reaches CreateNode as the position (0, 0) — a client
  // that serialises unset optionals as null would stack its whole tree on the origin. Erasing
  // the nulls once, here, makes the payload say what this layer already believes it says.
  for (const std::string& key : payload.getMemberNames())
    if (payload[key].isNull()) payload.removeMember(key);

  // Read through the const overload: jsoncpp's mutable operator[] CREATES the member it probes,
  // and a create_node that merely asked whether "x" was present would grow a position of {0,0}.
  const Json::Value& args = payload;

  if (namesAnExistingNode(tool)) {
    std::string node;
    if (std::optional<std::string> bad = requireHandle(args, kNodeHandle, "", node)) return bad;
    payload["id"] = node;  // the one write: both spellings land on the key commandFromJson reads
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
  if (tool == "connect" || tool == "disconnect") {
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

// Every room-touching tool holds the tree's strand, opens the room, and turns a "no such tree" into
// a tool-level error. An absent tree is a nullptr answered here; an infrastructure failure is left
// to throw past this, up to callTool, which logs the detail and answers a generic sentence — so a
// pqxx message never rides out on `error.what()` the way it once did.
template <typename Fn>
ToolResult withRoom(RoomRegistry& registry, const TreeId& tree, Fn&& fn) {
  std::lock_guard<std::mutex> lock(registry.strandFor(tree));
  TreeRoom* room = registry.open(tree);
  if (!room) return ToolResult::failure("no such tree \"" + tree.str() + "\"");
  return fn(*room);
}

// The caller's own progress rows, read ONCE per tree read and only when `status` was asked for:
// the overlay is the same set for every node on the page, and an anonymous caller has no marks to
// look up. Every node then answers `status`, marked or not.
Progress marksFor(ProgressService& progress, const TreeId& tree, const std::optional<UserId>& caller,
                  const NodeFields& fields) {
  if (!fields.count(NodeField::status) || !caller) return Progress{};
  return progress.progressOf(tree, *caller);
}

ToolResult readTree(RoomRegistry& registry, ProgressService& progress, const TreeId& tree,
                    const Json::Value& args, const std::optional<UserId>& caller) {
  return withRoom(registry, tree, [&](TreeRoom& room) -> ToolResult {
    // Byte-identical to the absent message (withRoom answers a null open the same) — a private
    // tree must be indistinguishable from one that does not exist, or the id is an oracle.
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

    const Progress marks = marksFor(progress, tree, caller, *nodeFields);
    Json::Value nodes(Json::arrayValue);
    for (std::size_t i = page->begin; i < page->end; ++i)
      nodes.append(projectNode(data.nodes[i], *nodeFields, marks));
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
    // Byte-identical to the absent message (withRoom answers a null open the same) — a private
    // tree must be indistinguishable from one that does not exist, or the id is an oracle.
    if (!canRead(caller, room.owner(), room.visibility())) return ToolResult::failure("no such tree \"" + tree.str() + "\"");
    return ToolResult::json(toJson(room.diagnose()));
  });
}

ToolResult readHealth(RoomRegistry& registry, const TreeId& tree, const std::optional<UserId>& caller) {
  return withRoom(registry, tree, [&](TreeRoom& room) -> ToolResult {
    // Byte-identical to the absent message (withRoom answers a null open the same) — a private
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
    // Byte-identical to the absent message (withRoom answers a null open the same) — a private
    // tree must be indistinguishable from one that does not exist, or the id is an oracle.
    if (!canRead(caller, room.owner(), room.visibility())) return ToolResult::failure("no such tree \"" + tree.str() + "\"");
    if (std::optional<std::string> bad = optionalOneOf(args["color"], "color", kHues))
      return ToolResult::failure(*bad);
    if (std::optional<std::string> bad = optionalString(args["kind"], "kind", kMaxIdLength))
      return ToolResult::failure(*bad);
    if (std::optional<std::string> bad = optionalString(args["query"], "query"))
      return ToolResult::failure(*bad);

    NodeFilter filter;
    if (args["color"].isString()) filter.color = parseColor(args["color"].asString());
    if (args["kind"].isString() && !args["kind"].asString().empty())
      filter.kind = KindId{args["kind"].asString()};
    filter.query = args.get("query", "").asString();

    std::string error;
    std::optional<NodeFields> fields = nodeVocabulary().parse(args["fields"], "fields", kFindNodesFields, error);
    if (!fields) return ToolResult::failure(error);

    const std::vector<NodeSpec> matches = selectNodes(room.snapshot(), filter);
    std::optional<Page> page = pageOf(matches, args, error);
    if (!page) return ToolResult::failure(error);

    const Progress marks = marksFor(progress, tree, caller, *fields);
    Json::Value nodes(Json::arrayValue);
    for (std::size_t i = page->begin; i < page->end; ++i)
      nodes.append(projectNode(matches[i], *fields, marks));
    Json::Value out(Json::objectValue);
    out["count"] = static_cast<Json::UInt64>(matches.size());  // everything that matched, not this page
    out["nodes"] = nodes;
    if (!page->nextCursor.empty()) out["nextCursor"] = page->nextCursor;
    return ToolResult::json(out);
  });
}

ToolResult applyEdit(RoomRegistry& registry, const TreeId& tree, const std::string& tool,
                     Json::Value payload, Clock& clock, const UserId& actor) {
  const std::string kind = *commandKindFor(tool);  // the caller reached here by resolving it
  if (std::optional<std::string> bad = prepareEdit(tool, payload)) return ToolResult::failure(*bad);

  return withRoom(registry, tree, [&](TreeRoom& room) -> ToolResult {
    // The read gate comes first, and answers exactly as an absent tree does: "belongs to another
    // account" on a private tree the caller cannot read would confirm the id names something.
    // Then the write gate, which admits the owner alone — an unowned tree is nobody's to edit.
    if (!canRead(actor, room.owner(), room.visibility()))
      return ToolResult::failure("no such tree \"" + tree.str() + "\"");
    if (!canWrite(actor, room.owner())) return ToolResult::failure(writeRefusal(room.owner()));
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

    // Bracketing the write under the strand is what makes the receipt attributable: whatever the
    // tree gains between these two reads, this command gained it.
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

// The shared write path for both set_progress and an import's carried progress. Under the
// strand it rejects (or, for a best-effort import, drops) unknown node ids, reads each node's
// prerequisites, and mints one clock stamp per mark; then applies the batch order-safe (§9)
// and echoes each mark to the caller's live sessions. Fills `results` with a row per applied
// mark; returns a failure message only when an unknown id is rejected.
std::optional<std::string> applyProgressBatch(
    RoomRegistry& registry, ProgressService& progress, PresenceBus& bus, const TreeId& tree,
    Clock& clock, const UserId& user, const std::vector<std::pair<NodeId, ProgressStatus>>& requested,
    bool rejectUnknown, Json::Value& results, Json::Value& skipped) {
  // Both out-params are set at entry, so an early return (absent/private-denied) still leaves them
  // as empty arrays — a caller that reads them without checking the return (import) sees [], not null.
  results = Json::Value(Json::arrayValue);
  skipped = Json::Value(Json::arrayValue);  // ids naming no node in the tree; the caller decides what to do with them
  std::vector<ProgressMark> marks;
  {
    std::lock_guard<std::mutex> lock(registry.strandFor(tree));
    TreeRoom* room = registry.open(tree);
    // Progress is a per-user overlay, not an edit — so it isn't owner-gated — but marking a
    // node against someone else's PRIVATE tree would confirm which node ids exist (and their
    // prerequisite shape). Deny it exactly as an absent tree does: private ⇒ owner-only. Both the
    // absent and the private-denied case leave as a returned error (not a throw), so the caller's
    // catch is left to mean only a genuine infrastructure failure.
    if (!room || !canRead(user, room->owner(), room->visibility()))
      return "no such tree \"" + tree.str() + "\"";  // byte-identical to every other absent/denied message
    for (const auto& [node, status] : requested) {
      if (!room->hasNode(node)) { skipped.append(node.str()); continue; }
      marks.push_back({node, status, room->prerequisitesOf(node), room->nextStamp(clock.nowMs())});
    }
    // set_progress rejects an unknown id outright (a mark that names nothing is a caller mistake);
    // an import's carried progress skips it and reports it in `skipped` instead, because the graft
    // has already landed and a dangling reference is dirt to surface, not a reason to refuse.
    if (rejectUnknown && !skipped.empty()) {
      std::string names;
      for (const Json::Value& id : skipped) { if (!names.empty()) names += ", "; names += id.asString(); }
      return "no node in this tree is named " + names +
             ". Call get_tree with fields [\"id\",\"label\"] to list the ids this tree has.";
    }
  }

  std::vector<ProgressOutcome> outcomes = progress.setStatuses(tree, user, marks);
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
  // Two shapes, one tool: a single mark or a batch. Both boundary cases are answered here,
  // before either shape is read, because both messages have to name both routes.
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

  // applyProgressBatch answers an absent/private-denied tree with a returned error string, so what
  // is left to throw is only an infrastructure failure — left to reach callTool, which logs the
  // detail and answers generically, rather than caught and echoed back on error.what().
  Json::Value results, skipped;  // set_progress rejects unknowns, so on success `skipped` stays empty
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

// Every item of an import, checked before treeFromJson reads it. The decoder indexes each item as
// an object, so a JSON-encoded string in nodes[] used to throw out of the whole request and
// return a bare transport error naming nothing.
std::optional<std::string> checkImport(const Json::Value& args) {
  // `nodes` stays required — the schema has always said so — but the refusal names the escape,
  // because a legend-only or progress-only import is a real thing to want.
  if (args["nodes"].isNull())
    return "missing required argument \"nodes\". Pass \"nodes\": [] to import only kinds or progress.";
  // Two incoming rows under one id is malformed, not an upsert: an upsert overwrites a TREE node
  // (reported in nodeCollisions), but two definitions of the same id WITHIN one batch are ambiguous
  // — which wins is order-dependent and invisible. So it's named and refused up front, before a
  // byte is written, naming both the offender and the earlier row it repeats.
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

  // A preview is a promise not to write, so the flag that asks for one is a boolean and nothing
  // else: accepting "yes" (and treating every string but "true" as go-ahead) turned a request to
  // change nothing into a real import.
  if (!args["dryRun"].isNull() && !args["dryRun"].isBool())
    return "argument \"dryRun\" must be a boolean, got " + typeName(args["dryRun"]);
  return std::nullopt;
}

// The legend's two invariants, checked against the legend the import WOULD leave behind. The
// graft path never runs the domain's validate(), and a duplicate hue is not merely wrong but
// unrepairable once it lands: remove_kind refuses any kind whose hue nodes still wear, so the
// only cure was deleting the tree.
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

  TreeData incoming = treeFromJson(args, tree);  // the get_tree shape: nodes[], kinds[]
  // `seedStatus` is this surface's name for the document's authored baseline — the codec still
  // reads the older `status`, so the published spelling is folded over it here, by id.
  std::map<std::string, std::string> seeds;
  for (const Json::Value& node : args["nodes"])
    if (node["seedStatus"].isString()) seeds[node["id"].asString()] = node["seedStatus"].asString();
  for (NodeSpec& node : incoming.nodes) {
    auto seed = seeds.find(node.id.str());
    if (seed != seeds.end()) node.status = seed->second;
  }
  const bool dryRun = args["dryRun"].asBool();

  ToolResult grafted = withRoom(registry, tree, [&](TreeRoom& room) -> ToolResult {
    // A read gate before the write gate, and for its own reason: a dry run answers with a
    // collision list, which would leak this tree's node and kind ids to a non-reader before the
    // ownership refusal ever ran. Then canWrite — an unowned tree grafts nothing.
    if (!canRead(actor, room.owner(), room.visibility()))
      return ToolResult::failure("no such tree \"" + tree.str() + "\"");
    if (!canWrite(actor, room.owner())) return ToolResult::failure(writeRefusal(room.owner()));

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

    Json::Value out(Json::objectValue);
    out["nodes"] = static_cast<int>(incoming.nodes.size());
    out["kinds"] = static_cast<int>(incoming.kinds.size());
    out["nodeCollisions"] = nodeCollisions;
    out["kindCollisions"] = kindCollisions;
    out["newNodes"] = static_cast<int>(incoming.nodes.size()) - nodeCollisions.size();
    out["newKinds"] = static_cast<int>(incoming.kinds.size()) - kindCollisions.size();
    if (dryRun) {  // report what would collide, change nothing (§7 dry-run)
      out["dryRun"] = true;
      // A faithful preview says which carried progress rows won't land: those naming no node the
      // graft would leave behind (present now, or arriving in this batch). Same set the real run
      // reports in progressSkipped, computed here before anything is written.
      if (args["progress"].isArray()) {
        std::set<std::string> afterGraft = presentNodes;
        for (const NodeSpec& n : incoming.nodes) afterGraft.insert(n.id.str());
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
    Seq seq = room.importTree(incoming, clock.nowMs(), actor);
    registry.persist(tree);
    out["imported"] = true;
    out["seq"] = static_cast<Json::Int64>(seq);
    answerDiagnostics(before, room.diagnose(), out);
    return ToolResult::json(out);
  });
  if (grafted.isError || dryRun || !(args.isMember("progress") && args["progress"].isArray()))
    return grafted;

  std::vector<std::pair<NodeId, ProgressStatus>> requested;  // carried progress, applied over the imported nodes
  for (const Json::Value& u : args["progress"]) {  // shape already checked; both handle spellings read
    const Json::Value& handle =
        u[kNodeHandle.published].isNull() ? u[kNodeHandle.alias] : u[kNodeHandle.published];
    requested.emplace_back(NodeId{handle.asString()}, *parseProgressStatus(u["status"].asString()));
  }
  if (!requested.empty()) {
    // The graft has already committed. A throw from the progress overlay here — the progress store
    // or the bus failing under it (a concurrent delete now returns a null open, not a throw) — must
    // not escape to callTool's generic catch, which would answer "nothing was changed": false, the
    // graft landed. Keep the graft's own receipt honest by catching it; the overlay is best-effort.
    try {
      Json::Value results, skipped;
      applyProgressBatch(registry, progress, bus, tree, clock, actor, requested, false, results, skipped);
      grafted.payload["progress"] = results;
      if (!skipped.empty()) grafted.payload["progressSkipped"] = skipped;  // named, not silently swallowed
    } catch (const std::exception&) { /* the graft stands; the carried progress simply didn't land */ }
    return ToolResult::json(grafted.payload);
  }
  return grafted;
}

ToolResult pruneTree(RoomRegistry& registry, ProgressService& progress, const TreeId& tree,
                     Clock& clock, const UserId& actor) {
  ToolResult cleaned = withRoom(registry, tree, [&](TreeRoom& room) -> ToolResult {
    // The read gate first, byte-identical to absent — then the write gate. See applyEdit.
    if (!canRead(actor, room.owner(), room.visibility()))
      return ToolResult::failure("no such tree \"" + tree.str() + "\"");
    if (!canWrite(actor, room.owner())) return ToolResult::failure(writeRefusal(room.owner()));

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
    answerDiagnostics(before, room.diagnose(), out);  // a GC only ever removes: always empty
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
  if (outcome == TreeRegistry::Removal::notFound)
    return ToolResult::failure("no such tree \"" + tree.str() + "\"");
  if (outcome == TreeRegistry::Removal::notOwner)
    return ToolResult::failure(kNotYours);
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

// Every failure an agent reads names the tool it came from, and it is named exactly once: here,
// on whatever `dispatch` refused with. A message that arrives in a transcript without its tool is
// a message the agent has to guess the origin of. The catch is the same promise for a throw:
// jsoncpp raises on a type-confused read, and a malformed argument must fail its own call rather
// than the whole request — which is how a bad import item once died as a bare transport error.
ToolResult RoadmapTools::callTool(const std::string& name, const Json::Value& arguments, const UserId& caller) {
  try {
    ToolResult outcome = dispatch(name, arguments, caller);
    if (!outcome.isError) return outcome;
    return ToolResult::failure(name + ": " + outcome.content[0]["text"].asString());
  } catch (const std::bad_alloc&) {
    throw;  // not a tool failure: an exhausted process must die loudly, not answer politely
  } catch (const std::exception& error) {
    // The detail goes to the log, never into the model's context: what escapes a repository is a
    // connection string, a host, a role. stderr rather than LOG_ERROR because on the stdio
    // transport stdout IS the protocol channel (infra/mcp_main.cpp).
    std::cerr << "mcp tool " << name << " failed: " << error.what() << "\n";
    return ToolResult::failure(name + ": that call failed inside the server. Nothing was changed; "
                               "the detail is in the server log.");
  }
}

ToolResult RoadmapTools::dispatch(const std::string& name, const Json::Value& arguments, const UserId& caller) {
  // The outermost shape: everything below reads `arguments` by key, and jsoncpp throws rather
  // than answers when a key is asked of something that is not an object.
  if (!arguments.isObject())
    return ToolResult::failure("arguments must be a JSON object of this tool's named arguments, got " +
                               typeName(arguments));

  if (name == "create_tree") {
    if (std::optional<std::string> bad = optionalString(arguments["title"], "title"))
      return ToolResult::failure(*bad);
    return createTree(treeRegistry_, caller, arguments.get("title", "").asString());  // no treeId
  }
  if (name == "list_trees") return listRegistry(treeRegistry_, caller);  // registry-wide: no treeId

  if (arguments["treeId"].isNull() ||
      (arguments["treeId"].isString() && arguments["treeId"].asString().empty()))
    return ToolResult::failure("missing required argument \"treeId\". Call list_trees to see the "
                               "roadmaps you own and their ids.");
  if (std::optional<std::string> bad =
          requireString(arguments["treeId"], "treeId", Empty::rejected, kMaxIdLength))
    return ToolResult::failure(*bad);
  TreeId tree{arguments["treeId"].asString()};

  // The MCP caller is an authenticated account (an OAuth token's user over HTTP, the
  // configured user over stdio); an empty id reads as anonymous for the read gate.
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

  if (commandKindFor(name)) return applyEdit(registry_, tree, name, arguments, clock_, caller);

  return ToolResult::failure("no such tool on this server — call tools/list for the whole surface.");
}

}
