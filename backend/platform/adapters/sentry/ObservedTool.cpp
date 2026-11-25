#include "platform/adapters/sentry/ObservedTool.h"
#include "platform/adapters/sentry/LogTee.h"
#include "platform/adapters/http/WriteRoutes.h"

#include <cstdio>
#include <cstdlib>
#include <stdexcept>

namespace wm {
namespace {
std::shared_ptr<SentryClient> toolReporter;
}

void installToolObservability(bool protocolStdout) {
  const char* dsn = std::getenv("SENTRY_DSN");
  const char* environment = std::getenv("SENTRY_ENVIRONMENT");
  const char* release = std::getenv("SENTRY_RELEASE");
  toolReporter = std::make_shared<SentryClient>(dsn ? dsn : "", environment ? environment : "production",
                                               release ? release : "");
  installWriteReporter(toolReporter);
  installPrivacySafeExceptionHandler(drogon::app());
  installLogTee(toolReporter, logLevelFromEnv(std::getenv("SENTRY_LOG_LEVEL")), protocolStdout ? stderr : stdout);
}

void stopToolObservability() {
  stopLogTee();
  installWriteReporter({});
  if (toolReporter) toolReporter->drain();
}

FailureReporter& toolFailureReporter() {
  if (!toolReporter) throw std::logic_error("the tool's observability is not installed");
  return *toolReporter;
}
}
