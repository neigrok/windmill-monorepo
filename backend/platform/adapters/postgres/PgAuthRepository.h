#pragma once

#include "platform/adapters/postgres/PgPool.h"
#include "platform/ports/AuthRepository.h"

#include <memory>
#include <string>

namespace wm {

// Postgres-backed accounts, magic links, and sessions. Times the domain owns (expiry, the
// rate window) are stored as epoch-millisecond bigints, so the adapter passes UnixMs
// through untouched; created_at timestamptz columns stay only for human inspection.
class PgAuthRepository : public AuthRepository {
public:
  explicit PgAuthRepository(std::shared_ptr<PgPool> pool);

  std::optional<User> findUserByEmail(const Email& email) override;
  std::optional<User> findUserById(const UserId& id) override;
  User createUser(const Email& email, const std::string& name) override;
  void updateName(const UserId& userId, const std::string& name) override;
  void markUserDeleted(const UserId& userId, UnixMs now) override;
  void reviveUser(const UserId& userId) override;
  void deleteUser(const UserId& userId) override;

  std::optional<UserId> findIdentity(Provider provider, const std::string& subject) override;
  void bindIdentity(Provider provider, const std::string& subject, const UserId& userId,
                    const std::string& emailAtLink) override;
  void moveIdentities(const UserId& from, const UserId& to) override;

  void insertLink(const std::string& digest, const Email& email, UnixMs createdAt, UnixMs expiresAt,
                  const std::string& forkSource) override;
  int countRecentLinks(const Email& email, UnixMs since) override;
  std::optional<StoredLink> findLink(const std::string& digest) override;
  bool consumeLink(const std::string& digest, UnixMs at) override;

  void insertSession(const std::string& digest, const UserId& user, UnixMs expiresAt,
                     const std::string& userAgent, const std::string& ip, UnixMs seenAt) override;
  std::optional<StoredSession> findSession(const std::string& digest) override;
  void refreshSession(const std::string& digest, UnixMs expiresAt, UnixMs seenAt,
                      const std::string& userAgent, const std::string& ip) override;
  void deleteSession(const std::string& digest) override;

  std::vector<SessionRow> listSessions(const UserId& userId) override;
  std::optional<std::string> revokeSession(const UserId& userId, const std::string& sessionId) override;
  void revokeSessionsExcept(const UserId& userId, const std::string& keepDigest) override;
  void revokeAllSessions(const UserId& userId) override;

private:
  std::shared_ptr<PgPool> pool_;
};

}
