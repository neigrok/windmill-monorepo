#pragma once

#include "domain/Auth.h"  // UnixMs

#include <string>
#include <vector>

namespace wm {

// Lifetimes for the OAuth 2.1 flow that fronts the MCP resource server. Access tokens are
// short; a rotating refresh token carries the grant forward without re-consent (MCP
// Authorization spec + OAuth 2.1 §4.3.1 rotation for public clients).
struct OAuthPolicy {
  static constexpr UnixMs codeLifetimeMs = 10ull * 60 * 1000;
  static constexpr UnixMs accessLifetimeMs = 60ull * 60 * 1000;
  static constexpr UnixMs refreshLifetimeMs = 30ull * 24 * 60 * 60 * 1000;
  // The settings §2 grant's last-used stamp is only advanced past this interval, so a busy
  // client resolving tokens on the hot path does not write on every call.
  static constexpr UnixMs grantTouchThrottleMs = 60ull * 1000;
};

inline UnixMs codeExpiry(UnixMs now) { return now + OAuthPolicy::codeLifetimeMs; }
inline UnixMs accessExpiry(UnixMs now) { return now + OAuthPolicy::accessLifetimeMs; }
inline UnixMs refreshExpiry(UnixMs now) { return now + OAuthPolicy::refreshLifetimeMs; }

// A redirect URI is honoured only when it matches one the client registered: exact for https —
// the open-redirect defense (OAuth 2.1 §7.12), no prefix or wildcard — but port-agnostic for
// loopback http, so a native/MCP client may use a fresh ephemeral port each flow (RFC 8252 §7.3).
bool redirectRegistered(const std::vector<std::string>& registered, const std::string& uri);

// A redirect URI may be registered only over HTTPS or to loopback http (OAuth 2.1 §1.5).
bool redirectSchemeAllowed(const std::string& uri);

// Canonical form for comparing resource/audience URIs: lowercase scheme+authority, no
// fragment, no trailing slash. Path case is preserved (it can be significant).
std::string canonicalResource(const std::string& uri);

// Whether a token minted for `tokenResource` may be spent at the server whose canonical
// resource is `serverResource` — the exact URI, or its bare origin, matches (RFC 8707
// audience binding, tolerant of the with/without-`/mcp-path` variance clients emit).
bool audienceMatches(const std::string& tokenResource, const std::string& serverResource);

}
