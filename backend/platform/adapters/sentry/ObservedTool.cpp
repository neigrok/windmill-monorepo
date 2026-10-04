#include "platform/adapters/sentry/ObservedTool.h"
#include "platform/adapters/sentry/LogTee.h"
#include "platform/adapters/http/WriteRoutes.h"

#include <cstdio>
#include <cstdlib>
#include <stdexcept>

namespace wm {
namespace {
std::shared_ptr<SentryClient> toolReporter;
struct ToolWriteFailure : std::runtime_error {
  ToolWriteFailure() : std::runtime_error("tool failed") {}
};
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

int runObservedTool(const std::string& operation, const std::string& product,
                    const std::function<int(WriteObservation&)>& run) {
  installToolObservability(true);
  ObservabilityLifetime lifetime;
  WriteObservation observation(operation, product, "tool");
  WriteContext context(observation);
  try {
    const int exit = run(observation);
    if (exit != 0) observation.reportFailure(ToolWriteFailure{});
    observation.finish(exit == 0 ? "ok" : "failed");
    return exit;
  } catch (const std::exception& error) {
    observation.fail(error);
    return 1;
  } catch (...) {
    observation.failUnknown();
    return 1;
  }
}
}
