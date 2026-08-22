#include "platform/application/OAuthService.h"

namespace wm {

OAuthService::OAuthService(OAuthRepository& repo, TokenGenerator& tokens, Clock& clock)
    : repo_(repo), tokens_(tokens), clock_(clock) {}

OAuthService::Registration OAuthService::registerClient(std::vector<std::string> redirectUris,
                                                        std::string name) {
  if (redirectUris.empty()) return {RegisterError::invalidMetadata, std::nullopt, 0};
  // Registration is the one door on this server that anyone may walk through, so what it may cost
  // us is bounded here rather than left to the rate limiter: an 8 MB body used to persist 8 MB of
  // redirect URIs, and nothing capped how many rows a script could plant (OAUTH-3).
  if (redirectUris.size() > OAuthPolicy::maxRedirectUris)
    return {RegisterError::invalidMetadata, std::nullopt, 0};
  for (const std::string& uri : redirectUris) {
    if (uri.size() > OAuthPolicy::maxRedirectUriChars)
      return {RegisterError::invalidMetadata, std::nullopt, 0};
    if (!redirectSchemeAllowed(uri)) return {RegisterError::invalidMetadata, std::nullopt, 0};
  }
  // The ceiling counts only clients that never completed an authorization, and only those
  // registered inside the rolling window: an honest client is attached to a grant within a minute,
  // so what this sees is a burst and not a table. It is a refusal of OURS, so it is reported as
  // one — a caller told "invalid_redirect_uri" here would go looking at a redirect that was fine.
  const UnixMs now = clock_.nowMs();
  const int unattached = repo_.unattachedClientsSince(now - OAuthPolicy::unattachedClientWindowMs);
  if (unattached >= OAuthPolicy::maxUnattachedClients)
    return {RegisterError::atCapacity, std::nullopt, unattached};

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
  return {RegisterError::ok, client, unattached};
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
  const RefreshRotation rotation = repo_.rotateRefreshToken(tokens_.digestOf(refreshToken), now);
  // A refresh token presented twice means two parties hold it, and there is no way to tell which
  // of them is the thief — so the grant goes, both of them lose access, and the person re-consents
  // (OAuth 2.1 §4.14.2). Answering invalid_grant and leaving the live family standing, which is
  // what this did before, hands the race winner a working token and tells nobody (OAUTH-2).
  if (rotation.outcome == RefreshOutcome::reused) {
    // ...unless the same client is presenting it again within moments of its own rotation. A retry
    // after a lost response, and two threads that both saw a 401, look exactly like theft from
    // here — and revoking on those disconnects an honest person from their tools, silently, in
    // favour of a thief who was never distinguishable inside that window anyway. Outside it, and
    // for any other client, reuse is reuse and the grant goes.
    const bool ownRetry = rotation.grant && rotation.grant->clientId == clientId &&
                          now - rotation.spentMs <= OAuthPolicy::refreshReplayGraceMs;
    if (!ownRetry && rotation.grant) repo_.revokeGrant(rotation.grant->user, rotation.grant->clientId);
    return {GrantError::invalidGrant, std::nullopt};
  }
  if (rotation.outcome != RefreshOutcome::rotated || !rotation.grant)
    return {GrantError::invalidGrant, std::nullopt};
  const StoredToken& grant = *rotation.grant;
  if (grant.clientId != clientId) return {GrantError::invalidClient, std::nullopt};
  return {GrantError::ok, mintPair(grant.clientId, grant.user, grant.resource, grant.scope, now)};
}

std::optional<ToolCaller> OAuthService::resolveAccessToken(const std::string& accessToken,
                                                           const std::string& serverResource) {
  if (accessToken.empty()) return std::nullopt;
  const UnixMs now = clock_.nowMs();
  const std::optional<StoredToken> token = repo_.findAccessToken(tokens_.digestOf(accessToken));
  if (!token || token->expiresAt <= now) return std::nullopt;
  if (!audienceMatches(token->resource, serverResource)) return std::nullopt;
  repo_.touchGrantUsed(token->user, token->clientId, now, OAuthPolicy::grantTouchThrottleMs);
  // The connection is the client: its id from the token, its registered name from the client row.
  // A client row that is gone costs the name and nothing else — the token still stands on its own.
  const std::optional<OAuthClient> client = repo_.findClient(token->clientId);
  return ToolCaller{token->user, parseToolScope(token->scope),
                    ToolConnection{token->clientId, client ? client->name : ""}};
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
