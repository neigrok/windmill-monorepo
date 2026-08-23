#pragma once

#include "platform/domain/Auth.h"  // UnixMs

#include <cstddef>
#include <string>
#include <vector>

namespace wm {

// Lifetimes for the OAuth 2.1 flow fronting the MCP resource server.
struct OAuthPolicy {
  static constexpr UnixMs codeLifetimeMs = 10ull * 60 * 1000;
  static constexpr UnixMs accessLifetimeMs = 60ull * 60 * 1000;
  static constexpr UnixMs refreshLifetimeMs = 30ull * 24 * 60 * 60 * 1000;
  // A grant's last-used stamp is advanced only past this interval.
  static constexpr UnixMs grantTouchThrottleMs = 60ull * 1000;

  // Dynamic Client Registration (RFC 7591) is open to anyone, so the bound is on size and count.
  static constexpr std::size_t maxRedirectUris = 5;
  static constexpr std::size_t maxRedirectUriChars = 512;
  // Counted only over clients that never completed an authorization and registered inside the
  // rolling window below, so the door reopens continuously.
  static constexpr int maxUnattachedClients = 10'000;
  static constexpr UnixMs unattachedClientWindowMs = 60ull * 60 * 1000;
  // Never-authorized rows are swept once this old.
  static constexpr UnixMs unattachedClientTtlMs = 30ull * 24 * 60 * 60 * 1000;

  // How long a just-spent refresh token answers "invalid_grant" without revoking the grant:
  // rotation is not atomic across a network, so a retry inside this window is not treated as theft.
  static constexpr UnixMs refreshReplayGraceMs = 30ull * 1000;
  // A spent row is kept this long to recognise reuse, then swept. Must outlive the grace above.
  static constexpr UnixMs spentRefreshTombstoneMs = 48ull * 60 * 60 * 1000;
};

inline UnixMs codeExpiry(UnixMs now) { return now + OAuthPolicy::codeLifetimeMs; }
inline UnixMs accessExpiry(UnixMs now) { return now + OAuthPolicy::accessLifetimeMs; }
inline UnixMs refreshExpiry(UnixMs now) { return now + OAuthPolicy::refreshLifetimeMs; }

// Exact match for https (OAuth 2.1 §7.12: no prefix, no wildcard), port-agnostic for loopback http
// (RFC 8252 §7.3). Answer from a PARSED uri, never a string scan: a uri a parser would read
// differently is refused rather than canonicalized — no userinfo, one colon in the authority, no
// fragment, and the loopback host exactly localhost / 127.0.0.1 / [::1]. This is the security
// boundary; the consent screen's own check is never the gate.
bool redirectRegistered(const std::vector<std::string>& registered, const std::string& uri);

// HTTPS or loopback http only (OAuth 2.1 §1.5), and only when it parses by the rule above.
bool redirectSchemeAllowed(const std::string& uri);

// Lowercase scheme+authority, no fragment, no trailing slash; path case is preserved.
std::string canonicalResource(const std::string& uri);

// RFC 8707 audience binding: the exact URI or its bare origin matches.
bool audienceMatches(const std::string& tokenResource, const std::string& serverResource);

}
