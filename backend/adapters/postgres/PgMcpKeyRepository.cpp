#include "adapters/postgres/PgMcpKeyRepository.h"

#include "adapters/postgres/PgConnection.h"

#include <pqxx/pqxx>

namespace wm {

PgMcpKeyRepository::PgMcpKeyRepository(std::string connString) : connString_(std::move(connString)) {}

std::string PgMcpKeyRepository::insert(const std::string& tokenDigest, const UserId& user,
                                       const std::string& name, long long createdMs) {
  pqxx::work txn{pgThreadConnection(connString_)};
  pqxx::result rows = txn.exec_params(
      "INSERT INTO mcp_keys (token_hash, user_id, name, created_ms) "
      "VALUES ($1, $2::uuid, $3, $4) RETURNING id::text",
      tokenDigest, user.str(), name, createdMs);
  txn.commit();
  return rows[0]["id"].as<std::string>();
}

std::vector<McpKeyRow> PgMcpKeyRepository::list(const UserId& user) {
  pqxx::work txn{pgThreadConnection(connString_)};
  pqxx::result rows = txn.exec_params(
      "SELECT id::text, name, created_ms, last_used_ms FROM mcp_keys "
      "WHERE user_id = $1::uuid ORDER BY created_ms DESC",
      user.str());

  std::vector<McpKeyRow> keys;
  keys.reserve(rows.size());
  for (const auto& row : rows) {
    std::optional<long long> lastUsed;
    if (!row["last_used_ms"].is_null()) lastUsed = row["last_used_ms"].as<long long>();
    keys.push_back(McpKeyRow{row["id"].as<std::string>(), row["name"].as<std::string>(),
                             row["created_ms"].as<long long>(), lastUsed});
  }
  return keys;
}

bool PgMcpKeyRepository::revoke(const UserId& user, const std::string& id) {
  // Compare id::text (not $1::uuid) so a malformed path id matches nothing instead of raising.
  pqxx::work txn{pgThreadConnection(connString_)};
  pqxx::result rows = txn.exec_params(
      "DELETE FROM mcp_keys WHERE id::text = $1 AND user_id = $2::uuid RETURNING token_hash",
      id, user.str());
  txn.commit();
  return !rows.empty();
}

std::optional<UserId> PgMcpKeyRepository::findActiveUser(const std::string& tokenDigest, long long nowMs) {
  pqxx::work txn{pgThreadConnection(connString_)};
  pqxx::result rows = txn.exec_params(
      "SELECT k.user_id::text FROM mcp_keys k JOIN users u ON u.id = k.user_id "
      "WHERE k.token_hash = $1 AND u.deleted_at IS NULL "
      "AND (k.expires_ms IS NULL OR k.expires_ms > $2)",
      tokenDigest, nowMs);
  if (rows.empty()) return std::nullopt;
  return UserId{rows[0]["user_id"].as<std::string>()};
}

void PgMcpKeyRepository::touchUsed(const std::string& tokenDigest, long long nowMs, long long throttleMs) {
  // A no-op inside the throttle window, so a busy client does not write on every key check.
  pqxx::work txn{pgThreadConnection(connString_)};
  txn.exec_params(
      // $2 - $3 alone is unknown-minus-unknown to Postgres (bind params are untyped) and won't
      // resolve; cast so the throttle threshold (now - window) is unambiguous bigint arithmetic.
      "UPDATE mcp_keys SET last_used_ms = $2 "
      "WHERE token_hash = $1 AND (last_used_ms IS NULL OR last_used_ms < $2::bigint - $3::bigint)",
      tokenDigest, nowMs, throttleMs);
  txn.commit();
}

}
