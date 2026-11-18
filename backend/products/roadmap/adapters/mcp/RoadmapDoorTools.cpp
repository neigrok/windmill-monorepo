#include "products/roadmap/adapters/mcp/RoadmapDoorTools.h"

#include "platform/application/WriteObservation.h"
#include "platform/domain/sync/Digest.h"
#include "platform/domain/ToolScope.h"
#include "platform/domain/sync/FractionalIndex.h"
#include "platform/domain/sync/Identity.h"
#include "products/roadmap/adapters/json/CommandJson.h"
#include "products/roadmap/adapters/json/TreeJson.h"
#include "products/roadmap/adapters/mcp/EditReceipt.h"
#include "products/roadmap/adapters/mcp/ReadShape.h"
#include "products/roadmap/adapters/mcp/RoadmapToolCatalog.h"
#include "products/roadmap/adapters/mcp/RoadmapToolParts.h"
#include "products/roadmap/adapters/mcp/ToolArgs.h"
#include "products/roadmap/domain/Command.h"
#include "products/roadmap/domain/Guides.h"
#include "products/roadmap/domain/OpenedTrees.h"
#include "products/roadmap/domain/TreeSummary.h"
#include "products/roadmap/domain/WebAddress.h"
#include "products/roadmap/domain/read/Reads.h"
#include "products/roadmap/sync/RoadmapRules.h"

#include <algorithm>
#include <map>
#include <set>

namespace wm {

namespace {

using roadmap::AccountRows;
using roadmap::RoadmapDoor;
using roadmap::RoadmapRows;
using roadmap::TreeRows;
using Call = RoadmapDoor::Call;
namespace read = roadmap::read;

ToolResult noSuchTree(const TreeId& tree) { return ToolResult::failure("no such tree \"" + tree.str() + "\""); }

ToolResult withPayload(ToolResult result, const Json::Value& payload) {
  ToolResult rewritten = ToolResult::json(payload);
  rewritten.outcomeCode = result.outcomeCode;
  if (!result.structured.isNull()) rewritten.structured = payload;
  return rewritten;
}

// A reply as a call stores it, so a call sent again under its requestId is answered it whole.
Json::Value storedOf(const ToolResult& result) {
  Json::Value stored(Json::objectValue);
  stored["content"] = result.content;
  stored["payload"] = result.payload;
  stored["structured"] = result.structured;
  stored["isError"] = result.isError;
  stored["outcomeCode"] = result.outcomeCode;
  return stored;
}

ToolResult resultOf(const Json::Value& stored) {
  if (stored["s"] == "refused") {
    if (stored["code"] == sync::code::requestConflict)
      return ToolResult::failure("this requestId was sent before with other arguments; nothing was written. Send a new "
                                 "requestId for a new call.", sync::code::requestConflict);
    return ToolResult::failure("this call could not run (" + stored.get("code", "internal").asString() +
                                   "); nothing was written.", stored.get("code", "internal").asString());
  }
  ToolResult result;
  result.content = stored["content"];
  result.payload = stored["payload"];
  result.structured = stored["structured"];
  result.isError = stored["isError"].asBool();
  result.outcomeCode = stored["outcomeCode"].asString();
  return result;
}

// A write the engine refused, in the words the tools answer it with.
ToolResult refusedByEngine(const Json::Value& result, const TreeId& tree) {
  const std::string code = roadmap::refusalOf(result);
  if (code == sync::code::notFound || code == sync::code::scopeDead) return noSuchTree(tree);
  if (code == sync::code::forbidden) return ToolResult::failure(writeRefusalSentence(WriteRefusal::notYours));
  return ToolResult::failure("the roadmap refused this write (" + code + "); nothing was written.", code);
}

bool opensToReaders(Visibility reach) { return reach == Visibility::unlisted || reach == Visibility::public_; }

// One roadmap as its caller reads it, in one snapshot: the tree's rows with the caller's marks, the owner's roadmaps
// read together with the owner's marks — what an opened roadmap comes to is the owner's for everyone (SPEC.md, Model,
// Subtrees) — and this roadmap with the caller's marks, which their states are read over.
struct Reading {
  TreeRows rows;
  AccountRows trees;
  read::RoadmapAccount owner;
  read::RoadmapTree mine;
  bool writer = false;

  Reading(TreeRows rows, AccountRows trees, std::vector<read::RoadmapTree> roadmaps, bool writer)
      : rows(std::move(rows)), trees(std::move(trees)), owner(std::move(roadmaps)),
        mine(read::RoadmapTree(roadmap::recordsOf(this->rows, this->trees))), writer(writer) {}

  read::Location location() const { return owner.locationOf(rows.tree); }
  bool readable() const {
    return rows.exists() && location().standing == read::Standing::standing && (writer || opensToReaders(rows.reach()));
  }
  // A roadmap's name: a subtree's is its owning step's label.
  std::string title() const { return location().title.value_or(rows.metaText("title")); }

