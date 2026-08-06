#include "platform/application/OAuthService.h"

namespace wm {

OAuthService::OAuthService(OAuthRepository& repo, TokenGenerator& tokens, Clock& clock)
    : repo_(repo), tokens_(tokens), clock_(clock) {}

std::optional<OAuthClient> OAuthService::registerClient(std::vector<std::string> redirectUris,
                                                        std::string name) {
  if (redirectUris.empty()) return std::nullopt;
  for (const std::string& uri : redirectUris)
    if (!redirectSchemeAllowed(uri)) return std::nullopt;

  // Registration is open (RFC 7591), and this name becomes the headline on the consent screen —
  // "<name> wants access to your Windmill account". Anyone could otherwise register a name that impersonates
  // us or runs long enough to push the honest signal (which host you'd be sent back to) off screen.
  // Clamp the length and drop control characters; the redirect host remains the real trust anchor.
  std::string safeName;
  for (char c : name) {
    if (static_cast<unsigned char>(c) < 0x20 || c == 0x7F) continue;
    safeName.push_back(c);
    if (safeName.size() >= 64) break;
  }

  OAuthClient client{tokens_.mint().secret, std::move(redirectUris), std::move(safeName)};
  repo_.registerClient(client);
  return client;
}

OAuthService::AuthorizeCheck OAuthService::checkAuthorize(const std::string& clientId,
                                                          const std::string& redirectUri,
                                                          const std::string& codeChallenge,
                                                          const std::string& codeChallengeMethod) {
  std::optional<OAuthClient> client = repo_.findClient(clientId);
  if (!client) return {AuthorizeError::unknownClient, std::nullopt};
  if (!redirectRegistered(client->redirectUris, redirectUri)) return {AuthorizeError::badRedirect, client};
  if (codeChallengeMethod != "S256" || codeChallenge.empty())
    return {AuthorizeError::unsupportedChallenge, client};
  return {AuthorizeError::ok, client};
}

std::optional<OAuthClient> OAuthService::describeClient(const std::string& clientId) {
  return repo_.findClient(clientId);
}

std::string OAuthService::issueCode(const std::string& clientId, const std::string& redirectUri,
                                    const std::string& codeChallenge, const std::string& resource,
                                    const std::string& scope, const UserId& user) {
  const MintedToken code = tokens_.mint();
  const UnixMs now = clock_.nowMs();
  repo_.insertCode(code.digest, StoredCode{clientId, user, redirectUri, codeChallenge,
                                           canonicalResource(resource), scope, codeExpiry(now)});
  return code.secret;
}

OAuthService::TokenResult OAuthService::exchangeCode(const std::string& code, const std::string& clientId,
                                                     const std::string& redirectUri,
                                                     const std::string& codeVerifier,
                                                     const std::string& resource) {
  const UnixMs now = clock_.nowMs();
  const std::optional<StoredCode> stored = repo_.takeCode(tokens_.digestOf(code));
  if (!stored || stored->expiresAt <= now) return {GrantError::invalidGrant, std::nullopt};
  if (stored->clientId != clientId) return {GrantError::invalidClient, std::nullopt};
  if (stored->redirectUri != redirectUri) return {GrantError::badRedirect, std::nullopt};
  if (tokens_.s256Challenge(codeVerifier) != stored->codeChallenge) return {GrantError::pkceMismatch, std::nullopt};
  // The token stays bound to the resource the code was issued for; a token request that
  // repeats it must match, but an omitted one falls back to that binding.
  if (!resource.empty() && !audienceMatches(resource, stored->resource)) return {GrantError::badResource, std::nullopt};
  // Consent → token: record the grant (settings §2), keyed apart from the rotating token rows. The
  // scope rides along so the settings row can say what a connected tool may do, months later, without
  // hunting down a token that has rotated a hundred times since.
  repo_.recordGrant(stored->user, stored->clientId, now, stored->scope);
  return {GrantError::ok, mintPair(stored->clientId, stored->user, stored->resource, stored->scope, now)};
}

OAuthService::TokenResult OAuthService::refresh(const std::string& refreshToken, const std::string& clientId) {
  const UnixMs now = clock_.nowMs();
  const std::optional<StoredToken> grant = repo_.takeRefreshToken(tokens_.digestOf(refreshToken), now);
  if (!grant) return {GrantError::invalidGrant, std::nullopt};
  if (grant->clientId != clientId) return {GrantError::invalidClient, std::nullopt};
  return {GrantError::ok, mintPair(grant->clientId, grant->user, grant->resource, grant->scope, now)};
}

std::optional<ToolCaller> OAuthService::resolveAccessToken(const std::string& accessToken,
                                                           const std::string& serverResource) {
  if (accessToken.empty()) return std::nullopt;
  const UnixMs now = clock_.nowMs();
  const std::optional<StoredToken> token = repo_.findAccessToken(tokens_.digestOf(accessToken));
  if (!token || token->expiresAt <= now) return std::nullopt;
  if (!audienceMatches(token->resource, serverResource)) return std::nullopt;
  repo_.touchGrantUsed(token->user, token->clientId, now, OAuthPolicy::grantTouchThrottleMs);
  return ToolCaller{token->user, parseToolScope(token->scope)};
}

std::vector<GrantView> OAuthService::listGrants(const UserId& user) { return repo_.listGrants(user); }

void OAuthService::disconnect(const UserId& user, const std::string& clientId) {
  repo_.revokeGrant(user, clientId);
}

void OAuthService::disconnectAll(const UserId& user) { repo_.revokeAllGrants(user); }

OAuthService::Tokens OAuthService::mintPair(const std::string& clientId, const UserId& user,
                                            const std::string& resource, const std::string& scope, UnixMs now) {
  const MintedToken access = tokens_.mint();
  const MintedToken refresh = tokens_.mint();
  repo_.insertToken(access.digest, refresh.digest,
                    StoredToken{clientId, user, resource, scope, accessExpiry(now)}, refreshExpiry(now));
  return Tokens{access.secret, refresh.secret, OAuthPolicy::accessLifetimeMs, scope};
}

}
