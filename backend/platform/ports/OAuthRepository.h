#pragma once

#include "platform/domain/Auth.h"  // UnixMs
#include "platform/domain/Ids.h"

#include <optional>
#include <string>
#include <vector>

namespace wm {

// RFC 7591. Public clients only, so no secret is stored — pinned by exact redirect URIs.
struct OAuthClient {
  std::string clientId;
  std::vector<std::string> redirectUris;
  std::string name;
};

// Addressed by the code's digest; the raw code is never at rest.
struct StoredCode {
  std::string clientId;
  UserId user;
  std::string redirectUri;
  std::string codeChallenge;
  std::string resource;
  std::string scope;
  UnixMs expiresAt = 0;
};

// `resource` is the audience the token is valid for.
struct StoredToken {
  std::string clientId;
  UserId user;
  std::string resource;
  std::string scope;
  UnixMs expiresAt = 0;
};

// `unknown`: never a refresh token here, or its window has closed. `reused`: already spent, and
// the grant it names is the one to revoke.
enum class RefreshOutcome { rotated, unknown, reused };
struct RefreshRotation {
  RefreshOutcome outcome = RefreshOutcome::unknown;
  std::optional<StoredToken> grant;  // present for rotated and reused alike
  UnixMs spentMs = 0;                // when the tombstone was stamped; only meaningful for reused
};

// A client the user has authorized; granted/last-used/scope are stable across token rotation.
struct GrantView {
  std::string clientId;
  std::string clientName;
  UnixMs grantedMs = 0;
  UnixMs lastUsedMs = 0;
  std::string scope;
};

// Digests, not secrets, are the keys throughout.
struct OAuthRepository {
  virtual ~OAuthRepository() = default;

  virtual void registerClient(const OAuthClient& client) = 0;
  virtual std::optional<OAuthClient> findClient(const std::string& clientId) = 0;
  // Clients registered since `sinceMs` that never completed an authorization.
  virtual int unattachedClientsSince(UnixMs sinceMs) = 0;

  virtual void insertCode(const std::string& codeDigest, const StoredCode& code) = 0;
  // Atomic: returns the grant only to the caller that removed the row, so a code works once.
  virtual std::optional<StoredCode> takeCode(const std::string& codeDigest) = 0;

  virtual void insertToken(const std::string& accessDigest, const std::string& refreshDigest,
                           const StoredToken& token, UnixMs refreshExpiresAt) = 0;
  virtual std::optional<StoredToken> findAccessToken(const std::string& accessDigest) = 0;
  // Atomically spends the presented token (if unexpired and unspent) and returns its grant.
  // A spent token leaves a tombstone so reuse stays distinguishable from an invalid string; it
  // lives as long as the refresh token would have (OAuthPolicy::spentRefreshTombstoneMs).
  virtual RefreshRotation rotateRefreshToken(const std::string& refreshDigest, UnixMs now) = 0;

  // recordGrant upserts: granted_ms keeps the earliest, last_used and scope advance.
  // touchGrantUsed advances last_used only past minIntervalMs.
  virtual void recordGrant(const UserId& user, const std::string& clientId, UnixMs now,
                           const std::string& scope) = 0;
  virtual void touchGrantUsed(const UserId& user, const std::string& clientId, UnixMs now,
                              UnixMs minIntervalMs) = 0;
  virtual std::vector<GrantView> listGrants(const UserId& user) = 0;
  // Drops its tokens, codes, and grant for this user, never its content.
  virtual void revokeGrant(const UserId& user, const std::string& clientId) = 0;
  virtual void revokeAllGrants(const UserId& user) = 0;
};

}
