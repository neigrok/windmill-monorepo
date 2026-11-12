#include "products/roadmap/adapters/postgres/PgTreeRepository.h"
#include "platform/application/WriteObservation.h"

#include "products/roadmap/adapters/json/TreeJson.h"
#include "platform/adapters/postgres/PgPool.h"
#include "products/roadmap/domain/Crdt.h"
#include "products/roadmap/domain/LooseGraph.h"

#include <pqxx/pqxx>
#include <stdexcept>

namespace wm {

AccountErasure roadmapAccountErasure() {
  const std::string owned = "(SELECT id FROM trees WHERE owner_id = $1::uuid)";
  return {{
      "DELETE FROM tree_nodes WHERE tree_id IN " + owned,
      "DELETE FROM tree_edges WHERE tree_id IN " + owned,
      "DELETE FROM tree_kinds WHERE tree_id IN " + owned,
      "DELETE FROM tree_og_images WHERE tree_id IN " + owned,
      "DELETE FROM tree_og_videos WHERE tree_id IN " + owned,
      "DELETE FROM tree_ops WHERE tree_id IN " + owned,
      "DELETE FROM node_progress WHERE tree_id IN " + owned + " OR user_id = $1::uuid::text",
      "DELETE FROM tend_runs WHERE tree_id IN " + owned + " OR user_id = $1::uuid",
      "DELETE FROM trees WHERE owner_id = $1::uuid RETURNING id",
  }, {}};
}

namespace {

// Add-biased presence, computed by the writer so reads never compare HLC text in SQL.
bool entryPresent(const Hlc& added, const Hlc& removed) {
  return added.isSet() && !(removed > added);
}

void upsertNode(pqxx::work& txn, const TreeId& tree, const NodeStateEntry& node) {
  std::optional<double> posX, posY;
  if (node.position) { posX = node.position->x; posY = node.position->y; }
  txn.exec_params(
      "INSERT INTO tree_nodes (tree_id, node_id, created_hlc, deleted_hlc, label, label_hlc, "
      "icon, icon_hlc, color, color_hlc, pos_x, pos_y, pos_hlc, status, status_hlc, "
      "description, description_hlc, links, links_hlc, present, ord, ord_hlc, opens, opens_hlc) "
      "VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, "
      "$18::jsonb, $19, $20, $21, $22, $23, $24) "
      "ON CONFLICT (tree_id, node_id) DO UPDATE SET "
      "created_hlc = EXCLUDED.created_hlc, deleted_hlc = EXCLUDED.deleted_hlc, "
      "label = EXCLUDED.label, label_hlc = EXCLUDED.label_hlc, "
      "icon = EXCLUDED.icon, icon_hlc = EXCLUDED.icon_hlc, "
      "color = EXCLUDED.color, color_hlc = EXCLUDED.color_hlc, "
      "pos_x = EXCLUDED.pos_x, pos_y = EXCLUDED.pos_y, pos_hlc = EXCLUDED.pos_hlc, "
      "status = EXCLUDED.status, status_hlc = EXCLUDED.status_hlc, "
      "description = EXCLUDED.description, description_hlc = EXCLUDED.description_hlc, "
      "links = EXCLUDED.links, links_hlc = EXCLUDED.links_hlc, present = EXCLUDED.present, "
      "ord = EXCLUDED.ord, ord_hlc = EXCLUDED.ord_hlc, "
      "opens = EXCLUDED.opens, opens_hlc = EXCLUDED.opens_hlc",
      tree.str(), node.id.str(), toString(node.createdAt), toString(node.deletedAt),
      node.label, toString(node.labelAt), node.icon, toString(node.iconAt),
      std::string(toString(node.color)), toString(node.colorAt),
      posX, posY, toString(node.positionAt), normalizeSeedStatus(node.status), toString(node.statusAt),
      node.description, toString(node.descriptionAt),
      dump(linksToJson(node.links)), toString(node.linksAt),
      entryPresent(node.createdAt, node.deletedAt),
      node.order, toString(node.orderAt), node.opens.str(), toString(node.opensAt));
}

void upsertEdge(pqxx::work& txn, const TreeId& tree, const EdgeStateEntry& edge) {
  txn.exec_params(
      "INSERT INTO tree_edges (tree_id, from_id, to_id, added_hlc, removed_hlc) "
      "VALUES ($1, $2, $3, $4, $5) "
      "ON CONFLICT (tree_id, from_id, to_id) DO UPDATE SET "
      "added_hlc = EXCLUDED.added_hlc, removed_hlc = EXCLUDED.removed_hlc",
      tree.str(), edge.edge.from.str(), edge.edge.to.str(),
      toString(edge.addedAt), toString(edge.removedAt));
}

void upsertKind(pqxx::work& txn, const TreeId& tree, const KindStateEntry& kind) {
  txn.exec_params(
      "INSERT INTO tree_kinds (tree_id, kind_id, created_hlc, deleted_hlc, hue, hue_hlc, "
      "label, label_hlc, description, description_hlc, cross_branch_exempt, cross_branch_exempt_hlc, "
      "rank, rank_hlc) "
      "VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) "
      "ON CONFLICT (tree_id, kind_id) DO UPDATE SET "
      "created_hlc = EXCLUDED.created_hlc, deleted_hlc = EXCLUDED.deleted_hlc, "
      "hue = EXCLUDED.hue, hue_hlc = EXCLUDED.hue_hlc, "
      "label = EXCLUDED.label, label_hlc = EXCLUDED.label_hlc, "
      "description = EXCLUDED.description, description_hlc = EXCLUDED.description_hlc, "
      "cross_branch_exempt = EXCLUDED.cross_branch_exempt, "
      "cross_branch_exempt_hlc = EXCLUDED.cross_branch_exempt_hlc, "
      "rank = EXCLUDED.rank, rank_hlc = EXCLUDED.rank_hlc",
      tree.str(), kind.id.str(), toString(kind.createdAt), toString(kind.deletedAt),
      std::string(toString(kind.hue)), toString(kind.hueAt), kind.label, toString(kind.labelAt),
      kind.description, toString(kind.descriptionAt), kind.crossBranchExempt,
      toString(kind.crossBranchExemptAt), kind.rank, toString(kind.rankAt));
}

void upsertSlice(pqxx::work& txn, const TreeId& tree, const GraphState& state, const LegendState& legend) {
  for (const NodeStateEntry& node : state.nodes) upsertNode(txn, tree, node);
  for (const EdgeStateEntry& edge : state.edges) upsertEdge(txn, tree, edge);
  for (const KindStateEntry& kind : legend.kinds) upsertKind(txn, tree, kind);
}

// pqxx names the row type row_ref on macOS and row on CI's Linux, so these accessors pin the
// .template dance to one place.
std::string text(const auto& row, const char* column) { return row[column].template as<std::string>(); }
Hlc stamp(const auto& row, const char* column) { return roadmapStamp(text(row, column)); }

NodeStateEntry nodeFromRow(const auto& row) {
  NodeStateEntry node;
  node.id = NodeId{text(row, "node_id")};
  node.createdAt = stamp(row, "created_hlc");
  node.deletedAt = stamp(row, "deleted_hlc");
  node.label = text(row, "label");
  node.labelAt = stamp(row, "label_hlc");
  node.icon = text(row, "icon");
  node.iconAt = stamp(row, "icon_hlc");
  node.color = parseColor(text(row, "color")).value_or(NodeColor::terracotta);
  node.colorAt = stamp(row, "color_hlc");
  node.order = text(row, "ord");
  node.orderAt = stamp(row, "ord_hlc");
  if (!row["pos_x"].is_null() && !row["pos_y"].is_null())
    node.position = Vec2{row["pos_x"].template as<double>(), row["pos_y"].template as<double>()};
  node.positionAt = stamp(row, "pos_hlc");
  if (!row["status"].is_null()) node.status = normalizeSeedStatus(text(row, "status"));
  node.statusAt = stamp(row, "status_hlc");
  node.description = text(row, "description");
  node.descriptionAt = stamp(row, "description_hlc");
  node.links = linksFromJson(parse(text(row, "links")));
  node.linksAt = stamp(row, "links_hlc");
  node.opens = TreeId{text(row, "opens")};
  node.opensAt = stamp(row, "opens_hlc");
  return node;
}

GraphState graphRows(pqxx::work& txn, const TreeId& tree) {
  GraphState state;
  pqxx::result nodes = txn.exec_params(
      "SELECT node_id, created_hlc, deleted_hlc, label, label_hlc, icon, icon_hlc, color, "
      "color_hlc, ord, ord_hlc, pos_x, pos_y, pos_hlc, status, status_hlc, description, "
      "description_hlc, links::text AS links, links_hlc, opens, opens_hlc FROM tree_nodes WHERE tree_id = $1",
      tree.str());
  for (const auto& row : nodes) state.nodes.push_back(nodeFromRow(row));

  pqxx::result edges = txn.exec_params(
      "SELECT from_id, to_id, added_hlc, removed_hlc FROM tree_edges WHERE tree_id = $1", tree.str());
  for (const auto& row : edges) {
    state.edges.push_back(EdgeStateEntry{
        Edge{NodeId{row["from_id"].as<std::string>()}, NodeId{row["to_id"].as<std::string>()}},
        roadmapStamp(row["added_hlc"].as<std::string>()), roadmapStamp(row["removed_hlc"].as<std::string>())});
  }
  return state;
}

LegendState legendRows(pqxx::work& txn, const TreeId& tree) {
  LegendState legend;
  pqxx::result kinds = txn.exec_params(
      "SELECT kind_id, created_hlc, deleted_hlc, hue, hue_hlc, label, label_hlc, description, "
      "description_hlc, cross_branch_exempt, cross_branch_exempt_hlc, rank, rank_hlc "
      "FROM tree_kinds WHERE tree_id = $1",
      tree.str());
  for (const auto& row : kinds) {
    KindStateEntry kind;
    kind.id = KindId{row["kind_id"].as<std::string>()};
    kind.createdAt = roadmapStamp(row["created_hlc"].as<std::string>());
    kind.deletedAt = roadmapStamp(row["deleted_hlc"].as<std::string>());
    kind.hue = parseColor(row["hue"].as<std::string>()).value_or(NodeColor::terracotta);
    kind.hueAt = roadmapStamp(row["hue_hlc"].as<std::string>());
    kind.label = row["label"].as<std::string>();
    kind.labelAt = roadmapStamp(row["label_hlc"].as<std::string>());
    kind.description = row["description"].as<std::string>();
    kind.descriptionAt = roadmapStamp(row["description_hlc"].as<std::string>());
    kind.crossBranchExempt = row["cross_branch_exempt"].as<bool>();
    kind.crossBranchExemptAt = roadmapStamp(row["cross_branch_exempt_hlc"].as<std::string>());
    kind.rank = row["rank"].as<double>();
    kind.rankAt = roadmapStamp(row["rank_hlc"].as<std::string>());
    legend.kinds.push_back(std::move(kind));
  }
  return legend;
}

}

PgTreeRepository::PgTreeRepository(std::shared_ptr<PgPool> pool) : pool_(std::move(pool)) {}

std::optional<TreeAccess> PgTreeRepository::loadAccess(const TreeId& tree) {
  // Two columns, one row, no lattice: "may this caller read it?" costs a primary-key lookup.
  PgLease conn{*pool_};
  pqxx::work txn{*conn};
  pqxx::result rows = txn.exec_params(
      "SELECT owner_id::text, visibility FROM trees WHERE id = $1 AND deleted_at IS NULL",
      tree.str());
  if (rows.empty()) return std::nullopt;

  const auto& row = rows[0];
  TreeAccess access;
  if (!row["owner_id"].is_null()) access.owner = UserId{row["owner_id"].as<std::string>()};
  access.visibility = parseVisibility(row["visibility"].as<std::string>());
  return access;
}

std::optional<UserId> PgTreeRepository::retiredOwner(const TreeId& tree) {
  // Only a deleted row answers.
  PgLease conn{*pool_};
  pqxx::work txn{*conn};
  pqxx::result rows = txn.exec_params(
      "SELECT owner_id::text FROM trees WHERE id = $1 AND deleted_at IS NOT NULL", tree.str());
  if (rows.empty()) return std::nullopt;

  const auto& row = rows[0];
  if (row["owner_id"].is_null()) return std::nullopt;
  return UserId{row["owner_id"].as<std::string>()};
}

ForkLineage PgTreeRepository::loadForkLineage(const TreeId& tree) {
  PgLease conn{*pool_};
  pqxx::work txn{*conn};
  ForkLineage lineage;
  // The source is named only while it still exists and is PUBLIC; an unlisted, private or
  // deleted source stays anonymous.
  pqxx::result src = txn.exec_params(
      "SELECT t.forked_from IS NOT NULL AS is_fork, "
      "coalesce(s.title, '') AS source_title, coalesce(s.visibility, '') AS source_visibility "
      "FROM trees t LEFT JOIN trees s ON s.id = t.forked_from AND s.deleted_at IS NULL "
      "WHERE t.id = $1 AND t.deleted_at IS NULL",
      tree.str());
  if (!src.empty()) {
    const auto& row = src[0];
    lineage.isFork = row["is_fork"].as<bool>();
    if (row["source_visibility"].as<std::string>() == "public")
      lineage.sourceTitle = row["source_title"].as<std::string>();
  }
  pqxx::result forks = txn.exec_params(
      "SELECT count(*) AS n FROM trees WHERE forked_from = $1 AND deleted_at IS NULL", tree.str());
  lineage.forkCount = forks[0]["n"].as<int>();
  return lineage;
}

std::optional<StoredTree> PgTreeRepository::load(const TreeId& tree) {
  PgLease conn{*pool_};
  pqxx::work txn{*conn};
  pqxx::result rows = txn.exec_params(
      "SELECT title, title_hlc, guide, guide_hlc, guide_inherited, head_seq, document::text, owner_id::text, visibility, "
      "(extract(epoch from created_at) * 1000)::bigint AS created_ms "
      "FROM trees WHERE id = $1 AND deleted_at IS NULL",
      tree.str());
  if (rows.empty()) return std::nullopt;
  const auto row = rows[0];

  GraphState state = graphRows(txn, tree);
  LegendState legend = legendRows(txn, tree);
  if (state.nodes.empty() && state.edges.empty() && legend.kinds.empty()) {
    // A tree whose lattice lives only in the document blob: parse it and backfill the rows in this
    // same transaction.
    Json::Value document = parse(row["document"].as<std::string>());
    state = graphStateFromJson(document);
    legend = legendStateFromJson(document["kinds"]);
    upsertSlice(txn, tree, state, legend);
  }
  txn.commit();

  std::optional<UserId> owner;
  if (!row["owner_id"].is_null()) owner = UserId{row["owner_id"].as<std::string>()};
  Lww<std::string> title{row["title"].as<std::string>(), roadmapStamp(row["title_hlc"].as<std::string>())};
  Lww<std::string> guide{row["guide"].as<std::string>(), roadmapStamp(row["guide_hlc"].as<std::string>())};
  return StoredTree{std::move(state), std::move(legend), std::move(title),
                    static_cast<Seq>(row["head_seq"].as<long long>()), std::move(owner),
                    parseVisibility(row["visibility"].as<std::string>()),
                    static_cast<std::uint64_t>(row["created_ms"].as<long long>()), std::move(guide),
                    row["guide_inherited"].as<bool>()};
}

bool PgTreeRepository::save(const TreeId& tree, const GraphState& state, const LegendState& legend,
                            const Lww<std::string>& title, const Lww<std::string>& guide, Seq head) {
  PgLease conn{*pool_};
  pqxx::work txn{*conn};
  // Only onto a row that stands: a tree erased or retired under its live room is not written back.
  if (txn.exec_params("UPDATE trees SET head_seq = $2, updated_at = now() WHERE id = $1 AND deleted_at IS NULL "
                      "RETURNING id",
                      tree.str(), static_cast<long long>(head))
          .empty())
    return false;
  // The title and guide registers are LWW at their columns: each lands only under a dominating
  // stamp. (ms, counter) order numerically; a tie falls to byte order (COLLATE "C"), which is the
  // actor tiebreak.
  txn.exec_params(
      "UPDATE trees SET title = $2, title_hlc = $3, title_ms = $4, title_counter = $5 "
      "WHERE id = $1 AND ($4::bigint, $5::bigint, $3::text COLLATE \"C\") "
      "> (title_ms, title_counter, title_hlc COLLATE \"C\")",
      tree.str(), title.value, toString(title.stamp),
      static_cast<long long>(title.stamp.physicalMs), static_cast<long long>(title.stamp.counter));
  txn.exec_params(
      "UPDATE trees SET guide = $2, guide_hlc = $3, guide_ms = $4, guide_counter = $5, guide_inherited = false "
      "WHERE id = $1 AND ($4::bigint, $5::bigint, $3::text COLLATE \"C\") "
      "> (guide_ms, guide_counter, guide_hlc COLLATE \"C\")",
      tree.str(), guide.value, toString(guide.stamp),
      static_cast<long long>(guide.stamp.physicalMs), static_cast<long long>(guide.stamp.counter));
  upsertSlice(txn, tree, state, legend);  // only the dirty slice — never the whole tree
  txn.commit();
  markCurrentWrite();
  return true;
}

void PgTreeRepository::create(const TreeId& tree, const GraphState& state, const LegendState& legend,
                              const std::string& title, const UserId& owner) {
  PgLease conn{*pool_};
  pqxx::work txn{*conn};
  if (txn.exec_params("SELECT id FROM users WHERE id=$1::uuid FOR KEY SHARE", owner.str()).empty())
    throw std::runtime_error("account no longer exists");
  try {
    txn.exec_params("INSERT INTO trees (id, title, head_seq, owner_id) VALUES ($1, $2, 0, $3::uuid)",
                    tree.str(), title, owner.str());
  } catch (const pqxx::unique_violation&) {
    throw DuplicateTree{};  // the unique index arbitrates cross-process races
  }
  upsertSlice(txn, tree, state, legend);
  txn.commit();
}

std::vector<OwnedTree> PgTreeRepository::listOwnedBy(const UserId& owner) {
  PgLease conn{*pool_};
  pqxx::work txn{*conn};
  pqxx::result rows = txn.exec_params(
      "SELECT id, title, document::text, "
      "(extract(epoch from created_at) * 1000)::bigint AS created_ms, "
      "(extract(epoch from updated_at) * 1000)::bigint AS updated_ms "
      "FROM trees WHERE owner_id = $1::uuid AND deleted_at IS NULL",
      owner.str());

  std::vector<OwnedTree> owned;
  owned.reserve(rows.size());
  for (const auto& row : rows) {
    TreeData data = projectDocument(txn, TreeId{row["id"].as<std::string>()}, row["title"].as<std::string>(),
                                    row["document"].as<std::string>()).data;
    owned.push_back(OwnedTree{std::move(data),
                              static_cast<std::uint64_t>(row["created_ms"].as<long long>()),
                              static_cast<std::uint64_t>(row["updated_ms"].as<long long>())});
  }
  return owned;
}

PgTreeRepository::ProjectedDocument PgTreeRepository::projectDocument(pqxx::work& txn, const TreeId& tree,
                                                                     const std::string& title,
                                                                     const std::string& documentBlob) {
  pqxx::result nodes = txn.exec_params(
      "SELECT node_id, color, opens, opens_hlc FROM tree_nodes WHERE tree_id = $1 AND present", tree.str());
  ProjectedDocument projected;
  projected.data.id = tree;
  projected.data.title = title;
  for (const auto& n : nodes) {
    NodeSpec spec;
    spec.id = NodeId{n["node_id"].as<std::string>()};
    spec.color = parseColor(n["color"].as<std::string>()).value_or(NodeColor::terracotta);
    spec.opens = TreeId{n["opens"].as<std::string>()};
    if (!spec.opens.empty()) projected.pointers.emplace(spec.id, StampedPointer{spec.opens, stamp(n, "opens_hlc")});
    projected.data.nodes.push_back(std::move(spec));
  }
  if (!projected.data.nodes.empty()) return projected;
  // A tree with no rows yet: fall back to the document blob.
  const LooseGraph graph(graphStateFromJson(parse(documentBlob)));
  return {graph.toTreeData(tree, title), graph.stampedPointers()};
}

std::vector<ListedTree> PgTreeRepository::listPublic() {
  PgLease conn{*pool_};
  pqxx::work txn{*conn};
  // Every listed tree, unbounded: ordering and the wall's cap belong to the domain, and a LIMIT
  // here would quietly change the ranking rule. The LEFT JOIN carries loadForkLineage's privacy
  // rule in its ON clause, so an unlisted, private or deleted source coalesces to ''. The owner's
  // marks are read after, as a reader is shown them.
  pqxx::result rows = txn.exec_params(
      "SELECT t.id, t.title, t.owner_id::text AS owner_id, t.document::text, "
      "(extract(epoch from t.updated_at) * 1000)::bigint AS updated_ms, "
      "(SELECT count(*) FROM trees f WHERE f.forked_from = t.id AND f.deleted_at IS NULL) AS forks, "
      "coalesce(s.title, '') AS source_title "
      "FROM trees t "
      "LEFT JOIN trees s ON s.id = t.forked_from AND s.deleted_at IS NULL AND s.visibility = 'public' "
      "WHERE t.visibility = 'public' AND t.deleted_at IS NULL AND t.owner_id IS NOT NULL");

  std::vector<ListedTree> listed;
  listed.reserve(rows.size());
  for (const auto& row : rows) {
    ListedTree entry;
    ProjectedDocument projected = projectDocument(txn, TreeId{row["id"].as<std::string>()},
                                                  row["title"].as<std::string>(), row["document"].as<std::string>());
    entry.data = std::move(projected.data);
    entry.pointers = std::move(projected.pointers);
    entry.updatedAt = static_cast<std::uint64_t>(row["updated_ms"].as<long long>());
    entry.forks = row["forks"].as<int>();
    entry.owner = UserId{row["owner_id"].as<std::string>()};
    entry.sourceTitle = row["source_title"].as<std::string>();
    listed.push_back(std::move(entry));
  }
  return listed;
}

std::set<TreeId> PgTreeRepository::listForkedSources(const UserId& owner) {
  PgLease conn{*pool_};
  pqxx::work txn{*conn};
  // One row per source this user still holds a fork of; a deleted fork drops out.
  pqxx::result rows = txn.exec_params(
      "SELECT DISTINCT forked_from FROM trees "
      "WHERE owner_id = $1::uuid AND forked_from IS NOT NULL AND deleted_at IS NULL",
      owner.str());

  std::set<TreeId> sources;
  for (const auto& row : rows) sources.insert(TreeId{row["forked_from"].as<std::string>()});
  return sources;
}

std::map<TreeId, std::string> PgTreeRepository::titlesOwnedBy(const UserId& owner, const std::set<TreeId>& trees) {
  if (trees.empty()) return {};
  Json::Value ids(Json::arrayValue);
  for (const TreeId& tree : trees) ids.append(tree.str());
  PgLease conn{*pool_};
  pqxx::work txn{*conn};
  pqxx::result rows = txn.exec_params(
      "SELECT id, title FROM trees WHERE deleted_at IS NULL AND owner_id = $1::uuid "
      "AND id IN (SELECT jsonb_array_elements_text($2::jsonb))",
      owner.str(), dump(ids));

  std::map<TreeId, std::string> titles;
  for (const auto& row : rows) titles.emplace(TreeId{row["id"].as<std::string>()}, row["title"].as<std::string>());
  return titles;
}

const char* PgTreeRepository::openedFromStatement() {
  // One statement: the counts and the marks are one snapshot, and no node row leaves the database.
  return
      "WITH RECURSIVE reached(id, title) AS ("
      "  SELECT t.id, t.title FROM trees t "
      "  WHERE t.deleted_at IS NULL AND t.owner_id = $1::uuid "
      "    AND t.id IN (SELECT jsonb_array_elements_text($2::jsonb)) "
      // UNION keeps each tree once, which is what ends the walk on a loop.
      "  UNION "
      "  SELECT t.id, t.title FROM reached r "
      // Each LATERAL runs once per row before it, so each table is read by its key whatever the planner expects.
      "  CROSS JOIN LATERAL (SELECT DISTINCT n.opens FROM tree_nodes n WHERE n.tree_id = r.id AND n.present) o "
      "  CROSS JOIN LATERAL (SELECT s.id, s.title, s.owner_id, s.deleted_at FROM trees s WHERE s.id = o.opens LIMIT 1) t "
      "  WHERE t.deleted_at IS NULL AND t.owner_id = $1::uuid"
      ") "
      // A row is a tree and one target: '' for its nodes that open none, NULL for a tree with no node. `latest` is
      // the stamp and receipt instant of the latest of the marks counted that carry a stamp, in the order the domain
      // compares stamps: a row written before marks were stamped counts, and is never the latest.
      "SELECT r.id, r.title, c.opens, c.nodes, c.marked, c.latest[1][1] AS latest_hlc, c.latest[1][2] AS latest_ms "
      "FROM reached r LEFT JOIN LATERAL ("
      "  SELECT n.opens, count(*) AS nodes, count(m.node_id) AS marked, "
      "         (array_agg(ARRAY[m.hlc, m.updated_ms::text] "
      "                    ORDER BY m.stamp_ms DESC, m.stamp_counter DESC, m.hlc COLLATE \"C\" DESC) "
      "            FILTER (WHERE m.node_id IS NOT NULL AND m.hlc NOT IN ('', '0:0:'))) AS latest "
      "  FROM tree_nodes n LEFT JOIN ("
      "    SELECT p.node_id, p.hlc, p.stamp_ms, p.stamp_counter, "
      "           (extract(epoch from p.updated_at) * 1000)::bigint AS updated_ms FROM node_progress p "
      // Both indexes on the reader's marks lead with the tree and the reader, in either order (node_progress_pkey and
      // node_progress_user_tree), so whichever the planner takes, it reads this reader's marks on this tree alone.
      "    WHERE p.tree_id = r.id AND p.user_id = $1::text AND p.status = 'complete'"
      "  ) m ON m.node_id = n.node_id "
      "  WHERE n.tree_id = r.id AND n.present GROUP BY n.opens"
      ") c ON true";
}

std::map<TreeId, OpenedTree> PgTreeRepository::openedFrom(const UserId& owner, const std::set<TreeId>& opened,
                                                          std::optional<std::chrono::milliseconds> budget) {
  if (opened.empty()) return {};
  Json::Value ids(Json::arrayValue);
  for (const TreeId& tree : opened) ids.append(tree.str());
  PgLease conn{*pool_};
  pqxx::work txn{*conn};
  // The budget is this transaction's alone: the connection goes back to the pool under its own limit.
  if (budget) txn.exec("SET LOCAL statement_timeout = '" + std::to_string(budget->count()) + "ms'");
  const char* statement = openedFromStatement();
  pqxx::result rows;
  try {
    rows = txn.exec_params(statement, owner.str(), dump(ids));
  } catch (const pqxx::sql_error& error) {
    if (budget && std::string{error.sqlstate()} == "57014") throw FollowTimedOut{};
    throw;
  }

  std::map<TreeId, OpenedTree> trees;
  for (const auto& row : rows) {
    OpenedTree& tree = trees[TreeId{row["id"].as<std::string>()}];
    tree.title = row["title"].as<std::string>();
    if (row["opens"].is_null()) continue;
    Pointers counted{row["nodes"].as<int>(), row["marked"].as<int>()};
    if (!row["latest_hlc"].is_null())
      counted.latest = LatestMark{roadmapStamp(row["latest_hlc"].as<std::string>()),
                                  static_cast<std::uint64_t>(row["latest_ms"].as<long long>())};
    tree.total += counted.nodes;
    const TreeId target{row["opens"].as<std::string>()};
    if (target.empty()) {
      tree.marked = counted.marked;
      tree.latest = counted.latest;
      continue;
    }
    tree.pointers.emplace(target, counted);
  }
  return trees;
}

const char* PgTreeRepository::guidedTreesAboveStatement() {
  // Keyed on the owner's own standing trees, so its cost does not grow with the pointers other accounts plant at one.
  return "WITH RECURSIVE owned(id, guided) AS MATERIALIZED ("
         "  SELECT t.id, t.guide <> '' FROM trees t WHERE t.owner_id = $1::uuid AND t.deleted_at IS NULL"
         "), "
         // The LATERAL runs once per owned tree, so each tree's pointers are read by its key whatever the planner
         // expects; tree_nodes_pointers_idx serves only a scan that states its predicate. Only a pointer at
         // another of the owner's standing trees can lead anywhere.
         "pointers(tree, opens) AS MATERIALIZED ("
         "  SELECT o.id, p.opens FROM owned o "
         "  CROSS JOIN LATERAL (SELECT DISTINCT n.opens FROM tree_nodes n "
         "                      WHERE n.tree_id = o.id AND n.present AND n.opens <> '') p "
         "  WHERE p.opens IN (SELECT target.id FROM owned target)"
         "), "
         "reached(id, distance) AS ("
         "  SELECT o.id, 0 FROM owned o WHERE o.id = $2 "
         // UNION keeps a tree once per distance and the levels end the walk, so a loop costs no more than its trees.
         "  UNION "
         "  SELECT p.tree, r.distance + 1 FROM reached r JOIN pointers p ON p.opens = r.id "
         "  WHERE r.distance < $3 AND p.tree <> $2"
         ") "
         // nearestGuided's cut, made here so only the rows a reading can keep are answered: the id ordered by its bytes.
         "SELECT g.id, nearest.distance, g.title, g.guide, g.guide_inherited "
         "FROM (SELECT r.id, min(r.distance) AS distance FROM reached r JOIN owned o ON o.id = r.id "
         "      WHERE r.distance > 0 AND o.guided GROUP BY r.id ORDER BY distance, r.id COLLATE \"C\" LIMIT $4) nearest "
         "CROSS JOIN LATERAL (SELECT s.id, s.title, s.guide, s.guide_inherited FROM trees s WHERE s.id = nearest.id LIMIT 1) g";
}

std::map<TreeId, TreeAbove> PgTreeRepository::guidedTreesAbove(const UserId& owner, const TreeId& tree) {
  PgLease conn{*pool_};
  pqxx::work txn{*conn};
  // One statement: the walk and the guides it answers are one snapshot.
  pqxx::result rows = txn.exec_params(guidedTreesAboveStatement(), owner.str(), tree.str(), kMaxLevelsAbove,
                                      static_cast<int>(kMaxGuides));

  std::map<TreeId, TreeAbove> above;
  for (const auto& row : rows)
    above.emplace(TreeId{row["id"].as<std::string>()},
                  TreeAbove{row["distance"].as<int>(), row["title"].as<std::string>(), row["guide"].as<std::string>(),
                            row["guide_inherited"].as<bool>()});
  return above;
}

void PgTreeRepository::softDelete(const TreeId& tree) {
  PgLease conn{*pool_};
  pqxx::work txn{*conn};
  txn.exec_params("UPDATE trees SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL", tree.str());
  txn.commit();
}

void PgTreeRepository::rename(const TreeId& tree, const Lww<std::string>& title) {
  PgLease conn{*pool_};
  pqxx::work txn{*conn};
  txn.exec_params(  // the same LWW guard as save(): only a dominating stamp lands
      "UPDATE trees SET title = $2, title_hlc = $3, title_ms = $4, title_counter = $5, "
      "updated_at = now() WHERE id = $1 AND deleted_at IS NULL "
      "AND ($4::bigint, $5::bigint, $3::text COLLATE \"C\") "
      "> (title_ms, title_counter, title_hlc COLLATE \"C\")",
      tree.str(), title.value, toString(title.stamp),
      static_cast<long long>(title.stamp.physicalMs), static_cast<long long>(title.stamp.counter));
  txn.commit();
}

void PgTreeRepository::setVisibility(const TreeId& tree, Visibility visibility) {
  PgLease conn{*pool_};
  pqxx::work txn{*conn};
  // Does NOT touch updated_at: the gallery folds that column into last-active, so a bump here
  // would let a visibility flip vault a long-dead tree up the wall.
  txn.exec_params("UPDATE trees SET visibility = $2 WHERE id = $1 AND deleted_at IS NULL",
                  tree.str(), toString(visibility));
  txn.commit();
}

void PgTreeRepository::fork(const TreeId& newTree, const TreeId& source, const GraphState& state,
                           const LegendState& legend, const Lww<std::string>& title, const Lww<std::string>& guide,
                           bool guideInherited, const UserId& owner) {
  PgLease conn{*pool_};
  pqxx::work txn{*conn};
  if (txn.exec_params("SELECT id FROM users WHERE id=$1::uuid FOR KEY SHARE", owner.str()).empty())
    throw std::runtime_error("account no longer exists");
  try {
    txn.exec_params(
        "INSERT INTO trees (id, title, title_hlc, title_ms, title_counter, guide, guide_hlc, guide_ms, guide_counter, "
        "guide_inherited, head_seq, forked_from, owner_id) "
        "VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 0, $11, $12::uuid)",
        newTree.str(), title.value, toString(title.stamp), static_cast<long long>(title.stamp.physicalMs),
        static_cast<long long>(title.stamp.counter), guide.value, toString(guide.stamp),
        static_cast<long long>(guide.stamp.physicalMs), static_cast<long long>(guide.stamp.counter), guideInherited,
        source.str(), owner.str());
  } catch (const pqxx::unique_violation&) {
    throw DuplicateTree{};
  }
  upsertSlice(txn, newTree, state, legend);
  txn.commit();
}

}
