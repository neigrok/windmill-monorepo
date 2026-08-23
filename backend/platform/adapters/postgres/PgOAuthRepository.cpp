#include "platform/adapters/postgres/PgOAuthRepository.h"

#include "platform/adapters/postgres/PgPool.h"

#include <pqxx/pqxx>

namespace wm {

namespace {
// A Postgres text[] literal, each element double-quoted with quotes/backslashes escaped.
std::string arrayLiteral(const std::vector<std::string>& items) {
  std::string out = "{";
  for (std::size_t i = 0; i < items.size(); ++i) {
    if (i) out += ',';
    out += '"';
    for (char c : items[i]) {
      if (c == '"' || c == '\\') out += '\\';
      out += c;
    }
    out += '"';
  }
  out += '}';
  return out;
}

// Parse a Postgres text[] literal ({"a","b"}) back into its elements.
std::vector<std::string> parseArrayLiteral(const std::string& literal) {
  std::vector<std::string> out;
  std::size_t i = literal.find('{');
  if (i == std::string::npos) return out;
  ++i;
  while (i < literal.size() && literal[i] != '}') {
    if (literal[i] == ',') { ++i; continue; }
    std::string value;
    if (literal[i] == '"') {
      for (++i; i < literal.size() && literal[i] != '"'; ++i) {
        if (literal[i] == '\\' && i + 1 < literal.size()) ++i;
        value += literal[i];
      }
      ++i;  // closing quote
    } else {
      for (; i < literal.size() && literal[i] != ',' && literal[i] != '}'; ++i) value += literal[i];
    }
    out.push_back(std::move(value));
  }
  return out;
}
}

PgOAuthRepository::PgOAuthRepository(std::shared_ptr<PgPool> pool) : pool_(std::move(pool)) {}

void PgOAuthRepository::registerClient(const OAuthClient& client) {
  PgLease conn{*pool_};
  pqxx::work txn{*conn};
  txn.exec_params(
      "INSERT INTO oauth_clients (client_id, redirect_uris, client_name) VALUES ($1, $2::text[], $3)",
      client.clientId, arrayLiteral(client.redirectUris), client.name);
  txn.commit();
}

int PgOAuthRepository::unattachedClientsSince(UnixMs sinceMs) {
  // One hour of registrations, by the created_at index — the window keeps it an index range scan.
  PgLease conn{*pool_};
  pqxx::work txn{*conn};
  return txn
      .exec_params("SELECT count(*)::int FROM oauth_clients c "
                   "WHERE c.created_at > to_timestamp($1::bigint / 1000.0) AND NOT EXISTS "
                   "(SELECT 1 FROM oauth_grants g WHERE g.client_id = c.client_id)",
                   static_cast<long long>(sinceMs))[0][0]
      .as<int>();
}

std::optional<OAuthClient> PgOAuthRepository::findClient(const std::string& clientId) {
  PgLease conn{*pool_};
  pqxx::work txn{*conn};
  pqxx::result rows = txn.exec_params(
      "SELECT redirect_uris::text, client_name FROM oauth_clients WHERE client_id = $1", clientId);
  if (rows.empty()) return std::nullopt;
  return OAuthClient{clientId, parseArrayLiteral(rows[0]["redirect_uris"].as<std::string>()),
                     rows[0]["client_name"].as<std::string>()};
}

void PgOAuthRepository::insertCode(const std::string& codeDigest, const StoredCode& code) {
  PgLease conn{*pool_};
  pqxx::work txn{*conn};
  txn.exec_params(
      "INSERT INTO oauth_codes (code_hash, client_id, user_id, redirect_uri, code_challenge, "
      "resource, scope, expires_ms) VALUES ($1, $2, $3::uuid, $4, $5, $6, $7, $8)",
      codeDigest, code.clientId, code.user.str(), code.redirectUri, code.codeChallenge, code.resource,
      code.scope, static_cast<long long>(code.expiresAt));
  txn.commit();
}

std::optional<StoredCode> PgOAuthRepository::takeCode(const std::string& codeDigest) {
  PgLease conn{*pool_};
  pqxx::work txn{*conn};
  pqxx::result rows = txn.exec_params(
      "DELETE FROM oauth_codes WHERE code_hash = $1 "
      "RETURNING client_id, user_id::text, redirect_uri, code_challenge, resource, scope, expires_ms",
      codeDigest);
  txn.commit();
  if (rows.empty()) return std::nullopt;
  const auto& row = rows[0];
  return StoredCode{row["client_id"].as<std::string>(), UserId{row["user_id"].as<std::string>()},
                    row["redirect_uri"].as<std::string>(), row["code_challenge"].as<std::string>(),
                    row["resource"].as<std::string>(), row["scope"].as<std::string>(),
                    static_cast<UnixMs>(row["expires_ms"].as<long long>())};
}

void PgOAuthRepository::insertToken(const std::string& accessDigest, const std::string& refreshDigest,
                                    const StoredToken& token, UnixMs refreshExpiresAt) {
  PgLease conn{*pool_};
  pqxx::work txn{*conn};
  txn.exec_params(
      "INSERT INTO oauth_tokens (token_hash, refresh_hash, client_id, user_id, resource, scope, "
      "expires_ms, refresh_expires_ms) VALUES ($1, $2, $3, $4::uuid, $5, $6, $7, $8)",
      accessDigest, refreshDigest, token.clientId, token.user.str(), token.resource, token.scope,
      static_cast<long long>(token.expiresAt), static_cast<long long>(refreshExpiresAt));
  txn.commit();
}

std::optional<StoredToken> PgOAuthRepository::findAccessToken(const std::string& accessDigest) {
  PgLease conn{*pool_};
  pqxx::work txn{*conn};
  pqxx::result rows = txn.exec_params(
      "SELECT client_id, user_id::text, resource, scope, expires_ms FROM oauth_tokens WHERE token_hash = $1",
      accessDigest);
  if (rows.empty()) return std::nullopt;
  const auto& row = rows[0];
  return StoredToken{row["client_id"].as<std::string>(), UserId{row["user_id"].as<std::string>()},
                     row["resource"].as<std::string>(), row["scope"].as<std::string>(),
                     static_cast<UnixMs>(row["expires_ms"].as<long long>())};
}

RefreshRotation PgOAuthRepository::rotateRefreshToken(const std::string& refreshDigest, UnixMs now) {
  // The row is SPENT, not deleted: one UPDATE stamps rotated_ms and expires the access token that
  // shared the row, leaving a tombstone that makes a second presentation recognisable as reuse.
  PgLease conn{*pool_};
  pqxx::work txn{*conn};
  pqxx::result rotated = txn.exec_params(
      "UPDATE oauth_tokens SET rotated_ms = $2, expires_ms = 0 "
      "WHERE refresh_hash = $1 AND rotated_ms IS NULL AND refresh_expires_ms > $2 "
      "RETURNING client_id, user_id::text, resource, scope",
      refreshDigest, static_cast<long long>(now));
  if (!rotated.empty()) {
    txn.commit();
    // Expiry is not among the columns: this row is freshly spent.
    const auto& row = rotated[0];
    return RefreshRotation{RefreshOutcome::rotated,
                           StoredToken{row["client_id"].as<std::string>(),
                                       UserId{row["user_id"].as<std::string>()},
                                       row["resource"].as<std::string>(),
                                       row["scope"].as<std::string>(), 0}};
  }
  // Nothing to rotate: either this was never a refresh token here, or it was one and is spent —
  // and only the second is a breach signal, which the tombstone is what tells the two apart.
  pqxx::result spent = txn.exec_params(
      "SELECT client_id, user_id::text, resource, scope, rotated_ms FROM oauth_tokens "
      "WHERE refresh_hash = $1 AND rotated_ms IS NOT NULL",
      refreshDigest);
  txn.commit();
  if (spent.empty()) return RefreshRotation{RefreshOutcome::unknown, std::nullopt};
  const auto& row = spent[0];
  // The stamp rides along: whether a second presentation is a thief or a retry is a question about
  // HOW LONG AGO the first one landed, and only the caller holds the policy.
  return RefreshRotation{RefreshOutcome::reused,
                         StoredToken{row["client_id"].as<std::string>(),
                                     UserId{row["user_id"].as<std::string>()},
                                     row["resource"].as<std::string>(),
                                     row["scope"].as<std::string>(), 0},
                         static_cast<UnixMs>(row["rotated_ms"].as<long long>())};
}

void PgOAuthRepository::recordGrant(const UserId& user, const std::string& clientId, UnixMs now,
                                    const std::string& scope) {
  // granted_ms is set once and kept as the earliest; last_used_ms and scope advance to this consent.
  PgLease conn{*pool_};
  pqxx::work txn{*conn};
  txn.exec_params(
      "INSERT INTO oauth_grants (user_id, client_id, granted_ms, last_used_ms, scope) "
      "VALUES ($1::uuid, $2, $3, $3, $4) "
      "ON CONFLICT (user_id, client_id) DO UPDATE SET "
      "granted_ms = least(oauth_grants.granted_ms, excluded.granted_ms), "
      "last_used_ms = excluded.last_used_ms, "
      "scope = excluded.scope",
      user.str(), clientId, static_cast<long long>(now), scope);
  txn.commit();
}

void PgOAuthRepository::touchGrantUsed(const UserId& user, const std::string& clientId, UnixMs now,
                                       UnixMs minIntervalMs) {
  // A no-op inside the throttle window, so a busy client does not write on every token check.
  PgLease conn{*pool_};
  pqxx::work txn{*conn};
  txn.exec_params(
      "UPDATE oauth_grants SET last_used_ms = $3 "
      "WHERE user_id = $1::uuid AND client_id = $2 AND $3 - last_used_ms > $4",
      user.str(), clientId, static_cast<long long>(now), static_cast<long long>(minIntervalMs));
  txn.commit();
}

std::vector<GrantView> PgOAuthRepository::listGrants(const UserId& user) {
  PgLease conn{*pool_};
  pqxx::work txn{*conn};
  pqxx::result rows = txn.exec_params(
      "SELECT g.client_id, coalesce(c.client_name, '') AS client_name, g.granted_ms, g.last_used_ms, "
      "g.scope FROM oauth_grants g LEFT JOIN oauth_clients c ON c.client_id = g.client_id "
      "WHERE g.user_id = $1::uuid ORDER BY g.last_used_ms DESC, g.granted_ms DESC",
      user.str());

  std::vector<GrantView> grants;
  grants.reserve(rows.size());
  for (const auto& row : rows)
    grants.push_back(GrantView{row["client_id"].as<std::string>(), row["client_name"].as<std::string>(),
                               static_cast<UnixMs>(row["granted_ms"].as<long long>()),
                               static_cast<UnixMs>(row["last_used_ms"].as<long long>()),
                               row["scope"].as<std::string>()});
  return grants;
}

void PgOAuthRepository::revokeGrant(const UserId& user, const std::string& clientId) {
  PgLease conn{*pool_};
  pqxx::work txn{*conn};
  txn.exec_params("DELETE FROM oauth_tokens WHERE user_id = $1::uuid AND client_id = $2",
                  user.str(), clientId);
  txn.exec_params("DELETE FROM oauth_codes WHERE user_id = $1::uuid AND client_id = $2",
                  user.str(), clientId);
  txn.exec_params("DELETE FROM oauth_grants WHERE user_id = $1::uuid AND client_id = $2",
                  user.str(), clientId);
  txn.commit();
}

void PgOAuthRepository::revokeAllGrants(const UserId& user) {
  PgLease conn{*pool_};
  pqxx::work txn{*conn};
  txn.exec_params("DELETE FROM oauth_tokens WHERE user_id = $1::uuid", user.str());
  txn.exec_params("DELETE FROM oauth_codes WHERE user_id = $1::uuid", user.str());
  txn.exec_params("DELETE FROM oauth_grants WHERE user_id = $1::uuid", user.str());
  txn.commit();
}

}
