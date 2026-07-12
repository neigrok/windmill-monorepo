#pragma once

#include "application/AuthService.h"
#include "domain/Ids.h"

#include <drogon/HttpRequest.h>

#include <optional>

namespace wm {

// Who is behind this request: the wm_session cookie, or a Bearer token, resolved to a user
// id — empty for an anonymous caller. One home for the trust boundary, shared by every REST
// surface so "who is the caller" is decided in exactly one place.
std::optional<UserId> callerOf(const drogon::HttpRequestPtr& req, AuthService& auth);

}
