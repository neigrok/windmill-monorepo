#include "products/roadmap/adapters/mcp/RoadmapTools.h"
#include "platform/application/WriteObservation.h"

#include "products/roadmap/adapters/json/CommandJson.h"
#include "products/roadmap/adapters/json/TreeJson.h"
#include "products/roadmap/adapters/mcp/EditReceipt.h"
#include "products/roadmap/adapters/mcp/ReadShape.h"
#include "products/roadmap/adapters/mcp/RoadmapToolCatalog.h"
#include "products/roadmap/adapters/mcp/ToolArgs.h"
#include "products/roadmap/application/TreeRoom.h"
#include "products/roadmap/domain/Access.h"
#include "products/roadmap/domain/Command.h"
#include "products/roadmap/domain/Guides.h"
#include "products/roadmap/domain/LooseGraph.h"
#include "products/roadmap/domain/NodeQuery.h"
#include "products/roadmap/domain/OpenedTrees.h"
#include "products/roadmap/domain/SkillTree.h"
#include "products/roadmap/domain/TreeHealth.h"
#include "products/roadmap/domain/UnlockRules.h"
#include "products/roadmap/domain/WebAddress.h"

#include <algorithm>
#include <cctype>
#include <chrono>
#include <iostream>
#include <map>
#include <mutex>
#include <optional>
#include <set>
#include <stdexcept>
#include <string>
#include <utility>
#include <variant>
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

// A refused `kind` completes under the code of its reason, so a caller naming a kind the legend lacks
// is told apart from a malformed call; the code never carries the kind it named.
ToolResult kindRefused(const KindRefusal& refusal) {
  switch (refusal.reason) {
    case KindRefusal::Reason::unknownKind: return ToolResult::failure(refusal.sentence, "kind-unknown");
    case KindRefusal::Reason::hueMismatch: return ToolResult::failure(refusal.sentence, "kind-hue-mismatch");
  }
  return ToolResult::failure(refusal.sentence);
}

// A minted id is the server's own choice, so it is held under kMaxIdLength with room for the
// "-N" a collision appends — a long label never refuses its own node by way of the id.
constexpr std::size_t kMaxSlugLength = kMaxIdLength - 8;

