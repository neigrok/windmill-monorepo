#pragma once

#include "platform/adapters/http/LogFormat.h"

#include <drogon/HttpAppFramework.h>
#include <drogon/HttpRequest.h>
#include <drogon/HttpResponse.h>

#include <string>

namespace wm {

// One line per request, from drogon's two advice hooks. A path that matches no route is missed:
// drogon answers it 404 without running a handler, so the post-handling advice never fires.
// It never carries the query string — `code`, `state` and every token this server accepts arrive
// there. redactedPath() (LogFormat.h) cuts a capability secret in a path segment to a prefix, and
// loggableField() encodes anything else a caller can steer.
void installAccessLog(drogon::HttpAppFramework& app);

// The line's body, without the timestamp trantor prepends.
std::string accessLine(const std::string& method, const std::string& path, int status,
                       long long micros, const std::string& caller);

}
