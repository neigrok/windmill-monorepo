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

std::string treeNameColumn(std::string_view tree) {
  const std::string t{tree};
  return "CASE WHEN " + t + ".parent_tree IS NULL THEN " + t + ".title ELSE coalesce((SELECT owning.label FROM tree_nodes owning "
         "WHERE owning.tree_id = " + t + ".parent_tree AND owning.node_id = " + t + ".parent_step), '') END";
}

std::string rootStandsCondition(std::string_view tree) {
  const std::string t{tree};
  return "CASE WHEN " + t + ".parent_tree IS NULL THEN true "
         "ELSE EXISTS (SELECT 1 FROM trees root WHERE root.id = " + t + ".root_tree AND root.deleted_at IS NULL) END";
}

std::string ownedSubtreeJoin(std::string_view step) {
  const std::string n{step};
  return "LEFT JOIN trees owned ON owned.parent_tree = " + n + ".tree_id AND owned.parent_step = " + n + ".node_id "
         "AND owned.deleted_at IS NULL";
}

std::string stepOpensColumn(std::string_view step) { return "coalesce(owned.id, " + std::string{step} + ".opens)"; }

namespace {

// Add-biased presence, computed by the writer so reads never compare HLC text in SQL.
bool entryPresent(const Hlc& added, const Hlc& removed) {
  return added.isSet() && !(removed > added);
}

void upsertNode(pqxx::work& txn, const TreeId& tree, const NodeStateEntry& node) {
  txn.exec_params(
      "INSERT INTO tree_nodes (tree_id, node_id, created_hlc, deleted_hlc, label, label_hlc, "
      "icon, icon_hlc, color, color_hlc, status, status_hlc, "
      "description, description_hlc, links, links_hlc, present, ord, ord_hlc, opens, opens_hlc) "
      "VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, "
      "$15::jsonb, $16, $17, $18, $19, $20, $21) "
      "ON CONFLICT (tree_id, node_id) DO UPDATE SET "
      "created_hlc = EXCLUDED.created_hlc, deleted_hlc = EXCLUDED.deleted_hlc, "
      "label = EXCLUDED.label, label_hlc = EXCLUDED.label_hlc, "
      "icon = EXCLUDED.icon, icon_hlc = EXCLUDED.icon_hlc, "
      "color = EXCLUDED.color, color_hlc = EXCLUDED.color_hlc, "
      "status = EXCLUDED.status, status_hlc = EXCLUDED.status_hlc, "
      "description = EXCLUDED.description, description_hlc = EXCLUDED.description_hlc, "
      "links = EXCLUDED.links, links_hlc = EXCLUDED.links_hlc, present = EXCLUDED.present, "
      "ord = EXCLUDED.ord, ord_hlc = EXCLUDED.ord_hlc, "
      "opens = EXCLUDED.opens, opens_hlc = EXCLUDED.opens_hlc",
      tree.str(), node.id.str(), toString(node.createdAt), toString(node.deletedAt),
      node.label, toString(node.labelAt), node.icon, toString(node.iconAt),
      std::string(toString(node.color)), toString(node.colorAt),
      normalizeSeedStatus(node.status), toString(node.statusAt),
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
      "label, label_hlc, description, description_hlc, rank, rank_hlc) "
      "VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) "
      "ON CONFLICT (tree_id, kind_id) DO UPDATE SET "
      "created_hlc = EXCLUDED.created_hlc, deleted_hlc = EXCLUDED.deleted_hlc, "
      "hue = EXCLUDED.hue, hue_hlc = EXCLUDED.hue_hlc, "
      "label = EXCLUDED.label, label_hlc = EXCLUDED.label_hlc, "
      "description = EXCLUDED.description, description_hlc = EXCLUDED.description_hlc, "
      "rank = EXCLUDED.rank, rank_hlc = EXCLUDED.rank_hlc",
      tree.str(), kind.id.str(), toString(kind.createdAt), toString(kind.deletedAt),
      std::string(toString(kind.hue)), toString(kind.hueAt), kind.label, toString(kind.labelAt),
      kind.description, toString(kind.descriptionAt), kind.rank, toString(kind.rankAt));
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
      "color_hlc, ord, ord_hlc, status, status_hlc, description, "
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
      "description_hlc, rank, rank_hlc "
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
    kind.rank = row["rank"].as<double>();
    kind.rankAt = roadmapStamp(row["rank_hlc"].as<std::string>());
    legend.kinds.push_back(std::move(kind));
  }
  return legend;
}

}