std::string slugify(const std::string& label) {
  std::string out;
  bool dash = false;
  for (unsigned char c : label) {
    if (out.size() == kMaxSlugLength) break;
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

// `prefix` is blank at the top level and "nodes[3]." inside a list. A node's label, icon and
// description are typed here and capped by the domain — validate() for a command, admit() for a
// graft — whose one sentence names every field over its cap and, for an append, the body the node
// would hold.
std::optional<std::string> checkAnnotation(const Json::Value& node, const std::string& prefix) {
  if (std::optional<std::string> bad = optionalString(node["description"], prefix + "description"))
    return bad;
  return optionalLinks(node["links"], prefix + "links");
}

// A legend kind id a node write files the node under; which kinds exist is the room's to say.
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

// Each register an imported node or kind may leave out, by its name on this surface: a node's
// `seedStatus` is the document's `status`.
constexpr std::pair<const char*, NodeRegister> kImportedNodeRegisters[] = {
    {"label", NodeRegister::label},       {"icon", NodeRegister::icon},
    {"color", NodeRegister::color},       {"order", NodeRegister::order},
    {"position", NodeRegister::position}, {"seedStatus", NodeRegister::status},
    {"description", NodeRegister::description}, {"links", NodeRegister::links},
    {"opens", NodeRegister::opens}};
constexpr std::pair<const char*, KindRegister> kImportedKindRegisters[] = {
    {"label", KindRegister::label},
    {"description", KindRegister::description},
    {"crossBranchExempt", KindRegister::crossBranchExempt}};

// `expectedSeq`, when a batch tool is sent one: a non-negative integer, the revision read from get_tree or get_nodes.
std::optional<std::string> checkExpectedSeq(const Json::Value& args) {
  if (args.isMember("expectedSeq") && (!args["expectedSeq"].isInt64() || args["expectedSeq"].asInt64() < 0))
    return "expectedSeq must be a non-negative integer from get_tree or get_nodes";
  return std::nullopt;
}

// A batch written against a revision the tree has moved past is refused whole, before anything is applied.
std::optional<std::string> staleExpectedSeq(const Json::Value& args, const TreeRoom& room) {
  if (!args.isMember("expectedSeq") || args["expectedSeq"].asInt64() == room.head()) return std::nullopt;
  return "expectedSeq conflict: requested " + args["expectedSeq"].asString() + ", current seq is " +
         std::to_string(room.head()) + ". Nothing changed; read get_nodes or get_tree and retry with the current seq.";
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
  if (!node["position"].isNull())
    if (std::optional<std::string> bad = requirePosition(node["position"], path)) return bad;
  if (std::optional<std::string> bad = optionalString(node["opens"], path + ".opens", kMaxIdLength)) return bad;
  return checkAnnotation(node, path + ".");
}

// A tree a call would make a node open, by the argument path that names it; an empty id opens none.
using OpenedTree = std::pair<std::string, TreeId>;

// Every tree a call would make a node open must stand and be the caller's, asked of the registry once
// for the whole call. One sentence serves a tree that is not there and a tree that is someone else's:
// a tree id is the read capability of an unlisted tree, so telling the two apart would say which ids exist.
// The refusal carries its own outcome code, so a write line tells a pointer at a tree that is not the
// caller's from a mistyped argument.
std::optional<ToolResult> checkOpenedTrees(TreeRegistry& trees, const UserId& caller,
                                           const std::vector<OpenedTree>& opened) {
  std::set<TreeId> targets;
  for (const auto& [path, target] : opened)
    if (!target.empty()) targets.insert(target);
  const std::map<TreeId, std::string> owned = trees.titlesOwnedBy(caller, targets);
  for (const auto& [path, target] : opened)
    if (!target.empty() && !owned.count(target))
      return ToolResult::failure(
          path + " names \"" + target.str() +
              "\", which is not a tree of yours — a node opens only a tree you own: list_trees lists them, "
              "and someone else's tree is copied into one of yours first, with create_tree then import_subgraph",
          "opens-not-yours");
  return std::nullopt;
}

bool opensATree(const std::vector<OpenedTree>& opened) {
  return std::any_of(opened.begin(), opened.end(), [](const OpenedTree& named) { return !named.second.empty(); });
}

// How long the follow an edit makes for its receipt may take. The edit is saved by then and its reply waits on
// nothing else, so past this the receipt goes out without the loops rather than hold a caller who would retry.
constexpr std::chrono::milliseconds kReceiptFollowBudget{750};

// What an edit that changed the tree a node opens takes from the room while it holds the strand: the graph's
// diagnostics before the edit and after it, and each node it made open a tree, or another tree.
struct PointerEdit {
  TreeDiagnostics before;
  TreeDiagnostics after;
  std::map<NodeId, TreeId> repointed;
};

// Nothing when the edit left every node opening the tree it opened: there is then no pointer to follow.
std::optional<PointerEdit> pointerEditOf(const TreeRoom& room, const std::map<NodeId, TreeId>& pointersBefore,
                                         const TreeDiagnostics& before, const TreeDiagnostics& after) {
  std::map<NodeId, TreeId> repointed = pointersSetSince(pointersBefore, room.pointers());
  if (repointed.empty()) return std::nullopt;
  return PointerEdit{before, after, std::move(repointed)};
}

// The receipt of such an edit, naming the loops of trees it closed. The edit has landed and the strand is released:
// one read follows the pointers it set, off the stored rows and within the receipt's budget. A read that runs past
// the budget is an expected refusal under load and one that fails is reported; either leaves the receipt the graph's
// diagnostics and a flag.
ToolResult withClosedLoops(TreeRegistry& trees, const UserId& actor, const TreeId& tree,
                           const std::optional<PointerEdit>& edit, const ToolResult& edited) {
  if (!edit) return edited;
  Json::Value receipt = edited.payload;
  WriteObservation observation{"roadmap.receipt.follow", "roadmap", "mcp"};
  try {
    const OpenedTrees followed(trees.openedFrom(actor, treesOpenedBy(edit->repointed), kReceiptFollowBudget));
    answerDiagnostics(edit->before, edit->after, receipt, followed.diagnose(tree, edit->repointed));
    observation.skip();
  } catch (const std::bad_alloc&) {
    throw;
  } catch (const FollowTimedOut&) {
    observation.finish("timeout");
    receipt["pointerDiagnosticsUnavailable"] = true;
  } catch (const std::exception& failure) {
    observation.fail(failure);
    receipt["pointerDiagnosticsUnavailable"] = true;
  }
  return ToolResult::json(receipt);
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
    if (std::optional<std::string> bad = requireString(args["label"], "label", Empty::rejected)) return bad;
    if (std::optional<std::string> bad = optionalString(args["id"], "id", kMaxIdLength)) return bad;
    if (std::optional<std::string> bad = optionalString(args["icon"], "icon")) return bad;
    if (std::optional<std::string> bad = optionalOneOf(args["color"], "color", kHues)) return bad;
    if (std::optional<std::string> bad = optionalKind(args["kind"], "kind")) return bad;
    if (std::optional<std::string> bad = optionalStrings(args["prerequisites"], "prerequisites", kMaxIdLength))
      return bad;
    if (std::optional<std::string> bad = optionalString(args["parentId"], "parentId", kMaxIdLength))
      return bad;
    if (std::optional<std::string> bad = optionalNumber(args["x"], "x")) return bad;
    if (std::optional<std::string> bad = optionalNumber(args["y"], "y")) return bad;
    if (args["x"].isNull() != args["y"].isNull())
      return "arguments \"x\" and \"y\" go together — a position needs both.";
    if (std::optional<std::string> bad = optionalString(args["opens"], "opens", kMaxIdLength)) return bad;
    // A created node opens the tree this call names and no other: the pointer is always written, so
    // an id a deleted node held brings none of that node's pointer back.
    if (args["opens"].isNull()) payload["opens"] = "";
    return checkAnnotation(args, "");
  }
  if (tool == "annotate_node") {
    if (args["description"].isNull() && args["appendDescription"].isNull() && args["icon"].isNull() &&
        args["links"].isNull() && args["addLinks"].isNull() && args["opens"].isNull())
      return "nothing to set — pass at least one of \"description\", \"appendDescription\", \"icon\", "
             "\"links\", \"addLinks\", \"opens\".";
    if (!args["description"].isNull() && !args["appendDescription"].isNull())
      return "\"description\" and \"appendDescription\" are both given — pass one: description "
             "replaces the body, appendDescription joins onto it.";
    if (!args["links"].isNull() && !args["addLinks"].isNull())
      return "\"links\" and \"addLinks\" are both given — pass one: links replaces the set, addLinks "
             "joins onto it.";
    if (args["addLinks"].isArray() && args["addLinks"].empty())
      return "addLinks, when sent, names at least one link — leave it out to keep the node's links as they are";
    if (std::optional<std::string> bad = optionalLinks(args["addLinks"], "addLinks")) return bad;
    if (std::optional<std::string> bad = optionalString(args["appendDescription"], "appendDescription"))
      return bad;
    if (std::optional<std::string> bad = optionalString(args["icon"], "icon")) return bad;
    if (std::optional<std::string> bad = optionalString(args["opens"], "opens", kMaxIdLength)) return bad;
    return checkAnnotation(args, "");
  }
  if (tool == "rename_node") return requireString(args["label"], "label", Empty::allowed);
  if (tool == "set_node_color") {
    if (args["color"].isNull() && args["kind"].isNull())
      return "missing required argument \"color\" or \"kind\" — the hue the node takes, or the legend kind "
             "whose hue it takes";
    if (std::optional<std::string> bad = optionalOneOf(args["color"], "color", kHues)) return bad;
    return optionalKind(args["kind"], "kind");
  }
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
    if (std::optional<std::string> bad = optionalString(args["description"], "description", kMaxKindDescriptionLength))
      return bad;
    return optionalBool(args["crossBranchExempt"], "crossBranchExempt");
  }
  if (tool == "rename_kind")
    return requireString(args["label"], "label", Empty::allowed, kMaxKindLabelLength);
  if (tool == "describe_kind") {
    if (args["description"].isNull() && args["crossBranchExempt"].isNull())
      return "nothing to set — pass \"description\", \"crossBranchExempt\", or both.";
    if (std::optional<std::string> bad =
            optionalString(args["description"], "description", kMaxKindDescriptionLength))
      return bad;
    return optionalBool(args["crossBranchExempt"], "crossBranchExempt");
  }
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

// The legend's hue -> kind id join: a node wears the kind its colour is the hue of, or none. The read
// field `kind` answers from it, and so does a colour-setting write that named no kind.
std::map<NodeColor, KindId> kindByHue(const std::vector<Kind>& kinds) {
  std::map<NodeColor, KindId> join;
  for (const Kind& kind : kinds) join[kind.hue] = kind.id;
  return join;
}

// What a read takes from the room while it holds the tree's strand; every repository read comes after it lets go.
struct RoomRead {
  TreeData data;
  Seq head = 0;
  std::optional<UserId> owner;
  bool guideInherited = false;
};

// Nothing for an absent tree and for one the caller may not read, which answer in the same words.
std::optional<RoomRead> readRoom(RoomRegistry& registry, const TreeId& tree, const std::optional<UserId>& caller) {
  std::lock_guard<std::mutex> lock(registry.strandFor(tree));
  TreeRoom* room = registry.open(tree);
  if (!room || !canRead(caller, room->owner(), room->visibility())) return std::nullopt;
  return RoomRead{room->snapshot(), room->head(), room->owner(), room->guideInherited()};
}

// The tree as the caller opens it on the web: in the app when it is theirs, on its share page otherwise.
WebTree webTreeOf(const std::string& origin, const RoomRead& read, const std::optional<UserId>& caller) {
  return WebTree{origin, read.data.id, canWrite(caller, read.owner) ? Opener::owner : Opener::reader};
}

// States are derived over the whole tree, as a prerequisite may sit off the page; only its writer has pointers followed.
NodeReadContext readContextFor(TreeRegistry& trees, ProgressService& progress, const std::string& origin,
                               const std::optional<UserId>& caller, const RoomRead& read, const NodeFields& fields,
                               bool filtersOnState) {
  const TreeData& data = read.data;
  const bool needsStates = fields.count(NodeField::state) || filtersOnState;
  const bool needsMarks = fields.count(NodeField::status) || needsStates;
  NodeReadContext context;
  if (needsMarks && caller) context.marks = progress.progressOf(data.id, *caller);
  if (fields.count(NodeField::kind)) context.kindByHue = kindByHue(data.kinds);
  if (fields.count(NodeField::url)) context.web = webTreeOf(origin, read, caller);
  const bool follows = (needsStates || fields.count(NodeField::opens)) && canWrite(caller, read.owner);
  if (!follows) {
    if (needsStates) context.states = UnlockRules::derive(data.nodes, context.marks);
    return context;
  }
  const OpenedTrees opened(trees.openedFrom(*caller, treesOpenedBy(data)));
  if (needsStates) context.states = UnlockRules::derive(data.nodes, opened.followed(data, context.marks));
  if (fields.count(NodeField::opens)) context.openings = opened.openings(data);
  return context;
}

// Every live edge, as {from, to}, in node order then prerequisite order; the snapshot's
// prerequisites are exactly the live edges (LooseGraph::liveEdges).
Json::Value edgeList(const TreeData& data) {
  Json::Value edges(Json::arrayValue);
  for (const NodeSpec& node : data.nodes) {
    for (const NodeId& prereq : node.prerequisites) {
      Json::Value edge(Json::objectValue);
      edge["from"] = prereq.str();
      edge["to"] = node.id.str();
      edges.append(edge);
    }
  }
  return edges;
}

std::size_t liveEdgeCount(const TreeData& data) {
  std::size_t count = 0;
  for (const NodeSpec& node : data.nodes) count += node.prerequisites.size();
  return count;
}

ToolResult readTree(RoomRegistry& registry, TreeRegistry& trees, ProgressService& progress, const std::string& origin,
                    const TreeId& tree, const Json::Value& args, const std::optional<UserId>& caller) {
  // Byte-identical to the absent message, or the id is an existence oracle.
  const std::optional<RoomRead> read = readRoom(registry, tree, caller);
  if (!read) return ToolResult::failure("no such tree \"" + tree.str() + "\"");

  std::string error;
  std::optional<NodeFields> nodeFields =
      nodeVocabulary().parse(args["fields"], "fields", kGetTreeFields, error);
  if (!nodeFields) return ToolResult::failure(error);
  std::optional<KindFields> kindFields =
      kindVocabulary().parse(args["kindFields"], "kindFields", kLegendFields, error);
  if (!kindFields) return ToolResult::failure(error);
  if (std::optional<std::string> bad = optionalBool(args["includeEdges"], "includeEdges"))
    return ToolResult::failure(*bad);
  if (std::optional<std::string> bad = optionalBool(args["includeGuides"], "includeGuides"))
    return ToolResult::failure(*bad);

  const TreeData& data = read->data;
  std::optional<Page> page = pageOf(data.nodes, args, error);
  if (!page) return ToolResult::failure(error);

  const NodeReadContext context = readContextFor(trees, progress, origin, caller, *read, *nodeFields, false);
  ProjectedPage projected = projectPage(data.nodes, *page, *nodeFields, context);
  Json::Value kinds(Json::arrayValue);
  for (const Kind& kind : data.kinds) kinds.append(projectKind(kind, *kindFields));

  // Whole on every page, and only here: `yours` says the caller owns the tree and wrote its current
  // guide — a guide a fork copied from someone else's tree is its author's words until its owner
  // writes their own.
  const bool mine = canWrite(caller, read->owner);
  const Guide own{data.id, data.title, data.guide, mine && !read->guideInherited};
  Json::Value guide(Json::objectValue);
  guide["text"] = own.text;
  guide["yours"] = own.yours;

  Json::Value document(Json::objectValue);
  document["id"] = data.id.str();
  document["title"] = data.title;
  document["url"] = treeAddress(webTreeOf(origin, *read, caller));
  document["guide"] = guide;
  // The first page alone adds the guides of the caller's trees above this one, unless the call asks for none; only
  // the tree's writer has them read. A walk that cannot be made is reported under its own name and leaves the
  // tree's own guide and a flag: the tree is still read.
  if (page->begin == 0 && (args["includeGuides"].isNull() || args["includeGuides"].asBool())) {
    std::map<TreeId, TreeAbove> above;
    if (mine) {
      WriteObservation observation{"roadmap.tree.guides", "roadmap", "mcp"};
      try {
        above = trees.guidedTreesAbove(*caller, data.id);
        observation.skip();
      } catch (const std::bad_alloc&) {
        throw;
      } catch (const std::exception& failure) {
        observation.fail(failure);
        document["guidesAboveUnavailable"] = true;
      }
    }
    document["guides"] = toJson(guidesFor(above, own));
  }
  document["nodes"] = std::move(projected.nodes);
  document["kinds"] = kinds;

  Json::Value out(Json::objectValue);
  out["seq"] = static_cast<Json::Int64>(read->head);
  out["count"] = static_cast<Json::UInt64>(data.nodes.size());  // the whole tree, not this page
  if (!projected.nextCursor.empty()) out["nextCursor"] = projected.nextCursor;
  if (projected.bytes) out["pageBytes"] = static_cast<Json::UInt64>(*projected.bytes);
  out["tree"] = document;
  // The edge list is whole or absent, never cut: past kMaxListedEdges the reply says so.
  if (args["includeEdges"].asBool()) {
    const std::size_t edgeCount = liveEdgeCount(data);
    if (edgeCount <= kMaxListedEdges) {
      out["edges"] = edgeList(data);
    } else {
      out["edgesOmitted"] = "this tree holds " + std::to_string(edgeCount) + " live edges, past the " +
                            std::to_string(kMaxListedEdges) + " one reply lists — page get_tree with "
                            "fields [\"id\", \"prerequisites\"] instead.";
    }
  }
  return ToolResult::json(out);
}

ToolResult readNodes(RoomRegistry& registry, TreeRegistry& trees, ProgressService& progress, const std::string& origin,
                     const TreeId& tree, const Json::Value& args, const std::optional<UserId>& caller) {
  const std::optional<RoomRead> read = readRoom(registry, tree, caller);
  if (!read) return ToolResult::failure("no such tree \"" + tree.str() + "\"");
  if (!args["nodeIds"].isArray() || args["nodeIds"].empty() || args["nodeIds"].size() > kMaxReadNodeIds)
    return ToolResult::failure("nodeIds must contain 1 to " + std::to_string(kMaxReadNodeIds) + " unique node ids");
  std::set<std::string> seen;
  for (Json::ArrayIndex i = 0; i < args["nodeIds"].size(); ++i) {
    const Json::Value& id = args["nodeIds"][i];
    if (std::optional<std::string> bad = requireString(id, "nodeIds[" + std::to_string(i) + "]", Empty::rejected, kMaxIdLength))
      return ToolResult::failure(*bad);
    if (!seen.insert(id.asString()).second)
      return ToolResult::failure("nodeIds repeats \"" + id.asString() + "\"");
  }
  std::string error;
  const std::optional<NodeFields> fields = nodeVocabulary().parse(args["fields"], "fields", kGetTreeFields, error);
  if (!fields) return ToolResult::failure(error);
  const NodeReadContext context = readContextFor(trees, progress, origin, caller, *read, *fields, false);
  std::map<NodeId, const NodeSpec*> byId;
  for (const NodeSpec& node : read->data.nodes) byId.emplace(node.id, &node);

  Json::Value out(Json::objectValue);
  out["treeId"] = tree.str();
  out["seq"] = static_cast<Json::Int64>(read->head);
  out["nodes"] = Json::Value(Json::arrayValue);
  out["missingNodeIds"] = Json::Value(Json::arrayValue);
  for (const Json::Value& id : args["nodeIds"]) {
    const auto node = byId.find(NodeId{id.asString()});
    if (node == byId.end()) out["missingNodeIds"].append(id);
    else out["nodes"].append(projectNode(*node->second, *fields, context));
  }
  ToolResult result = ToolResult::json(out);
  result.structured = out;
  Json::Value wire(Json::objectValue);
  wire["content"] = result.content;
  wire["structuredContent"] = result.structured;
  wire["isError"] = false;
  if (dump(wire).size() > kNodeBatchByteBudget)
    return ToolResult::failure("response exceeds the " + std::to_string(kNodeBatchByteBudget) +
        "-byte limit; retry with fewer nodeIds or fewer fields (summary instead of description). No nodes were omitted silently.");
  return result;
}

// The graph's diagnostics go to every reader. Its writer is also told the loops of trees through it and its pointers
// that lead nowhere, unless the call asks for neither: the pointers are followed in one read of the stored rows after
// the strand is released, and a read that fails is reported under its own name and leaves the graph's diagnostics
// and a flag.
ToolResult readDiagnostics(RoomRegistry& registry, TreeRegistry& trees, const TreeId& tree, const Json::Value& args,
                           const std::optional<UserId>& caller) {
  if (std::optional<std::string> bad = optionalBool(args["includePointers"], "includePointers"))
    return ToolResult::failure(*bad);
  const bool asked = args["includePointers"].isNull() || args["includePointers"].asBool();
  TreeDiagnostics graph;
  std::optional<std::map<NodeId, TreeId>> pointers;
  {
    std::lock_guard<std::mutex> lock(registry.strandFor(tree));
    TreeRoom* room = registry.open(tree);
    if (!room || !canRead(caller, room->owner(), room->visibility()))
      return ToolResult::failure("no such tree \"" + tree.str() + "\"");
    graph = room->diagnose();
    if (asked && canWrite(caller, room->owner())) pointers = room->pointers();
  }
  if (!pointers) return ToolResult::json(toJson(graph));

  WriteObservation observation{"roadmap.diagnostics.follow", "roadmap", "mcp"};
  try {
    const OpenedTrees opened(trees.openedFrom(*caller, treesOpenedBy(*pointers)));
    const ToolResult told = ToolResult::json(toJson(graph, opened.diagnose(tree, *pointers)));
    observation.skip();
    return told;
  } catch (const std::bad_alloc&) {
    throw;
  } catch (const std::exception& failure) {
    observation.fail(failure);
    Json::Value out = toJson(graph);
    out["pointerDiagnosticsUnavailable"] = true;
    return ToolResult::json(out);
  }
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
      out["crossBranchExempt"] = health.crossBranchExempt;
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

ToolResult findNodes(RoomRegistry& registry, TreeRegistry& trees, ProgressService& progress, const std::string& origin,
                     const TreeId& tree, const Json::Value& args, const std::optional<UserId>& caller) {
  const std::optional<RoomRead> read = readRoom(registry, tree, caller);
  if (!read) return ToolResult::failure("no such tree \"" + tree.str() + "\"");
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
  const NodeReadContext context = readContextFor(trees, progress, origin, caller, *read, *fields, state.has_value());
  std::vector<NodeSpec> matches = selectNodes(read->data, filter);
  if (state)
    std::erase_if(matches, [&](const NodeSpec& node) { return context.states.at(node.id) != *state; });
  std::optional<Page> page = pageOf(matches, args, error);
  if (!page) return ToolResult::failure(error);

  ProjectedPage projected = projectPage(matches, *page, *fields, context);
  Json::Value out(Json::objectValue);
  out["count"] = static_cast<Json::UInt64>(matches.size());  // everything that matched, not this page
  out["nodes"] = std::move(projected.nodes);
  if (!projected.nextCursor.empty()) out["nextCursor"] = projected.nextCursor;
  if (projected.bytes) out["pageBytes"] = static_cast<Json::UInt64>(*projected.bytes);
  return ToolResult::json(out);
}

ToolResult applyEdit(RoomRegistry& registry, TreeRegistry& trees, const TreeId& tree, const std::string& tool,
                     Json::Value payload, Clock& clock, const UserId& actor) {
  const std::string kind = *commandKindFor(tool);
  if (std::optional<std::string> bad = prepareEdit(tool, payload)) return ToolResult::failure(*bad);

  std::optional<PointerEdit> pointerEdit;
  const ToolResult edited = withRoom(registry, tree, [&](TreeRoom& room) -> ToolResult {
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

    // The domain refuses the same edit (validate's `present` gate); this is where the next move is
    // added to the sentence, the way delete_node's refusal carries it.
    if (namesAnExistingNode(tool) && !room.hasNode(NodeId{payload["id"].asString()}))
      return ToolResult::failure("no node in this tree is named \"" + payload["id"].asString() + "\"" +
                                 ". " + kNodeHandle.hint);

    // The links this write sends, judged against the ones the node holds: only the urls it brings are its word. A
    // node being created holds none, whatever a deleted node under its id held.
    if (payload.isMember("links") || payload.isMember("addLinks")) {
      const NodeId node{payload["id"].asString()};
      const auto links = payload.isMember("addLinks")
                             ? room.withLinksAdded(node, linksFromJson(payload["addLinks"]), "addLinks")
                             : tool == "create_node" ? shownLinks({}, linksFromJson(payload["links"]), "links")
                                                     : room.shownLinks(node, linksFromJson(payload["links"]), "links");
      if (const auto* refusal = std::get_if<std::string>(&links)) return ToolResult::failure(*refusal);
      payload["links"] = linksToJson(std::get<std::vector<Link>>(links));
    }

    const bool setsHue = tool == "create_node" || tool == "set_node_color";
    if (setsHue && payload.isMember("kind")) {
      HueChoice choice{parseColor(payload.get("color", "").asString()), KindId{payload["kind"].asString()}};
      // A node being created holds no colour that could be an echo beside its kind.
      const std::optional<NodeId> node =
          tool == "set_node_color" ? std::optional(NodeId{payload["id"].asString()}) : std::nullopt;
      const auto hue = room.resolveHue(choice, node, "");
      if (const auto* refusal = std::get_if<KindRefusal>(&hue)) return kindRefused(*refusal);
      payload["color"] = std::string(toString(*std::get<std::optional<NodeColor>>(hue)));
    }

    // Unreachable by construction: prepareEdit has already refused everything the decode can.
    std::optional<Command> command = commandFromJson(kind, payload);
    if (!command)
      return ToolResult::failure("the arguments passed every published check but no " + kind +
                                 " could be built from them — that is a server bug, please report it.");
    if (std::optional<std::string> reason = room.validate(*command)) return ToolResult::failure(*reason);
    std::vector<OpenedTree> opened;
    if (const CreateNode* created = std::get_if<CreateNode>(&*command); created && created->opens)
      opened.emplace_back("opens", *created->opens);
    if (const AnnotateNode* annotated = std::get_if<AnnotateNode>(&*command); annotated && annotated->opens)
      opened.emplace_back("opens", *annotated->opens);
    if (std::optional<ToolResult> refusal = checkOpenedTrees(trees, actor, opened)) return *refusal;

    // A single-node edit lands only the fields that differ from what the node holds; one that changes nothing writes
    // nothing — no seq, no op row, no frame, no save — and answers the head the tree stands at, and says so.
    const std::optional<Command> landed =
        namesAnExistingNode(tool) ? room.changedPart(NodeId{payload["id"].asString()}, *command) : command;

    // Bracketed under the strand, so whatever the tree gains between these reads, this gained.
    std::optional<std::map<NodeId, TreeId>> pointersBefore;
    if (landed && opensATree(opened)) pointersBefore = room.pointers();
    const TreeDiagnostics before = room.diagnose();
    Seq seq = room.head();
    if (landed) {
      seq = room.applyCommand(*landed, clock.nowMs(), actor);
      registry.persist(tree);  // flush the dirty rows so the web reader sees this edit
    }
    const TreeDiagnostics after = room.diagnose();
    if (pointersBefore) pointerEdit = pointerEditOf(room, *pointersBefore, before, after);

    Json::Value out(Json::objectValue);
    out["applied"] = true;
    out["seq"] = static_cast<Json::Int64>(seq);
    if (!landed) out["unchanged"] = true;
    answerDiagnostics(before, after, out);
    if (payload.isMember("id")) out["id"] = payload["id"];
    // A write that named its kind wears it, as resolveHue just said; one that named none is answered
    // from the hue join, for the hue its command landed.
    if (setsHue && payload.isMember("kind")) out["kind"] = payload["kind"];
    if (setsHue && !payload.isMember("kind")) {
      const NodeColor hue = std::holds_alternative<CreateNode>(*command) ? std::get<CreateNode>(*command).color
                                                                          : std::get<SetNodeColor>(*command).color;
      const std::map<NodeColor, KindId> worn = kindByHue(room.kinds());
      if (worn.count(hue)) out["kind"] = worn.at(hue).str();
    }
    return ToolResult::json(out);
  });
  return withClosedLoops(trees, actor, tree, pointerEdit, edited);
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

// One mark as the caller asked for it. `outOfOrder` is their word that completing the node before
// its prerequisites is meant; it lands on the row beside the status.
struct RequestedMark {
  NodeId node;
  ProgressStatus status;
  bool outOfOrder = false;
};

// The caller's marks a server write sets, landed by the one path every such write takes: set_progress, an import's
// progress rows, and the clears a delete, an import's tombstones and prune make. Each write comes stamped by the room's
// clock; where the caller's mark on that node holds a later stamp — a replica stamped it ahead of the server — it takes
// the stamp just after that one instead, so a later write always lands over it, and the room's clock does not learn it,
// so it carries no other write of the tree ahead. A node named twice is stamped after its own row. The marks go through
// ProgressService::mark with `pointers`, the nodes that open a tree as the room handed them to the caller: a mark on one
// that follows its tree is refused. The batch is written in one go, and the marks that landed go to the caller's open
// sessions in one progress frame.
ProgressReceipt landMarks(ProgressService& progress, PresenceBus& bus, const TreeId& tree, const UserId& user,
                          const std::map<NodeId, TreeId>& pointers, std::vector<ProgressWrite> writes, Clock& clock) {
  std::map<NodeId, Hlc> holds;
  for (const auto& [node, kept] : progress.progressOf(tree, user).marks) holds.emplace(node, kept.at);
  for (ProgressWrite& write : writes) {
    const auto held = holds.find(write.node);
    if (held != holds.end()) write.at = std::max(write.at, held->second.successor(write.at.actor));
    holds[write.node] = write.at;
  }
  const ProgressReceipt receipt = progress.mark(tree, pointers, user, writes, clock.nowMs());
  // One echo for the whole batch, not one frame per node.
  bus.broadcastProgress(tree, user, receipt.recorded);
  return receipt;
}

// A way the marks a write carries beside its tree edit fell short, said in the receipt's `progressError` after any
// said before it, the receipt answering progressApplied: false.
void fellShort(Json::Value& receipt, const std::string& sentence) {
  const std::string said = receipt.get("progressError", "").asString();
  receipt["progressApplied"] = false;
  receipt["progressError"] = said.empty() ? sentence : said + " " + sentence;
}

// What a batch of marks came to, as its tool answers it.
struct MarkedBatch {
  Json::Value results{Json::arrayValue};  // a row per mark that named a node, in the batch's order
  Json::Value skipped{Json::arrayValue};  // ids naming no node in the tree
  Json::Value refused{Json::arrayValue};  // ids of nodes that follow the tree they open and took no mark
  bool cameToARefusal = false;            // no mark was recorded and at least one was refused

  // The marks as a write that carries them beside its tree edit answers them — an import's `progress[]`, update_nodes'
  // marks: a row each in `progress`, and the ids skipped or refused listed, each said in `progressError`.
  void answerOnto(Json::Value& receipt) const {
    receipt["progress"] = results;
    if (!skipped.empty()) {
      receipt["progressSkipped"] = skipped;
      fellShort(receipt, "Some requested progress names nodes absent after the graft; those ids are listed in "
                         "progressSkipped.");
    }
    if (!refused.empty()) {
      receipt["progressRefused"] = refused;
      fellShort(receipt, "Some requested progress marks nodes that open a tree, which take no mark of their own — each "
                         "is complete when the tree it opens is; those ids are listed in progressRefused.");
    }
  }
};

// The sentence is the refusal of a call that could not be applied at all.
std::variant<MarkedBatch, std::string> applyProgressBatch(
    RoomRegistry& registry, ProgressService& progress, PresenceBus& bus, const TreeId& tree,
    Clock& clock, const UserId& user, const std::vector<RequestedMark>& requested, bool rejectUnknown) {
  MarkedBatch batch;
  std::vector<ProgressWrite> marks;
  std::map<NodeId, TreeId> pointers;
  {
    // The room is consulted under its strand and let go: the marks land, and the trees they may follow are read, once
    // it is released.
    std::lock_guard<std::mutex> lock(registry.strandFor(tree));
    TreeRoom* room = registry.open(tree);
    // Not owner-gated (a per-user overlay), but private stays owner-only: a mark would confirm which ids exist.
    if (!room || !canRead(user, room->owner(), room->visibility()))
      return "no such tree \"" + tree.str() + "\"";  // byte-identical to every other absent message
    for (const RequestedMark& mark : requested) {
      if (!room->hasNode(mark.node)) { batch.skipped.append(mark.node.str()); continue; }
      marks.push_back({mark.node, mark.status, room->prerequisitesOf(mark.node), room->nextStamp(clock.nowMs()),
                       mark.outOfOrder});
    }
    pointers = room->pointersFor(user);
  }
  // set_progress rejects an unknown id; an import skips it into `skipped`, its graft landed.
  if (rejectUnknown && !batch.skipped.empty()) {
    std::string names;
    for (const Json::Value& id : batch.skipped) { if (!names.empty()) names += ", "; names += id.asString(); }
    return "no node in this tree is named " + names +
           ". Call get_tree with fields [\"id\",\"label\"] to list the ids this tree has.";
  }

  const ProgressReceipt receipt = landMarks(progress, bus, tree, user, pointers, marks, clock);
  batch.cameToARefusal = receipt.cameToARefusal();
  for (std::size_t i = 0; i < marks.size(); ++i) {
    const ProgressOutcome& outcome = receipt.outcomes[i];
    Json::Value row(Json::objectValue);
    row["nodeId"] = marks[i].node.str();
    if (outcome.refused) {
      // Names the node and never the tree it opens: a tend, which is told of no pointer, reads this too.
      row["refused"] = "\"" + marks[i].node.str() + "\" opens a tree: it is complete when that tree is and takes "
                       "no mark of its own — mark the steps of the tree it opens";
      batch.refused.append(marks[i].node.str());
      batch.results.append(row);
      continue;
    }
    row["status"] = progressStatusName(outcome.status);
    row["prerequisitesMet"] = outcome.prerequisitesMet;
    // Only a mark that carried the word answers it: prerequisitesMet:false alone is an inversion
    // nobody acknowledged.
    if (outcome.outOfOrder) row["acknowledged"] = true;
    if (outcome.unchanged) row["unchanged"] = true;
    batch.results.append(row);
  }
  return batch;
}

// A kind's label, description and hue, any of them, as ONE op under one seq: a single command, or a Batch of them, so a
// replay lands what the call landed. What the kind already holds is left out, and a call that changes nothing writes
// nothing and answers the tree's head.
ToolResult updateKind(RoomRegistry& registry, const TreeId& tree, const Json::Value& args, Clock& clock,
                      const UserId& actor) {
  std::string kind;
  if (std::optional<std::string> bad = requireHandle(args, kKindHandle, "", kind)) return ToolResult::failure(*bad);
  if (std::optional<std::string> bad = optionalString(args["label"], "label", kMaxKindLabelLength))
    return ToolResult::failure(*bad);
  if (std::optional<std::string> bad = optionalString(args["description"], "description", kMaxKindDescriptionLength))
    return ToolResult::failure(*bad);
  if (std::optional<std::string> bad = optionalOneOf(args["hue"], "hue", kHues)) return ToolResult::failure(*bad);
  KindUpdate update{KindId{kind}};
  if (args["label"].isString()) update.label = args["label"].asString();
  if (args["description"].isString()) update.description = args["description"].asString();
  if (args["hue"].isString()) update.hue = parseColor(args["hue"].asString());

  return withRoom(registry, tree, [&](TreeRoom& room) -> ToolResult {
    if (!canRead(actor, room.owner(), room.visibility()))
      return ToolResult::failure("no such tree \"" + tree.str() + "\"");
    if (std::optional<WriteRefusal> refusal = writeRefusalFor(actor, room.owner()))
      return ToolResult::failure(writeRefusalSentence(*refusal));
    const std::variant<KindUpdatePlan, std::string> planned = room.planKindUpdate(update);
    if (const auto* refusal = std::get_if<std::string>(&planned)) return ToolResult::failure(*refusal);
    const KindUpdatePlan& plan = std::get<KindUpdatePlan>(planned);

    const TreeDiagnostics before = room.diagnose();
    Seq seq = room.head();
    if (!plan.landsNothing()) {
      seq = room.applyCommands(plan.commands, clock.nowMs(), actor);  // a lone command logs as itself
      registry.persist(tree);  // flush the dirty rows so the web reader sees this edit
    }
    Json::Value out(Json::objectValue);
    out["applied"] = true;
    out["seq"] = static_cast<Json::Int64>(seq);
    out["id"] = update.id.str();
    if (plan.landsNothing()) out["unchanged"] = true;
    if (plan.repaintedNodes) out["repaintedNodes"] = static_cast<Json::UInt64>(*plan.repaintedNodes);
    answerDiagnostics(before, room.diagnose(), out);
    return ToolResult::json(out);
  });
}

// The caller's own completion marks on the nodes a write removes, cleared to none through landMarks — stamped after the
// marks they clear, written in one batch, sent to the caller's open sessions — so a revive of the node brings none
// back; anyone else's marks stay theirs. A node that opens a tree goes with its mark as any other does, so no pointer is
// judged. Called under the tree's strand with its room open, as the write that removes the nodes is; answers how many
// clears landed. A delete, an import's tombstones and prune clear by this.
std::size_t clearMarksOn(ProgressService& progress, PresenceBus& bus, TreeRoom& room, const TreeId& tree,
                         const UserId& actor, const std::vector<NodeId>& removed, Clock& clock) {
  const Progress overlay = progress.progressOf(tree, actor);
  std::vector<ProgressWrite> clears;
  for (const NodeId& node : removed)
    if (overlay.completed.count(node))
      clears.push_back({node, ProgressStatus::none, room.prerequisitesOf(node), room.nextStamp(clock.nowMs()), false});
  if (clears.empty()) return 0;
  const ProgressReceipt receipt = landMarks(progress, bus, tree, actor, {}, clears, clock);
  return static_cast<std::size_t>(std::count_if(receipt.outcomes.begin(), receipt.outcomes.end(),
                                                [](const ProgressOutcome& outcome) { return outcome.applied; }));
}


// One progress row as a write sends it: `nodeId` (or the legacy `id`), `status`, and `outOfOrder`, a word about a
// completion that rides only a `complete` status. set_progress, single or bulk, and an import's progress rows read a
// row by this, so each takes the same checks; `path` names the row in a refusal ("" for set_progress's flat form).
std::variant<RequestedMark, std::string> readMark(const Json::Value& row, const std::string& path) {
  const std::string field = path.empty() ? "" : path + ".";
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

// patch_nodes, update_nodes and change_edges: a batch of rows planned against the room and landed as ONE op, or not at
// all. update_nodes is patch_nodes grown: its rows also append to a description or to the links, and carry the caller's
// own mark, which lands after the tree fields, as an import's progress lands after its graft, and asks only that the
// caller can read the tree; it moves no node.
ToolResult applyBatchEdit(RoomRegistry& registry, TreeRegistry& trees, ProgressService& progress, PresenceBus& bus,
                          const TreeId& tree, const std::string& name, const Json::Value& args, Clock& clock,
                          const UserId& actor) {
  if (std::optional<std::string> bad = optionalBool(args["dryRun"], "dryRun")) return ToolResult::failure(*bad);
  if (std::optional<std::string> bad = checkExpectedSeq(args)) return ToolResult::failure(*bad);

  const bool grown = name == "update_nodes";
  std::vector<NodePatch> patches;
  std::vector<NodeId> rows;           // every row's node, in input order
  std::vector<RequestedMark> marks;   // update_nodes' marks, in input order
  std::vector<OpenedTree> opened;
  EdgeChanges edges;
  if (name == "patch_nodes" || grown) {
    if (std::optional<std::string> bad = requireObjects(args["updates"], "updates", kMaxPatchNodes))
      return ToolResult::failure(*bad);
    const std::vector<const char*> texts = grown ? std::vector<const char*>{"label", "icon", "description", "appendDescription"}
                                                 : std::vector<const char*>{"label", "icon", "description"};
    const std::vector<const char*> treeFields = grown
        ? std::vector<const char*>{"label", "color", "kind", "description", "appendDescription", "icon", "links",
                                   "addLinks", "opens"}
        : std::vector<const char*>{"label", "color", "kind", "description", "icon", "position", "links", "opens"};
    std::set<std::string> named;
    for (Json::ArrayIndex i = 0; i < args["updates"].size(); ++i) {
      const Json::Value& row = args["updates"][i];
      const std::string path = "updates[" + std::to_string(i) + "]";
      if (std::optional<std::string> bad = requireString(row["nodeId"], path + ".nodeId", Empty::rejected, kMaxIdLength))
        return ToolResult::failure(*bad);
      // A mark-only row is planned by no patch, so update_nodes refuses a repeated node here, as the plan words it.
      if (grown && !named.insert(row["nodeId"].asString()).second)
        return ToolResult::failure("updates repeats nodeId " + quotedList({row["nodeId"].asString()}));
      for (const char* field : texts) {
        if (!row.isMember(field)) continue;
        if (std::optional<std::string> bad = requireString(row[field], path + "." + field, Empty::allowed))
          return ToolResult::failure(*bad);
      }
      if (grown && row.isMember("description") && row.isMember("appendDescription"))
        return ToolResult::failure(path + ": \"description\" and \"appendDescription\" are both given — pass one: "
                                   "description replaces the body, appendDescription joins onto it.");
      if (grown && row.isMember("links") && row.isMember("addLinks"))
        return ToolResult::failure(path + ": \"links\" and \"addLinks\" are both given — pass one: links replaces "
                                   "the set, addLinks joins onto it.");
      if (row.isMember("color"))
        if (std::optional<std::string> bad = requireOneOf(row["color"], path + ".color", kHues))
          return ToolResult::failure(*bad);
      if (std::optional<std::string> bad = optionalKind(row["kind"], path + ".kind")) return ToolResult::failure(*bad);
      if (!grown && row.isMember("position"))
        if (std::optional<std::string> bad = requirePosition(row["position"], path)) return ToolResult::failure(*bad);
      for (const char* field : {"links", "addLinks"}) {
        if (!row.isMember(field) || (!grown && std::string_view(field) == "addLinks")) continue;
        if (!row[field].isArray()) return ToolResult::failure(path + "." + field + " must be an array");
        if (std::optional<std::string> bad = optionalLinks(row[field], path + "." + field)) return ToolResult::failure(*bad);
      }
      if (grown && row["addLinks"].isArray() && row["addLinks"].empty())
        return ToolResult::failure(path + ".addLinks, when sent, names at least one link — leave it out to keep the "
                                   "node's links as they are");
      if (row.isMember("opens"))
        if (std::optional<std::string> bad = requireString(row["opens"], path + ".opens", Empty::allowed, kMaxIdLength))
          return ToolResult::failure(*bad);
      NodePatch patch;
      patch.nodeId = NodeId{row["nodeId"].asString()};
      if (row.isMember("label")) patch.label = row["label"].asString();
      if (row.isMember("icon")) patch.icon = row["icon"].asString();
      if (row.isMember("description")) patch.description = row["description"].asString();
      if (row.isMember("color")) patch.hue.color = parseColor(row["color"].asString());
      if (row["kind"].isString()) patch.hue.kind = KindId{row["kind"].asString()};
      if (!grown && row.isMember("position"))
        patch.position = Vec2{row["position"]["x"].asDouble(), row["position"]["y"].asDouble()};
      if (row.isMember("links")) patch.links = linksFromJson(row["links"]);
      if (grown && row.isMember("appendDescription")) patch.appendDescription = row["appendDescription"].asString();
      if (grown && row.isMember("addLinks")) patch.addLinks = linksFromJson(row["addLinks"]);
      if (row.isMember("opens")) {
        patch.opens = TreeId{row["opens"].asString()};
        opened.emplace_back(path + ".opens", *patch.opens);
      }
      // A field is sent when it holds a value: a null one is refused above where the field takes none, and is absent
      // where it may be left out (`kind`, `outOfOrder`), as its read takes it.
      bool carriesTree = false;
      for (const char* field : treeFields) carriesTree = carriesTree || !row[field].isNull();
      const bool carriesMark = grown && (!row["status"].isNull() || !row["outOfOrder"].isNull());
      if (carriesMark) {
        std::variant<RequestedMark, std::string> mark = readMark(row, path);
        if (const auto* bad = std::get_if<std::string>(&mark)) return ToolResult::failure(*bad);
        marks.push_back(std::get<RequestedMark>(std::move(mark)));
      }
      if (grown && !carriesTree && !carriesMark)
        return ToolResult::failure(path + " sets nothing — pass at least one of label, color, kind, description, "
                                   "appendDescription, icon, links, addLinks, opens, status.");
      rows.push_back(patch.nodeId);
      if (!grown || carriesTree) patches.push_back(std::move(patch));
    }
  } else {
    for (const char* field : {"add", "remove"}) {
      if (!args.isMember(field)) continue;
      if (std::optional<std::string> bad = requireObjects(args[field], field, kMaxChangeEdges))
        return ToolResult::failure(*bad);
      for (Json::ArrayIndex i = 0; i < args[field].size(); ++i) {
        const Json::Value& row = args[field][i];
        const std::string path = std::string(field) + "[" + std::to_string(i) + "]";
        for (const char* endpoint : {"from", "to"})
          if (std::optional<std::string> bad = requireString(row[endpoint], path + "." + endpoint, Empty::rejected, kMaxIdLength))
            return ToolResult::failure(*bad);
        Edge edge{NodeId{row["from"].asString()}, NodeId{row["to"].asString()}};
        if (std::string_view(field) == "add") edges.add.push_back(edge);
        else edges.remove.push_back(edge);
      }
    }
  }

  const bool dryRun = args["dryRun"].asBool();
  bool treeLanded = false;  // an op landed on the tree in this call
  std::optional<PointerEdit> pointerEdit;
  ToolResult edited = withRoom(registry, tree, [&](TreeRoom& room) -> ToolResult {
    if (!canRead(actor, room.owner(), room.visibility()))
      return ToolResult::failure("no such tree \"" + tree.str() + "\"");
    // Marks alone write the caller's own overlay, which reading the tree is enough for; every other field is the owner's.
    if (!grown || !patches.empty())
      if (std::optional<WriteRefusal> refusal = writeRefusalFor(actor, room.owner()))
        return ToolResult::failure(writeRefusalSentence(*refusal));
    if (std::optional<std::string> stale = staleExpectedSeq(args, room)) return ToolResult::failure(*stale);

    Batch batch;
    bool landsNothing = true;
    Json::Value out(Json::objectValue);
    out["treeId"] = tree.str();
    if (name != "change_edges") {
      std::set<NodeId> changed;
      // Rows that carry only marks plan no patch; every other batch is planned, an empty one included, so the planner
      // refuses it in its own words.
      if (!patches.empty() || rows.empty()) {
        const auto result = room.planNodePatches(patches);
        if (const auto* error = std::get_if<std::string>(&result)) return ToolResult::failure(*error);
        if (const auto* refusal = std::get_if<KindRefusal>(&result)) return kindRefused(*refusal);
        if (std::optional<ToolResult> refusal = checkOpenedTrees(trees, actor, opened)) return *refusal;
        const NodePatchPlan& plan = std::get<NodePatchPlan>(result);
        batch = plan.batch;
        landsNothing = plan.landsNothing();
        changed.insert(plan.changedNodeIds.begin(), plan.changedNodeIds.end());
      }
      // A mark names a node the tree holds, as set_progress's do; refused here, so a refused call lands nothing.
      std::vector<std::string> missing;
      for (const RequestedMark& mark : marks)
        if (!room.hasNode(mark.node)) missing.push_back(mark.node.str());
      if (!missing.empty())
        return ToolResult::failure("no node in this tree is named " + quotedList(missing) + ". " + kNodeHandle.hint);
      out["changedNodeIds"] = Json::Value(Json::arrayValue);
      out["unchangedNodeIds"] = Json::Value(Json::arrayValue);
      for (const NodeId& node : rows) out[changed.count(node) ? "changedNodeIds" : "unchangedNodeIds"].append(node.str());
    } else {
      const auto result = room.planEdgeChanges(edges);
      if (const auto* error = std::get_if<std::string>(&result)) return ToolResult::failure(*error);
      const EdgeChangePlan& plan = std::get<EdgeChangePlan>(result);
      batch = plan.batch;
      landsNothing = plan.landsNothing();
      out["addedEdges"] = Json::Value(Json::arrayValue);
      out["removedEdges"] = Json::Value(Json::arrayValue);
      for (const auto& [field, values] : {std::pair{"addedEdges", &plan.added}, {"removedEdges", &plan.removed}}) {
        for (const Edge& edge : *values) {
          Json::Value row(Json::objectValue);
          row["from"] = edge.from.str();
          row["to"] = edge.to.str();
          out[field].append(row);
        }
      }
      out["unchangedEdges"] = static_cast<Json::UInt64>(edges.add.size() + edges.remove.size() - plan.added.size() - plan.removed.size());
    }
    out["dryRun"] = dryRun;
    out["applied"] = !dryRun;
    out["seq"] = static_cast<Json::Int64>(room.head());
    if (landsNothing) out["unchanged"] = true;
    if (!dryRun) {
      // A batch that lands nothing writes nothing — no seq, no op row, no frame, no save — as a single-node edit does.
      std::optional<std::map<NodeId, TreeId>> pointersBefore;
      if (!landsNothing && opensATree(opened)) pointersBefore = room.pointers();
      const TreeDiagnostics before = room.diagnose();
      if (!landsNothing) {
        out["seq"] = static_cast<Json::Int64>(room.applyCommands(batch.commands, clock.nowMs(), actor));
        registry.persist(tree);  // flush the dirty rows so the web reader sees this edit
        treeLanded = true;
      }
      const TreeDiagnostics after = room.diagnose();
      if (pointersBefore) pointerEdit = pointerEditOf(room, *pointersBefore, before, after);
      answerDiagnostics(before, after, out);
    }
    return ToolResult::json(out);
  });
  edited = withClosedLoops(trees, actor, tree, pointerEdit, edited);
  // update_nodes' marks land after its tree fields, judged against the overlay as the whole call leaves it. A mark on a
  // node that follows the tree it opens is refused there, as set_progress refuses it.
  if (!edited.isError && !dryRun && !marks.empty()) {
    Json::Value receipt = edited.payload;
    bool cameToARefusal = false;
    const auto applyMarks = [&] { return applyProgressBatch(registry, progress, bus, tree, clock, actor, marks, true); };
    if (!treeLanded) {
      // No tree op landed, so the marks are the call: a refusal or a failure of theirs is the call's, as set_progress's
      // is, and a call that recorded no mark because each was refused on a node that opens a tree completes as
      // set_progress's batch does then.
      const std::variant<MarkedBatch, std::string> applied = applyMarks();
      if (const std::string* error = std::get_if<std::string>(&applied)) return ToolResult::failure(*error);
      const MarkedBatch& batch = std::get<MarkedBatch>(applied);
      batch.answerOnto(receipt);
      cameToARefusal = batch.cameToARefusal;
    } else {
      // A tree op has landed whatever becomes of the marks: a failure of theirs is told in the reply and reported under
      // its own name, at the call's door, not as the call's failure.
      WriteObservation marking{"roadmap.update_nodes.marks", "roadmap", currentWriteDoor()};
      try {
        const std::variant<MarkedBatch, std::string> applied = applyMarks();
        if (const std::string* error = std::get_if<std::string>(&applied))
          fellShort(receipt, "The marks did not apply: " + *error);
        else
          std::get<MarkedBatch>(applied).answerOnto(receipt);
        marking.skip();
      } catch (const std::bad_alloc&) {
        throw;
      } catch (const std::exception& error) {
        marking.fail(error);
        fellShort(receipt, "The marks' outcome is uncertain. Read get_progress before retrying progress changes.");
      }
    }
    edited = ToolResult::json(receipt);
    if (cameToARefusal) edited.outcomeCode = kOpensATree;
  }
  edited.structured = edited.payload;
  return edited;
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

  std::vector<RequestedMark> requested;
  if (bulk) {
    if (std::optional<std::string> bad = requireObjects(args["updates"], "updates", kMaxProgressUpdates))
      return ToolResult::failure(*bad);
    for (Json::ArrayIndex i = 0; i < args["updates"].size(); ++i) {
      std::variant<RequestedMark, std::string> mark = readMark(args["updates"][i], "updates[" + std::to_string(i) + "]");
      if (const auto* bad = std::get_if<std::string>(&mark)) return ToolResult::failure(*bad);
      requested.push_back(std::get<RequestedMark>(std::move(mark)));
    }
    if (requested.empty()) return ToolResult::failure("argument \"updates\" is an empty list — pass "
                                                      "at least one {nodeId, status} to mark.");
  } else {
    std::variant<RequestedMark, std::string> mark = readMark(args, "");
    if (const auto* bad = std::get_if<std::string>(&mark)) return ToolResult::failure(*bad);
    requested.push_back(std::get<RequestedMark>(std::move(mark)));
  }

  const std::variant<MarkedBatch, std::string> applied =
      applyProgressBatch(registry, progress, bus, tree, clock, user, requested, true);
  if (const std::string* error = std::get_if<std::string>(&applied)) return ToolResult::failure(*error);
  const MarkedBatch& batch = std::get<MarkedBatch>(applied);
  // A singular call answers its one mark flat, {nodeId, status, prerequisitesMet, acknowledged?, unchanged?}, or fails on
  // its refusal.
  if (!bulk && !batch.refused.empty()) return ToolResult::failure(batch.results[0]["refused"].asString(), kOpensATree);
  if (!bulk) return ToolResult::json(batch.results[0]);
  Json::Value out(Json::objectValue);
  out["results"] = batch.results;
  // A batch whose every mark the caller already held changed nothing, and says so as a patch batch does.
  bool unchanged = true;
  for (const Json::Value& row : batch.results) unchanged = unchanged && row.get("unchanged", false).asBool();
  if (unchanged) out["unchanged"] = true;
  ToolResult answered = ToolResult::json(out);
  if (batch.cameToARefusal) answered.outcomeCode = kOpensATree;
  return answered;
}

// A legend's kinds as a call sends them, checked item by item before treeFromJson reads them, an id once
// per list; `limit` caps the items when the list is the whole legend, 0 when it joins one.
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
    if (std::optional<std::string> bad = optionalBool(kinds[i]["crossBranchExempt"], path + ".crossBranchExempt"))
      return bad;
    const auto [seen, fresh] = kindIdAt.emplace(kinds[i]["id"].asString(), i);
    if (!fresh)
      return path + ".id \"" + seen->first + "\" is already used by kinds[" + std::to_string(seen->second) +
             "] — an id names one kind per batch";
  }
  return std::nullopt;
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

ToolResult importSubgraph(RoomRegistry& registry, TreeRegistry& trees, ProgressService& progress, PresenceBus& bus,
                          const TreeId& tree, const Json::Value& args, Clock& clock, const ToolCaller& caller) {
  if (std::optional<std::string> bad = checkImport(args)) return ToolResult::failure(*bad);
  // The marks the import carries, read as set_progress reads its rows; they land after the graft, on the tree it leaves.
  std::vector<RequestedMark> carried;
  for (Json::ArrayIndex i = 0; i < args["progress"].size(); ++i) {
    std::variant<RequestedMark, std::string> mark = readMark(args["progress"][i], "progress[" + std::to_string(i) + "]");
    if (const auto* bad = std::get_if<std::string>(&mark)) return ToolResult::failure(*bad);
    carried.push_back(std::get<RequestedMark>(std::move(mark)));
  }
  if (std::optional<std::string> bad = checkExpectedSeq(args)) return ToolResult::failure(*bad);
  // The tool is write-level, but a tombstone is what delete_node does, and `delete` is never implied
  // by `write`: refused before the tree is read, in the composite's own words.
  if (args["tombstone"].size() > 0 && !caller.scope.allows(kRoadmapProduct, Access::del))
    return ToolResult::failure(notGrantedSentence(kRoadmapProduct, Access::del));
  const UserId& actor = caller.user;

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
    if (seed != seeds.end()) node.status = normalizeSeedStatus(seed->second);
  }
  // A field the batch leaves off a node or a kind is not sent blank: the graft stamps that register
  // unset, so a node or kind the tree already holds keeps its value and a new one lands with the default.
  for (const Json::Value& node : args["nodes"]) {
    const NodeId id{node["id"].asString()};
    std::set<NodeRegister>& omitted = graft.omittedNodeRegisters[id];
    for (const auto& [field, held] : kImportedNodeRegisters)
      if (node[field].isNull()) omitted.insert(held);
    if (node["prerequisites"].isNull()) graft.omittedPrerequisites.insert(id);
    if (node["kind"].isString()) graft.nodeKinds[id] = KindId{node["kind"].asString()};
  }
  for (const Json::Value& kind : args["kinds"]) {
    std::set<KindRegister>& omitted = graft.omittedKindRegisters[KindId{kind["id"].asString()}];
    for (const auto& [field, held] : kImportedKindRegisters)
      if (kind[field].isNull()) omitted.insert(held);
  }
  const bool replace = args["prerequisiteMode"].asString() == "replace";
  graft.prerequisites = replace ? PrerequisiteMode::replace : PrerequisiteMode::merge;
  for (const Json::Value& id : args["tombstone"]) graft.tombstones.emplace_back(id.asString());
  const bool dryRun = args["dryRun"].asBool();

  std::optional<PointerEdit> pointerEdit;
  ToolResult grafted = withRoom(registry, tree, [&](TreeRoom& room) -> ToolResult {
    // Read gate before the write gate: a dry run's collision list would leak ids to a non-reader.
    if (!canRead(actor, room.owner(), room.visibility()))
      return ToolResult::failure("no such tree \"" + tree.str() + "\"");
    if (std::optional<WriteRefusal> refusal = writeRefusalFor(actor, room.owner()))
      return ToolResult::failure(writeRefusalSentence(*refusal));
    if (std::optional<std::string> stale = staleExpectedSeq(args, room)) return ToolResult::failure(*stale);

    // A tombstone must name a node that is there: every miss is named, and nothing is applied.
    std::vector<std::string> missing;
    for (const NodeId& id : graft.tombstones) if (!room.hasNode(id)) missing.push_back(id.str());
    if (!missing.empty())
      return ToolResult::failure("tombstone names " + quotedList(missing) +
                                 ", which this tree does not hold. " + kNodeHandle.hint);

    // The links each node sends, judged against the ones its record holds, before the caps weigh what would land.
    std::variant<Graft, std::string> shown = room.resolveLinks(std::move(graft));
    if (const auto* refusal = std::get_if<std::string>(&shown)) return ToolResult::failure(*refusal);
    graft = std::get<Graft>(std::move(shown));

    // A graft mints no Command, so the tree caps are checked here, before the dry-run branch.
    if (std::optional<Admission> refusal = room.admit(graft))
      return ToolResult::failure(refusal->reason);
    std::vector<OpenedTree> opened;
    for (std::size_t i = 0; i < graft.document.nodes.size(); ++i)
      opened.emplace_back("nodes[" + std::to_string(i) + "].opens", graft.document.nodes[i].opens);
    if (std::optional<ToolResult> refusal = checkOpenedTrees(trees, actor, opened)) return *refusal;

    const TreeData& incoming = graft.document;
    TreeData current = room.snapshot();  // collision = an incoming id already present (an upsert overwrites it)
    if (std::optional<std::string> bad = checkMergedLegend(current.kinds, incoming.kinds))
      return ToolResult::failure(*bad);
    std::variant<Graft, KindRefusal> filed = room.resolveKinds(graft);
    if (const auto* refusal = std::get_if<KindRefusal>(&filed)) return kindRefused(*refusal);
    graft = std::get<Graft>(std::move(filed));
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
    // A held kind the batch re-hues carries its nodes, as recolor_kind does; the receipt counts them.
    if (const Repaint repaint = room.repaintOf(graft); !repaint.rehued.empty())
      out["repaintedNodes"] = static_cast<Json::UInt64>(repaint.nodes.size());
    if (dryRun) {
      out["dryRun"] = true;
      if (room.graftLandsNothing(graft, clock.nowMs())) out["unchanged"] = true;
      Json::Value tombstone(Json::arrayValue);
      for (const NodeId& id : footprint.tombstonedNodes) tombstone.append(id.str());
      out["tombstone"] = tombstone;
      // Carried progress naming no node the graft would leave behind.
      if (!carried.empty()) {
        std::set<std::string> afterGraft = presentNodes;
        for (const NodeSpec& n : incoming.nodes) afterGraft.insert(n.id.str());
        for (const NodeId& id : footprint.tombstonedNodes) afterGraft.erase(id.str());
        Json::Value skipped(Json::arrayValue);
        for (const RequestedMark& mark : carried)
          if (!afterGraft.count(mark.node.str())) skipped.append(mark.node.str());
        if (!skipped.empty()) out["progressSkipped"] = skipped;
      }
      return ToolResult::json(out);
    }

    // A graft can dangle an edge per node it carries; the receipt says which of them are new.
    // A graft that lands nothing is not joined, so there is nothing to save and the head stays where it is.
    std::optional<std::map<NodeId, TreeId>> pointersBefore;
    if (opensATree(opened)) pointersBefore = room.pointers();
    const TreeDiagnostics before = room.diagnose();
    const std::optional<Seq> landed = room.importTree(graft, clock.nowMs(), actor);
    if (landed) registry.persist(tree);
    out["graphApplied"] = true;
    out["progressApplied"] = true;
    // The caller's marks on what the tombstones took are cleared after the graft, which has landed whatever becomes of
    // them: a clear that fails is told in the reply and reported under its own name, not as the call's failure.
    WriteObservation clearing{"roadmap.import.clear_marks", "roadmap", currentWriteDoor()};
    try {
      clearMarksOn(progress, bus, room, tree, actor, footprint.tombstonedNodes, clock);
      clearing.skip();
    } catch (const std::bad_alloc&) {
      throw;
    } catch (const std::exception& error) {
      clearing.fail(error);
      out["progressApplied"] = false;
      out["progressError"] = "The graph committed, but clearing progress on removed nodes failed. Read get_progress before retrying progress changes.";
    }
    out["imported"] = true;
    out["seq"] = static_cast<Json::Int64>(landed.value_or(room.head()));
    if (!landed) out["unchanged"] = true;
    const TreeDiagnostics after = room.diagnose();
    if (pointersBefore) pointerEdit = pointerEditOf(room, *pointersBefore, before, after);
    answerDiagnostics(before, after, out);
    return ToolResult::json(out);
  });
  grafted = withClosedLoops(trees, actor, tree, pointerEdit, grafted);
  if (grafted.isError || dryRun || carried.empty()) return grafted;
  // A graft that landed nothing beside marks that came to a refusal wrote nothing, and the write line says why.
  bool wroteNothingForARefusal = false;
  try {
    const std::variant<MarkedBatch, std::string> applied =
        applyProgressBatch(registry, progress, bus, tree, clock, actor, carried, false);
    if (const std::string* error = std::get_if<std::string>(&applied)) {
      fellShort(grafted.payload, "The graph committed, but the requested progress did not apply: " + *error);
      return ToolResult::json(grafted.payload);
    }
    const MarkedBatch& batch = std::get<MarkedBatch>(applied);
    wroteNothingForARefusal = batch.cameToARefusal && grafted.payload["unchanged"].asBool();
    batch.answerOnto(grafted.payload);
  } catch (const std::exception& error) {
    reportCurrentWriteFailure(error);
    fellShort(grafted.payload, "The graph committed, but the requested progress outcome is uncertain. Read get_progress "
                               "before retrying progress changes.");
  }
  ToolResult answered = ToolResult::json(grafted.payload);
  if (wroteNothingForARefusal) answered.outcomeCode = kOpensATree;
  return answered;
}

ToolResult pruneTree(RoomRegistry& registry, ProgressService& progress, PresenceBus& bus, const TreeId& tree,
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

    Seq seq = room.head();
    if (prunedEdges > 0) {
      seq = room.applyCommand(PruneDangling{}, clock.nowMs(), actor);
      registry.persist(tree);
    }
    const std::size_t cleared = clearMarksOn(progress, bus, room, tree, actor, orphans, clock);

    Json::Value out(Json::objectValue);
    out["prunedEdges"] = prunedEdges;
    out["prunedProgress"] = static_cast<int>(cleared);
    out["seq"] = static_cast<Json::Int64>(seq);
    answerDiagnostics(before, room.diagnose(), out);  // a GC only ever removes: always empty
    return ToolResult::json(out);
  });
  return cleaned;
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
ToolResult deleteNodes(RoomRegistry& registry, ProgressService& progress, PresenceBus& bus, const TreeId& tree,
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

    // The caller's own marks on what is going, cleared with or without prune and before the delete lands: a progress
    // store that fails then fails the call with nothing deleted, and a retry does the whole of it.
    const std::size_t cleared = clearMarksOn(progress, bus, room, tree, actor, targets, clock);
    const TreeDiagnostics before = room.diagnose();
    Seq seq = room.applyCommands(commands, clock.nowMs(), actor);
    registry.persist(tree);

    Json::Value ids(Json::arrayValue);
    for (const NodeId& node : targets) ids.append(node.str());
    Json::Value pruned(Json::objectValue);
    pruned["edges"] = static_cast<int>(dangled.size());
    pruned["progress"] = static_cast<int>(cleared);

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

    // Only a present edge becomes a RemoveEdge: a tombstone for an edge the lattice never held
    // would be a phantom entry, persisted, broadcast and fed for nothing.
    std::vector<Command> commands;
    for (const Edge& edge : targets)
      if (room.hasEdge(edge.from, edge.to)) commands.push_back(RemoveEdge{edge.from, edge.to});
    for (const Command& command : commands)
      if (std::optional<std::string> reason = room.validate(command)) return ToolResult::failure(*reason);

    const TreeDiagnostics before = room.diagnose();
    Seq seq = room.applyCommands(commands, clock.nowMs(), actor);  // an empty list leaves the head as is
    registry.persist(tree);

    Json::Value out(Json::objectValue);
    out["applied"] = true;
    out["seq"] = static_cast<Json::Int64>(seq);
    answerDiagnostics(before, room.diagnose(), out);
    out["removed"] = static_cast<int>(commands.size());
    return ToolResult::json(out);
  });
}

