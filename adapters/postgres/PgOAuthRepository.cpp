#include "adapters/postgres/PgOAuthRepository.h"

#include "adapters/postgres/PgConnection.h"

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

}
