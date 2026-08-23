#pragma once

#include "platform/adapters/postgres/PgPool.h"
#include "platform/ports/OAuthRepository.h"

#include <memory>
#include <string>

namespace wm {

// OAuth clients, authorization codes, and tokens in Postgres. A code is redeemed with
// DELETE ... RETURNING and a refresh token with UPDATE ... RETURNING, so either way exactly one
// caller spends a row; the refresh row stays behind as a tombstone so its reuse is recognisable.
class PgOAuthRepository : public OAuthRepository {
public:
  explicit PgOAuthRepository(std::shared_ptr<PgPool> pool);

  void registerClient(const OAuthClient& client) override;
  std::optional<OAuthClient> findClient(const std::string& clientId) override;
  int unattachedClientsSince(UnixMs sinceMs) override;
  void insertCode(const std::string& codeDigest, const StoredCode& code) override;
  std::optional<StoredCode> takeCode(const std::string& codeDigest) override;
  void insertToken(const std::string& accessDigest, const std::string& refreshDigest,
                   const StoredToken& token, UnixMs refreshExpiresAt) override;
  std::optional<StoredToken> findAccessToken(const std::string& accessDigest) override;
  RefreshRotation rotateRefreshToken(const std::string& refreshDigest, UnixMs now) override;

  void recordGrant(const UserId& user, const std::string& clientId, UnixMs now,
                   const std::string& scope) override;
  void touchGrantUsed(const UserId& user, const std::string& clientId, UnixMs now,
                      UnixMs minIntervalMs) override;
  std::vector<GrantView> listGrants(const UserId& user) override;
  void revokeGrant(const UserId& user, const std::string& clientId) override;
  void revokeAllGrants(const UserId& user) override;

private:
  std::shared_ptr<PgPool> pool_;
};

}
