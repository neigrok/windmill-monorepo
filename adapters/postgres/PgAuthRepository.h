#pragma once

#include "ports/AuthRepository.h"

#include <string>

namespace wm {

// Postgres-backed accounts, magic links, and sessions. Times the domain owns (expiry, the
// rate window) are stored as epoch-millisecond bigints, so the adapter passes UnixMs
// through untouched; created_at timestamptz columns stay only for human inspection.
class PgAuthRepository : public AuthRepository {
public:
  explicit PgAuthRepository(std::string connString);

  std::optional<User> findUserByEmail(const Email& email) override;
  std::optional<User> findUserById(const UserId& id) override;
  User createUser(const Email& email, const std::string& name) override;

  void insertLink(const std::string& digest, const Email& email, UnixMs createdAt, UnixMs expiresAt,
                  const std::string& forkSource) override;
  int countRecentLinks(const Email& email, UnixMs since) override;
  std::optional<StoredLink> findLink(const std::string& digest) override;
  bool consumeLink(const std::string& digest, UnixMs at) override;

  void insertSession(const std::string& digest, const UserId& user, UnixMs expiresAt) override;
  std::optional<StoredSession> findSession(const std::string& digest) override;
  void refreshSession(const std::string& digest, UnixMs expiresAt) override;
  void deleteSession(const std::string& digest) override;

private:
  std::string connString_;
};

}
