#pragma once

#include "platform/domain/Auth.h"  // UnixMs

#include <cstddef>
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

  // What one anonymous registration may cost us. Dynamic Client Registration (RFC 7591) is open
  // by design — an MCP client nobody has met has to be able to introduce itself — so the bound is
  // on the SIZE and the COUNT, not on who may ask. Before these, one 8 MB body persisted 8 MB of
  // redirect URIs and a script could plant rows forever (OAUTH-3).
  static constexpr std::size_t maxRedirectUris = 5;
  static constexpr std::size_t maxRedirectUriChars = 512;
  // Counted over clients that never completed an authorization AND were registered inside the
  // window below — the shape of an abuser's burst, not of a table. A ceiling over the whole table
  // was worse than the growth it bounded: five seconds of registrations filled it and then NOBODY
  // could connect a new MCP client for thirty days, because nothing aged out. A rolling hour
  // reopens the door continuously, and no honest deployment registers ten thousand clients in one.
  static constexpr int maxUnattachedClients = 10'000;
  static constexpr UnixMs unattachedClientWindowMs = 60ull * 60 * 1000;
  // ...and those same never-authorized rows are collected once they are this old. A client that
  // registered and never came back is dead — an MCP host re-registers on its next run.
  static constexpr UnixMs unattachedClientTtlMs = 30ull * 24 * 60 * 60 * 1000;

  // How long a just-spent refresh token answers "invalid_grant" WITHOUT taking the grant with it.
  // Rotation is not atomic across a network: a retry after a lost response, or two threads that
  // both saw a 401, present the same token milliseconds apart — and treating that as theft revoked
  // the winner's brand-new tokens and disconnected an honest person with nothing anywhere saying
  // why. Nothing real is given up: a thief replaying inside the victim's own rotation was never
  // distinguishable from the victim's own retry. Past this, reuse is reuse.
  static constexpr UnixMs refreshReplayGraceMs = 30ull * 1000;
  // A spent row is kept only long enough to recognise reuse, then swept. It must comfortably
  // outlive the grace above; 30 days (the refresh lifetime) turned every rotation into a row that
  // outlived its purpose by a month, which is a growth path of its own.
  static constexpr UnixMs spentRefreshTombstoneMs = 48ull * 60 * 60 * 1000;
};

inline UnixMs codeExpiry(UnixMs now) { return now + OAuthPolicy::codeLifetimeMs; }
inline UnixMs accessExpiry(UnixMs now) { return now + OAuthPolicy::accessLifetimeMs; }
inline UnixMs refreshExpiry(UnixMs now) { return now + OAuthPolicy::refreshLifetimeMs; }

// A redirect URI is honoured only when it matches one the client registered: exact for https —
// the open-redirect defense (OAuth 2.1 §7.12), no prefix or wildcard — but port-agnostic for
// loopback http, so a native/MCP client may use a fresh ephemeral port each flow (RFC 8252 §7.3).
//
// Both of these answer from a PARSED uri, never from a scan of the string, and that is the whole
// of OAUTH-1's fix. The old pair looked for a `localhost` PREFIX and erased everything after the
// first ':' as a port, so "http://127.0.0.1:80@evil.com/callback" — which every real URL parser
// reads as host evil.com — canonicalized to "http://127.0.0.1/callback" and matched an honest
// client's registered loopback, and "http://localhost.evil.com/cb" registered as loopback
// cleartext. A uri a parser would read differently than we do is refused rather than canonicalized:
// no userinfo, one colon in the authority, no fragment, and the loopback host EXACTLY localhost /
// 127.0.0.1 / [::1]. The authorization server is the security boundary here (OAuth 2.1 §7.12,
// RFC 8252 §7.3); the consent screen's own check is a courtesy on top, never the gate.
bool redirectRegistered(const std::vector<std::string>& registered, const std::string& uri);

// A redirect URI may be registered only over HTTPS or to loopback http (OAuth 2.1 §1.5) — and only
// when it parses at all, by the rule above.
bool redirectSchemeAllowed(const std::string& uri);

// Canonical form for comparing resource/audience URIs: lowercase scheme+authority, no
// fragment, no trailing slash. Path case is preserved (it can be significant).
std::string canonicalResource(const std::string& uri);

// Whether a token minted for `tokenResource` may be spent at the server whose canonical
// resource is `serverResource` — the exact URI, or its bare origin, matches (RFC 8707
// audience binding, tolerant of the with/without-`/mcp-path` variance clients emit).
bool audienceMatches(const std::string& tokenResource, const std::string& serverResource);

}
