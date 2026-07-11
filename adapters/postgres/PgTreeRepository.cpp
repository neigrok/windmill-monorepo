#include "adapters/postgres/PgTreeRepository.h"

#include "adapters/json/TreeJson.h"

#include <pqxx/pqxx>

namespace wm {

PgTreeRepository::PgTreeRepository(std::string connString) : connString_(std::move(connString)) {}

std::optional<StoredTree> PgTreeRepository::load(const TreeId& tree) {
  pqxx::connection conn{connString_};
  pqxx::work txn{conn};
  pqxx::result rows = txn.exec_params(
      "SELECT title, head_seq, document::text FROM trees WHERE id = $1 AND deleted_at IS NULL",
      tree.str());
  if (rows.empty()) return std::nullopt;

  const auto row = rows[0];
  GraphState state = graphStateFromJson(parse(row["document"].as<std::string>()));
  return StoredTree{std::move(state), row["title"].as<std::string>(),
                    static_cast<Seq>(row["head_seq"].as<long long>())};
}

void PgTreeRepository::save(const TreeId& tree, const GraphState& state, const std::string& title, Seq head) {
  std::string document = dump(toJson(state));
  pqxx::connection conn{connString_};
  pqxx::work txn{conn};
  txn.exec_params(
      "INSERT INTO trees (id, title, head_seq, document) VALUES ($1, $2, $3, $4::jsonb) "
      "ON CONFLICT (id) DO UPDATE SET title = EXCLUDED.title, head_seq = EXCLUDED.head_seq, "
      "document = EXCLUDED.document, updated_at = now()",
      tree.str(), title, static_cast<long long>(head), document);
  txn.commit();
}

}
