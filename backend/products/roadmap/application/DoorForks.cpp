#include "products/roadmap/application/DoorForks.h"

#include "platform/application/WriteObservation.h"
#include "platform/domain/sync/Registry.h"
#include "products/roadmap/domain/read/RoadmapAccount.h"

#include <trantor/utils/Logger.h>

#include <algorithm>
#include <map>
#include <set>

namespace wm {

namespace {

using roadmap::AccountRows;
using roadmap::TreeRows;
using roadmap::Written;
namespace read = roadmap::read;

// IMPORT_CHUNK (Roadmap on the sync engine §13): the most records one of a copy's intents carries.
constexpr std::size_t kChunk = 500;

bool opensToReaders(Visibility reach) { return reach == Visibility::unlisted || reach == Visibility::public_; }

Json::Value valueOf(const sync::Row& row, const char* field) {
  const auto found = row.lattice.f.find(field);
  return found == row.lattice.f.end() ? Json::Value() : found->second.value;
}

// One roadmap of the branch and the copy it becomes: the copy's id, and the place it hangs from in the copy.
struct Copy {
  TreeRows rows;
  std::string id;
  std::optional<read::Parent> parent;
};

// What a fork reads of its source in one snapshot: the branch, root first and each subtree after the roadmap holding
// its step, or why there is nothing to copy.
struct Branch {
  std::vector<Copy> copies;
  bool ownsSource = false;
  std::optional<TreeForks::Result> refused;
};

Branch branchOf(const roadmap::RoadmapRows& rows, sync::SyncTxn& txn, const TreeId& source, const UserId& forker) {
  Branch branch;
  TreeRows root = rows.tree(txn, source.str(), std::nullopt);
  if (!root.exists()) return Branch{{}, false, TreeForks::Result{TreeForks::Outcome::noSource, {}, std::nullopt}};
  const AccountRows trees = rows.account(txn, root.owner());
  branch.ownsSource = root.owner() == forker;
  const bool readable = branch.ownsSource || opensToReaders(root.reach());
  if (!trees.isAlive(source.str()) || !readable)
    return Branch{{}, false, TreeForks::Result{TreeForks::Outcome::noSource, {}, std::nullopt}};
  if (const std::optional<read::Parent> place = trees.placeOf(source.str()))
    return Branch{{}, false, TreeForks::Result{TreeForks::Outcome::notARoot, {},
                                               NotARoot{OwningStep{TreeId{place->tree}, NodeId{place->step}}, TreeId{trees.rootOf(source.str())}}}};
  std::vector<read::RoadmapTree> roadmaps;
  std::map<std::string, TreeRows> held;
  for (const auto& [id, record] : trees.trees) {
    TreeRows treeRows = rows.tree(txn, id, std::nullopt);
    roadmaps.emplace_back(roadmap::recordsOf(treeRows, trees));
    held.emplace(id, std::move(treeRows));
  }
  const read::RoadmapAccount account(std::move(roadmaps));
  std::vector<std::pair<std::int64_t, std::string>> standing;
  for (const auto& [id, tree] : account.trees()) {
    const read::Location location = account.locationOf(id);
    if (location.standing == read::Standing::standing && location.place->root == source.str())
      standing.emplace_back(location.place->depth, id);
  }
  std::stable_sort(standing.begin(), standing.end());
  for (const auto& [depth, id] : standing) branch.copies.push_back(Copy{std::move(held.at(id)), "", trees.placeOf(id)});
  return branch;
}

std::vector<Json::Value> chunked(const Json::Value& deltas) {
  std::vector<Json::Value> chunks;
  for (const Json::Value& delta : deltas) {
    if (chunks.empty() || chunks.back().size() == kChunk) chunks.emplace_back(Json::arrayValue);
    chunks.back().append(delta);
  }
  return chunks;
}

}

DoorForks::DoorForks(roadmap::RoadmapDoor& door, TokenGenerator& tokens) : door_(door), tokens_(tokens) {}

TreeForks::Result DoorForks::fork(const TreeId& source, const std::string& requestedId, const std::string& requestedTitle,
                                  const UserId& owner) {
  Branch branch = door_.read([&](sync::SyncTxn& txn) { return branchOf(door_.rows(), txn, source, owner); });
  if (branch.refused) return *branch.refused;
  const auto mint = [this] { return "t_" + tokens_.mint().digest.substr(0, 16); };
  std::map<std::string, std::string> copyOf;
  for (Copy& copy : branch.copies) {
    copy.id = copyOf.empty() && !requestedId.empty() ? requestedId : mint();
    copyOf.emplace(copy.rows.tree, copy.id);
  }
  const Copy& root = branch.copies.front();
  const std::string title = requestedTitle.empty() ? root.rows.metaText("title") : requestedTitle;

  Json::Value args(Json::objectValue);
  args["source"] = source.str();
  const Json::Value answer = door_.run(owner, std::nullopt, "fork", args, [&](roadmap::RoadmapDoor::Call& call) -> Json::Value {
    Json::Value records(Json::arrayValue);
    for (const Copy& copy : branch.copies) {
      Json::Value fields(Json::objectValue);
      if (copy.parent) {
        fields["parent"]["tree"] = copyOf.at(copy.parent->tree);
        fields["parent"]["step"] = copy.parent->step;
      }
      records.append(Written{.type = "tree", .id = Json::Value(copy.id), .fields = fields, .life = sync::LifeState::alive, .derived = true}.json());
    }
    const Json::Value planted = call.admit(roadmap::intentIn("self/roadmap", records));
    if (!roadmap::landed(planted)) return Json::Value(roadmap::refusalOf(planted));

    for (const Copy& copy : branch.copies) {
      Json::Value deltas(Json::arrayValue);
      Json::Value meta(Json::objectValue);
      const std::string guide = copy.rows.metaText("guide");
      const bool inherited = copy.rows.meta && valueOf(*copy.rows.meta, "guideInherited").asBool();
      meta["title"] = &copy == &root ? title : copy.rows.metaText("title");
      meta["guide"] = guide;
      meta["guideInherited"] = !guide.empty() && (!branch.ownsSource || inherited);
      meta["forkedFrom"] = copy.rows.tree;
      if (copy.parent) {
        meta["root"] = root.id;
        meta["parent"]["tree"] = copyOf.at(copy.parent->tree);
        meta["parent"]["step"] = copy.parent->step;
        meta["depth"] = copy.rows.meta ? valueOf(*copy.rows.meta, "depth") : Json::Value(0);
      }
      deltas.append(Written{.type = "meta", .id = Json::Value("meta"), .fields = meta}.json());
      for (const sync::Row& kind : copy.rows.kinds) {
        if (!kind.alive()) continue;
        Json::Value fields(Json::objectValue);
        for (const char* field : {"hue", "label", "description", "ord"})
          if (!valueOf(kind, field).isNull()) fields[field] = valueOf(kind, field);
        deltas.append(Written{.type = "kind", .id = kind.id.json(), .fields = fields, .life = sync::LifeState::alive, .derived = true}.json());
      }
      for (const sync::Row& node : copy.rows.nodes) {
        Json::Value fields(Json::objectValue);
        for (const char* field : {"label", "icon", "color", "ord", "description", "links"})
          if (!valueOf(node, field).isNull()) fields[field] = valueOf(node, field);
        const Json::Value branchOf = valueOf(node, "branch");
        if (branchOf.isString() && copyOf.contains(branchOf.asString())) fields["branch"] = copyOf.at(branchOf.asString());
        deltas.append(Written{.type = "node", .id = node.id.json(), .fields = fields,
                              .life = node.alive() ? sync::LifeState::alive : sync::LifeState::dead, .derived = true}.json());
      }
      for (const sync::Row& edge : copy.rows.edges)
        if (edge.alive()) deltas.append(Written{.type = "edge", .id = edge.id.json(), .life = sync::LifeState::alive}.json());
      for (const Json::Value& chunk : chunked(deltas)) {
        const Json::Value seeded = call.admit(roadmap::intentIn("tree/" + copy.id, chunk));
        if (!roadmap::landed(seeded)) return Json::Value(roadmap::refusalOf(seeded));
      }
      if (!branch.ownsSource) continue;
      Json::Value pointers(Json::arrayValue);
      for (const sync::Row& pointer : copy.rows.pointers) {
        if (!pointer.alive()) continue;
        Json::Value fields(Json::objectValue);
        fields["opens"] = valueOf(pointer, "opens");
        pointers.append(Written{.type = "pointer", .id = pointer.id.json(), .fields = fields, .life = sync::LifeState::alive}.json());
      }
      for (const Json::Value& chunk : chunked(pointers)) {
        const Json::Value opened = call.admit(roadmap::intentIn("self/overlay/" + copy.id, chunk));
        if (!roadmap::landed(opened)) return Json::Value(roadmap::refusalOf(opened));
      }
    }
    return Json::Value(Json::nullValue);
  });
  if (answer.isString()) {
    if (answer == sync::code::idTaken || answer == sync::code::idSpent) return Result{Outcome::conflict, {}, std::nullopt};
    throw std::runtime_error("the engine refused a fork's copy");
  }
  LOG_INFO << "roadmap_tree_fork trees=" << branch.copies.size() << " request_id=" << currentWriteRequestId();

  TreeData data = roadmap::documentOf(root.rows, title);
  data.id = TreeId{root.id};
  if (!branch.ownsSource)
    for (NodeSpec& node : data.nodes) node.opens = TreeId{};
  std::set<std::string> present;
  for (const NodeSpec& node : data.nodes) present.insert(node.id.str());
  for (const sync::Row& edge : root.rows.edges) {
    if (!edge.alive()) continue;
    const std::string from = edge.id.json()[0].asString();
    const std::string to = edge.id.json()[1].asString();
    if (!present.contains(from)) continue;
    for (NodeSpec& node : data.nodes)
      if (node.id.str() == to) node.prerequisites.emplace_back(from);
  }
  for (NodeSpec& node : data.nodes) node.status.reset();
  return Result{Outcome::forked, std::move(data), std::nullopt};
}

std::optional<TreeForks::Description> DoorForks::describe(const TreeId& source) {
  return door_.read([&](sync::SyncTxn& txn) -> std::optional<Description> {
    const TreeRows rows = door_.rows().tree(txn, source.str(), std::nullopt);
    if (!rows.exists() || !opensToReaders(rows.reach())) return std::nullopt;
    const AccountRows trees = door_.rows().account(txn, rows.owner());
    if (!trees.isAlive(source.str()) || trees.placeOf(source.str())) return std::nullopt;
    const std::size_t steps = std::count_if(rows.nodes.begin(), rows.nodes.end(), [](const sync::Row& node) { return node.alive(); });
    return Description{rows.metaText("title"), steps};
  });
}

}
