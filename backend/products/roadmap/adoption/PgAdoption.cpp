#include "products/roadmap/adoption/PgAdoption.h"

#include "platform/adapters/json/JsonText.h"
#include "platform/adapters/postgres/PgSyncStore.h"
#include "products/roadmap/adapters/json/TreeJson.h"
#include "products/roadmap/adapters/postgres/PgProgressRepository.h"
#include "products/roadmap/adapters/postgres/PgTreeRepository.h"
#include "products/roadmap/application/RoadmapRows.h"

#include <pqxx/pqxx>

#include <algorithm>
#include <map>
#include <stdexcept>

namespace wm::roadmap::adoption {

using sync::Row;
using sync::ScopeKey;

namespace {

template <typename Field>
std::string textOf(const Field& field) {
  return field.is_null() ? "" : field.template as<std::string>();
}

template <typename Field>
std::optional<std::string> maybeTextOf(const Field& field) {
  if (field.is_null()) return std::nullopt;
  return field.template as<std::string>();
}

template <typename Field>
std::int64_t msOf(const Field& field) {
  return field.is_null() ? 0 : field.template as<long long>();
}

template <typename Field>
OldRegister textRegister(const Field& value, const Field& stamp) {
  return OldRegister{value.is_null() ? Json::Value() : Json::Value(value.template as<std::string>()), textOf(stamp)};
}

// Links as the old server reads them (linksFromJson), each {url, label}.
Json::Value linksRead(const Json::Value& stored) {
  Json::Value links(Json::arrayValue);
  for (const Link& link : linksFromJson(stored)) {
    Json::Value entry(Json::objectValue);
    entry["url"] = link.url;
    entry["label"] = link.label;
    links.append(entry);
  }
  return links;
}

// A stamp a document holds: its text, nothing where it holds none, and any other JSON as the text that is no stamp.
std::string stampIn(const Json::Value& record, const char* name) {
  const Json::Value& value = record[name];
  if (value.isNull()) return "";
  return value.isString() ? value.asString() : dump(value);
}

OldRegister documentRegister(const Json::Value& record, const char* name, const char* stamp) {
  return OldRegister{record.isMember(name) ? record[name] : Json::Value(), stampIn(record, stamp)};
}

// A roadmap that holds no row, unfolded from its whole document as the old server unfolds it (graphStateFromJson and
// legendStateFromJson), keeping each stamp's text for §8.1 to read. A document whose shape that reading refuses — a step
// without a string id, an `opens` that names no tree — is marked unreadable, which stops the move.
void unfold(OldRoadmap& roadmap, const Json::Value& document) {
  if (!document.isObject()) {
    roadmap.unreadableDocument = true;
    return;
  }
  const auto list = [&](const char* name) {
    const Json::Value& items = document[name];
    if (!items.isNull() && !items.isArray()) roadmap.unreadableDocument = true;
    return items.isArray() ? items : Json::Value(Json::arrayValue);
  };
  for (const Json::Value& n : list("nodes")) {
    if (!n.isObject() || !n["id"].isString() || (!n["opens"].isNull() && !n["opens"].isString())) {
      roadmap.unreadableDocument = true;
      continue;
    }
    OldStep step{.id = n["id"].asString(), .added = stampIn(n, "createdAt"), .removed = stampIn(n, "deletedAt")};
    step.label = documentRegister(n, "label", "labelAt");
    step.icon = documentRegister(n, "icon", "iconAt");
    step.color = documentRegister(n, "color", "colorAt");
    step.ord = documentRegister(n, "order", "orderAt");
    step.status = OldRegister{n["status"].isString() ? n["status"] : Json::Value(), stampIn(n, "statusAt")};
    step.description = documentRegister(n, "description", "descriptionAt");
    step.links = OldRegister{linksRead(n["links"]), stampIn(n, "linksAt")};
    step.opens = documentRegister(n, "opens", "opensAt");
    roadmap.steps.push_back(std::move(step));
  }
  for (const Json::Value& e : list("edges")) {
    if (!e.isObject() || !e["from"].isString() || !e["to"].isString()) {
      roadmap.unreadableDocument = true;
      continue;
    }
    roadmap.links.push_back(OldLink{e["from"].asString(), e["to"].asString(), stampIn(e, "addedAt"), stampIn(e, "removedAt")});
  }
  for (const Json::Value& k : list("kinds")) {
    if (!k.isObject() || !k["id"].isString()) {
      roadmap.unreadableDocument = true;
      continue;
    }
    OldKind kind{.id = k["id"].asString(), .added = stampIn(k, "createdAt"), .removed = stampIn(k, "deletedAt")};
    kind.hue = documentRegister(k, "hue", "hueAt");
    kind.label = documentRegister(k, "label", "labelAt");
    kind.description = documentRegister(k, "description", "descriptionAt");
    kind.rank = OldRegister{k["rank"].isNumeric() ? k["rank"] : Json::Value(0.0), stampIn(k, "rankAt")};
    roadmap.kinds.push_back(std::move(kind));
  }
  roadmap.wholeDocument = !roadmap.steps.empty() || !roadmap.links.empty() || !roadmap.kinds.empty() || roadmap.unreadableDocument;
}

// A row to write as the type's store writes an admitted one: nothing stood before it.
sync::RowWrite rowWrite(const sync::TypeDef& type, Row row) {
  return sync::RowWrite{.type = &type, .id = row.id, .before = std::nullopt, .after = std::move(row)};
}

}

AdoptionFailure::AdoptionFailure(std::string code, std::string roadmap, bool stops)
    : std::runtime_error("the adoption of an owner's roadmaps stopped short"), code(std::move(code)), roadmap(std::move(roadmap)), stops(stops) {}

PgAdoption::PgAdoption(std::shared_ptr<PgPool> pool, const sync::SyncCatalog& catalog, sync::SyncStore& store, std::string ownSessions)
    : pool_(std::move(pool)), catalog_(catalog), store_(store), ownSessions_(std::move(ownSessions)) {}

namespace {

// The roadmaps of roadmap's own tables in `sql`'s view, every one or those of `only` alone, each with its rows in a fixed
// order, a roadmap that holds no row unfolded from its whole document.
std::vector<OldRoadmap> roadmapsIn(pqxx::transaction_base& sql, const std::optional<std::vector<std::string>>& only) {
  Json::Value among(Json::nullValue);
  if (only) {
    among = Json::Value(Json::arrayValue);
    for (const std::string& id : *only) among.append(id);
  }
  const std::optional<std::string> ids = only ? std::optional(dump(among)) : std::nullopt;
  const std::string ofTrees = " where ($1::jsonb is null or t.id in (select jsonb_array_elements_text($1::jsonb)))";
  const std::string ofRows = " where ($1::jsonb is null or tree_id in (select jsonb_array_elements_text($1::jsonb)))";
  std::map<std::string, OldRoadmap> roadmaps;
  std::map<std::string, std::string> documents;
  const pqxx::result trees = sql.exec(
      "select t.id, t.owner_id::text, t.title, t.title_hlc, t.guide, t.guide_hlc, t.guide_inherited, t.visibility, t.head_seq, "
      "t.forked_from, t.document::text, (extract(epoch from t.deleted_at) * 1000)::bigint, "
      "(extract(epoch from t.created_at) * 1000)::bigint, (extract(epoch from t.updated_at) * 1000)::bigint, "
      "t.parent_tree, t.parent_step, t.root_tree, t.depth, "
      "(select max(o.seq) from tree_ops o where o.tree_id = t.id), (select count(*) from tree_ops o where o.tree_id = t.id), "
      "exists (select 1 from tree_og_images i where i.tree_id = t.id), exists (select 1 from tree_og_videos v where v.tree_id = t.id) "
      "from trees t" + ofTrees, pqxx::params{ids});
  for (std::size_t i = 0; i < trees.size(); ++i) {
    const auto row = trees[i];
    OldRoadmap roadmap{.id = row[0].as<std::string>(), .owner = maybeTextOf(row[1]), .title = textRegister(row[2], row[3]),
                       .guide = textRegister(row[4], row[5]), .guideInherited = row[6].as<bool>(), .visibility = row[7].as<std::string>(),
                       .head = static_cast<std::uint64_t>(std::max<long long>({row[8].as<long long>(), msOf(row[18]), 0})),
                       .forkedFrom = maybeTextOf(row[9])};
    if (!row[11].is_null()) roadmap.deletedAt = row[11].as<long long>();
    roadmap.createdAt = msOf(row[12]);
    roadmap.updatedAt = msOf(row[13]);
    if (!row[14].is_null() || !row[15].is_null()) roadmap.parent = read::Parent{textOf(row[14]), textOf(row[15])};
    roadmap.root = textOf(row[16]);
    roadmap.depth = row[17].as<long long>();
    roadmap.activity = static_cast<std::uint64_t>(row[19].as<long long>());
    roadmap.ogImage = row[20].as<bool>();
    roadmap.ogVideo = row[21].as<bool>();
    documents.emplace(roadmap.id, row[10].as<std::string>());
    roadmaps.emplace(roadmap.id, std::move(roadmap));
  }
  const auto holder = [&](const auto& field) -> OldRoadmap* {
    const auto found = roadmaps.find(field.template as<std::string>());
    return found == roadmaps.end() ? nullptr : &found->second;
  };

  const pqxx::result nodes = sql.exec(
      "select tree_id, node_id, created_hlc, deleted_hlc, label, label_hlc, icon, icon_hlc, color, color_hlc, ord, ord_hlc, "
      "status, status_hlc, description, description_hlc, links::text, links_hlc, opens, opens_hlc from tree_nodes" + ofRows +
      " order by tree_id, node_id", pqxx::params{ids});
  for (std::size_t i = 0; i < nodes.size(); ++i) {
    const auto row = nodes[i];
    OldRoadmap* roadmap = holder(row[0]);
    if (!roadmap) continue;
    OldStep step{.id = row[1].as<std::string>(), .added = textOf(row[2]), .removed = textOf(row[3])};
    step.label = textRegister(row[4], row[5]);
    step.icon = textRegister(row[6], row[7]);
    step.color = textRegister(row[8], row[9]);
    step.ord = textRegister(row[10], row[11]);
    step.status = textRegister(row[12], row[13]);
    step.description = textRegister(row[14], row[15]);
    step.links = OldRegister{linksRead(parse(row[16].as<std::string>())), textOf(row[17])};
    step.opens = textRegister(row[18], row[19]);
    roadmap->steps.push_back(std::move(step));
  }
  const pqxx::result edges =
      sql.exec("select tree_id, from_id, to_id, added_hlc, removed_hlc from tree_edges" + ofRows + " order by tree_id, from_id, to_id",
               pqxx::params{ids});
  for (std::size_t i = 0; i < edges.size(); ++i) {
    const auto row = edges[i];
    if (OldRoadmap* roadmap = holder(row[0]))
      roadmap->links.push_back(OldLink{row[1].as<std::string>(), row[2].as<std::string>(), textOf(row[3]), textOf(row[4])});
  }
  const pqxx::result kinds = sql.exec(
      "select tree_id, kind_id, created_hlc, deleted_hlc, hue, hue_hlc, label, label_hlc, description, description_hlc, rank, rank_hlc "
      "from tree_kinds" + ofRows + " order by tree_id, kind_id", pqxx::params{ids});
  for (std::size_t i = 0; i < kinds.size(); ++i) {
    const auto row = kinds[i];
    OldRoadmap* roadmap = holder(row[0]);
    if (!roadmap) continue;
    OldKind kind{.id = row[1].as<std::string>(), .added = textOf(row[2]), .removed = textOf(row[3])};
    kind.hue = textRegister(row[4], row[5]);
    kind.label = textRegister(row[6], row[7]);
    kind.description = textRegister(row[8], row[9]);
    kind.rank = OldRegister{Json::Value(row[10].as<double>()), textOf(row[11])};
    roadmap->kinds.push_back(std::move(kind));
  }
  const pqxx::result marks = sql.exec(
      "select tree_id, user_id, node_id, status, out_of_order, hlc, (extract(epoch from updated_at) * 1000)::bigint from node_progress" +
      ofRows + " order by tree_id, user_id, node_id", pqxx::params{ids});
  for (std::size_t i = 0; i < marks.size(); ++i) {
    const auto row = marks[i];
    if (OldRoadmap* roadmap = holder(row[0]))
      roadmap->marks.push_back(OldMark{row[1].as<std::string>(), row[2].as<std::string>(), row[3].as<std::string>(), row[4].as<bool>(),
                                       textOf(row[5]), msOf(row[6])});
  }

  std::vector<OldRoadmap> read;
  for (auto& [id, roadmap] : roadmaps) {
    if (roadmap.steps.empty() && roadmap.links.empty() && roadmap.kinds.empty()) unfold(roadmap, parse(documents.at(id)));
    read.push_back(std::move(roadmap));
  }
  return read;
}

}

OldDatabase PgAdoption::oldTables() {
  PgLease conn{*pool_};
  pqxx::read_transaction txn{*conn};
  txn.exec("set local statement_timeout = 0");
  OldDatabase database{.roadmaps = roadmapsIn(txn, std::nullopt)};
  for (const auto& row : txn.exec("select id::text from users")) database.accounts.insert(row[0].as<std::string>());
  for (const auto& [kind, table] : std::map<std::string, std::string>{{"steps", "tree_nodes"}, {"links", "tree_edges"},
                                                                      {"kinds", "tree_kinds"}, {"marks", "node_progress"}}) {
    const pqxx::result rows = txn.exec("select count(*) from " + table + " r where not exists (select 1 from trees t where t.id = r.tree_id)");
    database.rowsOfNoRoadmap[kind] = rows[0][0].as<std::uint64_t>();
  }
  return database;
}

std::uint64_t PgAdoption::otherSessions() {
  PgLease conn{*pool_};
  pqxx::read_transaction txn{*conn};
  return txn.exec("select count(*) from pg_stat_activity where datname = current_database() and backend_type = 'client backend' "
                  "and pid <> pg_backend_pid() and application_name is distinct from $1",
                  pqxx::params{ownSessions_})[0][0].as<std::uint64_t>();
}

std::map<std::string, std::string> PgAdoption::lastChanges() {
  PgLease conn{*pool_};
  pqxx::read_transaction txn{*conn};
  std::map<std::string, std::string> changed;
  for (const auto& row : txn.exec("select id, updated_at::text from trees")) changed.emplace(row[0].as<std::string>(), row[1].as<std::string>());
  return changed;
}

std::size_t PgAdoption::keepLastChanges(const std::map<std::string, std::string>& changed) {
  Json::Value times(Json::objectValue);
  for (const auto& [id, at] : changed) times[id] = at;
  PgLease conn{*pool_};
  pqxx::work txn{*conn};
  const pqxx::result kept = txn.exec(
      "update trees t set updated_at = v.value::timestamptz from jsonb_each_text($1::jsonb) v "
      "where t.id = v.key and t.updated_at is distinct from v.value::timestamptz returning t.id",
      pqxx::params{dump(times)});
  txn.commit();
  return kept.size();
}

OldReadings PgAdoption::oldReadings(const Survey& survey) {
  PgTreeRepository trees(pool_);
  PgProgressRepository progress(pool_);
  OldReadings read;
  for (const auto& [id, surveyed] : survey.roadmaps()) {
    try {
      const std::optional<StoredTree> stored = trees.load(TreeId{id});
      const std::optional<StoredAccess> access = trees.loadAccess(TreeId{id});
      if (!stored || !access) continue;
      OldReading reading{.id = id, .stored = *stored, .access = *access, .forkedFrom = surveyed.roadmap->forkedFrom};
      for (const OldMark& mark : surveyed.roadmap->marks) {
        if (survey.accounts().contains(mark.account) && !reading.marks.contains(mark.account))
          reading.marks.emplace(mark.account, progress.load(TreeId{id}, UserId{mark.account}));
      }
      read.readings.push_back(std::move(reading));
    } catch (const std::invalid_argument&) {
      read.unreadable.insert(id);
    }
  }
  return read;
}

std::vector<std::string> PgAdoption::scopesInTheWay(const Plan& plan) {
  std::map<std::string, std::string> roadmapOf;
  Json::Value ids(Json::arrayValue);
  Json::Value keys(Json::arrayValue);
  for (const OwnerPlan& owner : plan.owners) {
    for (const RoadmapPlan& roadmap : owner.roadmaps) {
      ids.append(roadmap.id);
      const auto planned = [&](const ScopePlan& scope) {
        roadmapOf.emplace(scope.key.text(), roadmap.id);
        keys.append(scope.key.text());
      };
      planned(roadmap.tree);
      for (const ScopePlan& overlay : roadmap.overlays) planned(overlay);
    }
  }
  PgLease conn{*pool_};
  pqxx::read_transaction txn{*conn};
  txn.exec("set local statement_timeout = 0");
  std::set<std::string> adopted;
  for (const auto& row : txn.exec("select id from roadmap_trees where id in (select jsonb_array_elements_text($1::jsonb))", pqxx::params{dump(ids)}))
    adopted.insert(row[0].as<std::string>());
  std::set<std::string> inTheWay;
  for (const auto& row : txn.exec("select key from sync_scopes where key in (select jsonb_array_elements_text($1::jsonb))", pqxx::params{dump(keys)})) {
    const std::string& roadmap = roadmapOf.at(row[0].as<std::string>());
    if (!adopted.contains(roadmap)) inTheWay.insert(roadmap);
  }
  return {inTheWay.begin(), inTheWay.end()};
}

bool PgAdoption::houseStands() {
  PgLease conn{*pool_};
  pqxx::work txn{*conn};
  txn.exec("insert into users (id, email, name) values ($1::uuid, $2, 'Windmill') on conflict do nothing",
           pqxx::params{kHouseAccount.str(), kHouseEmail});
  const pqxx::result house = txn.exec("select 1 from users where id = $1::uuid", pqxx::params{kHouseAccount.str()});
  txn.commit();
  return !house.empty();
}

Written PgAdoption::write(const OwnerPlan& owner) {
  const std::unique_ptr<sync::SyncTxn> txn = store_.begin(sync::TxnMode::write);
  pqxx::transaction_base& sql = sync::sqlOf(*txn);
  sql.exec("set local statement_timeout = 0");
  sql.exec("select pg_advisory_xact_lock(hashtext('roadmap.adoption'))");
  sql.exec("lock table trees, tree_nodes, tree_edges, tree_kinds, node_progress, tree_ops in share mode");
  if (sql.exec("select 1 from users where id = $1::uuid for key share", pqxx::params{owner.owner.str()}).empty())
    throw AdoptionFailure("ownerAccountGone", "", true);
  std::vector<std::string> planned;
  for (const OldRoadmap& roadmap : owner.readFrom) planned.push_back(roadmap.id);
  if (roadmapsIn(sql, planned) != owner.readFrom) throw AdoptionFailure("oldRowsChangedSinceThePlan", "", true);
  Json::Value ids(Json::arrayValue);
  for (const RoadmapPlan& roadmap : owner.roadmaps) ids.append(roadmap.id);
  std::set<std::string> there;
  for (const auto& row : sql.exec("select id from roadmap_trees where id in (select jsonb_array_elements_text($1::jsonb))", pqxx::params{dump(ids)}))
    there.insert(row[0].as<std::string>());
  Written written{.already = there.size()};
  if (there.size() == owner.roadmaps.size()) return written;

  const ScopeKey account = ScopeKey::product(owner.owner, "roadmap");
  store_.insertScope(*txn, account, owner.owner, std::nullopt);
  sync::ScopeRow accountRow = *store_.scope(*txn, account, sync::RowLock::update);
  const auto created = [&](const std::string& roadmap, const ScopePlan& scope) {
    if (!store_.insertScope(*txn, scope.key, scope.owner, scope.governedBy)) throw AdoptionFailure("scopeAlreadyThere", roadmap, true);
    if (scope.deadAt) {
      store_.killTree(*txn, scope.key, *scope.deadAt);
      return;
    }
    std::map<std::string, std::vector<sync::RowWrite>> byType;
    for (const Row& row : scope.rows) byType[row.t].push_back(rowWrite(catalog_.store(row.t).def(), row));
    for (const sync::TypeDef* type : catalog_.applyOrder()) {
      const auto writes = byType.find(type->name);
      if (writes != byType.end()) catalog_.store(type->name).apply(*txn, scope.key, writes->second);
    }
    sync::ScopeRow stored = *store_.scope(*txn, scope.key, sync::RowLock::update);
    stored.seq = scope.seq;
    stored.counters = scope.counters;
    stored.digest = scope.digest;
    stored.open = scope.open;
    store_.saveScope(*txn, stored);
  };
  const sync::TypeDef& tree = catalog_.store("tree").def();
  for (const RoadmapPlan& roadmap : owner.roadmaps) {
    if (there.contains(roadmap.id)) continue;
    try {
      Row record = roadmap.record;
      record.seq = ++accountRow.seq;
      accountRow.digest = accountRow.digest + sync::rowHash(record.toJson());
      catalog_.store("tree").apply(*txn, account, {rowWrite(tree, std::move(record))});
      created(roadmap.id, roadmap.tree);
      for (const ScopePlan& overlay : roadmap.overlays) created(roadmap.id, overlay);
    } catch (const AdoptionFailure&) {
      throw;
    } catch (const std::exception&) {
      throw AdoptionFailure("storeRefusedARow", roadmap.id, false);
    }
    ++written.adopted;
  }
  try {
    store_.saveScope(*txn, accountRow);
    txn->commit();
  } catch (const std::exception&) {
    throw AdoptionFailure("commitFailed", "", false);
  }
  return written;
}

std::vector<UserId> PgAdoption::owners() {
  PgLease conn{*pool_};
  pqxx::read_transaction txn{*conn};
  std::vector<UserId> owners;
  for (const auto& row : txn.exec("select distinct s.owner::text from roadmap_trees t join sync_scopes s on s.key = t.scope_key order by 1"))
    owners.push_back(UserId{row[0].as<std::string>()});
  return owners;
}

bool PgAdoption::adopted(const std::string& tree) {
  PgLease conn{*pool_};
  pqxx::read_transaction txn{*conn};
  return !txn.exec("select 1 from roadmap_trees where id = $1", pqxx::params{tree}).empty();
}

std::vector<EngineRoadmap> PgAdoption::roadmapsOf(const UserId& owner) {
  const std::unique_ptr<sync::SyncTxn> txn = store_.begin(sync::TxnMode::snapshot);
  const RoadmapRows rows(catalog_, store_);
  const AccountRows account = rows.account(*txn, owner);
  std::vector<EngineRoadmap> roadmaps;
  for (const auto& [id, record] : account.trees) {
    const TreeRows tree = rows.tree(*txn, id, owner);
    EngineRoadmap roadmap{.records = recordsOf(tree, account), .owner = tree.exists() ? tree.owner().str() : owner.str()};
    if (tree.meta) {
      const auto forked = tree.meta->lattice.f.find("forkedFrom");
      if (forked != tree.meta->lattice.f.end() && forked->second.value.isString()) roadmap.forkedFrom = forked->second.value.asString();
    }
    const pqxx::result overlays = sync::sqlOf(*txn).exec(
        "select owner::text from sync_scopes where kind = 'overlay' and governed_by = $1 and owner <> $2::uuid order by 1",
        pqxx::params{ScopeKey::tree(id).text(), owner.str()});
    for (std::size_t i = 0; i < overlays.size(); ++i) {
      const UserId reader{overlays[i][0].as<std::string>()};
      std::vector<read::Mark>& marks = roadmap.otherMarks[reader.str()];
      for (const Row& row : catalog_.store("progress").feed(*txn, ScopeKey::overlay(reader, id), sync::FeedQuery{})) {
        const auto mark = row.lattice.f.find("mark");
        const Json::Value value = mark == row.lattice.f.end() ? Json::Value(Json::objectValue) : mark->second.value;
        marks.push_back(read::Mark{row.id.column(), value.get("status", "none").asString(), value.get("outOfOrder", false).asBool(),
                                   static_cast<std::int64_t>(row.ru), std::nullopt,
                                   mark == row.lattice.f.end() ? Hlc{} : mark->second.stamp});
      }
    }
    roadmaps.push_back(std::move(roadmap));
  }
  return roadmaps;
}

std::vector<Summed> PgAdoption::sums() {
  const std::unique_ptr<sync::SyncTxn> txn = store_.begin(sync::TxnMode::snapshot);
  sync::sqlOf(*txn).exec("set local statement_timeout = 0");
  const pqxx::result keys = sync::sqlOf(*txn).exec("select key from sync_scopes where state = 'alive' order by key collate \"C\"");
  std::vector<Summed> sums;
  for (std::size_t i = 0; i < keys.size(); ++i) {
    const std::optional<ScopeKey> key = ScopeKey::parse(keys[i][0].as<std::string>());
    if (!key) throw std::runtime_error("sync_scopes holds a key no scope kind parses");
    const std::vector<const sync::TypeDef*> types = catalog_.typesIn(key->registryScope());
    if (types.empty()) continue;
    const sync::ScopeRow scope = *store_.scope(*txn, *key, sync::RowLock::none);
    std::vector<Json::Value> rows;
    Seq highest = 0;
    bool opens = false;
    const std::optional<sync::Opening>& opening = catalog_.opening();
    for (const sync::TypeDef* type : types) {
      for (const Row& row : catalog_.store(type->name).feed(*txn, *key, sync::FeedQuery{})) {
        highest = std::max(highest, row.seq);
        rows.push_back(row.toJson());
        if (opening && row.t == opening->type) opens = opening->opens(row);
      }
    }
    sums.push_back(Summed{*key, sync::scopeDigest(rows) == scope.digest, scope.seq >= highest,
                          key->kind() != sync::ScopeKind::tree || scope.open == opens});
  }
  return sums;
}

}
