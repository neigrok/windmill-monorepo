#pragma once

#include "platform/adapters/http/LogFormat.h"

#include <drogon/HttpAppFramework.h>
#include <drogon/HttpRequest.h>
#include <drogon/HttpResponse.h>

#include <string>

namespace wm {

// One line per request, from the two advice hooks drogon gives us, so every registered route is
// covered without a handler being edited. A path that matches no route at all is missed: drogon
// answers it 404 without running a handler, so the post-handling advice never fires.
//
// It deliberately does NOT carry the query string — `code`, `state` and every token this server
// accepts arrive there. Where a route puts a capability secret in a path segment, redactedPath()
// (LogFormat.h) cuts it to a prefix, and loggableField() encodes anything else a caller can steer.
void installAccessLog(drogon::HttpAppFramework& app);

// The line's body, without the timestamp trantor prepends.
std::string accessLine(const std::string& method, const std::string& path, int status,
                       long long micros, const std::string& caller);

}