// A tree is born with the legend the call sends, whole and in its order, or with the default one when
// it sends none. The reply answers that legend from Legend::bornWith, the rule the registry plants by,
// in the shape get_tree answers kinds by default, and reads nothing back once the tree is inserted.
ToolResult createTree(TreeRegistry& trees, const std::string& origin, const UserId& caller, const Json::Value& args) {
  if (std::optional<std::string> bad = optionalString(args["title"], "title")) return ToolResult::failure(*bad);
  if (args["kinds"].isArray() && args["kinds"].empty())
    return ToolResult::failure("kinds, when sent, names at least one kind — leave it out for the default legend");
  if (std::optional<std::string> bad = checkKinds(args["kinds"], kMaxKinds)) return ToolResult::failure(*bad);
  const std::optional<TreeData> sent = treeFromJson(args, TreeId{});
  if (!sent) return ToolResult::failure("this tree's title or kinds carry a field of the wrong type");
  if (std::optional<std::string> bad = checkMergedLegend({}, sent->kinds)) return ToolResult::failure(*bad);

  TreeData initial;
  initial.title = sent->title;
  initial.kinds = sent->kinds;
  const TreeId created = trees.create(caller, initial);
  Json::Value out(Json::objectValue);
  out["treeId"] = created.str();
  out["url"] = treeAddress(WebTree{origin, created, Opener::owner});
  out["kinds"] = Json::Value(Json::arrayValue);
  for (const Kind& kind : Legend::bornWith(initial.kinds)) out["kinds"].append(projectKind(kind, kLegendFields));
  return ToolResult::json(out);
}