  // The steps complete for the caller: an opening that does not dangle by what it opens, read as the owner's, and
  // every other step by the caller's own mark. A reader's pointer opens nothing.
  std::set<std::string> completed() const {
    std::map<std::string, const read::Opening*> openings;
    for (const read::Opening& opening : owner.openingsOf(rows.tree))
      if (writer || opening.kind == read::OpeningKind::subtree) openings[opening.node] = &opening;
    std::set<std::string> done;
    for (const read::Step& step : mine.nodes) {
      if (!step.present) continue;
      const auto opening = openings.find(step.id);
      if (opening != openings.end() && opening->second->status != read::OpeningStatus::dangling) {
        if (owner.isComplete(opening->second->tree)) done.insert(step.id);
        continue;
      }
      const read::Mark* mark = mine.markOn(step.id);
      if (mark && mark->status == "complete") done.insert(step.id);
    }
    return done;
  }
  read::FollowGraph graph() const { return read::FollowGraph(mine, completed()); }
};

// The roadmaps of `tree`'s owner, each read with the owner's marks; `tree` itself as `rows` holds it when the caller
// is its owner.
std::vector<read::RoadmapTree> roadmapsOf(const RoadmapRows& rows, sync::SyncTxn& txn, const AccountRows& trees,
                                          const TreeRows& tree, bool writer) {
  std::vector<read::RoadmapTree> roadmaps;
  for (const auto& [id, record] : trees.trees) {
    if (id == tree.tree && writer) {
      roadmaps.emplace_back(roadmap::recordsOf(tree, trees));
      continue;
    }
    roadmaps.emplace_back(roadmap::recordsOf(rows.tree(txn, id, trees.owner), trees));
  }
  if (!trees.tree(tree.tree)) roadmaps.emplace_back(roadmap::recordsOf(tree, trees));
  return roadmaps;
}

std::optional<Reading> readingOf(const RoadmapRows& rows, sync::SyncTxn& txn, const TreeId& tree,
                                 const std::optional<UserId>& caller) {
  TreeRows treeRows = rows.tree(txn, tree.str(), caller);
  if (!treeRows.exists()) return std::nullopt;
  AccountRows trees = rows.account(txn, treeRows.owner());
  const bool writer = caller && *caller == treeRows.owner();
  std::vector<read::RoadmapTree> roadmaps = roadmapsOf(rows, txn, trees, treeRows, writer);
  return std::optional<Reading>(std::in_place, std::move(treeRows), std::move(trees), std::move(roadmaps), writer);
}

NodeState stateOf(read::StepState state) {
  switch (state) {
    case read::StepState::complete: return NodeState::complete;
    case read::StepState::available: return NodeState::available;
    case read::StepState::locked: return NodeState::locked;
  }
  return NodeState::locked;
}

// The tree as the reply shows it: its present steps in authored order, each following what D-5 reads it to follow.
TreeData documentOf(const Reading& reading, const read::FollowGraph& graph) {
  TreeData data = roadmap::documentOf(reading.rows, reading.title());
  for (NodeSpec& node : data.nodes)
    for (const read::Followed& followed : graph.followed(node.id.str())) node.prerequisites.emplace_back(followed.id);
  return data;
}

Opening openingOf(const read::RoadmapAccount& owner, const std::string& tree) {
  const std::optional<read::Counts> counts = owner.counts(tree);
  return Opening{TreeId{tree}, false, owner.locationOf(tree).title.value_or(""), owner.isComplete(tree),
                 counts ? static_cast<int>(counts->done) : 0, counts ? static_cast<int>(counts->total) : 0};
}

std::map<NodeColor, KindId> kindByHue(const read::LegendRead& legend) {
  std::map<NodeColor, KindId> join;
  for (const read::HueOwner& owner : legend.owners())
    if (const std::optional<NodeColor> hue = parseColor(owner.hue)) join[*hue] = KindId{owner.id};
  return join;
}

// What a read's fields ask of the tree beyond its records, filled only where asked.
NodeReadContext contextOf(const Reading& reading, const read::FollowGraph& graph, const NodeFields& fields,
                          const std::string& origin, bool needsStates) {
  NodeReadContext context;
  if (fields.count(NodeField::status) || needsStates || fields.count(NodeField::state))
    context.marks = roadmap::progressOf(reading.rows);
  if (fields.count(NodeField::state) || needsStates)
    for (const std::string& id : graph.ids()) context.states[NodeId{id}] = stateOf(graph.state(id));
  if (fields.count(NodeField::kind)) context.kindByHue = kindByHue(read::LegendRead(reading.mine));
  if (fields.count(NodeField::url))
    context.web = WebTree{origin, TreeId{reading.rows.tree}, reading.writer ? Opener::owner : Opener::reader};
  for (const read::Opening& opening : reading.owner.openingsOf(reading.rows.tree)) {
    if (opening.status == read::OpeningStatus::dangling) continue;
    const bool known = opening.status == read::OpeningStatus::loaded;
    if (opening.kind == read::OpeningKind::subtree && fields.count(NodeField::subtree))
      context.subtrees[NodeId{opening.node}] =
          OwnedSubtree{TreeId{opening.tree}, known ? std::optional(openingOf(reading.owner, opening.tree)) : std::nullopt};
    if (reading.writer && known && fields.count(NodeField::opens))
      context.openings[NodeId{opening.node}] = openingOf(reading.owner, opening.tree);
  }
  return context;
}

Place placeOf(const Reading& reading) {
  const read::Location location = reading.location();
  Place place{reading.title(), Hlc{}, TreeId{location.place->root}, std::nullopt, {}, static_cast<int>(location.place->depth)};
  if (location.place->parent)
    place.parent = OwningStep{TreeId{location.place->parent->tree}, NodeId{location.place->parent->step}};
  for (const read::PlaceStep& step : location.place->path)
    place.path.push_back(PathStep{TreeId{step.tree}, NodeId{step.step}, step.title.value_or("")});
  return place;
}

// The read domain's diagnostics in the words get_diagnostics and every receipt use: a loop among present steps, a link
// naming an id no step holds, a link from a step to itself, and the smells.
TreeDiagnostics diagnosticsOf(const read::Diagnostics& found) {
  TreeDiagnostics diagnostics;
  for (const read::Counted& cycle : found.cycles.entries) {
    Cycle members;
    for (const std::string& id : cycle.named) members.members.emplace_back(id);
    diagnostics.cycles.push_back(std::move(members));
  }
  for (const auto& [from, to] : found.missingEdges.entries) diagnostics.dangling.push_back(Edge{NodeId{from}, NodeId{to}});
  for (const auto& [from, to] : found.selfEdges.entries) diagnostics.selfEdges.push_back(Edge{NodeId{from}, NodeId{to}});
  const auto counted = [](const read::Counted& nodes) {
    CountedNodes held;
    held.count = nodes.count;
    for (const std::string& id : nodes.named) held.named.emplace_back(id);
    return held;
  };
  for (const read::Smell& smell : found.smells) diagnostics.smells.push_back(Smell{smell.kind, counted(smell.nodes)});
  for (const read::UnclaimedHue& hue : found.unclaimedHues)
    if (const std::optional<NodeColor> color = parseColor(hue.hue)) diagnostics.unclaimedHues.push_back(UnclaimedHue{*color, counted(hue.nodes)});
  diagnostics.legendEmpty = found.legendEmpty;
  return diagnostics;
}

// The diagnostics a write's receipt compares, read as get_diagnostics reads them (D-5): over the room's graph and legend
// as they stand, a link from a deleted step followed through rather than dangling.
TreeDiagnostics followedDiagnostics(const TreeRoom& room) {
  read::TreeRecords records;
  const GraphState graph = room.exportState();
  for (const NodeStateEntry& node : graph.nodes) {
    read::Step step{.id = node.id.str(), .present = ElementSet{node.createdAt, node.deletedAt}.present(), .born = node.createdAt,
                    .label = node.label, .icon = node.icon, .color = std::string(toString(node.color)), .ord = node.order};
    records.nodes.push_back(std::move(step));
  }
  for (const EdgeStateEntry& edge : graph.edges)
    records.edges.push_back(read::Edge{edge.edge.from.str(), edge.edge.to.str(), ElementSet{edge.addedAt, edge.removedAt}.present()});
  for (const KindStateEntry& kind : room.exportLegend().kinds)
    records.kinds.push_back(read::Kind{kind.id.str(), ElementSet{kind.createdAt, kind.deletedAt}.present(), kind.createdAt,
                                       std::string(toString(kind.hue)), kind.label, kind.description, ""});
  const read::RoadmapTree tree(std::move(records));
  return diagnosticsOf(read::diagnose(read::FollowGraph(tree)));
}

PointerDiagnostics pointerDiagnosticsOf(const read::PointerDiagnostics& found) {
  PointerDiagnostics pointers;
  for (const read::TreeLoop& loop : found.treeLoops) {
    TreeLoop held{NodeId{loop.node}, {}, loop.pathOmitted};
    for (const read::PathStep& step : loop.path) held.path.push_back(TreeOnLoop{TreeId{step.tree}, step.title.value_or("")});
    pointers.treeLoops.push_back(std::move(held));
  }
  pointers.treeLoopsOmitted = found.treeLoopsOmitted;
  for (const read::DanglingPointer& pointer : found.danglingPointers)
    pointers.danglingPointers.push_back(DanglingPointer{NodeId{pointer.node}, TreeId{pointer.tree}});
  pointers.danglingPointersOmitted = found.danglingPointersOmitted;
  return pointers;
}

// ---- writes ----

// A tool's refusal met under a scope's lock. Its admit is abandoned whole, so no part of the call is stored for it and
// the same call sent again is judged again; a part stored as admitted is always one that wrote what it meant to.
struct Refused {
  ToolResult answer;
};

[[noreturn]] void refuse(ToolResult answer) {
  const std::string code = answer.outcomeCode;
  throw sync::ServerBuildAborted{std::make_exception_ptr(Refused{std::move(answer)}), code};
}

// What a call answers when it was cut short after some of its writes and is sent again under its requestId: the writes
// that had landed are not made again, the rest are, and what the first attempt would have answered is not known.
ToolResult resumedReceipt(const TreeId& tree, Seq seq) {
  Json::Value out(Json::objectValue);
  out["applied"] = true;
  out["dryRun"] = false;
  out["resumed"] = true;
  out["seq"] = static_cast<Json::Int64>(seq);
  out["treeId"] = tree.str();
  return ToolResult::json(out);
}

// The tree-scope write of a tool: the room built from the tree's rows under the scope's lock, `edit` run in it as the
// tool's room function runs over rooms, and what the room then holds written as the intent's deltas. A refusal of
// `edit`'s abandons the admit. A reply's `seq` is the tree scope's once the write has landed.
using RoomEdit = std::function<ToolResult(TreeRoom&, const TreeRows&, const AccountRows&, sync::SyncTxn&)>;

struct TreeEdit {
  ToolResult answer;
  Seq seq = 0;
  bool planned = false;     // this attempt planned the edit; false when the call ran before and its write is replayed
  bool treeLanded = false;  // the edit wrote the tree scope
};

// The pointers a call sends, read from its arguments and the tree as it stands after the call's tree write.
using SentPointers = std::function<std::vector<roadmap::Opens>(const TreeRows&, const TreeEdit&)>;

TreeEdit editTree(Call& call, const TreeId& tree, const UserId& caller, const RoomEdit& edit, const SentPointers& sent = nullptr) {
  TreeEdit edited{noSuchTree(tree)};
  Seq before = 0;
  NullPresenceBus bus;
  Json::Value landed;
  try {
    landed = call.admitBuilt(roadmap::treePlaceholder(tree.str()), [&](sync::SyncTxn& txn) -> std::optional<Json::Value> {
      const TreeRows rows = call.rows().tree(txn, tree.str(), caller);
      if (!rows.exists()) refuse(noSuchTree(tree));
      const AccountRows account = call.rows().account(txn, rows.owner());
      edited.planned = true;
      before = rows.seq();
      const std::unique_ptr<TreeRoom> room = roadmap::roomOf(rows, account, bus);
      edited.answer = edit(*room, rows, account, txn);
      if (edited.answer.isError) refuse(edited.answer);
      const Json::Value writes = roadmap::writesOf(rows, *room);
      if (writes.empty()) return std::nullopt;
      return roadmap::intentIn("tree/" + tree.str(), writes);
    });
  } catch (const Refused& refused) {
    edited.answer = refused.answer;
    return edited;
  }
  if (!roadmap::landed(landed)) {
    edited.answer = refusedByEngine(landed, tree);
    return edited;
  }
  edited.seq = landed["seq"].asUInt64();
  edited.treeLanded = !edited.planned || edited.seq != before;
  if (!edited.planned) edited.answer = resumedReceipt(tree, edited.seq);
  if (sent) {
    // Always the call's next admit when it sends pointers, so a resumed call's admits line up with the first attempt's.
    const Json::Value opened = call.admitBuilt(roadmap::overlayPlaceholder(tree.str()), [&](sync::SyncTxn& txn) -> std::optional<Json::Value> {
      const TreeRows rows = call.rows().tree(txn, tree.str(), caller);
      if (!rows.exists()) return std::nullopt;
      const Json::Value writes = roadmap::pointerWritesOf(rows, call.rows().account(txn, rows.owner()), sent(rows, edited));
      if (writes.empty()) return std::nullopt;
      return roadmap::intentIn("self/overlay/" + tree.str(), writes);
    });
    if (!roadmap::landed(opened)) {
      edited.answer = refusedByEngine(opened, tree);
      return edited;
    }
  }
  if (edited.planned && edited.answer.payload.isMember("seq")) {
    Json::Value payload = edited.answer.payload;
    payload["seq"] = static_cast<Json::Int64>(edited.seq);
    edited.answer = withPayload(edited.answer, payload);
  }
  return edited;
}

// What a write judges, under the lock of the admit that comes first, before anything of it lands: it refuses or passes.
using Judge = std::function<void(sync::SyncTxn&, const TreeRows&)>;

// The caller's completions on `steps`, cleared in their overlay as it stands, before or after a write takes those steps:
// how many it cleared, or none when the call ran before and the clear is replayed. `judge` runs first, and its refusal
// abandons the clear whole.
std::optional<std::size_t> clearMarks(Call& call, const TreeId& tree, const UserId& caller, const std::vector<NodeId>& steps,
                                      const Judge& judge = nullptr) {
  std::optional<std::size_t> cleared;
  const Json::Value landed = call.admitBuilt(roadmap::overlayPlaceholder(tree.str()), [&](sync::SyncTxn& txn) -> std::optional<Json::Value> {
    const TreeRows rows = call.rows().tree(txn, tree.str(), caller);
    if (judge) judge(txn, rows);
    cleared = 0;
    Json::Value deltas(Json::arrayValue);
    for (const sync::Row& mark : rows.marks) {
      const auto held = mark.lattice.f.find("mark");
      if (held == mark.lattice.f.end() || held->second.value["status"] != "complete") continue;
      if (std::none_of(steps.begin(), steps.end(), [&](const NodeId& step) { return step.str() == mark.id.column(); })) continue;
      Json::Value fields(Json::objectValue);
      fields["mark"]["status"] = "none";
      fields["mark"]["outOfOrder"] = false;
      deltas.append(roadmap::Written{.type = "progress", .id = mark.id.json(), .fields = fields}.json());
      ++*cleared;
    }
    if (deltas.empty()) return std::nullopt;
    return roadmap::intentIn("self/overlay/" + tree.str(), deltas);
  });
  if (!roadmap::landed(landed)) throw Refused{refusedByEngine(landed, tree)};
  return cleared;
}

// Whether a step's completion follows the roadmap it opens, as a mark on it would read: for the owner a step that owns
// a subtree or whose pointer opens a standing roadmap, for anyone else a step that owns a subtree.
std::set<std::string> followingSteps(const Reading& reading) {
  std::set<std::string> following;
  for (const read::Opening& opening : reading.owner.openingsOf(reading.rows.tree))
    if (opening.status != read::OpeningStatus::dangling && (reading.writer || opening.kind == read::OpeningKind::subtree))
      following.insert(opening.node);
  return following;
}

// What a call's marks came to: the batch's rows, or the refusal that wrote none. A call resumed under its requestId
// after its marks landed is `resumed`, and what each row did is not told again.
struct Marked {
  std::variant<MarkedBatch, std::string> answer;
  bool resumed = false;
};

// The caller's marks on the tree's steps, in their overlay (Roadmap on the sync engine §5): a step that follows the
// roadmap it opens takes none and is refused row by row, a step the tree does not hold is skipped, or refuses the call
// when `rejectUnknown`. A mark already held is written again and answered unchanged. Whether a completed step's
// prerequisites are met is read after the marks, over what each step follows (D-5).
Marked markSteps(Call& call, const TreeId& tree, const UserId& caller, const std::vector<RequestedMark>& requested,
                 bool rejectUnknown) {
  Marked marked{MarkedBatch{}, true};
  std::vector<std::pair<std::size_t, bool>> written;  // each mark's row in `requested`, and whether it was held
  Json::Value landed;
  try {
  landed = call.admitBuilt(roadmap::overlayPlaceholder(tree.str()), [&](sync::SyncTxn& txn) -> std::optional<Json::Value> {
    std::optional<Reading> reading = readingOf(call.rows(), txn, tree, caller);
    if (!reading || !reading->readable()) refuse(noSuchTree(tree));
    marked.resumed = false;
    MarkedBatch batch;
    std::vector<std::string> unknown;
    for (const RequestedMark& mark : requested) {
      const read::Step* step = reading->mine.step(mark.node.str());
      if (!step || !step->present) unknown.push_back(mark.node.str());
    }
    if (rejectUnknown && !unknown.empty())
      refuse(ToolResult::failure("no node in this tree is named " + quotedList(unknown) + ". " + kNodeHandle.hint));
    for (const std::string& id : unknown) batch.skipped.append(id);
    const std::set<std::string> following = followingSteps(*reading);
    Json::Value deltas(Json::arrayValue);
    std::map<std::string, read::Mark> after;
    for (const auto& [node, mark] : reading->mine.marks) after[node] = mark;
    for (std::size_t i = 0; i < requested.size(); ++i) {
      const RequestedMark& mark = requested[i];
      const read::Step* step = reading->mine.step(mark.node.str());
      if (!step || !step->present || following.contains(mark.node.str())) continue;
      const read::Mark* held = reading->mine.markOn(mark.node.str());
      const std::string status = progressStatusName(mark.status);
      written.emplace_back(i, (held ? held->status : "none") == status && (held && held->outOfOrder) == mark.outOfOrder);
      Json::Value value(Json::objectValue);
      value["status"] = status;
      value["outOfOrder"] = mark.outOfOrder;
      Json::Value fields(Json::objectValue);
      fields["mark"] = value;
      deltas.append(roadmap::Written{.type = "progress", .id = Json::Value(mark.node.str()), .fields = fields}.json());
      after[mark.node.str()] = read::Mark{mark.node.str(), status, mark.outOfOrder, std::nullopt, std::nullopt, Hlc{1, 0, "door"}};
    }
    read::TreeRecords withMarks = roadmap::recordsOf(reading->rows, reading->trees);
    withMarks.marks.clear();
    for (const auto& [node, mark] : after) withMarks.marks.push_back(mark);
    reading->mine = read::RoadmapTree(std::move(withMarks));
    const read::FollowGraph graph = reading->graph();
    const std::set<std::string> completed = reading->completed();
    auto row = written.begin();
    for (std::size_t i = 0; i < requested.size(); ++i) {
      const RequestedMark& mark = requested[i];
      const read::Step* step = reading->mine.step(mark.node.str());
      if (!step || !step->present) continue;
      Json::Value result(Json::objectValue);
      result["nodeId"] = mark.node.str();
      if (following.contains(mark.node.str())) {
        result["refused"] = reading->writer
                                ? "\"" + mark.node.str() + "\" opens a tree: it is complete when that tree is and takes "
                                  "no mark of its own — mark the steps of the tree it opens"
                                : "\"" + mark.node.str() + "\" owns a subtree: it shows its owner's progress on that "
                                  "subtree and takes no mark of its own";
        batch.refused.append(mark.node.str());
        batch.results.append(result);
        continue;
      }
      bool met = true;
      if (mark.status == ProgressStatus::complete)
        for (const read::Followed& prerequisite : graph.followed(mark.node.str())) met = met && completed.contains(prerequisite.id);
      result["status"] = progressStatusName(mark.status);
      result["prerequisitesMet"] = met;
      if (mark.outOfOrder) result["acknowledged"] = true;
      const bool unchanged = row != written.end() && row->first == i && row->second;
      if (unchanged) result["unchanged"] = true;
      batch.changed = batch.changed || !unchanged;
      if (row != written.end() && row->first == i) ++row;
      batch.results.append(result);
    }
    batch.cameToARefusal = written.empty() && !batch.refused.empty();
    marked.answer = batch;
    if (deltas.empty()) return std::nullopt;
    return roadmap::intentIn("self/overlay/" + tree.str(), deltas);
  });
  } catch (const Refused& refused) {
    return Marked{refused.answer.content[0]["text"].asString(), false};
  }
  if (!roadmap::landed(landed)) return Marked{"no such tree \"" + tree.str() + "\"", false};
  return marked;
}

// The marks a write carries beside its tree edit, landed after it and told in its receipt; `treeLanded` says the tree
// edit landed, so a refusal of the marks is the receipt's to tell and not the call's.
ToolResult carryMarks(Call& call, const TreeId& tree, const UserId& caller, const std::vector<RequestedMark>& marks,
                      bool rejectUnknown, bool treeLanded, ToolResult edited, const char* failure) {
  Json::Value receipt = edited.payload;
  const Marked marked = markSteps(call, tree, caller, marks, rejectUnknown);
  if (marked.resumed) return resumedReceipt(tree, edited.payload["seq"].asUInt64());
  const std::variant<MarkedBatch, std::string>& applied = marked.answer;
  if (const std::string* error = std::get_if<std::string>(&applied)) {
    if (!treeLanded) return ToolResult::failure(*error);
    fellShort(receipt, std::string(failure) + *error);
    return withPayload(edited, receipt);
  }
  const MarkedBatch& batch = std::get<MarkedBatch>(applied);
  batch.answerOnto(receipt);
  ToolResult answered = withPayload(edited, receipt);
  if (batch.cameToARefusal && !treeLanded) {
    if (receipt.isMember("applied")) {
      receipt["applied"] = false;
      answered = withPayload(edited, receipt);
    }
    answered.outcomeCode = kOpensATree;
  }
  return answered;
}

// Every pointer a call sends a step that owns no subtree opens a standing root of the caller's, read in the writing
// transaction (opens, MCP README): a subtree of theirs is told as one, anything else in one sentence that confirms no id.
std::optional<ToolResult> checkPointers(const RoadmapRows& rows, sync::SyncTxn& txn, const UserId& caller,
                                        const TreeRoom& room, const std::vector<SentPointer>& sent) {
  const AccountRows mine = rows.account(txn, caller);
  for (const SentPointer& pointer : sent) {
    if (pointer.tree.empty() || room.ownsASubtree(pointer.step)) continue;
    const std::string target = pointer.tree.str();
    const bool standing = mine.isAlive(target) && rows.tree(txn, target, std::nullopt).exists();
    if (standing && !mine.placeOf(target)) continue;
    if (standing)
      return ToolResult::failure(pointer.path + " names \"" + target +
                                     "\", a subtree of one of your roadmaps, which only the step that owns it opens — a "
                                     "node opens a roadmap that has no parent: list_trees lists them",
                                 kOpensASubtree);
    return ToolResult::failure(pointer.path + " names \"" + target +
                                   "\", which is not a tree of yours — a node opens only a tree you own: list_trees "
                                   "lists them, and someone else's tree is copied into one of yours first, with "
                                   "create_tree then import_subgraph",
                               "opens-not-yours");
  }
  return std::nullopt;
}

std::vector<NodeId> refusedPointersOf(const TreeRoom& room, const std::vector<SentPointer>& sent) {
  std::vector<std::pair<NodeId, TreeId>> steps;
  for (const SentPointer& pointer : sent) steps.emplace_back(pointer.step, pointer.tree);
  return room.refusedPointers(steps);
}

// The loops of roadmaps an edit's pointers close, named in its receipt: the owner's roadmaps read once the edit has
// landed, the pointers' loops back to this one.
void answerClosedLoops(const RoadmapDoor& door, const TreeId& tree, const UserId& caller, const TreeDiagnostics& before,
                       const TreeDiagnostics& after, Json::Value& receipt) {
  door.read([&](sync::SyncTxn& txn) {
    const std::optional<Reading> reading = readingOf(door.rows(), txn, tree, caller);
    if (!reading) return;
    answerDiagnostics(before, after, receipt, pointerDiagnosticsOf(read::pointerDiagnostics(reading->owner, tree.str())));
  });
}

// The size of a subtree's branch, for a refusal that names it: its standing subtrees and every step across them.
std::string branchesUnconfirmed(const RoadmapRows& rows, sync::SyncTxn& txn, const AccountRows& account,
                                const std::vector<UnconfirmedBranch>& unconfirmed) {
  const auto counted = [](int count, const std::string& noun) {
    return std::to_string(count) + " " + noun + (count == 1 ? "" : "s");
  };
  std::string named;
  std::vector<std::string> ids;
  for (const UnconfirmedBranch& branch : unconfirmed) {
    std::vector<std::string> branchTrees{branch.subtree.str()};
    const roadmap::engine::Roadmaps roadmaps([&] {
      std::vector<sync::Row> records;
      for (const auto& [id, row] : account.trees) records.push_back(row);
      return records;
    }());
    for (const std::string& below : roadmaps.under(branch.subtree.str())) branchTrees.push_back(below);
    int steps = 0;
    for (const std::string& id : branchTrees) {
      const TreeRows held = rows.tree(txn, id, std::nullopt);
      for (const sync::Row& node : held.nodes) steps += node.alive() ? 1 : 0;
    }
    const int subtrees = static_cast<int>(branchTrees.size()) - 1;
    named += named.empty() ? "" : "; ";
    named += "step \"" + branch.step.str() + "\" owns the subtree \"" + branch.subtree.str() + "\"" +
             (subtrees == 0 ? ", holding " + counted(steps, "step")
                            : ", holding " + counted(steps, "step") + " across it and the " + counted(subtrees, "subtree") +
                                  " under it");
    ids.push_back(branch.subtree.str());
  }
  return named + ". Deleting a step that owns a subtree hides that subtree and everything under it until the step is "
                 "revived; pass branches: [" + quotedList(ids) + "] to take them with their steps. Nothing was deleted.";
}

}

RoadmapDoorTools::RoadmapDoorTools(roadmap::RoadmapDoor& door, TokenGenerator& tokens, Clock& clock, std::string appOrigin)
    : door_(door), tokens_(tokens), clock_(clock), appOrigin_(std::move(appOrigin)) {}

std::vector<ToolDeclaration> RoadmapDoorTools::declareTools() const { return roadmapDoorToolCatalog(); }

ToolResult RoadmapDoorTools::callTool(const std::string& name, const Json::Value& arguments, const ToolCaller& caller) {
  try {
    ToolResult outcome = dispatch(name, arguments, caller);
    if (!outcome.isError) return outcome;
    return ToolResult::failure(name + ": " + outcome.content[0]["text"].asString(), toolWriteOutcome(outcome));
  } catch (const std::bad_alloc&) {
    throw;
  } catch (const roadmap::DoorBusy&) {
    return ToolResult::failure(name + ": the roadmap is busy just now and nothing was written. Send the same call again "
                               "in a moment.", "busy");
  } catch (const std::exception& error) {
    reportCurrentWriteFailure(error);
    return ToolResult::failure(name + ": that call failed inside the server. The outcome may be uncertain; "
                               "read the affected records before retrying. The detail is in the server log.");
  }
}

ToolResult RoadmapDoorTools::dispatch(const std::string& name, const Json::Value& arguments, const ToolCaller& actor) {
  if (!arguments.isObject())
    return ToolResult::failure("arguments must be a JSON object of this tool's named arguments, got " + typeName(arguments));
  const UserId& caller = actor.user;
  const std::optional<UserId> reader = caller.empty() ? std::nullopt : std::optional<UserId>(caller);

  // Every write is one call of the door, deduplicated by its requestId when it sends one.
  const auto write = [&](const std::function<ToolResult(Call&)>& body) -> ToolResult {
    std::optional<std::string> requestId;
    if (!arguments["requestId"].isNull()) {
      if (std::optional<std::string> bad = requireString(arguments["requestId"], "requestId", Empty::rejected, kMaxIdLength))
        return ToolResult::failure(*bad);
      requestId = arguments["requestId"].asString();
      if (requestId->find('#') != std::string::npos)
        return ToolResult::failure("requestId must not contain \"#\" — send any other id of your choosing");
    }
    Json::Value sent = arguments;
    sent.removeMember("requestId");
    return resultOf(door_.run(caller, requestId, "mcp." + name, sent, [&](Call& call) { return storedOf(body(call)); }));
  };

  if (name == "create_tree") {
    if (std::optional<std::string> bad = optionalString(arguments["title"], "title", kMaxTitleChars)) return ToolResult::failure(*bad);
    if (std::optional<std::string> bad = checkKinds(arguments["kinds"], kMaxKinds)) return ToolResult::failure(*bad);
    const std::optional<TreeData> sent = treeFromJson(arguments, TreeId{});
    if (!sent) return ToolResult::failure("this tree's title or kinds carry a field of the wrong type");
    if (arguments["kinds"].isArray())
      if (std::optional<Admission> refusal = admitBornKinds(sent->kinds)) return ToolResult::failure(refusal->reason);
    const std::vector<Kind> kinds = Legend::bornWith(sent->kinds);
    return write([&](Call& call) -> ToolResult {
      // A call sent under a requestId plants the same id again, so its two admits resume as one.
      const std::string tree = arguments["requestId"].isString()
                                   ? "t_" + sync::sha256(caller.str() + "\n" + arguments["requestId"].asString()).hex().substr(0, 16)
                                   : "t_" + tokens_.mint().digest.substr(0, 16);
      const Json::Value planted = call.admit(roadmap::accountPlaceholder(tree));
      if (!roadmap::landed(planted)) return refusedByEngine(planted, TreeId{tree});
      Json::Value deltas(Json::arrayValue);
      Json::Value meta(Json::objectValue);
      meta["title"] = sent->title;
      deltas.append(roadmap::Written{.type = "meta", .id = Json::Value("meta"), .fields = meta}.json());
      std::optional<std::string> ord;
      for (const Kind& kind : kinds) {
        ord = sync::between(ord, std::nullopt);
        Json::Value fields(Json::objectValue);
        fields["hue"] = std::string(toString(kind.hue));
        fields["label"] = kind.label;
        fields["description"] = kind.description;
        fields["ord"] = *ord;
        deltas.append(roadmap::Written{.type = "kind", .id = Json::Value(kind.id.str()), .fields = fields,
                                       .life = sync::LifeState::alive, .derived = true}.json());
      }
      const Json::Value seeded = call.admit(roadmap::intentIn("tree/" + tree, deltas));
      if (!roadmap::landed(seeded)) return refusedByEngine(seeded, TreeId{tree});
      Json::Value out(Json::objectValue);
      out["treeId"] = tree;
      out["url"] = treeAddress(WebTree{appOrigin_, TreeId{tree}, Opener::owner});
      out["kinds"] = Json::Value(Json::arrayValue);
      for (const Kind& kind : kinds) out["kinds"].append(projectKind(kind, kLegendFields));
      return ToolResult::json(out);
    });
  }

  if (name == "list_trees") {
    return door_.read([&](sync::SyncTxn& txn) -> ToolResult {
      const AccountRows trees = door_.rows().account(txn, caller);
      std::vector<read::RoadmapTree> roadmaps;
      std::map<std::string, TreeRows> held;
      for (const auto& [id, record] : trees.trees) {
        TreeRows rows = door_.rows().tree(txn, id, caller);
        roadmaps.emplace_back(roadmap::recordsOf(rows, trees));
        held.emplace(id, std::move(rows));
      }
      const read::RoadmapAccount account(std::move(roadmaps));
      std::vector<Json::Value> rows;
      for (const auto& [id, record] : trees.trees) {
        const read::Location location = account.locationOf(id);
        const std::optional<read::Counts> counts = account.counts(id);
        if (location.standing != read::Standing::standing || location.place->parent || !counts) continue;
        const TreeRows& tree = held.at(id);
        sync::Ms updated = record.ru;
        for (const auto* rowsOf : {&tree.nodes, &tree.edges, &tree.kinds, &tree.marks})
          for (const sync::Row& row : *rowsOf) updated = std::max(updated, row.ru);
        if (tree.meta) updated = std::max(updated, tree.meta->ru);
        TreeSummary summary{TreeId{id}, location.title.value_or(""), record.rc, updated,
                            treeStats(roadmap::documentOf(tree, ""), roadmap::progressOf(tree)), {}, {}};
        summary.stats.total = static_cast<int>(counts->total);
        summary.stats.done = static_cast<int>(counts->done);
        Json::Value row = toJson(summary);
        row["url"] = treeAddress(WebTree{appOrigin_, TreeId{id}, Opener::owner});
        rows.push_back(row);
      }
      std::stable_sort(rows.begin(), rows.end(), [](const Json::Value& a, const Json::Value& b) {
        return a["updatedAt"].asInt64() > b["updatedAt"].asInt64();
      });
      Json::Value out(Json::objectValue);
      out["trees"] = Json::Value(Json::arrayValue);
      for (const Json::Value& row : rows) out["trees"].append(row);
      return ToolResult::json(out);
    });
  }

  if (arguments["treeId"].isNull() || (arguments["treeId"].isString() && arguments["treeId"].asString().empty()))
    return ToolResult::failure("missing required argument \"treeId\". Call list_trees to see the roadmaps you own and "
                               "their ids.");
  if (std::optional<std::string> bad = requireString(arguments["treeId"], "treeId", Empty::rejected, kMaxIdLength))
    return ToolResult::failure(*bad);
  const TreeId tree{arguments["treeId"].asString()};

  if (name == "get_tree") {
    return door_.read([&](sync::SyncTxn& txn) -> ToolResult {
      const std::optional<Reading> reading = readingOf(door_.rows(), txn, tree, reader);
      if (!reading || !reading->readable()) return noSuchTree(tree);
      std::string error;
      const std::optional<NodeFields> nodeFields = nodeVocabulary().parse(arguments["fields"], "fields", kGetTreeFields, error);
      if (!nodeFields) return ToolResult::failure(error);
      const std::optional<KindFields> kindFields = kindVocabulary().parse(arguments["kindFields"], "kindFields", kLegendFields, error);
      if (!kindFields) return ToolResult::failure(error);
      if (std::optional<std::string> bad = optionalBool(arguments["includeEdges"], "includeEdges")) return ToolResult::failure(*bad);
      if (std::optional<std::string> bad = optionalBool(arguments["includeGuides"], "includeGuides")) return ToolResult::failure(*bad);
      const read::FollowGraph graph = reading->graph();
      const TreeData data = documentOf(*reading, graph);
      const std::optional<Page> page = pageOf(data.nodes, arguments, error);
      if (!page) return ToolResult::failure(error);
      const NodeReadContext context = contextOf(*reading, graph, *nodeFields, appOrigin_, false);
      ProjectedPage projected = projectPage(data.nodes, *page, *nodeFields, context);
      Json::Value kinds(Json::arrayValue);
      for (const Kind& kind : data.kinds) kinds.append(projectKind(kind, *kindFields));

      const bool inherited = reading->rows.meta && reading->mine.meta.guideInherited;
      Json::Value guide(Json::objectValue);
      guide["text"] = data.guide;
      guide["yours"] = reading->writer && !inherited;
      Json::Value document(Json::objectValue);
      document["id"] = tree.str();
      document["title"] = data.title;
      document["url"] = treeAddress(WebTree{appOrigin_, tree, reading->writer ? Opener::owner : Opener::reader});
      const Json::Value where = toJson(placeOf(*reading));
      for (const std::string& key : where.getMemberNames()) document[key] = where[key];
      document["guide"] = guide;
      if (page->begin == 0 && (arguments["includeGuides"].isNull() || arguments["includeGuides"].asBool())) {
        std::vector<Guide> guides;
        if (reading->writer) {
          for (const read::Guide& above : reading->owner.guides(tree.str()))
            guides.push_back(Guide{TreeId{above.tree}, above.title, above.text, above.own});
        } else if (!data.guide.empty()) {
          guides.push_back(Guide{tree, data.title, data.guide, false});
        }
        document["guides"] = toJson(guides);
      }
      document["nodes"] = std::move(projected.nodes);
      document["kinds"] = kinds;
      Json::Value out(Json::objectValue);
      out["seq"] = static_cast<Json::Int64>(reading->rows.seq());
      out["count"] = static_cast<Json::UInt64>(data.nodes.size());
      if (!projected.nextCursor.empty()) out["nextCursor"] = projected.nextCursor;
      if (projected.bytes) out["pageBytes"] = static_cast<Json::UInt64>(*projected.bytes);
      out["tree"] = document;
      if (arguments["includeEdges"].asBool()) {
        std::size_t live = 0;
        for (const NodeSpec& node : data.nodes) live += node.prerequisites.size();
        if (live <= kMaxListedEdges) {
          Json::Value edges(Json::arrayValue);
          for (const NodeSpec& node : data.nodes)
            for (const NodeId& from : node.prerequisites) {
              Json::Value edge(Json::objectValue);
              edge["from"] = from.str();
              edge["to"] = node.id.str();
              edges.append(edge);
            }
          out["edges"] = edges;
        } else {
          out["edgesOmitted"] = "this tree holds " + std::to_string(live) + " live edges, past the " +
                                std::to_string(kMaxListedEdges) + " one reply lists — page get_tree with fields "
                                "[\"id\", \"prerequisites\"] instead.";
        }
      }
      return ToolResult::json(out);
    });
  }

  if (name == "get_nodes") {
    return door_.read([&](sync::SyncTxn& txn) -> ToolResult {
      const std::optional<Reading> reading = readingOf(door_.rows(), txn, tree, reader);
      if (!reading || !reading->readable()) return noSuchTree(tree);
      if (!arguments["nodeIds"].isArray() || arguments["nodeIds"].empty() || arguments["nodeIds"].size() > kMaxReadNodeIds)
        return ToolResult::failure("nodeIds must contain 1 to " + std::to_string(kMaxReadNodeIds) + " unique node ids");
      std::set<std::string> seen;
      for (Json::ArrayIndex i = 0; i < arguments["nodeIds"].size(); ++i) {
        const Json::Value& id = arguments["nodeIds"][i];
        if (std::optional<std::string> bad = requireString(id, "nodeIds[" + std::to_string(i) + "]", Empty::rejected, kMaxIdLength))
          return ToolResult::failure(*bad);
        if (!seen.insert(id.asString()).second) return ToolResult::failure("nodeIds repeats \"" + id.asString() + "\"");
      }
      std::string error;
      const std::optional<NodeFields> fields = nodeVocabulary().parse(arguments["fields"], "fields", kGetNodesFields, error);
      if (!fields) return ToolResult::failure(error);
      const read::FollowGraph graph = reading->graph();
      const TreeData data = documentOf(*reading, graph);
      const NodeReadContext context = contextOf(*reading, graph, *fields, appOrigin_, false);
      std::map<NodeId, const NodeSpec*> byId;
      for (const NodeSpec& node : data.nodes) byId.emplace(node.id, &node);
      Json::Value out(Json::objectValue);
      out["treeId"] = tree.str();
      out["seq"] = static_cast<Json::Int64>(reading->rows.seq());
      out["nodes"] = Json::Value(Json::arrayValue);
      out["missingNodeIds"] = Json::Value(Json::arrayValue);
      for (const Json::Value& id : arguments["nodeIds"]) {
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
                                   "-byte limit; retry with fewer nodeIds or fewer fields (summary instead of "
                                   "description). No nodes were omitted silently.");
      return result;
    });
  }

  if (name == "get_diagnostics") {
    if (std::optional<std::string> bad = optionalBool(arguments["includePointers"], "includePointers")) return ToolResult::failure(*bad);
    const bool asked = arguments["includePointers"].isNull() || arguments["includePointers"].asBool();
    return door_.read([&](sync::SyncTxn& txn) -> ToolResult {
      const std::optional<Reading> reading = readingOf(door_.rows(), txn, tree, reader);
      if (!reading || !reading->readable()) return noSuchTree(tree);
      const TreeDiagnostics graph = diagnosticsOf(read::diagnose(reading->graph()));
      if (!asked || !reading->writer) return ToolResult::json(toJson(graph));
      return ToolResult::json(toJson(graph, pointerDiagnosticsOf(read::pointerDiagnostics(reading->owner, tree.str()))));
    });
  }

  if (name == "get_progress") {
    std::string error;
    const std::optional<ProgressFields> fields = progressVocabulary().parse(arguments["fields"], "fields", kProgressFields, error);
    if (!fields) return ToolResult::failure(error);
    return door_.read([&](sync::SyncTxn& txn) -> ToolResult {
      const std::optional<Reading> reading = readingOf(door_.rows(), txn, tree, reader);
      if (!reading || !reading->readable()) return noSuchTree(tree);
      std::set<NodeId> held;
      for (const read::Step& step : reading->mine.nodes)
        if (step.present) held.emplace(step.id);
      return ToolResult::json(projectProgress(roadmap::progressOf(reading->rows).restrictedTo(held), *fields));
    });
  }

  if (name == "find_nodes") {
    if (std::optional<std::string> bad = optionalOneOf(arguments["color"], "color", kHues)) return ToolResult::failure(*bad);
    if (std::optional<std::string> bad = optionalString(arguments["kind"], "kind", kMaxIdLength)) return ToolResult::failure(*bad);
    if (std::optional<std::string> bad = optionalString(arguments["query"], "query")) return ToolResult::failure(*bad);
    if (std::optional<std::string> bad = optionalOneOf(arguments["state"], "state", kNodeStates)) return ToolResult::failure(*bad);
    if (std::optional<std::string> bad = optionalBool(arguments["owns"], "owns")) return ToolResult::failure(*bad);
    std::string error;
    const std::optional<NodeFields> fields = nodeVocabulary().parse(arguments["fields"], "fields", kFindNodesFields, error);
    if (!fields) return ToolResult::failure(error);
    return door_.read([&](sync::SyncTxn& txn) -> ToolResult {
      const std::optional<Reading> reading = readingOf(door_.rows(), txn, tree, reader);
      if (!reading || !reading->readable()) return noSuchTree(tree);
      read::NodeFilter filter;
      if (arguments["color"].isString()) filter.color = arguments["color"].asString();
      if (arguments["kind"].isString() && !arguments["kind"].asString().empty()) filter.kind = arguments["kind"].asString();
      filter.query = arguments.get("query", "").asString();
      std::optional<NodeState> state;
      if (arguments["state"].isString()) state = parseNodeState(arguments["state"].asString());
      const read::FollowGraph graph = reading->graph();
      const TreeData data = documentOf(*reading, graph);
      const NodeReadContext context = contextOf(*reading, graph, *fields, appOrigin_, state.has_value());
      std::map<std::string, const NodeSpec*> byId;
      for (const NodeSpec& node : data.nodes) byId.emplace(node.id.str(), &node);
      std::set<std::string> owning;
      for (const read::Opening& opening : reading->owner.openingsOf(tree.str()))
        if (opening.kind == read::OpeningKind::subtree && opening.status != read::OpeningStatus::dangling) owning.insert(opening.node);
      std::vector<NodeSpec> matches;
      for (const std::string& id : read::selectNodes(reading->mine, filter)) matches.push_back(*byId.at(id));
      if (state) std::erase_if(matches, [&](const NodeSpec& node) { return context.states.at(node.id) != *state; });
      if (arguments["owns"].isBool()) {
        const bool owns = arguments["owns"].asBool();
        std::erase_if(matches, [&](const NodeSpec& node) { return owning.contains(node.id.str()) != owns; });
      }
      const std::optional<Page> page = pageOf(matches, arguments, error);
      if (!page) return ToolResult::failure(error);
      ProjectedPage projected = projectPage(matches, *page, *fields, context);
      Json::Value out(Json::objectValue);
      out["count"] = static_cast<Json::UInt64>(matches.size());
      out["nodes"] = std::move(projected.nodes);
      if (!projected.nextCursor.empty()) out["nextCursor"] = projected.nextCursor;
      if (projected.bytes) out["pageBytes"] = static_cast<Json::UInt64>(*projected.bytes);
      return ToolResult::json(out);
    });
  }

  if (name == "update_tree") {
    const Json::Value& title = arguments["title"];
    const Json::Value& guide = arguments["guide"];
    if (title.isNull() && guide.isNull()) return ToolResult::failure("nothing to set — pass at least one of \"title\", \"guide\".");
    if (!title.isNull() && !title.isString()) return ToolResult::failure(*requireString(title, "title"));
    if (title.isString() && isValidUtf8(title.asString()))
      if (std::optional<std::string> bad = optionalString(title, "title", kMaxTitleChars)) return ToolResult::failure(*bad);
    if (!guide.isNull() && !guide.isString())
      return ToolResult::failure(*requireString(guide, "guide") + ". A guide is plain text of at most " +
                                 std::to_string(kMaxGuideChars) + " characters; \"\" clears it.");
    if (std::optional<std::string> bad = optionalString(guide, "guide", kMaxGuideChars)) return ToolResult::failure(*bad);
    if (title.isString())
      if (std::optional<Admission> refusal = admitTitle(title.asString())) return ToolResult::failure(refusal->reason);
    if (title.isString() && title.asString().find_first_not_of(" \t\r\n") == std::string::npos)
      return ToolResult::failure("title must not be blank");
    if (guide.isString())
      if (std::optional<Admission> refusal = admitGuide(guide.asString())) return ToolResult::failure(refusal->reason);
    return write([&](Call& call) -> ToolResult {
      // A subtree's name is its owning step's label, written in the roadmap that holds the step.
      const std::optional<OwningStep> owning = door_.read([&](sync::SyncTxn& txn) -> std::optional<OwningStep> {
        const TreeRows rows = door_.rows().tree(txn, tree.str(), std::nullopt);
        if (!rows.exists()) return std::nullopt;
        const std::optional<read::Parent> place = door_.rows().account(txn, rows.owner()).placeOf(tree.str());
        if (!place) return std::nullopt;
        return OwningStep{TreeId{place->tree}, NodeId{place->step}};
      });
      bool unchanged = true;
      Seq seq = 0;
      if (title.isString() && owning) {
        const TreeEdit renamed = editTree(call, owning->tree, caller, [&](TreeRoom& room, const TreeRows&, const AccountRows&, sync::SyncTxn& txn) -> ToolResult {
          if (!room.readableBy(caller)) return noSuchTree(tree);
          if (std::optional<WriteRefusal> refusal = writeRefusalFor(caller, room.owner())) return ToolResult::failure(writeRefusalSentence(*refusal));
          if (room.labelOf(owning->step) != title.asString()) room.applyCommand(RenameNode{owning->step, title.asString()}, clock_.nowMs(), caller);
          return ToolResult::json(Json::Value(Json::objectValue));
        });
        if (renamed.answer.isError) return renamed.answer;
        unchanged = !renamed.treeLanded;
      }
      const TreeEdit described = editTree(call, tree, caller, [&](TreeRoom& room, const TreeRows&, const AccountRows&, sync::SyncTxn& txn) -> ToolResult {
        if (!room.readableBy(caller)) return noSuchTree(tree);
        if (std::optional<WriteRefusal> refusal = writeRefusalFor(caller, room.owner())) return ToolResult::failure(writeRefusalSentence(*refusal));
        const std::optional<std::string> renamed =
            title.isString() && !owning && room.title().value != title.asString() ? std::optional(title.asString()) : std::nullopt;
        const std::string blanked = guide.isString() && isBlankGuide(guide.asString()) ? "" : guide.asString();
        const std::optional<std::string> guided =
            guide.isString() && room.guide().value != blanked ? std::optional(blanked) : std::nullopt;
        if (renamed || guided) room.describe(renamed, guided, clock_.nowMs());
        return ToolResult::json(Json::Value(Json::objectValue));
      });
      if (described.answer.isError) return described.answer;
      unchanged = unchanged && !described.treeLanded;
      seq = described.seq;
      Json::Value out(Json::objectValue);
      out["applied"] = true;
      out["seq"] = static_cast<Json::Int64>(seq);
      if (!described.planned) out["resumed"] = true;
      else if (unchanged) out["unchanged"] = true;
      return ToolResult::json(out);
    });
  }

  if (name == "delete_tree") {
    return write([&](Call& call) -> ToolResult {
      // A call that ran before and was cut short after the death landed is answered as removed, its counts not told again.
      Json::Value resumed(Json::objectValue);
      resumed["deleted"] = true;
      resumed["id"] = tree.str();
      resumed["resumed"] = true;
      ToolResult answer = ToolResult::json(resumed);
      Json::Value removed(Json::arrayValue);
      Json::Value branch(Json::objectValue);
      Json::Value landed;
      try {
      landed = call.admitBuilt(roadmap::accountPlaceholder(tree.str()), [&](sync::SyncTxn& txn) -> std::optional<Json::Value> {
        const AccountRows mine = door_.rows().account(txn, caller);
        const TreeRows rows = door_.rows().tree(txn, tree.str(), std::nullopt);
        if (!mine.isAlive(tree.str())) {
          if (rows.exists() && rows.owner() != caller && opensToReaders(rows.reach()))
            refuse(ToolResult::failure(writeRefusalSentence(WriteRefusal::notYours)));
          refuse(noSuchTree(tree));
        }
        if (const std::optional<read::Parent> place = mine.placeOf(tree.str()))
          refuse(ToolResult::failure("this tree is a subtree: it hangs from step \"" + place->step + "\" of \"" + place->tree +
                                         "\" under the roadmap \"" + mine.rootOf(tree.str()) + "\", and goes and comes back "
                                         "with that step. Delete the step with delete_node, naming this tree in its "
                                         "branches, and revive the step to bring it back.",
                                     roadmap::engine::kNotARoot));
        // What the death takes, read before it lands: every standing subtree under it and their steps, and each step of
        // the caller's other roadmaps whose pointer opens it.
        std::vector<read::RoadmapTree> roadmaps;
        for (const auto& [id, record] : mine.trees) roadmaps.emplace_back(roadmap::recordsOf(door_.rows().tree(txn, id, caller), mine));
        const read::RoadmapAccount account(std::move(roadmaps));
        int subtrees = 0;
        int steps = 0;
        for (const auto& [id, held] : account.trees()) {
          const read::Location location = account.locationOf(id);
          if (location.standing != read::Standing::standing || location.place->root != tree.str()) continue;
          subtrees += id == tree.str() ? 0 : 1;
          steps += static_cast<int>(std::count_if(held.nodes.begin(), held.nodes.end(), [](const read::Step& step) { return step.present; }));
        }
        branch["subtrees"] = subtrees;
        branch["steps"] = steps;
        for (const auto& [id, held] : account.trees()) {
          if (id == tree.str() || !mine.isAlive(id)) continue;
          Json::Value nodeIds(Json::arrayValue);
          for (const read::Step& step : held.nodes) {
            const read::Pointer* pointer = held.pointerOn(step.id);
            if (step.present && pointer && pointer->present && pointer->opens == tree.str()) nodeIds.append(step.id);
          }
          if (nodeIds.empty()) continue;
          Json::Value row(Json::objectValue);
          row["treeId"] = id;
          row["nodeIds"] = nodeIds;
          removed.append(row);
        }
        Json::Value out(Json::objectValue);
        out["removed"] = removed;
        out["deleted"] = true;
        out["id"] = tree.str();
        out["branch"] = branch;
        answer = ToolResult::json(out);
        Json::Value deltas(Json::arrayValue);
        deltas.append(roadmap::Written{.type = "tree", .id = Json::Value(tree.str()), .life = sync::LifeState::dead,
                                       .born = mine.tree(tree.str())->lattice.born.value_or(Hlc{}), .derived = true}.json());
        return roadmap::intentIn("self/roadmap", deltas);
      });
      } catch (const Refused& refused) {
        return refused.answer;
      }
      if (!roadmap::landed(landed)) return refusedByEngine(landed, tree);
      return answer;
    });
  }

  if (name == "create_subtree") {
    std::string step;
    if (std::optional<std::string> bad = requireHandle(arguments, kNodeHandle, "", step)) return ToolResult::failure(*bad);
    if (std::optional<std::string> bad = checkKinds(arguments["kinds"], kMaxKinds)) return ToolResult::failure(*bad);
    std::optional<std::vector<Kind>> kinds;
    if (arguments["kinds"].isArray()) {
      kinds = kindsFromJson(arguments["kinds"]);
      if (!kinds) return ToolResult::failure("this subtree's kinds carry a field of the wrong type");
      if (std::optional<Admission> refusal = admitBornKinds(*kinds)) return ToolResult::failure(refusal->reason, "kinds-refused");
    }
    return write([&](Call& call) -> ToolResult {
      struct Holder {
        std::string root;
        std::int64_t depth = 0;
      };
      const auto holder = door_.read([&](sync::SyncTxn& txn) -> std::variant<Holder, ToolResult> {
        const TreeRows rows = door_.rows().tree(txn, tree.str(), std::nullopt);
        if (!rows.exists()) return noSuchTree(tree);
        const AccountRows trees = door_.rows().account(txn, rows.owner());
        if (rows.owner() != caller) {
          if (opensToReaders(rows.reach())) return ToolResult::failure(writeRefusalSentence(WriteRefusal::notYours), "not-yours");
          return ToolResult::failure("no such tree \"" + tree.str() + "\"", "no-such-tree");
        }
        if (!trees.isAlive(tree.str())) return ToolResult::failure("no such tree \"" + tree.str() + "\"", "no-such-tree");
        const sync::Row* node = rows.node(step);
        if (!node || !node->alive())
          return ToolResult::failure("no node in this tree is named " + quotedList({step}) + ". " + kNodeHandle.hint, "step-gone");
        const Json::Value depth = rows.meta ? rows.meta->lattice.f.count("depth") ? rows.meta->lattice.f.at("depth").value : Json::Value() : Json::Value();
        return Holder{trees.rootOf(tree.str()), depth.isIntegral() ? depth.asInt64() : 0};
      });
      if (const ToolResult* refused = std::get_if<ToolResult>(&holder)) return *refused;
      const Holder& held = std::get<Holder>(holder);
      const std::string proposed = arguments["requestId"].isString()
                                       ? "t_" + sync::sha256(caller.str() + "\n" + arguments["requestId"].asString()).hex().substr(0, 16)
                                       : "t_" + tokens_.mint().digest.substr(0, 16);
      Json::Value args(Json::objectValue);
      args["tree"] = tree.str();
      args["root"] = held.root;
      args["step"] = step;
      args["subtree"] = proposed;
      Json::Value intent = roadmap::intentIn("self/roadmap", Json::Value(Json::arrayValue));
      intent["cmd"]["name"] = "roadmap.createSubtree";
      intent["cmd"]["args"] = args;
      const Json::Value created = call.admit(intent);
      if (!roadmap::landed(created)) {
        const std::string code = roadmap::refusalOf(created);
        if (code == roadmap::engine::kStepOpensATree)
          return ToolResult::failure(subtreeRefusalSentence(SubtreeRefusal::stepOpensATree, tree, NodeId{step}), "step-opens-a-tree");
        if (code == roadmap::engine::kDepthLimit)
          return ToolResult::failure(subtreeRefusalSentence(SubtreeRefusal::depthLimit, tree, NodeId{step}), "depth-limit");
        if (code == sync::code::unknownRecord)
          return ToolResult::failure(subtreeRefusalSentence(SubtreeRefusal::stepGone, tree, NodeId{step}), "step-gone");
        return refusedByEngine(created, tree);
      }
      const std::string subtree = created["write"][0]["id"].asString();
      const bool made = subtree == proposed;
      if (made && kinds) {
        Json::Value deltas(Json::arrayValue);
        std::optional<std::string> ord;
        std::set<std::string> sent;
        for (const Kind& kind : *kinds) {
          sent.insert(kind.id.str());
          ord = sync::between(ord, std::nullopt);
          Json::Value fields(Json::objectValue);
          fields["hue"] = std::string(toString(kind.hue));
          fields["label"] = kind.label;
          fields["description"] = kind.description;
          fields["ord"] = *ord;
          deltas.append(roadmap::Written{.type = "kind", .id = Json::Value(kind.id.str()), .fields = fields,
                                         .life = sync::LifeState::alive, .derived = true}.json());
        }
        const Json::Value replanted = call.admitBuilt(roadmap::treePlaceholder(subtree), [&](sync::SyncTxn& txn) -> std::optional<Json::Value> {
          const TreeRows rows = door_.rows().tree(txn, subtree, std::nullopt);
          for (const sync::Row& kind : rows.kinds) {
            if (sent.contains(kind.id.column())) {
              for (Json::Value& delta : deltas)
                if (delta["id"] == kind.id.column()) delta["born"] = toString(kind.lattice.born.value_or(Hlc{}));
              continue;
            }
            deltas.append(roadmap::Written{.type = "kind", .id = Json::Value(kind.id.column()), .life = sync::LifeState::dead,
                                           .born = kind.lattice.born.value_or(Hlc{}), .derived = true}.json());
          }
          return roadmap::intentIn("tree/" + subtree, deltas);
        });
        if (!roadmap::landed(replanted)) return refusedByEngine(replanted, TreeId{subtree});
      }
      const Seq parentSeq = door_.read([&](sync::SyncTxn& txn) { return door_.rows().tree(txn, tree.str(), std::nullopt).seq(); });
      Json::Value out(Json::objectValue);
      out["created"] = made;
      out["subtree"]["id"] = subtree;
      out["subtree"]["root"] = held.root;
      out["subtree"]["parent"]["tree"] = tree.str();
      out["subtree"]["parent"]["step"] = step;
      out["subtree"]["depth"] = static_cast<Json::Int64>(held.depth + 1);
      out["parentSeq"] = static_cast<Json::Int64>(parentSeq);
      if (!made && kinds)
        out["kindsError"] = "This step already owns this subtree, which keeps the legend it was created with: the kinds sent "
                            "were not planted. Change its legend with add_kind, update_kind and remove_kind.";
      ToolResult answered = ToolResult::json(out);
      if (!made) answered.outcomeCode = "unchanged";
      return answered;
    });
  }

  if (name == "create_node" || name == "add_kind" || name == "remove_kind") {
    Json::Value payload = arguments;
    payload.removeMember("treeId");
    payload.removeMember("requestId");
    const bool sentOpens = !std::as_const(payload)["opens"].isNull();
    if (std::optional<std::string> bad = prepareEdit(name, payload)) return ToolResult::failure(*bad);
    const std::string kind = *commandKindFor(name);
    return write([&](Call& call) -> ToolResult {
      std::string created;
      // A created step always takes the pointer the call names, or none: the step a resumed call created is the one its
      // tree write took, the row that write left at its seq.
      const SentPointers opensOf = [&](const TreeRows& rows, const TreeEdit& edited) -> std::vector<roadmap::Opens> {
        std::string step = created;
        if (!edited.planned)
          for (const sync::Row& node : rows.nodes)
            if (node.seq == edited.seq && node.alive()) step = node.id.column();
        if (step.empty()) return {};
        return {roadmap::Opens{step, payload.get("opens", "").asString()}};
      };
      return editTree(call, tree, caller, [&](TreeRoom& room, const TreeRows& rows, const AccountRows&, sync::SyncTxn& txn) -> ToolResult {
        if (!room.readableBy(caller)) return noSuchTree(tree);
        if (std::optional<WriteRefusal> refusal = writeRefusalFor(caller, room.owner())) return ToolResult::failure(writeRefusalSentence(*refusal));
        Json::Value command = payload;
        const std::string sentId = command.get("id", "").asString();
        if (name == "create_node" && sentId.empty()) {
          std::set<std::string> taken;
          for (const sync::Row& node : rows.nodes) taken.insert(node.id.column());
          command["id"] = sync::deriveId(command.get("label", "").asString(), "step", taken, kMaxIdLength);
        }
        if (name == "create_node") created = command["id"].asString();
        if (command.isMember("links")) {
          const auto links = shownLinks({}, linksFromJson(command["links"]), "links");
          if (const auto* refusal = std::get_if<std::string>(&links)) return ToolResult::failure(*refusal);
          command["links"] = linksToJson(std::get<std::vector<Link>>(links));
        }
        const bool setsHue = name == "create_node";
        if (setsHue && command.isMember("kind")) {
          const HueChoice choice{parseColor(command.get("color", "").asString()), KindId{command["kind"].asString()}};
          const auto hue = room.resolveHue(choice, std::nullopt, "");
          if (const auto* refusal = std::get_if<KindRefusal>(&hue)) return kindRefused(*refusal);
          command["color"] = std::string(toString(*std::get<std::optional<NodeColor>>(hue)));
        }
        if (setsHue && !command.isMember("kind") && !command.isMember("color")) {
          const std::string named = sentId.empty() ? "the node" : "node \"" + sentId + "\"";
          if (const std::optional<KindRefusal> refusal = unnamedHueRefusal(room.kinds(), {named}, JudgedLegend::held))
            return kindRefused(*refusal);
        }
        const std::optional<Command> decoded = commandFromJson(kind, command);
        if (!decoded)
          return ToolResult::failure("the arguments passed every published check but no " + kind +
                                     " could be built from them — that is a server bug, please report it.");
        if (std::optional<std::string> reason = room.validate(*decoded)) return ToolResult::failure(*reason);
        std::vector<SentPointer> opened;
        if (const CreateNode* created = std::get_if<CreateNode>(&*decoded); created && created->opens && sentOpens)
          opened.push_back({"opens", created->id, *created->opens});
        if (std::optional<ToolResult> refusal = checkPointers(door_.rows(), txn, caller, room, opened)) return *refusal;
        const std::vector<NodeId> refused = refusedPointersOf(room, opened);
        countCurrentWriteRefused(refused.size());
        const TreeDiagnostics before = followedDiagnostics(room);
        const Seq seq = room.applyCommand(*decoded, clock_.nowMs(), caller);
        Json::Value out(Json::objectValue);
        out["applied"] = true;
        out["seq"] = static_cast<Json::Int64>(seq);
        answerDiagnostics(before, followedDiagnostics(room), out);
        answerRefusedPointers(refused, out);
        if (command.isMember("id")) out["id"] = command["id"];
        if (setsHue && command.isMember("kind")) out["kind"] = command["kind"];
        if (setsHue && !command.isMember("kind")) {
          const NodeColor hue = std::get<CreateNode>(*decoded).color;
          for (const Kind& held : room.kinds())
            if (held.hue == hue) out["kind"] = held.id.str();
        }
        return ToolResult::json(out);
      }, name == "create_node" ? opensOf : nullptr).answer;
    });
  }

  if (name == "update_kind") {
    std::string kind;
    if (std::optional<std::string> bad = requireHandle(arguments, kKindHandle, "", kind)) return ToolResult::failure(*bad);
    if (std::optional<std::string> bad = optionalString(arguments["label"], "label", kMaxKindLabelLength)) return ToolResult::failure(*bad);
    if (std::optional<std::string> bad = optionalString(arguments["description"], "description", kMaxKindDescriptionLength))
      return ToolResult::failure(*bad);
    if (std::optional<std::string> bad = optionalOneOf(arguments["hue"], "hue", kHues)) return ToolResult::failure(*bad);
    KindUpdate update{KindId{kind}};
    if (arguments["label"].isString()) update.label = arguments["label"].asString();
    if (arguments["description"].isString()) update.description = arguments["description"].asString();
    if (arguments["hue"].isString()) update.hue = parseColor(arguments["hue"].asString());
    return write([&](Call& call) -> ToolResult {
      return editTree(call, tree, caller, [&](TreeRoom& room, const TreeRows&, const AccountRows&, sync::SyncTxn& txn) -> ToolResult {
        if (!room.readableBy(caller)) return noSuchTree(tree);
        if (std::optional<WriteRefusal> refusal = writeRefusalFor(caller, room.owner())) return ToolResult::failure(writeRefusalSentence(*refusal));
        const std::variant<KindUpdatePlan, std::string> planned = room.planKindUpdate(update);
        if (const auto* refusal = std::get_if<std::string>(&planned)) return ToolResult::failure(*refusal);
        const KindUpdatePlan& plan = std::get<KindUpdatePlan>(planned);
        const TreeDiagnostics before = followedDiagnostics(room);
        Seq seq = room.head();
        if (!plan.landsNothing()) seq = room.applyCommands(plan.commands, clock_.nowMs(), caller);
        Json::Value out(Json::objectValue);
        out["applied"] = true;
        out["seq"] = static_cast<Json::Int64>(seq);
        out["id"] = update.id.str();
        if (plan.landsNothing()) out["unchanged"] = true;
        if (plan.repaintedNodes) out["repaintedNodes"] = static_cast<Json::UInt64>(*plan.repaintedNodes);
        answerDiagnostics(before, followedDiagnostics(room), out);
        return ToolResult::json(out);
      }).answer;
    });
  }

  if (name == "update_nodes" || name == "change_edges") {
    if (std::optional<std::string> bad = optionalBool(arguments["dryRun"], "dryRun")) return ToolResult::failure(*bad);
    if (std::optional<std::string> bad = checkExpectedSeq(arguments)) return ToolResult::failure(*bad);
    const bool nodes = name == "update_nodes";
    std::vector<NodePatch> patches;
    std::vector<NodeId> rows;
    std::vector<RequestedMark> marks;
    std::vector<SentPointer> opened;
    EdgeChanges edges;
    if (nodes) {
      if (std::optional<std::string> bad = requireObjects(arguments["updates"], "updates", kMaxPatchNodes)) return ToolResult::failure(*bad);
      const std::vector<const char*> treeFields = {"label", "color", "kind", "description", "appendDescription", "icon",
                                                   "links", "addLinks", "opens"};
      std::set<std::string> named;
      for (Json::ArrayIndex i = 0; i < arguments["updates"].size(); ++i) {
        const Json::Value& row = arguments["updates"][i];
        const std::string path = "updates[" + std::to_string(i) + "]";
        if (std::optional<std::string> bad = requireString(row["nodeId"], path + ".nodeId", Empty::rejected, kMaxIdLength))
          return ToolResult::failure(*bad);
        if (!named.insert(row["nodeId"].asString()).second)
          return ToolResult::failure("updates repeats nodeId " + quotedList({row["nodeId"].asString()}));
        for (const char* field : {"label", "icon", "description", "appendDescription"}) {
          if (!row.isMember(field)) continue;
          if (std::optional<std::string> bad = requireString(row[field], path + "." + field, Empty::allowed)) return ToolResult::failure(*bad);
        }
        if (row.isMember("description") && row.isMember("appendDescription"))
          return ToolResult::failure(path + ": \"description\" and \"appendDescription\" are both given — pass one: "
                                     "description replaces the body, appendDescription joins onto it.");
        if (row.isMember("links") && row.isMember("addLinks"))
          return ToolResult::failure(path + ": \"links\" and \"addLinks\" are both given — pass one: links replaces "
                                     "the set, addLinks joins onto it.");
        if (row.isMember("color"))
          if (std::optional<std::string> bad = requireOneOf(row["color"], path + ".color", kHues)) return ToolResult::failure(*bad);
        if (std::optional<std::string> bad = optionalKind(row["kind"], path + ".kind")) return ToolResult::failure(*bad);
        for (const char* field : {"links", "addLinks"}) {
          if (!row.isMember(field)) continue;
          if (!row[field].isArray()) return ToolResult::failure(path + "." + field + " must be an array");
          if (std::optional<std::string> bad = optionalLinks(row[field], path + "." + field)) return ToolResult::failure(*bad);
        }
        if (row["addLinks"].isArray() && row["addLinks"].empty())
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
        if (row.isMember("links")) patch.links = linksFromJson(row["links"]);
        if (row.isMember("appendDescription")) patch.appendDescription = row["appendDescription"].asString();
        if (row.isMember("addLinks")) patch.addLinks = linksFromJson(row["addLinks"]);
        if (row.isMember("opens")) {
          patch.opens = TreeId{row["opens"].asString()};
          opened.push_back({path + ".opens", patch.nodeId, *patch.opens});
        }
        bool carriesTree = false;
        for (const char* field : treeFields) carriesTree = carriesTree || !row[field].isNull();
        const bool carriesMark = !row["status"].isNull() || !row["outOfOrder"].isNull();
        if (carriesMark) {
          std::variant<RequestedMark, std::string> mark = readMark(row, path);
          if (const auto* bad = std::get_if<std::string>(&mark)) return ToolResult::failure(*bad);
          marks.push_back(std::get<RequestedMark>(std::move(mark)));
        }
        if (!carriesTree && !carriesMark)
          return ToolResult::failure(path + " sets nothing — pass at least one of label, color, kind, description, "
                                     "appendDescription, icon, links, addLinks, opens, status.");
        rows.push_back(patch.nodeId);
        if (carriesTree) patches.push_back(std::move(patch));
      }
    } else {
      for (const char* field : {"add", "remove"}) {
        if (!arguments.isMember(field)) continue;
        if (std::optional<std::string> bad = requireObjects(arguments[field], field, kMaxChangeEdges)) return ToolResult::failure(*bad);
        for (Json::ArrayIndex i = 0; i < arguments[field].size(); ++i) {
          const Json::Value& row = arguments[field][i];
          const std::string path = std::string(field) + "[" + std::to_string(i) + "]";
          for (const char* endpoint : {"from", "to"})
            if (std::optional<std::string> bad = requireString(row[endpoint], path + "." + endpoint, Empty::rejected, kMaxIdLength))
              return ToolResult::failure(*bad);
          const Edge edge{NodeId{row["from"].asString()}, NodeId{row["to"].asString()}};
          if (std::string_view(field) == "add") edges.add.push_back(edge);
          else edges.remove.push_back(edge);
        }
      }
    }
    const bool dryRun = arguments["dryRun"].asBool();
    const bool marksAlone = nodes && patches.empty();
    return write([&](Call& call) -> ToolResult {
      // Marks alone write the caller's own overlay, which reading the tree is enough for.
      if (marksAlone) {
        Json::Value out(Json::objectValue);
        std::optional<Seq> head;
        const bool known = door_.read([&](sync::SyncTxn& txn) {
          const std::optional<Reading> reading = readingOf(door_.rows(), txn, tree, caller);
          if (!reading || !reading->readable()) return false;
          head = reading->rows.seq();
          return true;
        });
        if (!known) return noSuchTree(tree);
        if (arguments.isMember("expectedSeq") && arguments["expectedSeq"].asInt64() != static_cast<Json::Int64>(*head))
          return ToolResult::failure("expectedSeq conflict: requested " + arguments["expectedSeq"].asString() +
                                     ", current seq is " + std::to_string(*head) +
                                     ". Nothing changed; read get_nodes or get_tree and retry with the current seq.");
        out["treeId"] = tree.str();
        out["dryRun"] = dryRun;
        out["applied"] = !dryRun;
        out["seq"] = static_cast<Json::Int64>(*head);
        if (dryRun) return ToolResult::json(out);
        out["unchanged"] = true;
        ToolResult answered = carryMarks(call, tree, caller, marks, true, false, ToolResult::json(out), "");
        if (!answered.isError) answered.structured = answered.payload;
        return answered;
      }
      std::vector<NodeId> refused;
      TreeDiagnostics before;
      TreeDiagnostics after;
      bool pointersMoved = false;
      TreeEdit edited = editTree(call, tree, caller, [&](TreeRoom& room, const TreeRows&, const AccountRows&, sync::SyncTxn& txn) -> ToolResult {
        if (!room.readableBy(caller)) return noSuchTree(tree);
        if (std::optional<WriteRefusal> refusal = writeRefusalFor(caller, room.owner())) return ToolResult::failure(writeRefusalSentence(*refusal));
        if (arguments.isMember("expectedSeq") && arguments["expectedSeq"].asInt64() != static_cast<Json::Int64>(room.head()))
          return ToolResult::failure("expectedSeq conflict: requested " + arguments["expectedSeq"].asString() +
                                     ", current seq is " + std::to_string(room.head()) +
                                     ". Nothing changed; read get_nodes or get_tree and retry with the current seq.");
        Batch batch;
        bool landsNothing = true;
        Json::Value out(Json::objectValue);
        out["treeId"] = tree.str();
        if (nodes) {
          std::vector<std::string> missing;
          for (const NodeId& node : rows)
            if (!room.hasNode(node)) missing.push_back(node.str());
          if (!missing.empty()) return ToolResult::failure("no node in this tree is named " + quotedList(missing) + ". " + kNodeHandle.hint);
          const auto result = room.planNodePatches(patches);
          if (const auto* error = std::get_if<std::string>(&result)) return ToolResult::failure(*error);
          if (const auto* refusal = std::get_if<KindRefusal>(&result)) return kindRefused(*refusal);
          {
            if (std::optional<ToolResult> refusal = checkPointers(door_.rows(), txn, caller, room, opened)) return *refusal;
            refused = refusedPointersOf(room, opened);
            const NodePatchPlan& plan = std::get<NodePatchPlan>(result);
            batch = plan.batch;
            landsNothing = plan.landsNothing();
            const std::set<NodeId> changed(plan.changedNodeIds.begin(), plan.changedNodeIds.end());
            out["changedNodeIds"] = Json::Value(Json::arrayValue);
            out["unchangedNodeIds"] = Json::Value(Json::arrayValue);
            for (const NodePatch& patch : patches)
              out[changed.count(patch.nodeId) ? "changedNodeIds" : "unchangedNodeIds"].append(patch.nodeId.str());
            out["dryRun"] = dryRun;
            out["applied"] = !dryRun;
            out["seq"] = static_cast<Json::Int64>(room.head());
            if (landsNothing) out["unchanged"] = true;
            answerRefusedPointers(refused, out);
            if (dryRun) return ToolResult::json(out);
            countCurrentWriteRefused(refused.size());
            const std::map<NodeId, TreeId> pointersBefore = room.pointers();
            before = followedDiagnostics(room);
            if (!landsNothing) out["seq"] = static_cast<Json::Int64>(room.applyCommands(batch.commands, clock_.nowMs(), caller));
            after = followedDiagnostics(room);
            pointersMoved = !pointersSetSince(pointersBefore, room.pointers()).empty();
            answerDiagnostics(before, after, out);
            return ToolResult::json(out);
          }
        }
        const auto result = room.planEdgeChanges(edges);
        if (const auto* error = std::get_if<std::string>(&result)) {
          if (edges.add.empty() && edges.remove.empty())
            return ToolResult::failure(*error + ". Call get_tree with fields [\"id\",\"prerequisites\"] to list the edges this tree has.");
          return ToolResult::failure(*error);
        }
        const EdgeChangePlan& plan = std::get<EdgeChangePlan>(result);
        out["addedEdges"] = Json::Value(Json::arrayValue);
        out["removedEdges"] = Json::Value(Json::arrayValue);
        for (const auto& [field, values] : {std::pair{"addedEdges", &plan.added}, {"removedEdges", &plan.removed}})
          for (const Edge& edge : *values) {
            Json::Value row(Json::objectValue);
            row["from"] = edge.from.str();
            row["to"] = edge.to.str();
            out[field].append(row);
          }
        out["unchangedEdges"] = static_cast<Json::UInt64>(edges.add.size() + edges.remove.size() - plan.added.size() - plan.removed.size());
        out["dryRun"] = dryRun;
        out["applied"] = !dryRun;
        out["seq"] = static_cast<Json::Int64>(room.head());
        if (plan.landsNothing()) out["unchanged"] = true;
        if (dryRun) return ToolResult::json(out);
        before = followedDiagnostics(room);
        if (!plan.landsNothing()) out["seq"] = static_cast<Json::Int64>(room.applyCommands(plan.batch.commands, clock_.nowMs(), caller));
        after = followedDiagnostics(room);
        answerDiagnostics(before, after, out);
        return ToolResult::json(out);
      }, [&](const TreeRows&, const TreeEdit&) {
        std::vector<roadmap::Opens> sent;
        if (!dryRun)
          for (const SentPointer& pointer : opened) sent.push_back(roadmap::Opens{pointer.step.str(), pointer.tree.str()});
        return sent;
      });
      if (edited.answer.isError) return edited.answer;
      if (pointersMoved && !dryRun) {
        Json::Value receipt = edited.answer.payload;
        answerClosedLoops(door_, tree, caller, before, after, receipt);
        edited.answer = withPayload(edited.answer, receipt);
      }
      ToolResult answered = edited.answer;
      if (!dryRun && !marks.empty())
        answered = carryMarks(call, tree, caller, marks, true, edited.treeLanded, answered, "The marks did not apply: ");
      if (!answered.isError && !dryRun && !edited.treeLanded && marks.empty() && !refused.empty()) answered.outcomeCode = kOwnsASubtree;
      answered.structured = answered.payload;
      return answered;
    });
  }

  if (name == "delete_node") {
    std::vector<NodeId> targets;
    if (std::optional<std::string> bad = deleteTargets(arguments, targets)) return ToolResult::failure(*bad);
    std::variant<std::set<TreeId>, std::string> named = branchesOf(arguments, kMaxDeleteNodeIds);
    if (const std::string* bad = std::get_if<std::string>(&named)) return ToolResult::failure(*bad);
    const std::set<TreeId> branches = std::get<std::set<TreeId>>(std::move(named));
    if (!arguments["prune"].isNull() && !arguments["prune"].isBool())
      return ToolResult::failure("argument \"prune\" must be a boolean, got " + typeName(arguments["prune"]));
    const bool prune = arguments["prune"].asBool();
    const bool single = arguments["nodeIds"].isNull();
    return write([&](Call& call) -> ToolResult {
      // The call is judged as the caller's completions on the steps it deletes are cleared, under the overlay's lock and
      // before the deaths land, so a refused call clears nothing and a delete leaves no mark a revival would bring back.
      std::optional<std::size_t> cleared;
      try {
        cleared = clearMarks(call, tree, caller, targets, [&](sync::SyncTxn& txn, const TreeRows& rows) {
          if (!rows.exists()) refuse(noSuchTree(tree));
          const AccountRows account = door_.rows().account(txn, rows.owner());
          NullPresenceBus bus;
          const std::unique_ptr<TreeRoom> room = roadmap::roomOf(rows, account, bus);
          if (!room->readableBy(caller)) refuse(noSuchTree(tree));
          if (std::optional<WriteRefusal> refusal = writeRefusalFor(caller, room->owner()))
            refuse(ToolResult::failure(writeRefusalSentence(*refusal)));
          std::vector<std::string> missing;
          for (const NodeId& node : targets)
            if (!room->hasNode(node)) missing.push_back(node.str());
          if (!missing.empty())
            refuse(ToolResult::failure("no node in this tree is named " + quotedList(missing) + " — nothing was deleted. " + kNodeHandle.hint));
          if (std::vector<UnconfirmedBranch> unconfirmed = room->unconfirmedBranches(targets, branches); !unconfirmed.empty())
            refuse(ToolResult::failure(branchesUnconfirmed(door_.rows(), txn, account, unconfirmed), kBranchUnconfirmed));
        });
      } catch (const Refused& refused) {
        return refused.answer;
      }
      const TreeEdit edited = editTree(call, tree, caller, [&](TreeRoom& room, const TreeRows&, const AccountRows&, sync::SyncTxn& txn) -> ToolResult {
        std::vector<Command> commands;
        for (const NodeId& node : targets) commands.push_back(DeleteNode{node});
        const std::vector<Edge> dangled = prune ? room.edgesTouching(targets) : std::vector<Edge>{};
        for (const Edge& edge : dangled) commands.push_back(RemoveEdge{edge.from, edge.to});
        for (const Command& command : commands)
          if (std::optional<std::string> reason = room.validate(command)) return ToolResult::failure(*reason);
        const TreeDiagnostics before = followedDiagnostics(room);
        const Seq seq = room.applyCommands(commands, clock_.nowMs(), caller, branches);
        Json::Value ids(Json::arrayValue);
        for (const NodeId& node : targets) ids.append(node.str());
        Json::Value pruned(Json::objectValue);
        pruned["edges"] = static_cast<int>(dangled.size());
        pruned["progress"] = static_cast<int>(cleared.value_or(0));
        Json::Value out(Json::objectValue);
        out["applied"] = true;
        out["seq"] = static_cast<Json::Int64>(seq);
        answerDiagnostics(before, followedDiagnostics(room), out);
        if (single) out["id"] = targets.front().str();
        out["ids"] = ids;
        out["pruned"] = pruned;
        return ToolResult::json(out);
      });
      if (!cleared && !edited.answer.isError) return resumedReceipt(tree, edited.seq);
      return edited.answer;
    });
  }

  if (name == "import_subgraph") {
    if (std::optional<std::string> bad = checkImport(arguments)) return ToolResult::failure(*bad);
    std::vector<RequestedMark> carried;
    for (Json::ArrayIndex i = 0; i < arguments["progress"].size(); ++i) {
      std::variant<RequestedMark, std::string> mark = readMark(arguments["progress"][i], "progress[" + std::to_string(i) + "]");
      if (const auto* bad = std::get_if<std::string>(&mark)) return ToolResult::failure(*bad);
      carried.push_back(std::get<RequestedMark>(std::move(mark)));
    }
    if (std::optional<std::string> bad = checkExpectedSeq(arguments)) return ToolResult::failure(*bad);
    if (arguments["tombstone"].size() > 0 && !actor.scope.allows(kRoadmapProduct, Access::del))
      return ToolResult::failure(notGrantedSentence(kRoadmapProduct, Access::del));
    std::optional<TreeData> parsed = treeFromJson(arguments, tree);
    if (!parsed) return ToolResult::failure("this import's nodes or kinds carry a field of the wrong type");
    Graft graft;
    graft.document = *std::move(parsed);
    std::map<std::string, std::string> seeds;
    for (const Json::Value& node : arguments["nodes"])
      if (node["seedStatus"].isString()) seeds[node["id"].asString()] = node["seedStatus"].asString();
    for (NodeSpec& node : graft.document.nodes) {
      const auto seed = seeds.find(node.id.str());
      if (seed != seeds.end()) node.status = normalizeSeedStatus(seed->second);
    }
    for (const Json::Value& node : arguments["nodes"]) {
      const NodeId id{node["id"].asString()};
      std::set<NodeRegister>& omitted = graft.omittedNodeRegisters[id];
      for (const auto& [field, held] : kImportedNodeRegisters)
        if (node[field].isNull()) omitted.insert(held);
      if (node["prerequisites"].isNull()) graft.omittedPrerequisites.insert(id);
      if (node["kind"].isString()) graft.nodeKinds[id] = KindId{node["kind"].asString()};
    }
    for (const Json::Value& kind : arguments["kinds"]) {
      std::set<KindRegister>& omitted = graft.omittedKindRegisters[KindId{kind["id"].asString()}];
      for (const auto& [field, held] : kImportedKindRegisters)
        if (kind[field].isNull()) omitted.insert(held);
    }
    const bool replace = arguments["prerequisiteMode"].asString() == "replace";
    graft.prerequisites = replace ? PrerequisiteMode::replace : PrerequisiteMode::merge;
    for (const Json::Value& id : arguments["tombstone"]) graft.tombstones.emplace_back(id.asString());
    std::variant<std::set<TreeId>, std::string> named = branchesOf(arguments, kMaxTombstones);
    if (const std::string* bad = std::get_if<std::string>(&named)) return ToolResult::failure(*bad);
    graft.branches = std::get<std::set<TreeId>>(std::move(named));
    const bool dryRun = arguments["dryRun"].asBool();
    return write([&](Call& call) -> ToolResult {
      std::vector<NodeId> refused;
      TreeDiagnostics before;
      TreeDiagnostics after;
      bool pointersMoved = false;
      TreeEdit edited = editTree(call, tree, caller, [&](TreeRoom& room, const TreeRows&, const AccountRows& account, sync::SyncTxn& txn) -> ToolResult {
        if (!room.readableBy(caller)) return noSuchTree(tree);
        if (std::optional<WriteRefusal> refusal = writeRefusalFor(caller, room.owner())) return ToolResult::failure(writeRefusalSentence(*refusal));
        if (arguments.isMember("expectedSeq") && arguments["expectedSeq"].asInt64() != static_cast<Json::Int64>(room.head()))
          return ToolResult::failure("expectedSeq conflict: requested " + arguments["expectedSeq"].asString() +
                                     ", current seq is " + std::to_string(room.head()) +
                                     ". Nothing changed; read get_nodes or get_tree and retry with the current seq.");
        std::vector<std::string> missing;
        for (const NodeId& id : graft.tombstones)
          if (!room.hasNode(id)) missing.push_back(id.str());
        if (!missing.empty())
          return ToolResult::failure("tombstone names " + quotedList(missing) + ", which this tree does not hold. " + kNodeHandle.hint);
        {
          if (std::vector<UnconfirmedBranch> unconfirmed = room.unconfirmedBranches(graft); !unconfirmed.empty())
            return ToolResult::failure(branchesUnconfirmed(door_.rows(), txn, account, unconfirmed), kBranchUnconfirmed);
          std::variant<Graft, std::string> shown = room.resolveLinks(graft);
          if (const auto* refusal = std::get_if<std::string>(&shown)) return ToolResult::failure(*refusal);
          Graft landing = std::get<Graft>(std::move(shown));
          if (std::optional<Admission> refusal = room.admit(landing)) return ToolResult::failure(refusal->reason);
          std::vector<SentPointer> opened;
          for (std::size_t i = 0; i < landing.document.nodes.size(); ++i) {
            const NodeSpec& node = landing.document.nodes[i];
            if (landing.carries(node.id, NodeRegister::opens))
              opened.push_back({"nodes[" + std::to_string(i) + "].opens", node.id, node.opens});
          }
          if (std::optional<ToolResult> refusal = checkPointers(door_.rows(), txn, caller, room, opened)) return *refusal;
          refused = refusedPointersOf(room, opened);
          const TreeData& incoming = landing.document;
          const TreeData current = room.snapshot();
          if (std::optional<Admission> refusal = admitMergedKinds(current.kinds, incoming.kinds)) return ToolResult::failure(refusal->reason);
          std::variant<Graft, KindRefusal> filed = room.resolveKinds(landing);
          if (const auto* refusal = std::get_if<KindRefusal>(&filed)) return kindRefused(*refusal);
          landing = std::get<Graft>(std::move(filed));
          std::set<std::string> presentNodes;
          std::set<std::string> presentKinds;
          for (const NodeSpec& node : current.nodes) presentNodes.insert(node.id.str());
          for (const Kind& kind : current.kinds) presentKinds.insert(kind.id.str());
          Json::Value nodeCollisions(Json::arrayValue);
          Json::Value kindCollisions(Json::arrayValue);
          for (const NodeSpec& node : incoming.nodes)
            if (presentNodes.count(node.id.str())) nodeCollisions.append(node.id.str());
          for (const Kind& kind : incoming.kinds)
            if (presentKinds.count(kind.id.str())) kindCollisions.append(kind.id.str());
          int edgeCount = 0;
          for (const NodeSpec& node : incoming.nodes) edgeCount += static_cast<int>(node.prerequisites.size());
          const GraftFootprint footprint = room.footprintOf(landing);
          Json::Value out(Json::objectValue);
          out["nodes"] = static_cast<int>(incoming.nodes.size());
          out["edges"] = edgeCount;
          out["kinds"] = static_cast<int>(incoming.kinds.size());
          out["nodeCollisions"] = nodeCollisions;
          out["kindCollisions"] = kindCollisions;
          out["newNodes"] = static_cast<int>(incoming.nodes.size()) - static_cast<int>(nodeCollisions.size());
          out["newKinds"] = static_cast<int>(incoming.kinds.size()) - static_cast<int>(kindCollisions.size());
          out["prerequisiteMode"] = replace ? "replace" : "merge";
          answerKeptEdges(footprint.keptEdges, out);
          if (replace) out["removedEdges"] = static_cast<Json::UInt64>(footprint.replacedEdges.size());
          Json::Value counts(Json::objectValue);
          counts["nodes"] = static_cast<Json::UInt64>(footprint.tombstonedNodes.size());
          counts["edges"] = static_cast<Json::UInt64>(footprint.tombstonedEdges.size());
          out["tombstoned"] = counts;
          if (const Repaint repaint = room.repaintOf(landing); !repaint.rehued.empty())
            out["repaintedNodes"] = static_cast<Json::UInt64>(repaint.present);
          answerRefusedPointers(refused, out);
          if (dryRun) {
            out["dryRun"] = true;
            const bool marksAlone = incoming.nodes.empty() && incoming.kinds.empty() && landing.tombstones.empty() && !carried.empty();
            if (room.graftLandsNothing(landing, clock_.nowMs()) && !marksAlone) out["unchanged"] = true;
            Json::Value tombstone(Json::arrayValue);
            for (const NodeId& id : footprint.tombstonedNodes) tombstone.append(id.str());
            out["tombstone"] = tombstone;
            if (!carried.empty()) {
              std::set<std::string> afterGraft = presentNodes;
              for (const NodeSpec& node : incoming.nodes) afterGraft.insert(node.id.str());
              for (const NodeId& id : footprint.tombstonedNodes) afterGraft.erase(id.str());
              Json::Value skipped(Json::arrayValue);
              for (const RequestedMark& mark : carried)
                if (!afterGraft.count(mark.node.str())) skipped.append(mark.node.str());
              if (!skipped.empty()) out["progressSkipped"] = skipped;
            }
            return ToolResult::json(out);
          }
          countCurrentWriteRefused(refused.size());
          const std::map<NodeId, TreeId> pointersBefore = room.pointers();
          before = followedDiagnostics(room);
          const std::optional<Seq> landed = room.importTree(landing, clock_.nowMs(), caller);
          out["graphApplied"] = true;
          out["progressApplied"] = true;
          out["imported"] = true;
          out["seq"] = static_cast<Json::Int64>(landed.value_or(room.head()));
          if (!landed) out["unchanged"] = true;
          after = followedDiagnostics(room);
          pointersMoved = !pointersSetSince(pointersBefore, room.pointers()).empty();
          answerDiagnostics(before, after, out);
          return ToolResult::json(out);
        }
      }, [&](const TreeRows&, const TreeEdit&) {
        std::vector<roadmap::Opens> sent;
        if (!dryRun)
          for (const Json::Value& node : arguments["nodes"])
            if (node["opens"].isString()) sent.push_back(roadmap::Opens{node["id"].asString(), node["opens"].asString()});
        return sent;
      });
      if (edited.answer.isError || dryRun) return edited.answer;
      ToolResult grafted = edited.answer;
      // The caller's completions on what the tombstones took, cleared once the graft has landed.
      if (!graft.tombstones.empty()) {
        try {
          clearMarks(call, tree, caller, graft.tombstones);
        } catch (const Refused&) {
          Json::Value receipt = grafted.payload;
          fellShort(receipt, "The graph committed, but clearing progress on removed nodes failed. Read get_progress before "
                             "retrying progress changes.");
          grafted = withPayload(grafted, receipt);
        }
      }
      if (pointersMoved) {
        Json::Value receipt = grafted.payload;
        answerClosedLoops(door_, tree, caller, before, after, receipt);
        grafted = withPayload(grafted, receipt);
      }
      if (carried.empty()) {
        if (!refused.empty() && grafted.payload.get("unchanged", false).asBool()) grafted.outcomeCode = kOwnsASubtree;
        return grafted;
      }
      return carryMarks(call, tree, caller, carried, false, edited.treeLanded, grafted,
                        "The graph committed, but the requested progress did not apply: ");
    });
  }

  return ToolResult::failure("no such roadmap tool — call tools/list for the surface this connection may use.");
}

}
