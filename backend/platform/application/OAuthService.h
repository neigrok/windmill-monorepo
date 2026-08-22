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

// The OAuth 2.1 authorization server for the MCP resource server. Each method is a fail-fast
// pipeline: check through the domain, persist a digest, hand back the raw secret. Consent
// (resolving the human via the magic-link session) lives at the HTTP edge; this service is
// handed an already-authenticated UserId when a code is issued.
class OAuthService {
public:
  OAuthService(OAuthRepository& repo, TokenGenerator& tokens, Clock& clock);

  // Dynamic Client Registration (RFC 7591). The two refusals are DIFFERENT facts and say so: bad
  // metadata is the caller's to fix (an empty redirect list, a redirect that is not HTTPS/loopback,
  // more redirects or longer ones than OAuthPolicy allows), while `atCapacity` is ours — the door
  // is briefly shut on everyone because someone is bursting through it. An operator debugging a
  // dead connect flow must never be sent to look at a redirect URI that was fine.
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

  // On consent approval: mint a single-use authorization code bound to the grant. The raw
  // code is returned to append to the client's redirect; only its digest is stored.
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
  // Rotation, and the breach signal that rides with it: presenting a refresh token that has
  // already been spent revokes the whole (user, client) grant before answering invalid_grant.
  TokenResult refresh(const std::string& refreshToken, const std::string& clientId);

  // Resource-server validation: the account a valid, unexpired, audience-matching access token acts
  // as AND the grant it carries, or nullopt. The scope has been stored end to end since the first
  // token; this is the line where it stops being an opaque string and starts being enforced. A
  // resolved token also advances its grant's last-used stamp (throttled), so the settings §2 list
  // shows honest recent activity.
  std::optional<ToolCaller> resolveAccessToken(const std::string& accessToken,
                                               const std::string& serverResource);

  // The settings §2 "Connected tools" surface: list a user's grants, disconnect one tool
  // (drops its tokens+codes+grant), and disconnect them all (account close).
  std::vector<GrantView> listGrants(const UserId& user);
  void disconnect(const UserId& user, const std::string& clientId);
  void disconnectAll(const UserId& user);

private:
  // Shared by exchangeCode and refresh: mint + persist a fresh access/refresh pair.
  Tokens mintPair(const std::string& clientId, const UserId& user, const std::string& resource,
                  const std::string& scope, UnixMs now);

  OAuthRepository& repo_;
  TokenGenerator& tokens_;
  Clock& clock_;
};

}
