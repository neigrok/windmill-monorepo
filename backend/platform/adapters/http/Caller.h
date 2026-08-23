#pragma once

#include "platform/application/AuthService.h"
#include "platform/domain/Ids.h"

#include <drogon/HttpRequest.h>

#include <optional>
#include <string>

namespace wm {

// Where a resolved caller is left on the request for anything downstream that needs it — the access log.
inline constexpr char kCallerAttribute[] = "wm.caller";

// Who is behind this request: the wm_session cookie, or a Bearer token, resolved to an account —
// empty for an anonymous caller. One home for the trust boundary, shared by every REST surface.
std::optional<User> callerUserOf(const drogon::HttpRequestPtr& req, AuthService& auth);

// The same resolution projected to just the id, for the surfaces that only key on it.
std::optional<UserId> callerOf(const drogon::HttpRequestPtr& req, AuthService& auth);

// A shared secret presented whole — the admin bearer, the MCP fallback token — compared in constant
// time so a mismatch cannot be timed out a byte at a time.
bool secretEqual(const std::string& a, const std::string& b);

}
