#include "products/roadmap/adapters/postgres/PgOgImageRepository.h"

#include "platform/adapters/postgres/PgPool.h"

#include <pqxx/pqxx>

namespace wm {

PgOgImageRepository::PgOgImageRepository(std::shared_ptr<PgPool> pool) : pool_(std::move(pool)) {}

void PgOgImageRepository::put(const std::string& treeId, const std::string& pngBytes) {
  PgLease conn{*pool_};
  pqxx::work txn{*conn};
  // The bytes ride as a bound bytea parameter, never interpolated into SQL.
  txn.exec_params(
      "INSERT INTO tree_og_images (tree_id, png, updated_at) VALUES ($1, $2, now()) "
      "ON CONFLICT (tree_id) DO UPDATE SET png = EXCLUDED.png, updated_at = now()",
      treeId, pqxx::binary_cast(pngBytes));
  txn.commit();
}

std::optional<std::string> PgOgImageRepository::get(const std::string& treeId) {
  PgLease conn{*pool_};
  pqxx::work txn{*conn};
  pqxx::result rows = txn.exec_params("SELECT png FROM tree_og_images WHERE tree_id = $1", treeId);
  txn.commit();
  if (rows.empty()) return std::nullopt;
  pqxx::bytes raw = rows[0]["png"].as<pqxx::bytes>();
  return std::string(reinterpret_cast<const char*>(raw.data()), raw.size());
}

}
