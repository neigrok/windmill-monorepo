#include "platform/adapters/postgres/PgOAuthRepository.h"

#include "platform/adapters/postgres/PgConnection.h"

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

// Parse a Postgres text[] literal ({"a","b"}) back into its elements — controlled inputs
// (registered redirect URIs), so a straightforward quoted/unquoted scan suffices.
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

PgOAuthRepository::PgOAuthRepository(std::string connString) : connString_(std::move(connString)) {}

void PgOAuthRepository::registerClient(const OAuthClient& client) {
  pqxx::work txn{pgThreadConnection(connString_)};
  txn.exec_params(
      "INSERT INTO oauth_clients (client_id, redirect_uris, client_name) VALUES ($1, $2::text[], $3)",
      client.clientId, arrayLiteral(client.redirectUris), client.name);
  txn.commit();
}

std::optional<OAuthClient> PgOAuthRepository::findClient(const std::string& clientId) {
  pqxx::work txn{pgThreadConnection(connString_)};
  pqxx::result rows = txn.exec_params(
      "SELECT redirect_uris::text, client_name FROM oauth_clients WHERE client_id = $1", clientId);
  if (rows.empty()) return std::nullopt;
  return OAuthClient{clientId, parseArrayLiteral(rows[0]["redirect_uris"].as<std::string>()),
                     rows[0]["client_name"].as<std::string>()};
}

void PgOAuthRepository::insertCode(const std::string& codeDigest, const StoredCode& code) {
  pqxx::work txn{pgThreadConnection(connString_)};
  txn.exec_params(
      "INSERT INTO oauth_codes (code_hash, client_id, user_id, redirect_uri, code_challenge, "
      "resource, scope, expires_ms) VALUES ($1, $2, $3::uuid, $4, $5, $6, $7, $8)",
      codeDigest, code.clientId, code.user.str(), code.redirectUri, code.codeChallenge, code.resource,
      code.scope, static_cast<long long>(code.expiresAt));
  txn.commit();
}

std::optional<StoredCode> PgOAuthRepository::takeCode(const std::string& codeDigest) {
  pqxx::work txn{pgThreadConnection(connString_)};
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
  pqxx::work txn{pgThreadConnection(connString_)};
  txn.exec_params(
      "INSERT INTO oauth_tokens (token_hash, refresh_hash, client_id, user_id, resource, scope, "
      "expires_ms, refresh_expires_ms) VALUES ($1, $2, $3, $4::uuid, $5, $6, $7, $8)",
      accessDigest, refreshDigest, token.clientId, token.user.str(), token.resource, token.scope,
      static_cast<long long>(token.expiresAt), static_cast<long long>(refreshExpiresAt));
  txn.commit();
}

std::optional<StoredToken> PgOAuthRepository::findAccessToken(const std::string& accessDigest) {
  pqxx::work txn{pgThreadConnection(connString_)};
  pqxx::result rows = txn.exec_params(
      "SELECT client_id, user_id::text, resource, scope, expires_ms FROM oauth_tokens WHERE token_hash = $1",
      accessDigest);
  if (rows.empty()) return std::nullopt;
  const auto& row = rows[0];
  return StoredToken{row["client_id"].as<std::string>(), UserId{row["user_id"].as<std::string>()},
                     row["resource"].as<std::string>(), row["scope"].as<std::string>(),
                     static_cast<UnixMs>(row["expires_ms"].as<long long>())};
}

std::optional<StoredToken> PgOAuthRepository::takeRefreshToken(const std::string& refreshDigest, UnixMs now) {
  pqxx::work txn{pgThreadConnection(connString_)};
  pqxx::result rows = txn.exec_params(
      "DELETE FROM oauth_tokens WHERE refresh_hash = $1 AND refresh_expires_ms > $2 "
      "RETURNING client_id, user_id::text, resource, scope, expires_ms",
      refreshDigest, static_cast<long long>(now));
  txn.commit();
  if (rows.empty()) return std::nullopt;
  const auto& row = rows[0];
  return StoredToken{row["client_id"].as<std::string>(), UserId{row["user_id"].as<std::string>()},
                     row["resource"].as<std::string>(), row["scope"].as<std::string>(),
                     static_cast<UnixMs>(row["expires_ms"].as<long long>())};
}

void PgOAuthRepository::recordGrant(const UserId& user, const std::string& clientId, UnixMs now,
                                    const std::string& scope) {
  // granted_ms is set once and kept as the earliest; last_used_ms and scope advance to this consent,
  // so re-approving a narrower grant is what the settings row then says.
  pqxx::work txn{pgThreadConnection(connString_)};
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
  pqxx::work txn{pgThreadConnection(connString_)};
  txn.exec_params(
      "UPDATE oauth_grants SET last_used_ms = $3 "
      "WHERE user_id = $1::uuid AND client_id = $2 AND $3 - last_used_ms > $4",
      user.str(), clientId, static_cast<long long>(now), static_cast<long long>(minIntervalMs));
  txn.commit();
}

std::vector<GrantView> PgOAuthRepository::listGrants(const UserId& user) {
  pqxx::work txn{pgThreadConnection(connString_)};
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
  pqxx::work txn{pgThreadConnection(connString_)};
  txn.exec_params("DELETE FROM oauth_tokens WHERE user_id = $1::uuid AND client_id = $2",
                  user.str(), clientId);
  txn.exec_params("DELETE FROM oauth_codes WHERE user_id = $1::uuid AND client_id = $2",
                  user.str(), clientId);
  txn.exec_params("DELETE FROM oauth_grants WHERE user_id = $1::uuid AND client_id = $2",
                  user.str(), clientId);
  txn.commit();
}

void PgOAuthRepository::revokeAllGrants(const UserId& user) {
  pqxx::work txn{pgThreadConnection(connString_)};
  txn.exec_params("DELETE FROM oauth_tokens WHERE user_id = $1::uuid", user.str());
  txn.exec_params("DELETE FROM oauth_codes WHERE user_id = $1::uuid", user.str());
  txn.exec_params("DELETE FROM oauth_grants WHERE user_id = $1::uuid", user.str());
  txn.commit();
}

}
