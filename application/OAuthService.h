#pragma once

#include "domain/Ids.h"
#include "domain/OAuth.h"
#include "ports/Clock.h"
#include "ports/OAuthRepository.h"
#include "ports/TokenGenerator.h"

#include <optional>
#include <string>
#include <vector>

namespace wm {

// The OAuth 2.1 authorization server for the MCP resource server. Each method is a fail-fast
// pipeline: check through the domain, persist a digest, hand back the raw secret. Consent
// (resolving the human via the magic-link session) lives at the HTTP edge; this service is
// handed an already-authenticated UserId when a code is issued.
class OAuthService {
public:
  OAuthService(OAuthRepository& repo, TokenGenerator& tokens, Clock& clock);

  // Dynamic Client Registration (RFC 7591). Rejects (nullopt) an empty redirect list or any
  // redirect that is not HTTPS/loopback.
  std::optional<OAuthClient> registerClient(std::vector<std::string> redirectUris, std::string name);

  // The verdict on an /authorize request, evaluated before the consent screen is shown.
  enum class AuthorizeError { ok, unknownClient, badRedirect, unsupportedChallenge };
  struct AuthorizeCheck {
    AuthorizeError error = AuthorizeError::ok;
    std::optional<OAuthClient> client;  // present whenever the client id resolved (for display)
  };
  AuthorizeCheck checkAuthorize(const std::string& clientId, const std::string& redirectUri,
                                const std::string& codeChallenge, const std::string& codeChallengeMethod);

  // The registered client, for the consent screen to show verified name/redirects.
  std::optional<OAuthClient> describeClient(const std::string& clientId);

  // On consent approval: mint a single-use authorization code bound to the grant. The raw
  // code is returned to append to the client's redirect; only its digest is stored.
  std::string issueCode(const std::string& clientId, const std::string& redirectUri,
                        const std::string& codeChallenge, const std::string& resource,
                        const std::string& scope, const UserId& user);

  struct Tokens {
    std::string accessToken;
    std::string refreshToken;
    UnixMs accessLifetimeMs = 0;
  };
  enum class GrantError { ok, invalidGrant, invalidClient, badRedirect, pkceMismatch, badResource };
  struct TokenResult {
    GrantError error = GrantError::ok;
    std::optional<Tokens> tokens;
  };
  TokenResult exchangeCode(const std::string& code, const std::string& clientId,
                           const std::string& redirectUri, const std::string& codeVerifier,
                           const std::string& resource);
  TokenResult refresh(const std::string& refreshToken, const std::string& clientId);

  // Resource-server validation: the account a valid, unexpired, audience-matching access
  // token acts as, or nullopt.
  std::optional<UserId> resolveAccessToken(const std::string& accessToken, const std::string& serverResource);

private:
  // Shared by exchangeCode and refresh: mint + persist a fresh access/refresh pair.
  Tokens mintPair(const std::string& clientId, const UserId& user, const std::string& resource,
                  const std::string& scope, UnixMs now);

  OAuthRepository& repo_;
  TokenGenerator& tokens_;
  Clock& clock_;
};

}
