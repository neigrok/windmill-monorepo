#include "products/roadmap/adapters/postgres/PgTreeRepository.h"

#include "products/roadmap/adapters/json/TreeJson.h"
#include "platform/adapters/postgres/PgConnection.h"
#include "platform/domain/Crdt.h"
#include "products/roadmap/domain/LooseGraph.h"

#include <pqxx/pqxx>

namespace wm {

namespace {

// A row's `present` flag, computed by the writer so reads never compare HLC text in SQL —
// the same add-biased rule as ElementSet::present().
bool entryPresent(const Hlc& added, const Hlc& removed) {
  return added.isSet() && !(removed > added);
}

void upsertNode(pqxx::work& txn, const TreeId& tree, const NodeStateEntry& node) {
  std::optional<double> posX, posY;
  if (node.position) { posX = node.position->x; posY = node.position->y; }
  txn.exec_params(
      "INSERT INTO tree_nodes (tree_id, node_id, created_hlc, deleted_hlc, label, label_hlc, "
      "icon, icon_hlc, color, color_hlc, pos_x, pos_y, pos_hlc, status, status_hlc, "
      "description, description_hlc, links, links_hlc, present, ord, ord_hlc) "
      "VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, "
      "$18::jsonb, $19, $20, $21, $22) "
      "ON CONFLICT (tree_id, node_id) DO UPDATE SET "
      "created_hlc = EXCLUDED.created_hlc, deleted_hlc = EXCLUDED.deleted_hlc, "
      "label = EXCLUDED.label, label_hlc = EXCLUDED.label_hlc, "
      "icon = EXCLUDED.icon, icon_hlc = EXCLUDED.icon_hlc, "
      "color = EXCLUDED.color, color_hlc = EXCLUDED.color_hlc, "
      "pos_x = EXCLUDED.pos_x, pos_y = EXCLUDED.pos_y, pos_hlc = EXCLUDED.pos_hlc, "
      "status = EXCLUDED.status, status_hlc = EXCLUDED.status_hlc, "
      "description = EXCLUDED.description, description_hlc = EXCLUDED.description_hlc, "
      "links = EXCLUDED.links, links_hlc = EXCLUDED.links_hlc, present = EXCLUDED.present, "
      "ord = EXCLUDED.ord, ord_hlc = EXCLUDED.ord_hlc",
      tree.str(), node.id.str(), toString(node.createdAt), toString(node.deletedAt),
      node.label, toString(node.labelAt), node.icon, toString(node.iconAt),
      std::string(toString(node.color)), toString(node.colorAt),
      posX, posY, toString(node.positionAt), node.status, toString(node.statusAt),
      node.description, toString(node.descriptionAt),
      dump(linksToJson(node.links)), toString(node.linksAt),
      entryPresent(node.createdAt, node.deletedAt),
      node.order, toString(node.orderAt));
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

// Row iteration hands back a dependent row type across libpqxx versions; these accessors
// pin the .template dance to one place.
std::string text(const auto& row, const char* column) { return row[column].template as<std::string>(); }
Hlc stamp(const auto& row, const char* column) { return parseHlc(text(row, column)); }

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
  if (!row["status"].is_null()) node.status = text(row, "status");
  node.statusAt = stamp(row, "status_hlc");
  node.description = text(row, "description");
  node.descriptionAt = stamp(row, "description_hlc");
  node.links = linksFromJson(parse(text(row, "links")));
  node.linksAt = stamp(row, "links_hlc");
  return node;
}

GraphState graphRows(pqxx::work& txn, const TreeId& tree) {
  GraphState state;
  pqxx::result nodes = txn.exec_params(
      "SELECT node_id, created_hlc, deleted_hlc, label, label_hlc, icon, icon_hlc, color, "
      "color_hlc, ord, ord_hlc, pos_x, pos_y, pos_hlc, status, status_hlc, description, "
      "description_hlc, links::text AS links, links_hlc FROM tree_nodes WHERE tree_id = $1",
      tree.str());
  for (const auto& row : nodes) state.nodes.push_back(nodeFromRow(row));

  pqxx::result edges = txn.exec_params(
      "SELECT from_id, to_id, added_hlc, removed_hlc FROM tree_edges WHERE tree_id = $1", tree.str());
  for (const auto& row : edges) {
    state.edges.push_back(EdgeStateEntry{
        Edge{NodeId{row["from_id"].as<std::string>()}, NodeId{row["to_id"].as<std::string>()}},
        parseHlc(row["added_hlc"].as<std::string>()), parseHlc(row["removed_hlc"].as<std::string>())});
  }
  return state;
}

LegendState legendRows(pqxx::work& txn, const TreeId& tree) {
  LegendState legend;
  pqxx::result kinds = txn.exec_params(
      "SELECT kind_id, created_hlc, deleted_hlc, hue, hue_hlc, label, label_hlc, description, "
      "description_hlc, rank, rank_hlc FROM tree_kinds WHERE tree_id = $1",
      tree.str());
  for (const auto& row : kinds) {
    KindStateEntry kind;
    kind.id = KindId{row["kind_id"].as<std::string>()};
    kind.createdAt = parseHlc(row["created_hlc"].as<std::string>());
    kind.deletedAt = parseHlc(row["deleted_hlc"].as<std::string>());
    kind.hue = parseColor(row["hue"].as<std::string>()).value_or(NodeColor::terracotta);
    kind.hueAt = parseHlc(row["hue_hlc"].as<std::string>());
    kind.label = row["label"].as<std::string>();
    kind.labelAt = parseHlc(row["label_hlc"].as<std::string>());
    kind.description = row["description"].as<std::string>();
    kind.descriptionAt = parseHlc(row["description_hlc"].as<std::string>());
    kind.rank = row["rank"].as<double>();
    kind.rankAt = parseHlc(row["rank_hlc"].as<std::string>());
    legend.kinds.push_back(std::move(kind));
  }
  return legend;
}

}

PgTreeRepository::PgTreeRepository(std::string connString) : connString_(std::move(connString)) {}

std::optional<TreeAccess> PgTreeRepository::loadAccess(const TreeId& tree) {
  // Two columns, one row, no lattice — the whole point is that deciding "may this caller read it?"
  // costs a primary-key lookup rather than every node, edge and kind the tree owns.
  pqxx::work txn{pgThreadConnection(connString_)};
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
  // The mirror of loadAccess: one column off the rows load() refuses to see. Only a deleted row
  // answers — a live one is load()'s to classify, and an unowned one names nobody.
  pqxx::work txn{pgThreadConnection(connString_)};
  pqxx::result rows = txn.exec_params(
      "SELECT owner_id::text FROM trees WHERE id = $1 AND deleted_at IS NOT NULL", tree.str());
  if (rows.empty()) return std::nullopt;

  const auto& row = rows[0];
  if (row["owner_id"].is_null()) return std::nullopt;
  return UserId{row["owner_id"].as<std::string>()};
}

ForkLineage PgTreeRepository::loadForkLineage(const TreeId& tree) {
  pqxx::work txn{pgThreadConnection(connString_)};
  ForkLineage lineage;
  // Is this a fork, and may its source be named? The source is named only while it still exists
  // and is PUBLIC — an unlisted, private or deleted source stays anonymous in the unfurl. (auto
  // row, never a bound pqxx::row: it is named row_ref on macOS and row on the CI's Linux.)
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
  // Trees forked FROM this one — the social proof that invites the next fork.
  pqxx::result forks = txn.exec_params(
      "SELECT count(*) AS n FROM trees WHERE forked_from = $1 AND deleted_at IS NULL", tree.str());
  lineage.forkCount = forks[0]["n"].as<int>();
  return lineage;
}

std::optional<StoredTree> PgTreeRepository::load(const TreeId& tree) {
  pqxx::work txn{pgThreadConnection(connString_)};
  pqxx::result rows = txn.exec_params(
      "SELECT title, title_hlc, head_seq, document::text, owner_id::text, visibility, "
      "(extract(epoch from created_at) * 1000)::bigint AS created_ms "
      "FROM trees WHERE id = $1 AND deleted_at IS NULL",
      tree.str());
  if (rows.empty()) return std::nullopt;
  const auto row = rows[0];

  GraphState state = graphRows(txn, tree);
  LegendState legend = legendRows(txn, tree);
  if (state.nodes.empty() && state.edges.empty() && legend.kinds.empty()) {
    // A pre-rows tree: its lattice still lives only in the legacy document blob. Parse it
    // and backfill the rows in this same transaction — a one-time lazy migration; every
    // later load and save on this tree is row-based. The blob is left behind, stale.
    Json::Value document = parse(row["document"].as<std::string>());
    state = graphStateFromJson(document);
    legend = legendStateFromJson(document["kinds"]);
    upsertSlice(txn, tree, state, legend);
  }
  txn.commit();

  std::optional<UserId> owner;
  if (!row["owner_id"].is_null()) owner = UserId{row["owner_id"].as<std::string>()};
  Lww<std::string> title{row["title"].as<std::string>(), parseHlc(row["title_hlc"].as<std::string>())};
  return StoredTree{std::move(state), std::move(legend), std::move(title),
                    static_cast<Seq>(row["head_seq"].as<long long>()), std::move(owner),
                    parseVisibility(row["visibility"].as<std::string>()),
                    static_cast<std::uint64_t>(row["created_ms"].as<long long>())};
}

void PgTreeRepository::save(const TreeId& tree, const GraphState& state, const LegendState& legend,
                            const Lww<std::string>& title, Seq head) {
  pqxx::work txn{pgThreadConnection(connString_)};
  txn.exec_params(
      "INSERT INTO trees (id, title, title_hlc, title_ms, title_counter, head_seq) "
      "VALUES ($1, $2, $3, $4, $5, $6) "
      "ON CONFLICT (id) DO UPDATE SET head_seq = EXCLUDED.head_seq, updated_at = now()",
      tree.str(), title.value, toString(title.stamp),
      static_cast<long long>(title.stamp.physicalMs), static_cast<long long>(title.stamp.counter),
      static_cast<long long>(head));
  // The title register is LWW at the column: it lands only under a dominating stamp, so a
  // stale room cache in another process can never revert a newer rename. (ms, counter) order
  // numerically; a tie falls to the canonical text under byte order (COLLATE "C") — its
  // numeric prefix is equal whenever ms and counter are, so that is exactly the actor tiebreak.
  txn.exec_params(
      "UPDATE trees SET title = $2, title_hlc = $3, title_ms = $4, title_counter = $5 "
      "WHERE id = $1 AND ($4::bigint, $5::bigint, $3::text COLLATE \"C\") "
      "> (title_ms, title_counter, title_hlc COLLATE \"C\")",
      tree.str(), title.value, toString(title.stamp),
      static_cast<long long>(title.stamp.physicalMs), static_cast<long long>(title.stamp.counter));
  upsertSlice(txn, tree, state, legend);  // only the dirty slice — never the whole tree
  txn.commit();
}

void PgTreeRepository::create(const TreeId& tree, const GraphState& state, const LegendState& legend,
                              const std::string& title, const UserId& owner) {
  pqxx::work txn{pgThreadConnection(connString_)};
  try {
    txn.exec_params("INSERT INTO trees (id, title, head_seq, owner_id) VALUES ($1, $2, 0, $3::uuid)",
                    tree.str(), title, owner.str());
  } catch (const pqxx::unique_violation&) {
    throw DuplicateTree{};  // the unique index arbitrates cross-process races (the MCP binary shares this DB)
  }
  upsertSlice(txn, tree, state, legend);
  txn.commit();
}

std::vector<OwnedTree> PgTreeRepository::listOwnedBy(const UserId& owner) {
  pqxx::work txn{pgThreadConnection(connString_)};
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
                                    row["document"].as<std::string>());
    owned.push_back(OwnedTree{std::move(data),
                              static_cast<std::uint64_t>(row["created_ms"].as<long long>()),
                              static_cast<std::uint64_t>(row["updated_ms"].as<long long>())});
  }
  return owned;
}

