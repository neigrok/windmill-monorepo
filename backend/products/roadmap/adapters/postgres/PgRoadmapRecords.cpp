#include "products/roadmap/adapters/postgres/PgRoadmapRecords.h"

#include "platform/adapters/json/JsonText.h"
#include "platform/domain/sync/Scope.h"

#include <pqxx/pqxx>

#include <algorithm>
#include <utility>

namespace wm {

namespace read = roadmap::read;

namespace {

// The rows of each table that belong to `owner`'s alive roadmaps: their tree scopes, or their owner's overlays of them.
const std::string kTreeScopes = "join roadmap_trees t on t.scope_key = $1 and t.life = 'alive' and r.scope_key = 'tree:' || t.id";
const std::string kOverlays =
    "join roadmap_trees t on t.scope_key = $1 and t.life = 'alive' and r.scope_key = 'acct:' || $2 || '/overlay/' || t.id";

template <typename Field>
std::string textOf(const Field& field, const std::string& otherwise = "") {
  return field.is_null() ? otherwise : field.template as<std::string>();
}

template <typename Field>
Hlc stampOf(const Field& field) {
  return field.is_null() ? Hlc{} : parseHlc(field.template as<std::string>()).value_or(Hlc{});
}

template <typename Field>
read::Instant instantOf(const Field& field) {
  return field.is_null() ? read::Instant{} : read::Instant{field.template as<long long>()};
}

}

PgRoadmapRecords::PgRoadmapRecords(std::shared_ptr<PgPool> pool) : pool_(std::move(pool)) {}

std::optional<UserId> PgRoadmapRecords::ownerOf(const TreeId& tree) {
  PgLease conn{*pool_};
  pqxx::work txn{*conn};
  const pqxx::result rows = txn.exec_params(
      "select s.owner::text from roadmap_trees t join sync_scopes s on s.key = t.scope_key where t.id = $1", tree.str());
  if (rows.empty()) return std::nullopt;
  return UserId{rows[0][0].as<std::string>()};
}

AccountRoadmaps PgRoadmapRecords::roadmapsOf(const UserId& owner) {
  PgLease conn{*pool_};
  pqxx::work txn{*conn};
  const std::string account = sync::ScopeKey::product(owner, "roadmap").text();
  std::map<std::string, read::TreeRecords> trees;
  AccountRoadmaps roadmaps;
  const auto edited = [&](const std::string& tree, long long at) {
    std::uint64_t& latest = roadmaps.editedAt[tree];
    latest = std::max(latest, static_cast<std::uint64_t>(at));
  };

  const pqxx::result records = txn.exec_params(
      "select id, life, case when jsonb_typeof(parent) = 'object' then parent->>'tree' end, "
      "case when jsonb_typeof(parent) = 'object' then parent->>'step' end from roadmap_trees where scope_key = $1",
      account);
  for (std::size_t i = 0; i < records.size(); ++i) {
    read::TreeRecords tree;
    tree.id = records[i][0].as<std::string>();
    tree.present = records[i][1].as<std::string>() == "alive";
    tree.read = tree.present ? read::Read::loaded : read::Read::unread;
    if (!records[i][2].is_null()) tree.parent = read::Parent{records[i][2].as<std::string>(), records[i][3].as<std::string>()};
    trees.emplace(tree.id, std::move(tree));
  }

  const pqxx::result metas = txn.exec_params(
      "select t.id, r.title, r.guide, r.guide_inherited, r.root, r.depth, r.visibility, r.reach, r.ru from roadmap_metas r " +
          kTreeScopes,
      account);
  for (std::size_t i = 0; i < metas.size(); ++i) {
    const auto row = metas[i];
    read::Meta meta;
    meta.title = textOf(row[1]);
    meta.guide = textOf(row[2]);
    meta.guideInherited = !row[3].is_null() && row[3].as<bool>();
    meta.root = textOf(row[4]);
    meta.depth = row[5].is_null() ? 0 : row[5].as<long long>();
    meta.visibility = textOf(row[6], "private");
    meta.reach = textOf(row[7], "private");
    trees.at(row[0].as<std::string>()).meta = std::move(meta);
    edited(row[0].as<std::string>(), row[8].as<long long>());
  }

  const pqxx::result nodes = txn.exec_params(
      "select t.id, r.id, r.life, r.born, r.rc, r.ru, r.label, r.icon, r.color, r.ord, r.status, r.description, r.links::text, "
      "r.branch, r.branch_stamp from roadmap_nodes r " + kTreeScopes,
      account);
  for (std::size_t i = 0; i < nodes.size(); ++i) {
    const auto row = nodes[i];
    read::Step step;
    step.id = row[1].as<std::string>();
    step.present = row[2].as<std::string>() == "alive";
    step.born = stampOf(row[3]);
    step.rc = instantOf(row[4]);
    step.ru = instantOf(row[5]);
    step.label = textOf(row[6]);
    step.icon = textOf(row[7]);
    step.color = textOf(row[8], "terracotta");
    step.ord = textOf(row[9]);
    step.status = textOf(row[10], "none");
    step.description = textOf(row[11]);
    if (!row[12].is_null())
      for (const Json::Value& link : parse(row[12].as<std::string>()))
        if (link.isObject()) step.links.push_back(read::StepLink{link.get("url", "").asString(), link.get("label", "").asString()});
    if (!row[13].is_null()) step.branch = row[13].as<std::string>();
    step.branchStamp = stampOf(row[14]);
    trees.at(row[0].as<std::string>()).nodes.push_back(std::move(step));
    edited(row[0].as<std::string>(), row[5].as<long long>());
  }

  const pqxx::result edges = txn.exec_params("select t.id, r.id, r.life, r.ru from roadmap_edges r " + kTreeScopes, account);
  for (std::size_t i = 0; i < edges.size(); ++i) {
    const auto row = edges[i];
    const Json::Value ends = parse(row[1].as<std::string>());
    trees.at(row[0].as<std::string>()).edges.push_back(read::Edge{ends[0].asString(), ends[1].asString(), row[2].as<std::string>() == "alive"});
    edited(row[0].as<std::string>(), row[3].as<long long>());
  }

  const pqxx::result kinds = txn.exec_params(
      "select t.id, r.id, r.life, r.born, r.hue, r.label, r.description, r.ord, r.ru from roadmap_kinds r " + kTreeScopes, account);
  for (std::size_t i = 0; i < kinds.size(); ++i) {
    const auto row = kinds[i];
    read::Kind kind;
    kind.id = row[1].as<std::string>();
    kind.present = row[2].as<std::string>() == "alive";
    kind.born = stampOf(row[3]);
    kind.hue = textOf(row[4]);
    kind.label = textOf(row[5]);
    kind.description = textOf(row[6]);
    kind.ord = textOf(row[7]);
    trees.at(row[0].as<std::string>()).kinds.push_back(std::move(kind));
    edited(row[0].as<std::string>(), row[8].as<long long>());
  }

  const pqxx::result marks = txn.exec_params(
      "select t.id, r.id, r.mark::text, r.mark_stamp, r.ru from roadmap_progress r " + kOverlays, account, owner.str());
  for (std::size_t i = 0; i < marks.size(); ++i) {
    const auto row = marks[i];
    const Json::Value value = row[2].is_null() ? Json::Value(Json::objectValue) : parse(row[2].as<std::string>());
    read::Mark mark;
    mark.node = row[1].as<std::string>();
    mark.status = value.get("status", "none").asString();
    mark.outOfOrder = value.get("outOfOrder", false).asBool();
    mark.recordedAt = instantOf(row[4]);
    mark.stamp = stampOf(row[3]);
    trees.at(row[0].as<std::string>()).marks.push_back(std::move(mark));
  }

  const pqxx::result pointers = txn.exec_params(
      "select t.id, r.id, r.life, r.opens, r.opens_stamp from roadmap_pointers r " + kOverlays, account, owner.str());
  for (std::size_t i = 0; i < pointers.size(); ++i) {
    const auto row = pointers[i];
    trees.at(row[0].as<std::string>()).pointers.push_back(
        read::Pointer{row[1].as<std::string>(), row[2].as<std::string>() == "alive", textOf(row[3]), stampOf(row[4])});
  }

  for (auto& [id, tree] : trees) roadmaps.trees.push_back(std::move(tree));
  return roadmaps;
}

std::vector<ListedRoot> PgRoadmapRecords::publicRoots() {
  PgLease conn{*pool_};
  pqxx::work txn{*conn};
  // A root is public while its visibility, and so its reach, says so. A source is named only while it is an alive public
  // root itself.
  const pqxx::result rows = txn.exec(
      "select t.id, s.owner::text, m.forked_from, coalesce(source.title, ''), "
      "(select count(*) from roadmap_metas copy join roadmap_trees c on 'tree:' || c.id = copy.scope_key and c.life = 'alive' "
      " where copy.forked_from = t.id and copy.id = 'meta') "
      "from roadmap_trees t join sync_scopes s on s.key = t.scope_key "
      "join roadmap_metas m on m.scope_key = 'tree:' || t.id and m.id = 'meta' "
      "left join roadmap_trees st on st.id = m.forked_from and st.life = 'alive' "
      "left join roadmap_metas source on source.scope_key = 'tree:' || st.id and source.id = 'meta' and source.reach = 'public' "
      "  and jsonb_typeof(source.parent) is distinct from 'object' "
      "where t.life = 'alive' and jsonb_typeof(t.parent) is distinct from 'object' and m.reach = 'public' order by t.id");
  std::vector<ListedRoot> roots;
  for (std::size_t i = 0; i < rows.size(); ++i) {
    const auto row = rows[i];
    roots.push_back(ListedRoot{TreeId{row[0].as<std::string>()}, UserId{row[1].as<std::string>()},
                               ForkLineage{!row[2].is_null(), row[3].as<std::string>(), row[4].as<int>()}});
  }
  return roots;
}

ForkLineage PgRoadmapRecords::lineageOf(const TreeId& tree) {
  PgLease conn{*pool_};
  pqxx::work txn{*conn};
  const pqxx::result rows = txn.exec_params(
      "select m.forked_from, coalesce(source.title, ''), "
      "(select count(*) from roadmap_metas copy join roadmap_trees c on 'tree:' || c.id = copy.scope_key and c.life = 'alive' "
      " where copy.forked_from = $1 and copy.id = 'meta') "
      "from roadmap_metas m "
      "left join roadmap_trees st on st.id = m.forked_from and st.life = 'alive' "
      "left join roadmap_metas source on source.scope_key = 'tree:' || st.id and source.id = 'meta' and source.reach = 'public' "
      "  and jsonb_typeof(source.parent) is distinct from 'object' "
      "where m.scope_key = 'tree:' || $1 and m.id = 'meta'",
      tree.str());
  if (rows.empty()) return ForkLineage{};
  return ForkLineage{!rows[0][0].is_null(), rows[0][1].as<std::string>(), rows[0][2].as<int>()};
}

std::set<TreeId> PgRoadmapRecords::forkedSources(const UserId& viewer) {
  PgLease conn{*pool_};
  pqxx::work txn{*conn};
  const pqxx::result rows = txn.exec_params(
      "select distinct m.forked_from from roadmap_trees t join roadmap_metas m on m.scope_key = 'tree:' || t.id and m.id = 'meta' "
      "where t.scope_key = $1 and t.life = 'alive' and m.forked_from is not null",
      sync::ScopeKey::product(viewer, "roadmap").text());
  std::set<TreeId> sources;
  for (std::size_t i = 0; i < rows.size(); ++i) sources.insert(TreeId{rows[i][0].as<std::string>()});
  return sources;
}

}
