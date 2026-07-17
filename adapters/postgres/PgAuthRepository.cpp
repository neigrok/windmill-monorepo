#include "adapters/postgres/PgAuthRepository.h"

#include "adapters/postgres/PgConnection.h"

#include <pqxx/pqxx>

namespace wm {

PgAuthRepository::PgAuthRepository(std::string connString) : connString_(std::move(connString)) {}

namespace {
// A users row → User, carrying the soft-close stamp (null deleted_at → a live account).
User userFrom(const pqxx::row_ref& row) {
  std::optional<UnixMs> deletedAt;
  if (!row["deleted_ms"].is_null()) deletedAt = static_cast<UnixMs>(row["deleted_ms"].as<long long>());
  return User{UserId{row["id"].as<std::string>()}, Email{row["email"].as<std::string>()},
              row["name"].as<std::string>(), deletedAt};
}
const char* kUserColumns =
    "id::text, email::text, name, (extract(epoch from deleted_at) * 1000)::bigint AS deleted_ms";
}

std::optional<User> PgAuthRepository::findUserByEmail(const Email& email) {
  pqxx::work txn{pgThreadConnection(connString_)};
  pqxx::result rows = txn.exec_params(
      "SELECT " + std::string(kUserColumns) + " FROM users WHERE email = $1", email.value);
  if (rows.empty()) return std::nullopt;
  return userFrom(rows[0]);
}

std::optional<User> PgAuthRepository::findUserById(const UserId& id) {
  pqxx::work txn{pgThreadConnection(connString_)};
  pqxx::result rows = txn.exec_params(
      "SELECT " + std::string(kUserColumns) + " FROM users WHERE id = $1::uuid", id.str());
  if (rows.empty()) return std::nullopt;
  return userFrom(rows[0]);
}

User PgAuthRepository::createUser(const Email& email, const std::string& name) {
  pqxx::work txn{pgThreadConnection(connString_)};
  pqxx::result rows = txn.exec_params(
      "INSERT INTO users (id, email, name) VALUES (gen_random_uuid(), $1, $2) "
      "RETURNING " + std::string(kUserColumns),
      email.value, name);
  txn.commit();
  return userFrom(rows[0]);
}

void PgAuthRepository::updateName(const UserId& userId, const std::string& name) {
  pqxx::work txn{pgThreadConnection(connString_)};
  txn.exec_params("UPDATE users SET name = $2 WHERE id = $1::uuid", userId.str(), name);
  txn.commit();
}

void PgAuthRepository::markUserDeleted(const UserId& userId, UnixMs now) {
  pqxx::work txn{pgThreadConnection(connString_)};
  txn.exec_params("UPDATE users SET deleted_at = to_timestamp($2::double precision / 1000.0) "
                  "WHERE id = $1::uuid",
                  userId.str(), static_cast<long long>(now));
  txn.commit();
}

void PgAuthRepository::reviveUser(const UserId& userId) {
  pqxx::work txn{pgThreadConnection(connString_)};
  txn.exec_params("UPDATE users SET deleted_at = NULL WHERE id = $1::uuid", userId.str());
  txn.commit();
}

void PgAuthRepository::insertLink(const std::string& digest, const Email& email, UnixMs createdAt,
                                  UnixMs expiresAt, const std::string& forkSource) {
  pqxx::work txn{pgThreadConnection(connString_)};
  txn.exec_params(
      "INSERT INTO magic_links (token_hash, email, created_ms, expires_ms, fork_source) "
      "VALUES ($1, $2, $3, $4, nullif($5, ''))",
      digest, email.value, static_cast<long long>(createdAt), static_cast<long long>(expiresAt),
      forkSource);
  txn.commit();
}

int PgAuthRepository::countRecentLinks(const Email& email, UnixMs since) {
  pqxx::work txn{pgThreadConnection(connString_)};
  pqxx::result rows = txn.exec_params(
      "SELECT count(*) FROM magic_links "
      "WHERE email = $1 AND consumed_ms IS NULL AND created_ms >= $2",
      email.value, static_cast<long long>(since));
  return rows[0][0].as<int>();
}

std::optional<StoredLink> PgAuthRepository::findLink(const std::string& digest) {
  pqxx::work txn{pgThreadConnection(connString_)};
  pqxx::result rows = txn.exec_params(
      "SELECT email::text, consumed_ms, expires_ms, coalesce(fork_source, '') AS fork_source "
      "FROM magic_links WHERE token_hash = $1", digest);
  if (rows.empty()) return std::nullopt;

  const auto& row = rows[0];
  return StoredLink{Email{row["email"].as<std::string>()}, !row["consumed_ms"].is_null(),
                    static_cast<UnixMs>(row["expires_ms"].as<long long>()),
                    row["fork_source"].as<std::string>()};
}

bool PgAuthRepository::consumeLink(const std::string& digest, UnixMs at) {
  pqxx::work txn{pgThreadConnection(connString_)};
  pqxx::result result = txn.exec_params(
      "UPDATE magic_links SET consumed_ms = $2 WHERE token_hash = $1 AND consumed_ms IS NULL",
      digest, static_cast<long long>(at));
  txn.commit();
  return result.affected_rows() == 1;  // only the winner of a concurrent race flips the row
}

void PgAuthRepository::insertSession(const std::string& digest, const UserId& user, UnixMs expiresAt,
                                    const std::string& userAgent, const std::string& ip, UnixMs seenAt) {
  pqxx::work txn{pgThreadConnection(connString_)};
  txn.exec_params(
      "INSERT INTO sessions (token_hash, user_id, expires_ms, user_agent, ip, last_seen_ms) "
      "VALUES ($1, $2::uuid, $3, $4, $5, $6)",
      digest, user.str(), static_cast<long long>(expiresAt), userAgent, ip,
      static_cast<long long>(seenAt));
  txn.commit();
}

std::optional<StoredSession> PgAuthRepository::findSession(const std::string& digest) {
  pqxx::work txn{pgThreadConnection(connString_)};
  pqxx::result rows = txn.exec_params(
      "SELECT user_id::text, expires_ms FROM sessions WHERE token_hash = $1", digest);
  if (rows.empty()) return std::nullopt;

  const auto& row = rows[0];
  return StoredSession{UserId{row["user_id"].as<std::string>()},
                       static_cast<UnixMs>(row["expires_ms"].as<long long>())};
}

void PgAuthRepository::refreshSession(const std::string& digest, UnixMs expiresAt, UnixMs seenAt,
                                     const std::string& userAgent, const std::string& ip) {
  pqxx::work txn{pgThreadConnection(connString_)};
  txn.exec_params(
      "UPDATE sessions SET expires_ms = $2, last_seen_ms = $3, "
      "user_agent = coalesce(nullif($4, ''), user_agent), ip = coalesce(nullif($5, ''), ip) "
      "WHERE token_hash = $1",
      digest, static_cast<long long>(expiresAt), static_cast<long long>(seenAt), userAgent, ip);
  txn.commit();
}

void PgAuthRepository::deleteSession(const std::string& digest) {
  pqxx::work txn{pgThreadConnection(connString_)};
  txn.exec_params("DELETE FROM sessions WHERE token_hash = $1", digest);
  txn.commit();
}

std::vector<SessionRow> PgAuthRepository::listSessions(const UserId& userId) {
  pqxx::work txn{pgThreadConnection(connString_)};
  pqxx::result rows = txn.exec_params(
      "SELECT id::text, token_hash, user_agent, last_seen_ms, "
      "(extract(epoch from created_at) * 1000)::bigint AS created_ms, ip "
      "FROM sessions WHERE user_id = $1::uuid "
      "ORDER BY greatest(last_seen_ms, (extract(epoch from created_at) * 1000)::bigint) DESC",
      userId.str());

  std::vector<SessionRow> sessions;
  sessions.reserve(rows.size());
  for (const auto& row : rows)
    sessions.push_back(SessionRow{row["id"].as<std::string>(), row["token_hash"].as<std::string>(),
                                  row["user_agent"].as<std::string>(),
                                  static_cast<UnixMs>(row["last_seen_ms"].as<long long>()),
                                  static_cast<UnixMs>(row["created_ms"].as<long long>()),
                                  row["ip"].as<std::string>()});
  return sessions;
}

std::optional<std::string> PgAuthRepository::revokeSession(const UserId& userId,
                                                           const std::string& sessionId) {
  // Compare id::text (not $1::uuid) so a malformed path id matches nothing instead of raising.
  pqxx::work txn{pgThreadConnection(connString_)};
  pqxx::result rows = txn.exec_params(
      "DELETE FROM sessions WHERE id::text = $1 AND user_id = $2::uuid RETURNING token_hash",
      sessionId, userId.str());
  txn.commit();
  if (rows.empty()) return std::nullopt;
  return rows[0]["token_hash"].as<std::string>();
}

void PgAuthRepository::revokeSessionsExcept(const UserId& userId, const std::string& keepDigest) {
  pqxx::work txn{pgThreadConnection(connString_)};
  txn.exec_params("DELETE FROM sessions WHERE user_id = $1::uuid AND token_hash <> $2",
                  userId.str(), keepDigest);
  txn.commit();
}

void PgAuthRepository::revokeAllSessions(const UserId& userId) {
  pqxx::work txn{pgThreadConnection(connString_)};
  txn.exec_params("DELETE FROM sessions WHERE user_id = $1::uuid", userId.str());
  txn.commit();
}

}
