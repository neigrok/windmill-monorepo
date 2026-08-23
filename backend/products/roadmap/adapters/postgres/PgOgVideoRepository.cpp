#include "products/roadmap/adapters/postgres/PgOgVideoRepository.h"

#include "platform/adapters/postgres/PgPool.h"

#include <pqxx/pqxx>

namespace wm {

PgOgVideoRepository::PgOgVideoRepository(std::shared_ptr<PgPool> pool) : pool_(std::move(pool)) {}

void PgOgVideoRepository::put(const std::string& treeId, const std::string& bytes, const std::string& mime) {
  PgLease conn{*pool_};
  pqxx::work txn{*conn};
  // The bytes ride as a bound bytea parameter, never interpolated into SQL.
  txn.exec_params(
      "INSERT INTO tree_og_videos (tree_id, video, mime, updated_at) VALUES ($1, $2, $3, now()) "
      "ON CONFLICT (tree_id) DO UPDATE SET video = EXCLUDED.video, mime = EXCLUDED.mime, updated_at = now()",
      treeId, pqxx::binary_cast(bytes), mime);
  txn.commit();
}

std::optional<StoredVideo> PgOgVideoRepository::get(const std::string& treeId) {
  PgLease conn{*pool_};
  pqxx::work txn{*conn};
  pqxx::result rows = txn.exec_params("SELECT video, mime FROM tree_og_videos WHERE tree_id = $1", treeId);
  txn.commit();
  if (rows.empty()) return std::nullopt;
  const auto& row = rows[0];
  pqxx::bytes raw = row["video"].as<pqxx::bytes>();
  return StoredVideo{std::string(reinterpret_cast<const char*>(raw.data()), raw.size()),
                     row["mime"].as<std::string>()};
}

bool PgOgVideoRepository::has(const std::string& treeId) {
  PgLease conn{*pool_};
  pqxx::work txn{*conn};
  pqxx::result rows = txn.exec_params("SELECT 1 FROM tree_og_videos WHERE tree_id = $1", treeId);
  txn.commit();
  return !rows.empty();
}

}
