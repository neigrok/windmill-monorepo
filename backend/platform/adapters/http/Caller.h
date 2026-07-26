#pragma once

#include "platform/application/AuthService.h"
#include "platform/domain/Ids.h"

#include <drogon/HttpRequest.h>

#include <optional>
#include <string>

namespace wm {

// Who is behind this request: the wm_session cookie, or a Bearer token, resolved to an account —
// empty for an anonymous caller. One home for the trust boundary, shared by every REST surface so
// "who is the caller" is decided in exactly one place.
std::optional<User> callerUserOf(const drogon::HttpRequestPtr& req, AuthService& auth);

// The same resolution projected to just the id, for the surfaces that only key on it.
std::optional<UserId> callerOf(const drogon::HttpRequestPtr& req, AuthService& auth);

// The other way an edge decides who is calling: a shared secret presented whole — the admin
// bearer, the MCP fallback token — compared in constant time so a mismatch cannot be timed out a
// byte at a time. The == that would otherwise be written here returns on the first differing byte.
bool secretEqual(const std::string& a, const std::string& b);

}
