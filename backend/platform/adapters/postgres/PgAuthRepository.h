#pragma once

#include "platform/adapters/postgres/PgPool.h"
#include "platform/adapters/postgres/PgAccountFootprint.h"
#include "platform/ports/AuthRepository.h"

#include <functional>
#include <memory>
#include <string>
#include <vector>

namespace wm {

// One product's share of erasing an account. `statements` are the DELETEs for its rows that no foreign key to users
// cascades from, each taking the account's id as text in $1, run in order inside the erasing transaction.
// `committed` is told, once that transaction commits, the first column of every row the statements' RETURNING clauses
// answered, so the product can drop what it holds of them in memory.
struct AccountErasure {
  std::vector<std::string> statements;
  std::function<void(const std::vector<std::string>& erased)> committed;
};

// Postgres-backed accounts, magic links, and sessions. Times the domain owns (expiry, the
// rate window) are stored as epoch-millisecond bigints, so the adapter passes UnixMs
// through untouched; created_at timestamptz columns stay only for human inspection.
class PgAuthRepository : public AuthRepository {
public:
  // `productErasures` name every product's rows the users row's own cascade does not reach; the platform's own are
  // erased here.
  explicit PgAuthRepository(std::shared_ptr<PgPool> pool, std::shared_ptr<PgAccountFootprint> footprint = nullptr,
                            std::vector<AccountErasure> productErasures = {});

  std::optional<User> findUserByEmail(const Email& email) override;
  std::optional<User> findUserById(const UserId& id) override;
  User createUser(const Email& email, const std::string& name) override;
  void updateName(const UserId& userId, const std::string& name) override;
  void markUserDeleted(const UserId& userId, UnixMs now, UnixMs closesAt) override;
  bool reviveUser(const UserId& userId, UnixMs now) override;
  std::vector<std::string> deleteUser(const UserId& userId) override;
  std::vector<UserId> finalClosedAccounts(UnixMs now, int limit) override;
  bool eraseAccount(const UserId& userId, UnixMs now) override;

  std::optional<UserId> findIdentity(Provider provider, const std::string& subject) override;
  void bindIdentity(Provider provider, const std::string& subject, const UserId& userId,
                    const std::string& emailAtLink) override;
  bool tryBindIdentity(const ProviderIdentity& identity, const UserId& userId) override;
  std::optional<User> signInApple(const ProviderIdentity& identity, const UserId& userId,
      const std::string& sessionDigest, UnixMs expiresAt, const std::string& userAgent,
      const std::string& ip, UnixMs now) override;
  std::vector<SignInMethod> signInMethods(const UserId& userId) override;
  bool unbindIdentity(Provider provider, const UserId& userId) override;
  std::optional<std::vector<std::string>> takeOverIdentity(
      const ProviderIdentity& identity, const UserId& from, const UserId& to) override;
  void insertAppleTicket(const std::string& digest, const StoredAppleTicket& ticket) override;
  std::optional<StoredAppleTicket> findAppleTicket(const std::string& digest, UnixMs now) override;
  AppleTicketResult redeemAppleTicket(const std::string& digest, UnixMs now,
      const std::optional<UserId>& target, const std::string& name, const std::string& sessionDigest,
      UnixMs expiresAt, const std::string& userAgent, const std::string& ip,
      const std::string& codeLinkDigest = "") override;
  void moveIdentities(const UserId& from, const UserId& to) override;

  void insertLink(const std::string& digest, const std::string& codeDigest, const Email& email,
                  UnixMs createdAt, UnixMs expiresAt, const std::string& forkSource) override;
  int countRecentLinks(const Email& email, UnixMs since) override;
  std::optional<StoredLink> findLink(const std::string& digest) override;
  std::optional<StoredSignInCode> findLiveCode(const Email& email, UnixMs now,
                                               int maxAttempts) override;
  int spendCodeAttempt(const std::string& digest, int maxAttempts) override;
  bool consumeLink(const std::string& digest, UnixMs at) override;

  void insertSession(const std::string& digest, const UserId& user, UnixMs expiresAt,
                     const std::string& userAgent, const std::string& ip, UnixMs seenAt) override;
  std::optional<StoredSession> findSession(const std::string& digest) override;
  bool refreshSession(const std::string& digest, UnixMs expiresAt, UnixMs seenAt,
                      const std::string& userAgent, const std::string& ip) override;
  void deleteSession(const std::string& digest) override;

  std::vector<SessionRow> listSessions(const UserId& userId) override;
  std::optional<std::string> revokeSession(const UserId& userId, const std::string& sessionId) override;
  std::vector<std::string> revokeSessionsExcept(const UserId& userId, const std::string& keepDigest) override;
  std::vector<std::string> revokeAllSessions(const UserId& userId) override;

private:
  std::shared_ptr<PgPool> pool_;
  std::shared_ptr<PgAccountFootprint> footprint_;
  std::vector<AccountErasure> productErasures_;
};

}
