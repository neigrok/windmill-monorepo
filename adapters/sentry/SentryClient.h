#pragma once

#include <trantor/net/EventLoopThread.h>

#include <cstdint>
#include <mutex>
#include <string>

namespace wm {

// Ships an uncaught server exception to Sentry as a single envelope POST, over a private event-loop
// thread so a report never parks a request loop. An empty or malformed DSN makes every capture a
// no-op (mirroring the ResendEmailSender apiKey_.empty() degradation). Fire-and-forget by contract:
// reporting a crash must never crash, so the send is async and its own failure is only logged.
class SentryClient {
public:
  explicit SentryClient(const std::string& dsn, std::string environment = "production",
                        std::string release = "");

  void captureException(const std::string& kind, const std::string& method, const std::string& path,
                        const std::string& message);

private:
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