PgTreeRepository::PgTreeRepository(std::shared_ptr<PgPool> pool) : pool_(std::move(pool)) {}

std::optional<TreeAccess> PgTreeRepository::loadAccess(const TreeId& tree) {
  // Two columns of the root's row, no lattice: "may this caller read it?" costs two primary-key lookups.
  PgLease conn{*pool_};
  pqxx::work txn{*conn};
  pqxx::result rows = txn.exec_params(
      "SELECT r.owner_id::text AS owner_id, r.visibility, r.id AS root, t.parent_tree, t.parent_step "
      "FROM trees t JOIN trees r ON r.id = t.root_tree "
      "WHERE t.id = $1 AND t.deleted_at IS NULL AND r.deleted_at IS NULL",
      tree.str());
  if (rows.empty()) return std::nullopt;

  const auto& row = rows[0];
  TreeAccess access;
  if (!row["owner_id"].is_null()) access.owner = UserId{row["owner_id"].as<std::string>()};
  access.visibility = parseVisibility(row["visibility"].as<std::string>());
  access.root = TreeId{text(row, "root")};
  if (!row["parent_tree"].is_null())
    access.parent = OwningStep{TreeId{text(row, "parent_tree")}, NodeId{text(row, "parent_step")}};
  return access;
}

std::optional<Place> PgTreeRepository::placeOf(const TreeId& tree) {
  PgLease conn{*pool_};
  pqxx::work txn{*conn};
  // One walk up the parents through trees_pkey, at most kMaxTreeDepth rows, each named in the same snapshot.
  pqxx::result rows = txn.exec_params(
      "WITH RECURSIVE up(id, title, title_hlc, parent_tree, parent_step, depth, deleted) AS ("
      "  SELECT t.id, t.title, t.title_hlc, t.parent_tree, t.parent_step, t.depth, t.deleted_at IS NOT NULL "
      "  FROM trees t WHERE t.id = $1"
      "  UNION ALL"
      "  SELECT p.id, p.title, p.title_hlc, p.parent_tree, p.parent_step, p.depth, p.deleted_at IS NOT NULL "
      "  FROM up u JOIN trees p ON p.id = u.parent_tree"
      ") "
      "SELECT u.id, " + treeNameColumn("u") + " AS name, "
      "CASE WHEN u.parent_tree IS NULL THEN u.title_hlc ELSE coalesce((SELECT owning.label_hlc FROM tree_nodes owning "
      "WHERE owning.tree_id = u.parent_tree AND owning.node_id = u.parent_step), '') END AS name_hlc, "
      "u.parent_tree, u.parent_step, u.depth, u.deleted FROM up u ORDER BY u.depth",
      tree.str());
  // A tree stands while its own row and its root's do: the first row is the root, the last the tree.
  if (rows.empty() || rows[0]["deleted"].as<bool>() || rows[rows.size() - 1]["deleted"].as<bool>()) return std::nullopt;

  const auto& own = rows[rows.size() - 1];
  Place place;
  place.title = text(own, "name");
  place.titleAt = stamp(own, "name_hlc");
  place.root = TreeId{text(rows[0], "id")};
  place.depth = own["depth"].as<int>();
  if (!own["parent_tree"].is_null())
    place.parent = OwningStep{TreeId{text(own, "parent_tree")}, NodeId{text(own, "parent_step")}};
  for (pqxx::result::size_type i = 0; i + 1 < rows.size(); ++i)
    place.path.push_back(PathStep{TreeId{text(rows[i], "id")}, NodeId{text(rows[i + 1], "parent_step")},
                                  text(rows[i], "name")});
  return place;
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
  // A subtree is read by its root's owner and visibility, and stands only while its root does.
  pqxx::result rows = txn.exec_params(
      "SELECT t.title, t.title_hlc, t.guide, t.guide_hlc, t.guide_inherited, t.head_seq, t.document::text, "
      "r.owner_id::text AS owner_id, r.visibility, t.root_tree, t.parent_tree, t.parent_step, t.depth, "
      "(extract(epoch from t.created_at) * 1000)::bigint AS created_ms "
      "FROM trees t JOIN trees r ON r.id = t.root_tree "
      "WHERE t.id = $1 AND t.deleted_at IS NULL AND r.deleted_at IS NULL",
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
  // Through trees_parent_step, which leads with the parent.
  std::map<NodeId, TreeId> subtrees;
  for (const auto& owned : txn.exec_params(
           "SELECT parent_step, id FROM trees WHERE parent_tree = $1 AND deleted_at IS NULL", tree.str()))
    subtrees.emplace(NodeId{text(owned, "parent_step")}, TreeId{text(owned, "id")});
  txn.commit();

  std::optional<UserId> owner;
  if (!row["owner_id"].is_null()) owner = UserId{row["owner_id"].as<std::string>()};
  Lww<std::string> title{row["title"].as<std::string>(), roadmapStamp(row["title_hlc"].as<std::string>())};
  Lww<std::string> guide{row["guide"].as<std::string>(), roadmapStamp(row["guide_hlc"].as<std::string>())};
  std::optional<OwningStep> parent;
  if (!row["parent_tree"].is_null()) parent = OwningStep{TreeId{text(row, "parent_tree")}, NodeId{text(row, "parent_step")}};
  return StoredTree{std::move(state), std::move(legend), std::move(title),
                    static_cast<Seq>(row["head_seq"].as<long long>()), std::move(owner),
                    parseVisibility(row["visibility"].as<std::string>()),
                    static_cast<std::uint64_t>(row["created_ms"].as<long long>()), std::move(guide),
                    row["guide_inherited"].as<bool>(), TreeId{text(row, "root_tree")}, std::move(parent),
                    row["depth"].as<int>(), std::move(subtrees)};
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
      "SELECT id, title, document::text, parent_tree, parent_step, "
      "(extract(epoch from created_at) * 1000)::bigint AS created_ms, "
      "(extract(epoch from updated_at) * 1000)::bigint AS updated_ms "
      "FROM trees WHERE owner_id = $1::uuid AND deleted_at IS NULL",
      owner.str());

  std::vector<OwnedTree> owned;
  owned.reserve(rows.size());
  for (const auto& row : rows) {
    TreeData data = projectDocument(txn, TreeId{row["id"].as<std::string>()}, row["title"].as<std::string>(),
                                    row["document"].as<std::string>()).data;
    std::optional<OwningStep> parent;
    if (!row["parent_tree"].is_null())
      parent = OwningStep{TreeId{text(row, "parent_tree")}, NodeId{text(row, "parent_step")}};
    owned.push_back(OwnedTree{std::move(data), static_cast<std::uint64_t>(row["created_ms"].as<long long>()),
                              static_cast<std::uint64_t>(row["updated_ms"].as<long long>()), std::move(parent)});
  }
  return owned;
}