TreeData PgTreeRepository::projectDocument(pqxx::work& txn, const TreeId& tree, const std::string& title,
                                           const std::string& documentBlob) {
  pqxx::result nodes = txn.exec_params(
      "SELECT node_id, color FROM tree_nodes WHERE tree_id = $1 AND present", tree.str());
  TreeData data;
  data.id = tree;
  data.title = title;
  for (const auto& n : nodes) {
    NodeSpec spec;
    spec.id = NodeId{n["node_id"].as<std::string>()};
    spec.color = parseColor(n["color"].as<std::string>()).value_or(NodeColor::terracotta);
    data.nodes.push_back(std::move(spec));
  }
  if (!data.nodes.empty()) return data;
  // A pre-rows tree not yet opened: fall back to the legacy blob.
  GraphState state = graphStateFromJson(parse(documentBlob));
  return LooseGraph(state).toTreeData(tree, title);
}

std::vector<ListedTree> PgTreeRepository::listPublic() {
  pqxx::work txn{pgThreadConnection(connString_)};
  // Every listed tree, unbounded: listing is a deliberate, rare owner act, so the candidate set
  // is small by construction. Ordering and the wall's cap belong to the domain (domain/Gallery.h)
  // and are deliberately NOT duplicated here — if this set ever grows past one query's worth,
  // that is a materialized wall, not a silent LIMIT that would quietly change the ranking rule.
  // The source's title rides the same row as a LEFT JOIN carrying loadForkLineage's privacy rule
  // in its ON clause — the source is named only while it exists and is public, so an unlisted,
  // private or deleted source coalesces to '' and the card says nothing. Joined rather than
  // looked up per card: a wall of sixty would otherwise be sixty extra round trips.
  // The owner's latest mark rides it the same way, as a lateral. It has to: `updated_at` on this
  // row moves for a structural edit, a rename or a visibility flip and for NOTHING else, so a
  // wall ranked on that column alone cannot see a tree being worked on at all — while the flip
  // that lists a long-dead tree reads to it as freshness. The domain folds the two (lastActiveAt).
  // The lookup lands on node_progress's primary key, whose (tree_id, user_id) prefix is exactly
  // this predicate — an index scan per listed tree, not a scan of the marks table.
  pqxx::result rows = txn.exec_params(
      "SELECT t.id, t.title, t.owner_id::text AS owner_id, t.document::text, "
      "(extract(epoch from t.updated_at) * 1000)::bigint AS updated_ms, "
      "coalesce((extract(epoch from m.marked_at) * 1000)::bigint, 0) AS marked_ms, "
      "(SELECT count(*) FROM trees f WHERE f.forked_from = t.id AND f.deleted_at IS NULL) AS forks, "
      "coalesce(s.title, '') AS source_title "
      "FROM trees t "
      "LEFT JOIN trees s ON s.id = t.forked_from AND s.deleted_at IS NULL AND s.visibility = 'public' "
      "LEFT JOIN LATERAL (SELECT max(p.updated_at) AS marked_at FROM node_progress p "
      "                   WHERE p.tree_id = t.id AND p.user_id = t.owner_id::text) m ON true "
      "WHERE t.visibility = 'public' AND t.deleted_at IS NULL AND t.owner_id IS NOT NULL");

  std::vector<ListedTree> listed;
  listed.reserve(rows.size());
  for (const auto& row : rows) {
    ListedTree entry;
    entry.data = projectDocument(txn, TreeId{row["id"].as<std::string>()}, row["title"].as<std::string>(),
                                 row["document"].as<std::string>());
    entry.updatedAt = static_cast<std::uint64_t>(row["updated_ms"].as<long long>());
    entry.lastMarkedAt = static_cast<std::uint64_t>(row["marked_ms"].as<long long>());
    entry.forks = row["forks"].as<int>();
    entry.owner = UserId{row["owner_id"].as<std::string>()};
    entry.sourceTitle = row["source_title"].as<std::string>();
    listed.push_back(std::move(entry));
  }
  return listed;
}