// Every row is a tree the caller owns, so each opens in the app.
ToolResult listRegistry(TreeRegistry& registry, const std::string& origin, const UserId& caller) {
  Json::Value trees(Json::arrayValue);
  for (const TreeSummary& summary : registry.list(caller)) {
    Json::Value row = toJson(summary);
    row["url"] = treeAddress(WebTree{origin, summary.id, Opener::owner});
    trees.append(row);
  }
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

// The guide is user content: a refusal names its bound and its type, never its text.
ToolResult updateTree(TreeRegistry& registry, const TreeId& tree, const Json::Value& args, const UserId& caller) {
  const Json::Value& title = args["title"];
  const Json::Value& guide = args["guide"];
  if (title.isNull() && guide.isNull())
    return ToolResult::failure("nothing to set — pass at least one of \"title\", \"guide\".");
  // A title is judged by rename's own rule (TreeRegistry::titleFrom), so the tool checks only that one is a string.
  if (!title.isNull() && !title.isString()) return ToolResult::failure(*requireString(title, "title"));
  if (!guide.isNull() && !guide.isString())
    return ToolResult::failure(*requireString(guide, "guide") + ". A guide is plain text of at most " +
                               std::to_string(kMaxGuideChars) + " characters; \"\" clears it.");
  if (std::optional<std::string> bad = optionalString(guide, "guide", kMaxGuideChars))
    return ToolResult::failure(*bad);

  TreeRegistry::Description sent;
  if (title.isString()) sent.title = title.asString();
  if (guide.isString()) sent.guide = guide.asString();
  const std::variant<TreeRegistry::Described, TreeRegistry::Renaming, Admission> outcome =
      registry.describe(tree, caller, sent);
  if (const Admission* refusal = std::get_if<Admission>(&outcome)) return ToolResult::failure(refusal->reason);
  if (const TreeRegistry::Renaming* refusal = std::get_if<TreeRegistry::Renaming>(&outcome)) {
    if (*refusal == TreeRegistry::Renaming::notYours)
      return ToolResult::failure(writeRefusalSentence(WriteRefusal::notYours));
    if (*refusal == TreeRegistry::Renaming::nobodysTree)
      return ToolResult::failure(writeRefusalSentence(WriteRefusal::nobodysTree));
    if (*refusal == TreeRegistry::Renaming::notFound) return ToolResult::failure("no such tree \"" + tree.str() + "\"");
    return ToolResult::failure(TreeRegistry::sentenceOf(*refusal));
  }
  const TreeRegistry::Described& described = std::get<TreeRegistry::Described>(outcome);
  Json::Value out(Json::objectValue);
  out["applied"] = true;
  out["seq"] = static_cast<Json::Int64>(described.seq);
  if (described.unchanged) out["unchanged"] = true;
  return ToolResult::json(out);
}

}  // namespace

