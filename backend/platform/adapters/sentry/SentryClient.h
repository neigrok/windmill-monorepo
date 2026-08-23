#pragma once

#include "platform/ports/FailureReporter.h"

#include <json/json.h>
#include <trantor/net/EventLoopThread.h>

#include <cstdint>
#include <memory>
#include <mutex>
#include <string>
#include <vector>

namespace drogon {
class HttpClient;
}

namespace wm {

// Ships an uncaught server exception to Sentry as a single envelope POST, over a private event-loop
// thread so a report never parks a request loop. An empty or malformed DSN makes every capture a
// no-op. Fire-and-forget: the send is async and its own failure is only logged.
class SentryClient : public FailureReporter {
public:
  explicit SentryClient(const std::string& dsn, std::string environment = "production",
                        std::string release = "");

  void captureException(const std::string& kind, const std::string& method, const std::string& path,
                        const std::string& message);

  // The handled half (ports/FailureReporter): a failure the user saw that never threw, so drogon's
  // exception handler never sees it. Same envelope, same cap, level error.
  void report(const std::string& kind, const std::string& where, const std::string& detail) override;

  // The server's own log lines, as Sentry structured logs (envelope item type `log`). Buffered
  // rather than one POST per line; flushed on a timer, or early once a batch fills.
  enum class Level { trace, debug, info, warn, error, fatal };
  void log(Level level, std::string body, std::string source);

  // True on this client's own loop thread. The tee asks before forwarding, so a diagnostic this
  // client emits about a failed send can never be teed back into the buffer it was reporting on.
  bool onReportingThread() const;

private:
  Json::Value newEvent(const std::string& id, const std::string& kind) const;
  void ship(const std::string& id, const Json::Value& event);
  void post(std::string body);
  void flushLogs();

  // A per-minute cap: an error storm must not mint one outbound TLS connection per failed request
  // on the single loop thread. Excess reports drop; the DB server_errors mirror still records every one.
  bool allow();

  bool enabled_ = false;
  std::string host_;
  std::string projectId_;
  std::string publicKey_;
  std::string environment_;
  std::string release_;
  std::mutex rateMutex_;
  std::int64_t windowStartMs_ = 0;
  int windowCount_ = 0;

  // One trace for the whole process run, so every log line since boot is one query in Sentry.
  std::string runTraceId_;
  std::shared_ptr<drogon::HttpClient> client_;
  std::mutex logMutex_;
  std::vector<Json::Value> logItems_;
  std::int64_t logDropped_ = 0;

  trantor::EventLoopThread loop_;
};

}
