#pragma once

#include "platform/application/AuthService.h"
#include "platform/domain/Ids.h"
#include "platform/domain/sync/Credentials.h"

#include <drogon/HttpRequest.h>
#include <drogon/HttpResponse.h>

#include <optional>
#include <string>

namespace wm {

// Where a request's caller is left for the access log: the account's id, or `refused` or `lapsed` for credentials that
// fail (SentCaller); absent for a request that sends none.
inline constexpr char kCallerAttribute[] = "wm.caller";

// Every credential a request's header lines send as received (§9.1, platform/domain/sync/Credentials.h), each token held
// as its digest. Every door that reads a session reads it from these, through SentCaller.
sync::SentCredentials sentCredentialsOf(const drogon::HttpRequestPtr& req, AuthService& auth);

// Whom sent credentials serve a request as: the credential they make, each digest revalidated to its live session's
// account (rolling the session forward and healing its metadata from `ctx`), and that account, which `user` holds unless
// the request is anonymous or its credential fails. A door that serves an account alone answers 401 unless `user` holds
// one; a door that serves anonymous callers too answers 401 when `refused()`.
struct SentCaller {
  sync::Credential credential;
  std::optional<User> user;
  // One credential of its form that no live session holds, as a browser sends once its session is revoked or expired.
  bool lapsed = false;

  static SentCaller of(const sync::SentCredentials& sent, AuthService& auth, const SessionContext& ctx = {});
  // The caller of the credentials `req`'s header lines send (sentCredentialsOf), which it leaves for the access log.
  static SentCaller of(const drogon::HttpRequestPtr& req, AuthService& auth, const SessionContext& ctx = {});

  std::optional<UserId> account() const;
  // Credentials that fail, but for one lapsed credential, which a door that serves anonymous callers serves as anonymous.
  // The sync doors, GET /v1/me and the AI doors refuse every credential that fails (`credential.fails()`).
  bool refused() const;
};

// What a door that serves anonymous callers too answers a request it refuses: 401 unauthenticated.
drogon::HttpResponsePtr refusedCredentials();

// A shared secret presented whole — the admin bearer, the MCP fallback token — compared in constant
// time so a mismatch cannot be timed out a byte at a time.
bool secretEqual(const std::string& a, const std::string& b);

}
