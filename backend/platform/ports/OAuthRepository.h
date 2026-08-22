#pragma once

#include "platform/domain/Auth.h"  // UnixMs
#include "platform/domain/Ids.h"

#include <optional>
#include <string>
#include <vector>

namespace wm {

// A dynamically-registered OAuth client (RFC 7591). Public clients only, so no secret is
// stored — the client is pinned by its exact redirect URIs.
struct OAuthClient {
  std::string clientId;
  std::vector<std::string> redirectUris;
  std::string name;
};

// A pending authorization code's grant: who approved it, for which client/redirect, the
// PKCE challenge to verify at the token endpoint, and the resource the token will be bound
// to. Addressed by the code's digest; the raw code is never at rest.
struct StoredCode {
  std::string clientId;
  UserId user;
  std::string redirectUri;
  std::string codeChallenge;
  std::string resource;
  std::string scope;
  UnixMs expiresAt = 0;
};

// An issued token's grant: the account it acts as and the resource (audience) it is valid
// for. Digests, not the tokens, are the keys.
struct StoredToken {
  std::string clientId;
  UserId user;
  std::string resource;
  std::string scope;
  UnixMs expiresAt = 0;
};

// What presenting a refresh token turned out to mean. `unknown` is a string that was never a
// refresh token here, or one whose window has closed; `reused` is one that WAS one and has already
// been spent, and the grant it names is the one to revoke.
enum class RefreshOutcome { rotated, unknown, reused };
struct RefreshRotation {
  RefreshOutcome outcome = RefreshOutcome::unknown;
  std::optional<StoredToken> grant;  // present for rotated and reused alike
  UnixMs spentMs = 0;                // when the tombstone was stamped; only meaningful for reused
};

// One row of the settings §2 "Connected tools" list: a client the user has authorized, its
// display name (from the registered client), when the grant was first made, when its
// tokens last acted, and the scope that was approved. granted/last-used/scope live on
// oauth_grants, stable across token rotation. The scope is here because a person who approved a
// grant months ago has no other way to find out what they handed over.
struct GrantView {
  std::string clientId;
  std::string clientName;
  UnixMs grantedMs = 0;
  UnixMs lastUsedMs = 0;
  std::string scope;
};

// Persistence for OAuth clients, authorization codes, and tokens — one connection per call,
// mirroring the other Postgres repositories; digests, not secrets, are the keys throughout.
struct OAuthRepository {
  virtual ~OAuthRepository() = default;

  virtual void registerClient(const OAuthClient& client) = 0;
  virtual std::optional<OAuthClient> findClient(const std::string& clientId) = 0;
  // How many clients registered since `sinceMs` never completed an authorization — the shape of an
  // abuser's burst, and so what the open registration door is capped on
  // (OAuthPolicy::maxUnattachedClients over OAuthPolicy::unattachedClientWindowMs). Counting the
  // whole table instead would let one burst close registration for everyone until the TTL drained.
  virtual int unattachedClientsSince(UnixMs sinceMs) = 0;

  virtual void insertCode(const std::string& codeDigest, const StoredCode& code) = 0;
  // Redeem a code atomically: delete it and return its grant only to the caller that
  // removed the row, so a code works exactly once (OAuth 2.1 §7.5 protection).
  virtual std::optional<StoredCode> takeCode(const std::string& codeDigest) = 0;

  virtual void insertToken(const std::string& accessDigest, const std::string& refreshDigest,
                           const StoredToken& token, UnixMs refreshExpiresAt) = 0;
  virtual std::optional<StoredToken> findAccessToken(const std::string& accessDigest) = 0;
  // Rotate a refresh token: atomically spend the presented one (if unexpired and unspent) and
  // return its grant so a fresh access+refresh pair can be minted (OAuth 2.1 §4.3.1 rotation).
  //
  // A spent refresh token leaves a TOMBSTONE behind rather than vanishing, and that is the whole
  // of OAUTH-2's fix: presenting one again is the classic signal that a token leaked and two
  // parties hold copies, and it is only distinguishable from a merely-invalid string if the row
  // that was spent is still there to recognise. `reused` carries the grant it belonged to, so the
  // caller can revoke it (OAuth 2.1 §4.14.2). The tombstone lives exactly as long as the refresh
  // token would have — past that, nobody could have spent it anyway and the sweep collects it.
  virtual RefreshRotation rotateRefreshToken(const std::string& refreshDigest, UnixMs now) = 0;

  // The settings §2 grant record, kept apart from the rotation-prone token rows. recordGrant
  // upserts on first token issue: granted_ms is set once and kept as the earliest, last_used
  // and scope advance — a re-consent that narrows the grant must narrow what settings shows.
  // touchGrantUsed advances last_used on the token's hot path, but only past the throttle so a
  // busy client does not write on every call.
  virtual void recordGrant(const UserId& user, const std::string& clientId, UnixMs now,
                           const std::string& scope) = 0;
  virtual void touchGrantUsed(const UserId& user, const std::string& clientId, UnixMs now,
                              UnixMs minIntervalMs) = 0;
  virtual std::vector<GrantView> listGrants(const UserId& user) = 0;
  // Disconnect one tool: drop its tokens, codes, and grant for this user (never its content).
  virtual void revokeGrant(const UserId& user, const std::string& clientId) = 0;
  // Account close: disconnect every tool the user has connected.
  virtual void revokeAllGrants(const UserId& user) = 0;
};

}
