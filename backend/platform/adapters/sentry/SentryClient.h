#pragma once

#include "platform/ports/FailureReporter.h"

#include <json/json.h>
#include <trantor/net/EventLoopThread.h>

#include <cstdint>
#include <mutex>
#include <string>

namespace wm {

// Ships an uncaught server exception to Sentry as a single envelope POST, over a private event-loop
// thread so a report never parks a request loop. An empty or malformed DSN makes every capture a
// no-op (mirroring the ResendEmailSender apiKey_.empty() degradation). Fire-and-forget by contract:
// reporting a crash must never crash, so the send is async and its own failure is only logged.
class SentryClient : public FailureReporter {
public:
  explicit SentryClient(const std::string& dsn, std::string environment = "production",
                        std::string release = "");

  void captureException(const std::string& kind, const std::string& method, const std::string& path,
                        const std::string& message);

  // The handled half (ports/FailureReporter): a failure the user saw that never threw, so drogon's
  // exception handler never sees it. Same envelope, same cap, level error — a broken feature should
  // go red here whether or not it took the request down with it.
  void report(const std::string& kind, const std::string& where, const std::string& detail) override;

private:
  Json::Value newEvent(const std::string& id, const std::string& kind) const;
  void ship(const std::string& id, const Json::Value& event);

  // A per-minute cap: an error storm (a broken endpoint at high RPS) must not mint one outbound TLS
  // connection per failed request on the single loop thread. Excess reports drop; the DB
  // server_errors mirror still records every one.
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
  trantor::EventLoopThread loop_;
};

}
