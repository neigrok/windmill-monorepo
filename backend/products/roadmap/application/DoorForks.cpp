#include "products/roadmap/application/DoorForks.h"

#include "platform/application/WriteObservation.h"
#include "platform/domain/sync/Digest.h"
#include "platform/domain/sync/Registry.h"
#include "products/roadmap/domain/read/RoadmapAccount.h"
#include "products/roadmap/sync/RoadmapRules.h"

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

bool opensToReaders(Visibility reach) { return reach == Visibility::unlisted || reach == Visibility::public_; }

Json::Value valueOf(const sync::Row& row, const char* field) {
  const auto found = row.lattice.f.find(field);
  return found == row.lattice.f.end() ? Json::Value() : found->second.value;
}

bool holds(const std::vector<sync::Row>& rows, const std::string& id) {
  return std::any_of(rows.begin(), rows.end(), [&](const sync::Row& row) { return row.id.column() == id; });
}

// The copy of `source` a keyed fork makes: one per account, request key and source, so every send of the fork names
// the same copy.
std::string copyOf(const UserId& owner, const std::string& key, const std::string& source) {
  return "t_" + sync::sha256(owner.str() + "\n" + key + "\n" + source).hex().substr(0, 16);
}

// What a fork reads of its source in one snapshot: every roadmap of the source's owner with its rows, the root and the
// subtrees that stand under it, or why there is nothing to copy.
struct Source {
  std::map<std::string, TreeRows> trees;
  std::vector<std::string> branch;  // the root first, each subtree after the roadmap holding its step
  AccountRows owner;
  bool ownsSource = false;
  std::optional<TreeForks::Result> refused;

  const TreeRows* placedAt(const read::Parent& place) const {
    for (const std::string& id : branch)
      if (owner.placeOf(id) == place) return &trees.at(id);
    return nullptr;
  }
};

Source sourceOf(const roadmap::RoadmapRows& rows, sync::SyncTxn& txn, const TreeId& source, const UserId& forker) {
  const auto refused = [](TreeForks::Result result) { return Source{{}, {}, {}, false, std::move(result)}; };
  const TreeRows root = rows.tree(txn, source.str(), std::nullopt);
  if (!root.exists()) return refused({TreeForks::Outcome::noSource, {}, std::nullopt});
  Source found{{}, {}, rows.account(txn, root.owner()), root.owner() == forker, std::nullopt};
  if (!found.owner.isAlive(source.str()) || !(found.ownsSource || opensToReaders(root.reach())))
    return refused({TreeForks::Outcome::noSource, {}, std::nullopt});
  if (const std::optional<read::Parent> place = found.owner.placeOf(source.str()))
    return refused({TreeForks::Outcome::notARoot, {},
                    NotARoot{OwningStep{TreeId{place->tree}, NodeId{place->step}}, TreeId{found.owner.rootOf(source.str())}}});
  if (!root.meta) return refused({TreeForks::Outcome::noSource, {}, std::nullopt});
  std::vector<read::RoadmapTree> roadmaps;
  for (const auto& [id, record] : found.owner.trees) {
    TreeRows treeRows = rows.tree(txn, id, std::nullopt);
    roadmaps.emplace_back(roadmap::recordsOf(treeRows, found.owner));
    found.trees.emplace(id, std::move(treeRows));
  }
  const read::RoadmapAccount account(std::move(roadmaps));
  std::vector<std::pair<std::int64_t, std::string>> standing;
  for (const auto& [id, tree] : account.trees()) {
    const read::Location location = account.locationOf(id);
    if (location.standing == read::Standing::standing && location.place->root == source.str())
      standing.emplace_back(location.place->depth, id);
  }
  std::stable_sort(standing.begin(), standing.end());
  for (const auto& [depth, id] : standing) found.branch.push_back(id);
  return found;
}

// One roadmap of the fork: the copy's record as the caller's account holds it, and the source roadmap it copies, found
// by place — the root by the source's id, a subtree by the step of the copied roadmap above that owns it.
struct Copy {
  std::string id;
  std::optional<read::Parent> parent;
  std::int64_t depth = 0;
  const TreeRows* source = nullptr;
};

