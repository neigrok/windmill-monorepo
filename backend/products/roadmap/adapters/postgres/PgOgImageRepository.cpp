#include "products/roadmap/adapters/postgres/PgOgImageRepository.h"

#include "platform/adapters/postgres/PgConnection.h"

#include <pqxx/pqxx>

namespace wm {

PgOgImageRepository::PgOgImageRepository(std::string connString) : connString_(std::move(connString)) {}

void PgOgImageRepository::put(const std::string& treeId, const std::string& pngBytes) {
  pqxx::work txn{pgThreadConnection(connString_)};
  // The bytes ride as a bound bytea parameter (binary_cast → a byte view over the string) —
  // never interpolated into SQL, so a PNG that happens to contain a quote can't break the query.
  txn.exec_params(
      "INSERT INTO tree_og_images (tree_id, png, updated_at) VALUES ($1, $2, now()) "
      "ON CONFLICT (tree_id) DO UPDATE SET png = EXCLUDED.png, updated_at = now()",
      treeId, pqxx::binary_cast(pngBytes));
  txn.commit();
}

std::optional<std::string> PgOgImageRepository::get(const std::string& treeId) {
  pqxx::work txn{pgThreadConnection(connString_)};
  pqxx::result rows = txn.exec_params("SELECT png FROM tree_og_images WHERE tree_id = $1", treeId);
  txn.commit();
  if (rows.empty()) return std::nullopt;
  pqxx::bytes raw = rows[0]["png"].as<pqxx::bytes>();
  return std::string(reinterpret_cast<const char*>(raw.data()), raw.size());
}

}
