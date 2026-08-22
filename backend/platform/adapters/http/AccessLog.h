#pragma once

#include "platform/adapters/http/LogFormat.h"

#include <drogon/HttpAppFramework.h>
#include <drogon/HttpRequest.h>
#include <drogon/HttpResponse.h>

#include <string>

namespace wm {

// One line per request, from the two advice hooks drogon already gives us — which is why this
// covers every route the server serves, writes included, without a single handler being edited.
// Handlers that log their own domain event still do; this is the floor under them, not a rival.
//
// What it deliberately does NOT carry: the query string. `code`, `state` and every token this
// server accepts arrive there, and a log is retained, replicated to Sentry, and read by more people
// than a database is. Paths carry ids, which are the whole point of the line — except where a route
// puts a capability secret in a segment, which redactedPath() (LogFormat.h) cuts down to a prefix.
// Nothing a caller can steer reaches the line unencoded either: see loggableField().
//
// The one class of request it misses, measured rather than assumed: a path that matches no route at
// all. Drogon answers it 404 without running a handler, so the post-handling advice never fires and
// a scan or a client left pointing at a route that moved is invisible here. Every REGISTERED route
// is covered, which is the whole of the write surface. Closing the rest means setDefaultHandler,
// which changes how unmatched paths are served — worth doing deliberately, not as a side effect.
void installAccessLog(drogon::HttpAppFramework& app);

// The line's body, without the timestamp trantor prepends. Pure, so the format is pinned by a test
// rather than by reading it off a screen and hoping.
std::string accessLine(const std::string& method, const std::string& path, int status,
                       long long micros, const std::string& caller);

}