std::set<TreeId> PgTreeRepository::listForkedSources(const UserId& owner) {
  pqxx::work txn{pgThreadConnection(connString_)};
  // One row per source this user still holds a fork of. A deleted fork drops out: the reader let
  // that copy go, so the plan is theirs to take again.
  pqxx::result rows = txn.exec_params(
      "SELECT DISTINCT forked_from FROM trees "
      "WHERE owner_id = $1::uuid AND forked_from IS NOT NULL AND deleted_at IS NULL",
      owner.str());

  std::set<TreeId> sources;
  for (const auto& row : rows) sources.insert(TreeId{row["forked_from"].as<std::string>()});
  return sources;
}

void PgTreeRepository::softDelete(const TreeId& tree) {
  pqxx::work txn{pgThreadConnection(connString_)};
  txn.exec_params("UPDATE trees SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL", tree.str());
  txn.commit();
}

void PgTreeRepository::rename(const TreeId& tree, const Lww<std::string>& title) {
  pqxx::work txn{pgThreadConnection(connString_)};
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
  pqxx::work txn{pgThreadConnection(connString_)};
  // Deliberately does NOT touch updated_at. The gallery folds that column into last-active, so a
  // bump here would let anyone flip unlisted->public to vault a long-dead tree up the wall — the
  // one thing ranking by activity exists to prevent. Nothing is lost by leaving it: the funnel's
  // W1-return test is a three-way OR over marks, tree edits AND events, and listing a tree already
  // beacons its own event, so a share flip still counts as a return through that arm.
  txn.exec_params("UPDATE trees SET visibility = $2 WHERE id = $1 AND deleted_at IS NULL",
                  tree.str(), toString(visibility));
  txn.commit();
}

void PgTreeRepository::fork(const TreeId& newTree, const TreeId& source, const GraphState& state,
                           const LegendState& legend, const std::string& title, const UserId& owner) {
  pqxx::work txn{pgThreadConnection(connString_)};
  try {
    txn.exec_params(
        "INSERT INTO trees (id, title, head_seq, forked_from, owner_id) VALUES ($1, $2, 0, $3, $4::uuid)",
        newTree.str(), title, source.str(), owner.str());
  } catch (const pqxx::unique_violation&) {
    throw DuplicateTree{};
  }
  upsertSlice(txn, newTree, state, legend);
  txn.commit();
}

}