// The fork's copies as the caller's account holds their records, alive or not, the root first and each subtree after
// the roadmap holding its step: read from what the fork's first admit wrote, so every send of the fork copies into the
// same roadmaps in the same order, whatever the source has become meanwhile.
std::vector<Copy> copiesOf(const AccountRows& mine, const std::string& rootCopy, const Source& source) {
  std::map<std::string, std::string> sourceOf{{rootCopy, source.branch.front()}};
  std::vector<std::pair<std::int64_t, std::string>> placed{{0, rootCopy}};
  for (std::size_t next = 0; next < placed.size(); ++next)
    for (const auto& [id, row] : mine.trees)
      if (const std::optional<read::Parent> place = mine.placeOf(id); place && place->tree == placed[next].second)
        placed.emplace_back(placed[next].first + 1, id);
  std::stable_sort(placed.begin(), placed.end());
  std::vector<Copy> copies;
  for (const auto& [depth, id] : placed) {
    Copy copy{id, mine.placeOf(id), depth, nullptr};
    if (!copy.parent) copy.source = &source.trees.at(source.branch.front());
    else if (const auto above = sourceOf.find(copy.parent->tree); above != sourceOf.end())
      if (const TreeRows* held = source.placedAt(read::Parent{above->second, copy.parent->step})) copy.source = held;
    if (copy.source) sourceOf.emplace(id, copy.source->tree);
    copies.push_back(copy);
  }
  return copies;
}

// The records of a copy's source that the copy does not hold yet, as one intent: the legend, the steps and the links. A
// step that owns a subtree of the source names the copy of it.
Json::Value missingFrom(const Copy& copy, const TreeRows& held, const std::map<std::string, std::string>& subtreeOf) {
  Json::Value deltas(Json::arrayValue);
  if (!copy.source) return deltas;
  for (const sync::Row& kind : copy.source->kinds) {
    if (!kind.alive() || holds(held.kinds, kind.id.column())) continue;
    Json::Value fields(Json::objectValue);
    for (const char* field : {"hue", "label", "description", "ord"})
      if (!valueOf(kind, field).isNull()) fields[field] = valueOf(kind, field);
    deltas.append(Written{.type = "kind", .id = kind.id.json(), .fields = fields, .life = sync::LifeState::alive, .derived = true}.json());
  }
  for (const sync::Row& node : copy.source->nodes) {
    if (holds(held.nodes, node.id.column())) continue;
    Json::Value fields(Json::objectValue);
    for (const char* field : {"label", "icon", "color", "ord", "description", "links"})
      if (!valueOf(node, field).isNull()) fields[field] = valueOf(node, field);
    if (const auto owned = subtreeOf.find(node.id.column()); owned != subtreeOf.end()) fields["branch"] = owned->second;
    deltas.append(Written{.type = "node", .id = node.id.json(), .fields = fields,
                          .life = node.alive() ? sync::LifeState::alive : sync::LifeState::dead, .derived = true}.json());
  }
  for (const sync::Row& edge : copy.source->edges)
    if (edge.alive() && !holds(held.edges, edge.id.column()))
      deltas.append(Written{.type = "edge", .id = edge.id.json(), .life = sync::LifeState::alive}.json());
  return deltas;
}

std::optional<Json::Value> intentOf(const std::string& scope, Json::Value deltas) {
  if (deltas.empty()) return std::nullopt;
  return roadmap::intentIn(scope, std::move(deltas));
}

}

DoorForks::DoorForks(roadmap::RoadmapDoor& door, TokenGenerator& tokens) : door_(door), tokens_(tokens) {}

