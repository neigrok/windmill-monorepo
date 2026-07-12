#include "adapters/postgres/PgTreeRepository.h"

#include "adapters/json/TreeJson.h"
#include "adapters/postgres/PgConnection.h"

#include <pqxx/pqxx>

namespace wm {

namespace {
// The persisted document jsonb: the graph (nodes + edges) plus the legend kinds.
std::string documentText(const GraphState& state, const LegendState& legend) {
  Json::Value document = toJson(state);
  document["kinds"] = toJson(legend);
  return dump(document);
}
}

PgTreeRepository::PgTreeRepository(std::string connString) : connString_(std::move(connString)) {}

std::optional<StoredTree> PgTreeRepository::load(const TreeId& tree) {
  pqxx::work txn{pgThreadConnection(connString_)};
  pqxx::result rows = txn.exec_params(
      "SELECT title, head_seq, document::text, owner_id::text, visibility "
      "FROM trees WHERE id = $1 AND deleted_at IS NULL",
      tree.str());
  if (rows.empty()) return std::nullopt;

  const auto row = rows[0];
  Json::Value document = parse(row["document"].as<std::string>());
  GraphState state = graphStateFromJson(document);
  LegendState legend = legendStateFromJson(document["kinds"]);
  std::optional<UserId> owner;
  if (!row["owner_id"].is_null()) owner = UserId{row["owner_id"].as<std::string>()};
  return StoredTree{std::move(state), std::move(legend), row["title"].as<std::string>(),
                    static_cast<Seq>(row["head_seq"].as<long long>()), std::move(owner),
                    row["visibility"].as<std::string>()};
}

void PgTreeRepository::save(const TreeId& tree, const GraphState& state, const LegendState& legend,
                            const std::string& title, Seq head) {
  std::string document = documentText(state, legend);
  pqxx::work txn{pgThreadConnection(connString_)};
  txn.exec_params(
      "INSERT INTO trees (id, title, head_seq, document) VALUES ($1, $2, $3, $4::jsonb) "
      "ON CONFLICT (id) DO UPDATE SET title = EXCLUDED.title, head_seq = EXCLUDED.head_seq, "
      "document = EXCLUDED.document, updated_at = now()",
      tree.str(), title, static_cast<long long>(head), document);
  txn.commit();
}

void PgTreeRepository::claim(const TreeId& tree, const UserId& owner) {
  pqxx::work txn{pgThreadConnection(connString_)};
  txn.exec_params("UPDATE trees SET owner_id = $2::uuid WHERE id = $1 AND owner_id IS NULL",
                  tree.str(), owner.str());
  txn.commit();
}

void PgTreeRepository::fork(const TreeId& newTree, const TreeId& source, const GraphState& state,
                           const LegendState& legend, const std::string& title, const UserId& owner) {
  std::string document = documentText(state, legend);
  pqxx::work txn{pgThreadConnection(connString_)};
  txn.exec_params(
      "INSERT INTO trees (id, title, head_seq, forked_from, owner_id, document) "
      "VALUES ($1, $2, 0, $3, $4::uuid, $5::jsonb)",
      newTree.str(), title, source.str(), owner.str(), document);
  txn.commit();
}

}
