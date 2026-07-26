#pragma once

#include "platform/ports/OAuthRepository.h"

#include <string>

namespace wm {

// OAuth clients, authorization codes, and tokens in Postgres. Codes and refresh tokens are
// redeemed with DELETE ... RETURNING so a row is spent exactly once. A per-thread connection
// (PgConnection) backs every call, like the other repositories.
class PgOAuthRepository : public OAuthRepository {
public:
  explicit PgOAuthRepository(std::string connString);

  void registerClient(const OAuthClient& client) override;
  std::optional<OAuthClient> findClient(const std::string& clientId) override;
  void insertCode(const std::string& codeDigest, const StoredCode& code) override;
  std::optional<StoredCode> takeCode(const std::string& codeDigest) override;
  void insertToken(const std::string& accessDigest, const std::string& refreshDigest,
                   const StoredToken& token, UnixMs refreshExpiresAt) override;
  std::optional<StoredToken> findAccessToken(const std::string& accessDigest) override;
  std::optional<StoredToken> takeRefreshToken(const std::string& refreshDigest, UnixMs now) override;

  void recordGrant(const UserId& user, const std::string& clientId, UnixMs now) override;
  void touchGrantUsed(const UserId& user, const std::string& clientId, UnixMs now,
                      UnixMs minIntervalMs) override;
  std::vector<GrantView> listGrants(const UserId& user) override;
  void revokeGrant(const UserId& user, const std::string& clientId) override;
  void revokeAllGrants(const UserId& user) override;

private:
  std::string connString_;
};

}
