#include "products/roadmap/application/RoadmapRows.h"

#include "platform/domain/sync/FractionalIndex.h"
#include "products/roadmap/domain/Access.h"
#include "products/roadmap/domain/Legend.h"
#include "products/roadmap/domain/LooseGraph.h"

#include <algorithm>
#include <set>

namespace wm::roadmap {

namespace {

const sync::Reg* registerOf(const sync::Row& row, const char* field) {
  const auto found = row.lattice.f.find(field);
  return found == row.lattice.f.end() ? nullptr : &found->second;
}

Json::Value valueOf(const sync::Row& row, const char* field) {
  const sync::Reg* reg = registerOf(row, field);
  return reg ? reg->value : Json::Value();
}

sync::Stamp stampOf(const sync::Row& row, const char* field) {
  const sync::Reg* reg = registerOf(row, field);
  return reg ? reg->stamp : sync::Stamp{};
}

std::string textOf(const sync::Row& row, const char* field, const char* fallback = "") {
  const Json::Value value = valueOf(row, field);
  return value.isString() ? value.asString() : fallback;
}

bool alive(const sync::Row& row) { return !row.lattice.life || row.lattice.life->alive(); }

// A record's life as the room's add-and-remove set holds it: alive at its life's stamp, or dead at it after its birth.
ElementSet lifeOf(const sync::Row& row) {
  if (!row.lattice.life) return ElementSet{};
  if (row.lattice.life->alive()) return ElementSet{row.lattice.life->stamp, Hlc{}};
  return ElementSet{row.lattice.born.value_or(Hlc{}), row.lattice.life->stamp};
}

std::vector<Link> linksOf(const Json::Value& links) {
  std::vector<Link> held;
  for (const Json::Value& link : links) held.push_back(Link{link.get("label", "").asString(), link.get("url", "").asString()});
  return held;
}

Json::Value linksJson(const std::vector<Link>& links) {
  Json::Value out(Json::arrayValue);
  for (const Link& link : links) {
    Json::Value entry(Json::objectValue);
    entry["url"] = link.url;
    entry["label"] = link.label;
    out.append(entry);
  }
  return out;
}

std::string edgeFrom(const sync::Row& row) { return row.id.json()[0].asString(); }
std::string edgeTo(const sync::Row& row) { return row.id.json()[1].asString(); }

// Records in the order their roadmap reads them: `(ord, born, id)`.
std::vector<const sync::Row*> authored(const std::vector<sync::Row>& rows) {
  std::vector<const sync::Row*> ordered;
  for (const sync::Row& row : rows) ordered.push_back(&row);
  std::stable_sort(ordered.begin(), ordered.end(), [](const sync::Row* a, const sync::Row* b) {
    const std::string left = textOf(*a, "ord");
    const std::string right = textOf(*b, "ord");
    if (left != right) return left < right;
    const Hlc bornA = a->lattice.born.value_or(Hlc{});
    const Hlc bornB = b->lattice.born.value_or(Hlc{});
    if (bornA != bornB) return bornA < bornB;
    return a->id.column() < b->id.column();
  });
  return ordered;
}

NodeStateEntry entryOf(const sync::Row& node, const sync::Row* pointer) {
  const ElementSet life = lifeOf(node);
  NodeStateEntry entry;
  entry.id = NodeId{node.id.column()};
  entry.createdAt = life.addedAt;
  entry.deletedAt = life.removedAt;
  entry.label = textOf(node, "label");
  entry.labelAt = stampOf(node, "label");
  entry.icon = textOf(node, "icon");
  entry.iconAt = stampOf(node, "icon");
  entry.color = parseColor(textOf(node, "color", "terracotta")).value_or(NodeColor::terracotta);
  entry.colorAt = stampOf(node, "color");
  entry.order = textOf(node, "ord");
  entry.orderAt = stampOf(node, "ord");
  if (const Json::Value status = valueOf(node, "status"); status.isString()) entry.status = status.asString();
  entry.statusAt = stampOf(node, "status");
  entry.description = textOf(node, "description");
  entry.descriptionAt = stampOf(node, "description");
  entry.links = linksOf(valueOf(node, "links"));
  entry.linksAt = stampOf(node, "links");
  if (pointer) {
    const sync::Stamp lifeStamp = pointer->lattice.life ? pointer->lattice.life->stamp : sync::Stamp{};
    entry.opens = TreeId{alive(*pointer) ? textOf(*pointer, "opens") : ""};
    entry.opensAt = std::max(lifeStamp, stampOf(*pointer, "opens"));
  }
  return entry;
}

std::map<std::string, const sync::Row*> byId(const std::vector<sync::Row>& rows) {
  std::map<std::string, const sync::Row*> found;
  for (const sync::Row& row : rows) found.emplace(row.id.column(), &row);
  return found;
}

// The key a created record takes, after every one the roadmap holds.
std::string keyAfter(const std::vector<sync::Row>& rows, std::set<std::string>& placed) {
  std::optional<std::string> last;
  for (const sync::Row& row : rows) {
    const std::string key = textOf(row, "ord");
    if (sync::isOrderKey(key) && (!last || key > *last)) last = key;
  }
  for (const std::string& key : placed)
    if (!last || key > *last) last = key;
  const std::string next = sync::between(last, std::nullopt);
  placed.insert(next);
  return next;
}

bool lifeChanged(const ElementSet& before, const ElementSet& after) {
  return before.addedAt != after.addedAt || before.removedAt != after.removedAt;
}

}

const sync::Row* AccountRows::tree(const std::string& id) const {
  const auto found = trees.find(id);
  return found == trees.end() ? nullptr : &found->second;
}

bool AccountRows::isAlive(const std::string& id) const {
  const sync::Row* row = tree(id);
  return row && alive(*row);
}

std::optional<read::Parent> AccountRows::placeOf(const std::string& id) const {
  const sync::Row* row = tree(id);
  if (!row) return std::nullopt;
  const Json::Value parent = valueOf(*row, "parent");
  if (!parent.isObject()) return std::nullopt;
  return read::Parent{parent["tree"].asString(), parent["step"].asString()};
}

std::vector<OwningStep> AccountRows::pathOf(const std::string& id) const {
  std::vector<OwningStep> path;
  std::set<std::string> seen{id};
  for (std::optional<read::Parent> place = placeOf(id); place && seen.insert(place->tree).second; place = placeOf(place->tree))
    path.push_back(OwningStep{TreeId{place->tree}, NodeId{place->step}});
  std::reverse(path.begin(), path.end());
  return path;
}

std::string AccountRows::rootOf(const std::string& id) const {
  const std::vector<OwningStep> path = pathOf(id);
  return path.empty() ? id : path.front().tree.str();
}

std::string TreeRows::metaText(const char* field) const { return meta ? textOf(*meta, field) : ""; }

Visibility TreeRows::reach() const {
  const std::string reach = meta ? textOf(*meta, "reach", "private") : "private";
  return parseVisibility(reach);
}

const sync::Row* TreeRows::node(const std::string& id) const {
  for (const sync::Row& row : nodes)
    if (row.id.column() == id) return &row;
  return nullptr;
}

std::vector<sync::Row> RoadmapRows::rows(sync::SyncTxn& txn, const sync::ScopeKey& key, const std::string& type) const {
  return catalog_.store(type).feed(txn, key, sync::FeedQuery{});
}

std::optional<sync::ScopeRow> RoadmapRows::scope(sync::SyncTxn& txn, const sync::ScopeKey& key) const {
  return store_.scope(txn, key, sync::RowLock::none);
}

AccountRows RoadmapRows::account(sync::SyncTxn& txn, const UserId& owner) const {
  AccountRows account{owner, {}};
  for (sync::Row& row : rows(txn, sync::ScopeKey::product(owner, "roadmap"), "tree"))
    account.trees.emplace(row.id.column(), std::move(row));
  return account;
}

TreeRows RoadmapRows::tree(sync::SyncTxn& txn, const std::string& tree, const std::optional<UserId>& reader) const {
  TreeRows found;
  found.tree = tree;
  const sync::ScopeKey key = sync::ScopeKey::tree(tree);
  found.scope = scope(txn, key);
  if (!found.exists()) return found;
  for (sync::Row& row : rows(txn, key, "meta")) found.meta = std::move(row);
  found.nodes = rows(txn, key, "node");
  found.edges = rows(txn, key, "edge");
  found.kinds = rows(txn, key, "kind");
  found.pointers = rows(txn, sync::ScopeKey::overlay(found.scope->owner, tree), "pointer");
  if (reader) found.marks = rows(txn, sync::ScopeKey::overlay(*reader, tree), "progress");
  return found;
}

read::TreeRecords recordsOf(const TreeRows& rows, const AccountRows& account) {
  read::TreeRecords records;
  records.id = rows.tree;
  records.present = rows.exists() && account.isAlive(rows.tree) && (account.placeOf(rows.tree) || rows.meta.has_value());
  records.parent = account.placeOf(rows.tree);
  if (rows.meta) {
    records.meta.title = textOf(*rows.meta, "title");
    records.meta.guide = textOf(*rows.meta, "guide");
    records.meta.guideInherited = valueOf(*rows.meta, "guideInherited").asBool();
    records.meta.root = textOf(*rows.meta, "root");
    records.meta.depth = valueOf(*rows.meta, "depth").isIntegral() ? valueOf(*rows.meta, "depth").asInt64() : 0;
    records.meta.visibility = textOf(*rows.meta, "visibility", "private");
    records.meta.reach = textOf(*rows.meta, "reach", "private");
  }
  for (const sync::Row& row : rows.nodes) {
    read::Step step{.id = row.id.column(), .present = alive(row), .born = row.lattice.born.value_or(Hlc{}),
                    .rc = static_cast<std::int64_t>(row.rc), .ru = static_cast<std::int64_t>(row.ru),
                    .label = textOf(row, "label"), .icon = textOf(row, "icon"), .color = textOf(row, "color", "terracotta"),
                    .ord = textOf(row, "ord"), .status = textOf(row, "status", "none"), .description = textOf(row, "description")};
    for (const Link& link : linksOf(valueOf(row, "links"))) step.links.push_back(read::StepLink{link.url, link.label});
    if (const Json::Value branch = valueOf(row, "branch"); branch.isString()) step.branch = branch.asString();
    step.branchStamp = stampOf(row, "branch");
    records.nodes.push_back(std::move(step));
  }
  for (const sync::Row& row : rows.edges) records.edges.push_back(read::Edge{edgeFrom(row), edgeTo(row), alive(row)});
  for (const sync::Row& row : rows.kinds)
    records.kinds.push_back(read::Kind{row.id.column(), alive(row), row.lattice.born.value_or(Hlc{}), textOf(row, "hue", "terracotta"),
                                       textOf(row, "label"), textOf(row, "description"), textOf(row, "ord")});
  for (const sync::Row& row : rows.marks) {
    const Json::Value mark = valueOf(row, "mark");
    records.marks.push_back(read::Mark{row.id.column(), mark.get("status", "none").asString(), mark.get("outOfOrder", false).asBool(),
                                       static_cast<std::int64_t>(row.ru), std::nullopt, stampOf(row, "mark")});
  }
  for (const sync::Row& row : rows.pointers)
    records.pointers.push_back(read::Pointer{row.id.column(), alive(row), textOf(row, "opens"),
                                             std::max(row.lattice.life ? row.lattice.life->stamp : Hlc{}, stampOf(row, "opens"))});
  return records;
}

TreeData documentOf(const TreeRows& rows, const std::string& title) {
  TreeData data;
  data.id = TreeId{rows.tree};
  data.title = title;
  data.guide = rows.metaText("guide");
  const std::map<std::string, const sync::Row*> pointers = byId(rows.pointers);
  for (const sync::Row* row : authored(rows.nodes)) {
    if (!alive(*row)) continue;
    const auto pointer = pointers.find(row->id.column());
    const NodeStateEntry entry = entryOf(*row, pointer == pointers.end() ? nullptr : pointer->second);
    data.nodes.push_back(NodeSpec{entry.id, entry.label, entry.icon, entry.color, entry.order, {}, entry.status,
                                  entry.description, entry.links, entry.opens});
  }
  for (const sync::Row* row : authored(rows.kinds)) {
    if (!alive(*row)) continue;
    data.kinds.push_back(Kind{KindId{row->id.column()}, parseColor(textOf(*row, "hue", "terracotta")).value_or(NodeColor::terracotta),
                              textOf(*row, "label"), textOf(*row, "description")});
  }
  return data;
}

Progress progressOf(const TreeRows& rows) {
  Progress progress;
  for (const sync::Row& row : rows.marks) {
    const Json::Value mark = valueOf(row, "mark");
    const std::optional<ProgressStatus> status = parseProgressStatus(mark.get("status", "none").asString());
    progress.record(NodeId{row.id.column()},
                    ProgressMark{status.value_or(ProgressStatus::none), stampOf(row, "mark"), row.ru, mark.get("outOfOrder", false).asBool()});
  }
  return progress;
}

std::unique_ptr<TreeRoom> roomOf(const TreeRows& rows, const AccountRows& account, PresenceBus& bus) {
  const std::map<std::string, const sync::Row*> pointers = byId(rows.pointers);
  GraphState graph;
  std::map<NodeId, TreeId> subtrees;
  for (const sync::Row& row : rows.nodes) {
    const auto pointer = pointers.find(row.id.column());
    graph.nodes.push_back(entryOf(row, pointer == pointers.end() ? nullptr : pointer->second));
    const Json::Value branch = valueOf(row, "branch");
    if (branch.isString() && account.isAlive(branch.asString())) {
      const std::optional<read::Parent> place = account.placeOf(branch.asString());
      if (place && place->tree == rows.tree && place->step == row.id.column())
        subtrees.emplace(NodeId{row.id.column()}, TreeId{branch.asString()});
    }
  }
  for (const sync::Row& row : rows.edges) {
    const ElementSet life = lifeOf(row);
    graph.edges.push_back(EdgeStateEntry{Edge{NodeId{edgeFrom(row)}, NodeId{edgeTo(row)}}, life.addedAt, life.removedAt});
  }
  LegendState legend;
  double rank = 0;
  for (const sync::Row* row : authored(rows.kinds)) {
    const ElementSet life = lifeOf(*row);
    legend.kinds.push_back(KindStateEntry{KindId{row->id.column()}, life.addedAt, life.removedAt,
                                          parseColor(textOf(*row, "hue", "terracotta")).value_or(NodeColor::terracotta),
                                          stampOf(*row, "hue"), textOf(*row, "label"), stampOf(*row, "label"),
                                          textOf(*row, "description"), stampOf(*row, "description"), rank++, stampOf(*row, "ord")});
  }
  const sync::Row* meta = rows.meta ? &*rows.meta : nullptr;
  Lww<std::string> title{meta ? textOf(*meta, "title") : "", meta ? stampOf(*meta, "title") : Hlc{}};
  Lww<std::string> guide{meta ? textOf(*meta, "guide") : "", meta ? stampOf(*meta, "guide") : Hlc{}};
  const bool guideInherited = meta && valueOf(*meta, "guideInherited").asBool();
  auto access = std::make_shared<RootAccess>(std::optional<UserId>(rows.owner()), rows.reach());
  return std::make_unique<TreeRoom>(TreeId{rows.tree}, title, guide, guideInherited, LooseGraph(graph), Legend(legend),
                                    rows.seq(), TreeId{account.rootOf(rows.tree)}, account.pathOf(rows.tree),
                                    std::move(subtrees), std::move(access), meta ? meta->rc : 0, bus);
}

Json::Value writesOf(const TreeRows& before, const TreeRoom& room) {
  Json::Value writes(Json::arrayValue);
  const auto [graph, legend] = room.dirtyState();
  const std::map<std::string, const sync::Row*> nodes = byId(before.nodes);
  const std::map<std::string, const sync::Row*> kinds = byId(before.kinds);
  const std::map<std::string, const sync::Row*> pointers = byId(before.pointers);
  std::set<std::string> placedSteps;
  std::set<std::string> placedKinds;

  for (const NodeStateEntry& after : graph.nodes) {
    const auto held = nodes.find(after.id.str());
    const auto pointer = pointers.find(after.id.str());
    const std::optional<NodeStateEntry> was =
        held == nodes.end() ? std::nullopt
                            : std::optional(entryOf(*held->second, pointer == pointers.end() ? nullptr : pointer->second));
    Written step{.type = "node", .id = Json::Value(after.id.str()), .derived = true};
    if (was) step.born = held->second->lattice.born.value_or(Hlc{});
    const auto changed = [&](const Hlc NodeStateEntry::*at) { return !was || (*was).*at != after.*at; };
    if (changed(&NodeStateEntry::labelAt) && after.labelAt.isSet()) step.fields["label"] = after.label;
    if (changed(&NodeStateEntry::iconAt) && after.iconAt.isSet()) step.fields["icon"] = after.icon;
    if (changed(&NodeStateEntry::colorAt) && after.colorAt.isSet()) step.fields["color"] = std::string(toString(after.color));
    if (changed(&NodeStateEntry::statusAt) && after.statusAt.isSet())
      step.fields["status"] = after.status ? Json::Value(*normalizeSeedStatus(after.status)) : Json::Value();
    if (changed(&NodeStateEntry::descriptionAt) && after.descriptionAt.isSet()) step.fields["description"] = after.description;
    if (changed(&NodeStateEntry::linksAt) && after.linksAt.isSet()) step.fields["links"] = linksJson(after.links);
    if (changed(&NodeStateEntry::orderAt) && sync::isOrderKey(after.order)) step.fields["ord"] = after.order;
    if (!was && !step.fields.isMember("ord")) step.fields["ord"] = keyAfter(before.nodes, placedSteps);
    const ElementSet lifeAfter{after.createdAt, after.deletedAt};
    if (!was || lifeChanged(ElementSet{was->createdAt, was->deletedAt}, lifeAfter))
      step.life = lifeAfter.present() ? sync::LifeState::alive : sync::LifeState::dead;
    if (!step.fields.empty() || step.life) writes.append(step.json());
  }
  std::map<Edge, const sync::Row*> edges;
  for (const sync::Row& row : before.edges) edges.emplace(Edge{NodeId{edgeFrom(row)}, NodeId{edgeTo(row)}}, &row);
  for (const EdgeStateEntry& after : graph.edges) {
    const ElementSet lifeAfter{after.addedAt, after.removedAt};
    const auto held = edges.find(after.edge);
    if (held != edges.end() && !lifeChanged(lifeOf(*held->second), lifeAfter)) continue;
    Json::Value id(Json::arrayValue);
    id.append(after.edge.from.str());
    id.append(after.edge.to.str());
    writes.append(Written{.type = "edge", .id = id, .life = lifeAfter.present() ? sync::LifeState::alive : sync::LifeState::dead}.json());
  }
  for (const KindStateEntry& after : legend.kinds) {
    const auto held = kinds.find(after.id.str());
    Written kind{.type = "kind", .id = Json::Value(after.id.str()), .derived = true};
    const sync::Row* row = held == kinds.end() ? nullptr : held->second;
    if (row) kind.born = row->lattice.born.value_or(Hlc{});
    const auto moved = [&](const char* field, const Hlc& at) { return !row || stampOf(*row, field) != at; };
    if (moved("hue", after.hueAt) && after.hueAt.isSet()) kind.fields["hue"] = std::string(toString(after.hue));
    if (moved("label", after.labelAt) && after.labelAt.isSet()) kind.fields["label"] = after.label;
    if (moved("description", after.descriptionAt) && after.descriptionAt.isSet()) kind.fields["description"] = after.description;
    if (!row) kind.fields["ord"] = keyAfter(before.kinds, placedKinds);
    const ElementSet lifeAfter{after.createdAt, after.deletedAt};
    if (!row || lifeChanged(lifeOf(*row), lifeAfter)) kind.life = lifeAfter.present() ? sync::LifeState::alive : sync::LifeState::dead;
    if (!kind.fields.empty() || kind.life) writes.append(kind.json());
  }
  Json::Value meta(Json::objectValue);
  const sync::Row* held = before.meta ? &*before.meta : nullptr;
  if (room.title().stamp != (held ? stampOf(*held, "title") : Hlc{})) meta["title"] = room.title().value;
  if (room.guide().stamp != (held ? stampOf(*held, "guide") : Hlc{})) meta["guide"] = room.guide().value;
  if (!meta.empty()) writes.append(Written{.type = "meta", .id = Json::Value("meta"), .fields = meta}.json());
  return writes;
}

Json::Value pointerWritesOf(const TreeRows& rows, const AccountRows& account, const std::vector<Opens>& sent) {
  const std::map<std::string, const sync::Row*> pointers = byId(rows.pointers);
  Json::Value writes(Json::arrayValue);
  std::set<std::string> written;
  for (const Opens& opens : sent) {
    const sync::Row* node = rows.node(opens.step);
    if (!node || !alive(*node) || !written.insert(opens.step).second) continue;
    const Json::Value branch = valueOf(*node, "branch");
    if (branch.isString() && account.isAlive(branch.asString())) {
      const std::optional<read::Parent> place = account.placeOf(branch.asString());
      if (place && place->tree == rows.tree && place->step == opens.step) continue;
    }
    const auto held = pointers.find(opens.step);
    const bool holds = held != pointers.end() && alive(*held->second);
    if (opens.tree.empty() && !holds) continue;
    if (!opens.tree.empty() && holds && textOf(*held->second, "opens") == opens.tree) continue;
    Written pointer{.type = "pointer", .id = Json::Value(opens.step)};
    pointer.life = opens.tree.empty() ? sync::LifeState::dead : sync::LifeState::alive;
    if (!opens.tree.empty()) pointer.fields["opens"] = opens.tree;
    writes.append(pointer.json());
  }
  return writes;
}

Json::Value Written::json() const {
  Json::Value out(Json::objectValue);
  out["t"] = type;
  out["id"] = id;
  if (derived) out["born"] = born ? Json::Value(toString(*born)) : Json::Value();
  if (life) {
    out["life"] = Json::Value(Json::arrayValue);
    out["life"].append(*life == sync::LifeState::alive ? "alive" : "dead");
    out["life"].append(Json::Value());
  }
  for (const std::string& field : fields.getMemberNames()) {
    out["f"][field] = Json::Value(Json::arrayValue);
    out["f"][field].append(fields[field]);
    out["f"][field].append(Json::Value());
  }
  return out;
}

Json::Value intentIn(const std::string& scope, Json::Value deltas) {
  Json::Value intent(Json::objectValue);
  intent["scope"] = scope;
  intent["d"] = std::move(deltas);
  return intent;
}

}
