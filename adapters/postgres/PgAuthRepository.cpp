#include "adapters/postgres/PgAuthRepository.h"

#include "adapters/postgres/PgConnection.h"

#include <pqxx/pqxx>

namespace wm {

PgAuthRepository::PgAuthRepository(std::string connString) : connString_(std::move(connString)) {}

std::optional<User> PgAuthRepository::findUserByEmail(const Email& email) {
  pqxx::work txn{pgThreadConnection(connString_)};
  pqxx::result rows = txn.exec_params(
      "SELECT id::text, email::text, name FROM users WHERE email = $1", email.value);
  if (rows.empty()) return std::nullopt;

  const auto& row = rows[0];
  return User{UserId{row["id"].as<std::string>()}, Email{row["email"].as<std::string>()},
              row["name"].as<std::string>()};
}

std::optional<User> PgAuthRepository::findUserById(const UserId& id) {
  pqxx::work txn{pgThreadConnection(connString_)};
  pqxx::result rows = txn.exec_params(
      "SELECT id::text, email::text, name FROM users WHERE id = $1::uuid", id.str());
  if (rows.empty()) return std::nullopt;

  const auto& row = rows[0];
  return User{UserId{row["id"].as<std::string>()}, Email{row["email"].as<std::string>()},
              row["name"].as<std::string>()};
}

User PgAuthRepository::createUser(const Email& email, const std::string& name) {
  pqxx::work txn{pgThreadConnection(connString_)};
  pqxx::result rows = txn.exec_params(
      "INSERT INTO users (id, email, name) VALUES (gen_random_uuid(), $1, $2) "
      "RETURNING id::text, email::text, name",
      email.value, name);
  txn.commit();

  const auto& row = rows[0];
  return User{UserId{row["id"].as<std::string>()}, Email{row["email"].as<std::string>()},
              row["name"].as<std::string>()};
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

void PgAuthRepository::insertSession(const std::string& digest, const UserId& user, UnixMs expiresAt) {
  pqxx::work txn{pgThreadConnection(connString_)};
  txn.exec_params(
      "INSERT INTO sessions (token_hash, user_id, expires_ms) VALUES ($1, $2::uuid, $3)",
      digest, user.str(), static_cast<long long>(expiresAt));
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

void PgAuthRepository::refreshSession(const std::string& digest, UnixMs expiresAt) {
  pqxx::work txn{pgThreadConnection(connString_)};
  txn.exec_params("UPDATE sessions SET expires_ms = $2 WHERE token_hash = $1", digest,
                  static_cast<long long>(expiresAt));
  txn.commit();
}

void PgAuthRepository::deleteSession(const std::string& digest) {
  pqxx::work txn{pgThreadConnection(connString_)};
  txn.exec_params("DELETE FROM sessions WHERE token_hash = $1", digest);
  txn.commit();
}

}
