#pragma once

#include "platform/domain/Ids.h"
#include "platform/domain/OAuth.h"
#include "platform/domain/ToolScope.h"
#include "platform/ports/Clock.h"
#include "platform/ports/OAuthRepository.h"
#include "platform/ports/TokenGenerator.h"

#include <optional>
#include <string>
#include <vector>

namespace wm {

// Consent lives at the HTTP edge; this service is handed an already-authenticated UserId when a
// code is issued.
class OAuthService {
public:
  OAuthService(OAuthRepository& repo, TokenGenerator& tokens, Clock& clock);

  // Dynamic Client Registration (RFC 7591). atCapacity is a global refusal, invalidMetadata the
  // caller's own.
  enum class RegisterError { ok, invalidMetadata, atCapacity };
  struct Registration {
    RegisterError error = RegisterError::ok;
    std::optional<OAuthClient> client;
    int unattachedInWindow = 0;  // what the ceiling saw, for the log line at the edge
  };
  Registration registerClient(std::vector<std::string> redirectUris, std::string name);

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

  // Mints a single-use authorization code bound to the grant; only its digest is stored.
  std::string issueCode(const std::string& clientId, const std::string& redirectUri,
                        const std::string& codeChallenge, const std::string& resource,
                        const std::string& scope, const UserId& user);

  struct Tokens {
    std::string accessToken;
    std::string refreshToken;
    UnixMs accessLifetimeMs = 0;
    std::string scope;  // echoed in the token reply: what was actually granted, not what was asked
  };
  enum class GrantError { ok, invalidGrant, invalidClient, badRedirect, pkceMismatch, badResource };
  struct TokenResult {
    GrantError error = GrantError::ok;
    std::optional<Tokens> tokens;
  };
  TokenResult exchangeCode(const std::string& code, const std::string& clientId,
                           const std::string& redirectUri, const std::string& codeVerifier,
                           const std::string& resource);
  // Presenting an already-spent refresh token revokes the whole (user, client) grant before
  // answering invalid_grant.
  TokenResult refresh(const std::string& refreshToken, const std::string& clientId);

  // The account a valid, unexpired, audience-matching access token acts as, or nullopt. A resolved
  // token advances its grant's last-used stamp (throttled).
  std::optional<ToolCaller> resolveAccessToken(const std::string& accessToken,
                                               const std::string& serverResource);

  // disconnect drops one tool's tokens, codes and grant; disconnectAll does it for every tool.
  std::vector<GrantView> listGrants(const UserId& user);
  void disconnect(const UserId& user, const std::string& clientId);
  void disconnectAll(const UserId& user);

private:
  // Shared by exchangeCode and refresh: mint and persist a fresh access/refresh pair.
  Tokens mintPair(const std::string& clientId, const UserId& user, const std::string& resource,
                  const std::string& scope, UnixMs now);

  OAuthRepository& repo_;
  TokenGenerator& tokens_;
  Clock& clock_;
};

}