RoadmapTools::RoadmapTools(RoomRegistry& registry, ProgressService& progress, Clock& clock,
                           TreeRegistry& treeRegistry, PresenceBus& bus, std::string appOrigin)
    : registry_(registry), progress_(progress), clock_(clock), treeRegistry_(treeRegistry), bus_(bus),
      appOrigin_(std::move(appOrigin)) {}

std::vector<ToolDeclaration> RoadmapTools::declareTools() const { return roadmapToolCatalog(); }

// Every failure names the tool it came from, exactly once.
ToolResult RoadmapTools::callTool(const std::string& name, const Json::Value& arguments,
                                  const ToolCaller& caller) {
  try {
    ToolResult outcome = dispatch(name, arguments, caller);
    if (!outcome.isError) return outcome;
    return ToolResult::failure(name + ": " + outcome.content[0]["text"].asString(), toolWriteOutcome(outcome));
  } catch (const std::bad_alloc&) {
    throw;  // not a tool failure: an exhausted process must die rather than answer
  } catch (const std::exception& error) {
    reportCurrentWriteFailure(error);
    return ToolResult::failure(name + ": that call failed inside the server. The outcome may be uncertain; "
                               "read the affected records before retrying. The detail is in the server log.");
  }
}

ToolResult RoadmapTools::dispatch(const std::string& name, const Json::Value& arguments, const ToolCaller& actor) {
  // jsoncpp throws when a key is asked of something that is not an object.
  if (!arguments.isObject())
    return ToolResult::failure("arguments must be a JSON object of this tool's named arguments, got " +
                               typeName(arguments));
  const UserId& caller = actor.user;

  if (name == "create_tree") return createTree(treeRegistry_, appOrigin_, caller, arguments);
  if (name == "list_trees") return listRegistry(treeRegistry_, appOrigin_, caller);

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
  if (name == "update_tree") return updateTree(treeRegistry_, tree, arguments, caller);
  if (name == "get_tree")        return readTree(registry_, treeRegistry_, progress_, appOrigin_, tree, arguments, reader);
  if (name == "get_nodes")       return readNodes(registry_, treeRegistry_, progress_, appOrigin_, tree, arguments, reader);
  if (name == "get_diagnostics") return readDiagnostics(registry_, treeRegistry_, tree, arguments, reader);
  if (name == "get_health")      return readHealth(registry_, tree, reader);
  if (name == "get_progress")    return readProgress(progress_, tree, arguments, caller);
  if (name == "find_nodes")      return findNodes(registry_, treeRegistry_, progress_, appOrigin_, tree, arguments, reader);
  if (name == "patch_nodes" || name == "update_nodes" || name == "change_edges")
    return applyBatchEdit(registry_, treeRegistry_, progress_, bus_, tree, name, arguments, clock_, caller);
  if (name == "set_progress")
    return writeProgress(registry_, progress_, bus_, tree, arguments, clock_, caller);
  if (name == "import_subgraph")
    return importSubgraph(registry_, treeRegistry_, progress_, bus_, tree, arguments, clock_, actor);
  if (name == "prune")
    return pruneTree(registry_, progress_, bus_, tree, clock_, caller);
  if (name == "delete_node")
    return deleteNodes(registry_, progress_, bus_, tree, arguments, clock_, caller);
  if (name == "disconnect")
    return disconnectEdges(registry_, tree, arguments, clock_, caller);
  if (name == "update_kind")
    return updateKind(registry_, tree, arguments, clock_, caller);

  if (commandKindFor(name)) return applyEdit(registry_, treeRegistry_, tree, name, arguments, clock_, caller);

  // The whole-server "no such tool" answer belongs to CompositeToolHost.
  return ToolResult::failure("no such roadmap tool — call tools/list for the surface this connection "
                             "may use.");
}

}
