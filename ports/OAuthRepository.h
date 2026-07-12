#pragma once

#include "domain/Auth.h"  // UnixMs
#include "domain/Ids.h"

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

// Persistence for OAuth clients, authorization codes, and tokens — one connection per call,
// mirroring the other Postgres repositories; digests, not secrets, are the keys throughout.
struct OAuthRepository {
  virtual ~OAuthRepository() = default;

  virtual void registerClient(const OAuthClient& client) = 0;
  virtual std::optional<OAuthClient> findClient(const std::string& clientId) = 0;

  virtual void insertCode(const std::string& codeDigest, const StoredCode& code) = 0;
  // Redeem a code atomically: delete it and return its grant only to the caller that
  // removed the row, so a code works exactly once (OAuth 2.1 §7.5 protection).
  virtual std::optional<StoredCode> takeCode(const std::string& codeDigest) = 0;

  virtual void insertToken(const std::string& accessDigest, const std::string& refreshDigest,
                           const StoredToken& token, UnixMs refreshExpiresAt) = 0;
  virtual std::optional<StoredToken> findAccessToken(const std::string& accessDigest) = 0;
  // Rotate a refresh token: atomically consume the presented one (if unexpired) and return
  // its grant so a fresh access+refresh pair can be minted (OAuth 2.1 §4.3.1 rotation).
  virtual std::optional<StoredToken> takeRefreshToken(const std::string& refreshDigest, UnixMs now) = 0;
};

}
