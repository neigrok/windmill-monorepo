#pragma once

#include "platform/application/AuthService.h"
#include "platform/domain/Ids.h"
#include "platform/domain/sync/Credentials.h"

#include <drogon/HttpRequest.h>

#include <optional>
#include <string>

namespace wm {

// Where a resolved caller is left on the request for anything downstream that needs it — the access log.
inline constexpr char kCallerAttribute[] = "wm.caller";

// The session secret a request presents: the wm_session cookie, else a Bearer token; empty for none. A
// WebSocket upgrade presents it the same way.
std::string sessionSecretOf(const drogon::HttpRequestPtr& req);

// Who is behind this request: the wm_session cookie, or a Bearer token, resolved to an account —
// empty for an anonymous caller. One home for the trust boundary, shared by every REST surface that does not read sent
// credentials (SentCaller).
std::optional<User> callerUserOf(const drogon::HttpRequestPtr& req, AuthService& auth);

// The same resolution projected to just the id, for the surfaces that only key on it.
std::optional<UserId> callerOf(const drogon::HttpRequestPtr& req, AuthService& auth);

// Every credential a request's header lines send as received (§9.1, platform/domain/sync/Credentials.h), each token held
// as its digest. The sync doors, GET /v1/me and the AI doors read their caller from these, never from the session
// secret REST reads.
sync::SentCredentials sentCredentialsOf(const drogon::HttpRequestPtr& req, AuthService& auth);

// Whom sent credentials serve a request as: the credential they make, each digest revalidated to its live session's
// account (rolling the session forward and healing its metadata from `ctx`), and that account, which `user` holds unless
// the request is anonymous or its credential fails.
struct SentCaller {
  sync::Credential credential;
  std::optional<User> user;

  static SentCaller of(const sync::SentCredentials& sent, AuthService& auth, const SessionContext& ctx = {});
  // The caller of the credentials `req`'s header lines send (sentCredentialsOf).
  static SentCaller of(const drogon::HttpRequestPtr& req, AuthService& auth, const SessionContext& ctx = {});
};

// A shared secret presented whole — the admin bearer, the MCP fallback token — compared in constant
// time so a mismatch cannot be timed out a byte at a time.
bool secretEqual(const std::string& a, const std::string& b);

}