PgTreeRepository::ProjectedDocument PgTreeRepository::projectDocument(pqxx::work& txn, const TreeId& tree,
                                                                     const std::string& title,
                                                                     const std::string& documentBlob) {
  // A step that owns a standing subtree opens it, under no stamp, whatever its pointer holds.
  pqxx::result nodes = txn.exec_params(
      "SELECT n.node_id, n.color, " + stepOpensColumn("n") + " AS opens, "
      "CASE WHEN owned.id IS NULL THEN n.opens_hlc ELSE '' END AS opens_hlc FROM tree_nodes n " + ownedSubtreeJoin("n") +
          " WHERE n.tree_id = $1 AND n.present",
      tree.str());
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
  // Every listed root, unbounded: ordering and the wall's cap belong to the domain, and a LIMIT
  // here would quietly change the ranking rule. A subtree is shared as its root is and never listed. The LEFT JOIN carries loadForkLineage's privacy
  // rule in its ON clause, so an unlisted, private or deleted source coalesces to ''. The owner's
  // marks are read after, as a reader is shown them.
  pqxx::result rows = txn.exec_params(
      "SELECT t.id, t.title, t.owner_id::text AS owner_id, t.document::text, "
      "(extract(epoch from t.updated_at) * 1000)::bigint AS updated_ms, "
      "(SELECT count(*) FROM trees f WHERE f.forked_from = t.id AND f.deleted_at IS NULL) AS forks, "
      "coalesce(s.title, '') AS source_title "
      "FROM trees t "
      "LEFT JOIN trees s ON s.id = t.forked_from AND s.deleted_at IS NULL AND s.visibility = 'public' "
      "WHERE t.visibility = 'public' AND t.deleted_at IS NULL AND t.owner_id IS NOT NULL AND t.parent_tree IS NULL");

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

std::string PgTreeRepository::openedFromStatement() {
  // One statement: the counts and the marks are one snapshot, and no node row leaves the database. A step opens the
  // subtree it owns, found through trees_parent_step, else the tree its pointer names; a tree stands while its own row
  // and its root's do, the root read only for a subtree.
  const std::string opens = stepOpensColumn("n");
  const std::string owned = ownedSubtreeJoin("n") + " ";
  const std::string rootStands = rootStandsCondition("t");
  return
      "WITH RECURSIVE reached(id, title, parent_tree, parent_step) AS ("
      "  SELECT t.id, t.title, t.parent_tree, t.parent_step FROM trees t "
      "  WHERE t.deleted_at IS NULL AND t.owner_id = $1::uuid "
      "    AND t.id IN (SELECT jsonb_array_elements_text($2::jsonb)) AND " + rootStands + " "
      // UNION keeps each tree once, which is what ends the walk on a loop.
      "  UNION "
      "  SELECT t.id, t.title, t.parent_tree, t.parent_step FROM reached r "
      // Each LATERAL runs once per row before it, so each table is read by its key whatever the planner expects.
      "  CROSS JOIN LATERAL (SELECT DISTINCT " + opens + " AS opens FROM tree_nodes n " + owned +
      "                      WHERE n.tree_id = r.id AND n.present) o "
      "  CROSS JOIN LATERAL (SELECT s.id, s.title, s.owner_id, s.deleted_at, s.parent_tree, s.parent_step, s.root_tree "
      "                      FROM trees s "
      "                      WHERE s.id = o.opens LIMIT 1) t "
      "  WHERE t.deleted_at IS NULL AND t.owner_id = $1::uuid AND " + rootStands +
      ") "
      // A row is a tree and one target: '' for its nodes that open none, NULL for a tree with no node. `latest` is
      // the stamp and receipt instant of the latest of the marks counted that carry a stamp, in the order the domain
      // compares stamps: a row written before marks were stamped counts, and is never the latest.
      "SELECT r.id, " + treeNameColumn("r") + " AS title, c.opens, c.nodes, c.marked, "
      "c.latest[1][1] AS latest_hlc, c.latest[1][2] AS latest_ms "
      "FROM reached r LEFT JOIN LATERAL ("
      "  SELECT " + opens + " AS opens, count(*) AS nodes, count(m.node_id) AS marked, "
      "         (array_agg(ARRAY[m.hlc, m.updated_ms::text] "
      "                    ORDER BY m.stamp_ms DESC, m.stamp_counter DESC, m.hlc COLLATE \"C\" DESC) "
      "            FILTER (WHERE m.node_id IS NOT NULL AND m.hlc NOT IN ('', '0:0:'))) AS latest "
      "  FROM tree_nodes n " + owned + "LEFT JOIN ("
      "    SELECT p.node_id, p.hlc, p.stamp_ms, p.stamp_counter, "
      "           (extract(epoch from p.updated_at) * 1000)::bigint AS updated_ms FROM node_progress p "
      // Both indexes on the reader's marks lead with the tree and the reader, in either order (node_progress_pkey and
      // node_progress_user_tree), so whichever the planner takes, it reads this reader's marks on this tree alone.
      "    WHERE p.tree_id = r.id AND p.user_id = $1::text AND p.status = 'complete'"
      "  ) m ON m.node_id = n.node_id "
      "  WHERE n.tree_id = r.id AND n.present GROUP BY " + opens +
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
  const std::string statement = openedFromStatement();
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

std::string PgTreeRepository::guidedTreesAboveStatement() {
  // Keyed on the owner's own standing trees, so its cost does not grow with the pointers other accounts plant at one. A
  // subtree stands while its root does, which is read for a subtree alone.
  return "WITH RECURSIVE owned(id, guided, parent_tree) AS MATERIALIZED ("
         "  SELECT t.id, t.guide <> '', t.parent_tree FROM trees t WHERE t.owner_id = $1::uuid AND t.deleted_at IS NULL "
         "  AND " + rootStandsCondition("t") +
         "), "
         // What lies directly below each tree: the subtrees it owns, off the rows already read, and each root its steps
         // point at. The LATERAL runs once per owned tree, so each tree's pointers are read by its key whatever the
         // planner expects; tree_nodes_pointers_idx serves only a scan that states its predicate. A step that owns a
         // subtree opens it and no other tree, and a pointer leads anywhere only at another of the owner's standing roots.
         "below(tree, opens) AS MATERIALIZED ("
         "  SELECT o.parent_tree, o.id FROM owned o WHERE o.parent_tree IN (SELECT parent.id FROM owned parent) "
         "  UNION ALL "
         "  SELECT o.id, p.opens FROM owned o "
         "  CROSS JOIN LATERAL (SELECT DISTINCT n.opens FROM tree_nodes n "
         "                      WHERE n.tree_id = o.id AND n.present AND n.opens <> '' "
         "                        AND NOT EXISTS (SELECT 1 FROM trees owning WHERE owning.parent_tree = n.tree_id "
         "                                        AND owning.parent_step = n.node_id AND owning.deleted_at IS NULL)) p "
         "  WHERE p.opens IN (SELECT target.id FROM owned target WHERE target.parent_tree IS NULL)"
         "), "
         "reached(id, distance) AS ("
         "  SELECT o.id, 0 FROM owned o WHERE o.id = $2 "
         // UNION keeps a tree once per distance and the levels end the walk, so a loop costs no more than its trees.
         "  UNION "
         "  SELECT b.tree, r.distance + 1 FROM reached r JOIN below b ON b.opens = r.id "
         "  WHERE r.distance < $3 AND b.tree <> $2"
         ") "
         // nearestGuided's cut, made here so only the rows a reading can keep are answered: the id ordered by its bytes.
         "SELECT g.id, nearest.distance, " + treeNameColumn("g") + " AS title, g.guide, g.guide_inherited "
         "FROM (SELECT r.id, min(r.distance) AS distance FROM reached r JOIN owned o ON o.id = r.id "
         "      WHERE r.distance > 0 AND o.guided GROUP BY r.id ORDER BY distance, r.id COLLATE \"C\" LIMIT $4) nearest "
         "CROSS JOIN LATERAL (SELECT s.id, s.title, s.guide, s.guide_inherited, s.parent_tree, s.parent_step FROM trees s "
         "                    WHERE s.id = nearest.id LIMIT 1) g";
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

const char* PgTreeRepository::treesOpeningStatement() {
  // Keyed on the owner's own trees. The LATERAL runs once per standing one and stops at its first node that opens $2, so
  // each tree's pointers are read by its key on tree_nodes_pointers_idx, which serves only a scan that states its
  // predicate, and never through tree_nodes_opens_idx, where other accounts' pointers at $2 sit too.
  return "SELECT t.id FROM trees t "
         "CROSS JOIN LATERAL (SELECT 1 FROM tree_nodes n "
         "                    WHERE n.tree_id = t.id AND n.present AND n.opens <> '' AND n.opens = $2 LIMIT 1) o "
         "WHERE t.owner_id = $1::uuid AND t.deleted_at IS NULL AND t.id <> $2 "
         "  AND EXISTS (SELECT 1 FROM trees opened WHERE opened.id = $2 AND opened.owner_id = $1::uuid) "
         "ORDER BY t.id COLLATE \"C\"";
}

std::vector<TreeId> PgTreeRepository::treesOpening(const UserId& owner, const TreeId& tree) {
  PgLease conn{*pool_};
  pqxx::work txn{*conn};
  pqxx::result rows = txn.exec_params(treesOpeningStatement(), owner.str(), tree.str());

  std::vector<TreeId> opening;
  opening.reserve(rows.size());
  for (const auto& row : rows) opening.emplace_back(row["id"].as<std::string>());
  return opening;
}

const char* PgTreeRepository::accountsTreesStatement() {
  // A row is a standing tree and one tree its present steps open, with how many do and where that tree stands for the
  // tree's account; a tree that opens none has one row with the rest NULL. Each LATERAL runs once per row before it, so a
  // tree's pointers are read by its key on tree_nodes_pointers_idx, which serves only a scan that states its predicate,
  // and each tree they name by trees_pkey.
  return "SELECT t.owner_id::text AS owner, t.id AS tree, p.opens AS target, p.steps, "
         "       CASE WHEN p.opens IS NULL THEN NULL "
         "            WHEN named.id IS NULL THEN 'absent' "
         "            WHEN named.owner_id IS DISTINCT FROM t.owner_id THEN 'foreign' "
         "            WHEN named.deleted_at IS NOT NULL THEN 'deleted' "
         "            ELSE 'standing' END AS stands "
         "FROM trees t "
         "LEFT JOIN LATERAL (SELECT n.opens, count(*) AS steps FROM tree_nodes n "
         "                   WHERE n.tree_id = t.id AND n.present AND n.opens <> '' GROUP BY n.opens) p ON true "
         "LEFT JOIN LATERAL (SELECT s.id, s.owner_id, s.deleted_at FROM trees s WHERE s.id = p.opens LIMIT 1) named ON true "
         "WHERE t.deleted_at IS NULL AND t.owner_id IS NOT NULL "
         "ORDER BY t.owner_id";
}

void PgTreeRepository::eachAccountsTrees(const std::function<void(const UserId&, const AccountTrees&)>& visit) {
  PgLease conn{*pool_};
  pqxx::read_transaction txn{*conn};
  // A cursor, so each page is one short statement under the pool's limit and the rows arrive account after account.
  txn.exec(std::string("DECLARE accounts_trees NO SCROLL CURSOR FOR ") + accountsTreesStatement());
  std::optional<UserId> owner;
  AccountTrees account;
  for (pqxx::result page = txn.exec("FETCH 1000 FROM accounts_trees"); !page.empty();
       page = txn.exec("FETCH 1000 FROM accounts_trees")) {
    for (const auto& row : page) {
      UserId ownerOfRow{text(row, "owner")};
      if (owner && *owner != ownerOfRow) {
        visit(*owner, account);
        account = AccountTrees{};
      }
      owner = std::move(ownerOfRow);
      std::map<TreeId, int>& pointers = account.standing[TreeId{text(row, "tree")}];
      if (row["target"].is_null()) continue;
      const TreeId target{text(row, "target")};
      pointers.emplace(target, row["steps"].as<int>());
      const std::string stands = text(row, "stands");
      if (stands == "deleted") account.deleted.insert(target);
      if (stands == "foreign") account.foreign.insert(target);
    }
  }
  if (owner) visit(*owner, account);
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
  txn.exec_params("UPDATE trees SET visibility = $2 WHERE id = $1 AND parent_tree IS NULL AND deleted_at IS NULL",
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

std::optional<SubtreeSite> PgTreeRepository::subtreeSite(const TreeId& parent, const NodeId& step,
                                                         const std::optional<TreeId>& opened,
                                                         const std::optional<TreeId>& proposed) {
  PgLease conn{*pool_};
  pqxx::work txn{*conn};
  // The step's subtree through trees_parent_step, the pointer's tree and the proposed id each through trees_pkey.
  pqxx::result rows = txn.exec_params(
      "SELECT p.root_tree, p.depth, p.head_seq, c.id AS owned, c.root_tree AS owned_root, c.depth AS owned_depth, "
      "c.head_seq AS owned_seq, "
      "EXISTS (SELECT 1 FROM trees o WHERE o.id = $3 AND o.deleted_at IS NULL AND o.owner_id = p.owner_id) "
      "AS opens_a_tree, "
      "EXISTS (SELECT 1 FROM trees t WHERE t.id = $4) AS proposed_taken "
      "FROM trees p LEFT JOIN trees c ON c.parent_tree = p.id AND c.parent_step = $2 "
      "WHERE p.id = $1 AND p.deleted_at IS NULL",
      parent.str(), step.str(), opened ? std::optional<std::string>{opened->str()} : std::nullopt,
      proposed ? std::optional<std::string>{proposed->str()} : std::nullopt);
  if (rows.empty()) return std::nullopt;

  const auto& row = rows[0];
  SubtreeSite site{TreeId{text(row, "root_tree")}, row["depth"].as<int>(),
                   static_cast<Seq>(row["head_seq"].as<long long>())};
  if (!row["owned"].is_null())
    site.owned = Subtree{TreeId{text(row, "owned")}, TreeId{text(row, "owned_root")}, OwningStep{parent, step},
                         row["owned_depth"].as<int>(), static_cast<Seq>(row["owned_seq"].as<long long>())};
  site.opensATree = row["opens_a_tree"].as<bool>();
  site.proposedTaken = row["proposed_taken"].as<bool>();
  return site;
}

std::variant<Subtree, SubtreeConflict> PgTreeRepository::createSubtree(const TreeId& child, const OwningStep& parent,
                                                                       const LegendState& legend, Seq parentSeq) {
  try {
    PgLease conn{*pool_};
    pqxx::work txn{*conn};
    // The owner's account held as create and fork hold it, so an erasure either waits for this child or leaves no
    // parent to put it under.
    if (txn.exec_params("SELECT u.id FROM trees p JOIN users u ON u.id = p.owner_id "
                        "WHERE p.id = $1 AND p.deleted_at IS NULL FOR KEY SHARE OF u",
                        parent.tree.str())
            .empty())
      return SubtreeConflict::parentGone;
    // trees_place takes the root, depth and owner from the parent's row.
    const pqxx::result inserted = txn.exec_params(
        "INSERT INTO trees (id, head_seq, parent_tree, parent_step) VALUES ($1, 0, $2, $3) RETURNING root_tree, depth",
        child.str(), parent.tree.str(), parent.step.str());
    upsertSlice(txn, child, GraphState{}, legend);
    // The parent's head goes after the child, so a parent removed or erased meanwhile leaves neither written.
    if (txn.exec_params("UPDATE trees SET head_seq = $2, updated_at = now() WHERE id = $1 AND deleted_at IS NULL "
                        "RETURNING id",
                        parent.tree.str(), static_cast<long long>(parentSeq))
            .empty())
      return SubtreeConflict::parentGone;
    txn.commit();
    markCurrentWrite();
    return Subtree{child, TreeId{text(inserted[0], "root_tree")}, parent, inserted[0]["depth"].as<int>(), 0};
  } catch (const pqxx::foreign_key_violation&) {
    return SubtreeConflict::parentGone;  // trees_place found the parent gone once it held its row
  } catch (const pqxx::unique_violation&) {
    // trees_parent_step or trees_pkey, told apart by what the other writer committed.
    PgLease conn{*pool_};
    pqxx::work txn{*conn};
    const bool owned = !txn.exec_params("SELECT 1 FROM trees WHERE parent_tree = $1 AND parent_step = $2",
                                        parent.tree.str(), parent.step.str())
                            .empty();
    return owned ? SubtreeConflict::stepOwned : SubtreeConflict::idTaken;
  }
}

}
