#include "platform/adapters/http/AccessLog.h"

#include "platform/adapters/http/Caller.h"

#include <trantor/utils/Logger.h>

#include <chrono>
#include <string>

namespace wm {

namespace {
constexpr char kStartAttribute[] = "wm.received";

// The probe fires every few seconds forever and says nothing when it is healthy. At info it would
// be most of what this server ever reports; at debug it stays in stdout and out of the log stream
// the humans read. It is not silenced — it is filed where a heartbeat belongs.
bool isProbe(const std::string& path) {
  return path == "/healthz" || path == "/v1/health" || path == "/";
}
}

std::string accessLine(const std::string& method, const std::string& path, int status,
                       long long micros, const std::string& caller) {
  std::string line =
      "http " + method + " " + path + " " + std::to_string(status) + " " + tookMs(micros) + "ms";
  // Anonymous is a fact worth logging, not an absence to omit: "who did this write" with no answer
  // is the shape of a bug, and a missing field reads as a logger that forgot rather than a caller
  // that had no session.
  line += " caller=" + (caller.empty() ? std::string("anon") : caller);
  return line;
}

void installAccessLog(drogon::HttpAppFramework& app) {
  // Stamped before routing so the measurement includes everything the server does with the request,
  // not just the handler body — a request slow because it queued is still a slow request.
  app.registerPreRoutingAdvice([](const drogon::HttpRequestPtr& req) {
    req->attributes()->insert(kStartAttribute, std::chrono::steady_clock::now());
  });

  app.registerPostHandlingAdvice([](const drogon::HttpRequestPtr& req,
                                    const drogon::HttpResponsePtr& resp) {
    const std::string path = req->path();
    const int status = static_cast<int>(resp->getStatusCode());

    long long micros = -1;
    if (req->attributes()->find(kStartAttribute)) {
      const auto started = req->attributes()->get<std::chrono::steady_clock::time_point>(kStartAttribute);
      micros = std::chrono::duration_cast<std::chrono::microseconds>(
                   std::chrono::steady_clock::now() - started)
                   .count();
    }

    std::string caller;
    if (req->attributes()->find(kCallerAttribute))
      caller = req->attributes()->get<std::string>(kCallerAttribute);

    const std::string line = accessLine(req->methodString(), path, status, micros, caller);
    if (isProbe(path)) {
      LOG_DEBUG << line;
      return;
    }
    switch (severityForStatus(status)) {
      case Severity::error: LOG_ERROR << line; return;
      case Severity::warn: LOG_WARN << line; return;
      case Severity::info: LOG_INFO << line; return;
    }
  });
}

}