// The fork's admits, in an order a resend repeats: the copies' records; each copy's content, an intent at a time until
// none is missing; the owner's pointers in each copy; the death of any copy whose source no longer stands; and each
// copy's meta, the deepest first and the root's last. A root stands only once its meta lands (RoadmapRows), so until
// the last admit the copy is listed and opened nowhere, and the resend under the same request key finishes it.
TreeForks::Result DoorForks::fork(const TreeId& source, const std::string& requestedId, const std::string& requestedTitle,
                                  const UserId& owner, const std::optional<std::string>& requestKey) {
  const Source origin = door_.read([&](sync::SyncTxn& txn) { return sourceOf(door_.rows(), txn, source, owner); });
  if (origin.refused) return *origin.refused;
  const auto mint = [&](const std::string& tree) {
    return requestKey ? copyOf(owner, *requestKey, tree) : "t_" + tokens_.mint().digest.substr(0, 16);
  };
  std::map<std::string, std::string> planned;
  for (const std::string& tree : origin.branch) planned.emplace(tree, planned.empty() && !requestedId.empty() ? requestedId : mint(tree));
  const std::string rootCopy = planned.at(origin.branch.front());
  const TreeRows& rootSource = origin.trees.at(origin.branch.front());
  const std::string title = requestedTitle.empty() ? rootSource.metaText("title") : requestedTitle;

  Json::Value args(Json::objectValue);
  args["source"] = source.str();
  args["id"] = requestedId;
  args["title"] = requestedTitle;
  Json::Value answer;
  try {
    answer = door_.run(owner, requestKey, "fork", args, [&](roadmap::RoadmapDoor::Call& call) -> Json::Value {
      Json::Value records(Json::arrayValue);
      for (const std::string& tree : origin.branch) {
        Json::Value fields(Json::objectValue);
        if (const std::optional<read::Parent> place = origin.owner.placeOf(tree)) {
          fields["parent"]["tree"] = planned.at(place->tree);
          fields["parent"]["step"] = place->step;
        }
        records.append(Written{.type = "tree", .id = Json::Value(planned.at(tree)), .fields = fields, .life = sync::LifeState::alive,
                               .derived = true}.json());
      }
      const Json::Value planted = call.admit(roadmap::intentIn("self/roadmap", records));
      if (!roadmap::landed(planted)) return Json::Value(roadmap::refusalOf(planted));

      const std::vector<Copy> copies = door_.read([&](sync::SyncTxn& txn) {
        return copiesOf(door_.rows().account(txn, owner), rootCopy, origin);
      });
      std::map<std::string, std::map<std::string, std::string>> subtrees;  // per copy: the copy each of its steps owns
      for (const Copy& copy : copies)
        if (copy.parent) subtrees[copy.parent->tree][copy.parent->step] = copy.id;

      for (const Copy& copy : copies) {
        const Json::Value seeded = call.admitBuilt(roadmap::treePlaceholder(copy.id), [&](sync::SyncTxn& txn) {
          return intentOf("tree/" + copy.id, missingFrom(copy, door_.rows().tree(txn, copy.id, std::nullopt), subtrees[copy.id]));
        });
        if (!roadmap::landed(seeded)) return Json::Value(roadmap::refusalOf(seeded));
      }

      if (origin.ownsSource) {
        for (const Copy& copy : copies) {
          const Json::Value opened = call.admitBuilt(roadmap::overlayPlaceholder(copy.id), [&](sync::SyncTxn& txn) {
            Json::Value pointers(Json::arrayValue);
            if (!copy.source) return intentOf("self/overlay/" + copy.id, pointers);
            const TreeRows held = door_.rows().tree(txn, copy.id, std::nullopt);
            for (const sync::Row& pointer : copy.source->pointers) {
              if (!pointer.alive() || holds(held.pointers, pointer.id.column())) continue;
              Json::Value fields(Json::objectValue);
              fields["opens"] = valueOf(pointer, "opens");
              pointers.append(Written{.type = "pointer", .id = pointer.id.json(), .fields = fields, .life = sync::LifeState::alive}.json());
            }
            return intentOf("self/overlay/" + copy.id, pointers);
          });
          if (!roadmap::landed(opened)) return Json::Value(roadmap::refusalOf(opened));
        }
      }

      // A copy's meta, written once: a copy whose source no longer stands is described by nothing.
      const auto describe = [&](const Copy& copy) -> Json::Value {
        return call.admitBuilt(roadmap::treePlaceholder(copy.id), [&](sync::SyncTxn& txn) {
          const TreeRows held = door_.rows().tree(txn, copy.id, std::nullopt);
          Json::Value deltas(Json::arrayValue);
          if (!copy.source || !held.exists() || (held.meta && held.meta->lattice.f.count("forkedFrom")))
            return intentOf("tree/" + copy.id, deltas);
          const TreeRows& from = *copy.source;
          const std::string guide = from.metaText("guide");
          const bool inherited = from.meta && valueOf(*from.meta, "guideInherited").asBool();
          Json::Value meta(Json::objectValue);
          meta["title"] = copy.parent ? from.metaText("title") : title;
          meta["guide"] = guide;
          meta["guideInherited"] = !guide.empty() && (!origin.ownsSource || inherited);
          meta["forkedFrom"] = from.tree;
          if (copy.parent) {
            meta["root"] = rootCopy;
            meta["parent"]["tree"] = copy.parent->tree;
            meta["parent"]["step"] = copy.parent->step;
            meta["depth"] = Json::Int64(copy.depth);
          }
          deltas.append(Written{.type = "meta", .id = Json::Value("meta"), .fields = meta}.json());
          return intentOf("tree/" + copy.id, deltas);
        });
      };
      // The subtrees' metas, the deepest first, then the death of any copy whose source no longer stands.
      for (std::size_t index = copies.size(); index-- > 1;) {
        const Json::Value described = describe(copies[index]);
        if (!roadmap::landed(described)) return Json::Value(roadmap::refusalOf(described));
      }
      const Json::Value cleared = call.admitBuilt(roadmap::accountPlaceholder(rootCopy), [&](sync::SyncTxn& txn) {
        const AccountRows mine = door_.rows().account(txn, owner);
        Json::Value deaths(Json::arrayValue);
        for (const Copy& copy : copies)
          if (!copy.source && mine.isAlive(copy.id))
            deaths.append(Written{.type = "tree", .id = Json::Value(copy.id), .life = sync::LifeState::dead,
                                  .born = mine.tree(copy.id)->lattice.born.value_or(Hlc{}), .derived = true}.json());
        return intentOf("self/roadmap", deaths);
      });
      if (!roadmap::landed(cleared)) return Json::Value(roadmap::refusalOf(cleared));

      // The root's meta last: until it lands the copy stands nowhere.
      const Json::Value finished = describe(copies.front());
      if (!roadmap::landed(finished)) return Json::Value(roadmap::refusalOf(finished));
      return Json::Value(Json::nullValue);
    });
  } catch (const roadmap::DoorBusy&) {
    return Result{Outcome::busy, {}, std::nullopt};
  }
  if (answer.isString()) {
    if (answer == sync::code::requestConflict) return Result{Outcome::requestConflict, {}, std::nullopt};
    if (answer == sync::code::idTaken || answer == sync::code::idSpent) return Result{Outcome::conflict, {}, std::nullopt};
    throw std::runtime_error("the engine refused a fork's copy");
  }
  LOG_INFO << "roadmap_tree_fork trees=" << origin.branch.size() << " request_id=" << currentWriteRequestId();

  TreeData data = roadmap::documentOf(rootSource, title);
  data.id = TreeId{rootCopy};
  std::set<std::string> present;
  for (NodeSpec& node : data.nodes) {
    present.insert(node.id.str());
    node.status.reset();
    if (!origin.ownsSource) node.opens = TreeId{};
  }
  for (const sync::Row& edge : rootSource.edges) {
    if (!edge.alive() || !present.contains(edge.id.json()[0].asString())) continue;
    for (NodeSpec& node : data.nodes)
      if (node.id.str() == edge.id.json()[1].asString()) node.prerequisites.emplace_back(edge.id.json()[0].asString());
  }
  return Result{Outcome::forked, std::move(data), std::nullopt};
}

std::optional<TreeForks::Description> DoorForks::describe(const TreeId& source) {
  return door_.read([&](sync::SyncTxn& txn) -> std::optional<Description> {
    const TreeRows rows = door_.rows().tree(txn, source.str(), std::nullopt);
    if (!rows.exists() || !rows.meta || !opensToReaders(rows.reach())) return std::nullopt;
    const AccountRows trees = door_.rows().account(txn, rows.owner());
    if (!trees.isAlive(source.str()) || trees.placeOf(source.str())) return std::nullopt;
    const std::size_t steps = std::count_if(rows.nodes.begin(), rows.nodes.end(), [](const sync::Row& node) { return node.alive(); });
    return Description{rows.metaText("title"), steps};
  });
}

}
