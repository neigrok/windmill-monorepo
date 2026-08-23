#pragma once

#include "platform/application/Heartbeat.h"
#include "platform/ports/Clock.h"
#include "platform/ports/Retention.h"
#include "platform/ports/SweepMutex.h"

#include <trantor/utils/Logger.h>

#include <string>
#include <utility>

namespace wm {

// The one pass that deletes. It takes the fleet lock to avoid duplicated work, not for correctness.
class RetentionSweep {
public:
  RetentionSweep(RetentionStore& store, SweepMutex& mutex, Clock& clock, RetentionWindows windows)
      : store_(store), mutex_(mutex), clock_(clock), windows_(std::move(windows)) {}

  // Armed a few minutes past boot, then hourly: a crash-looping process must not delete on every
  // restart.
  void start() {
    LOG_INFO << "retention: events " << window(windows_.eventDays) << ", feedback "
             << window(windows_.feedbackDays) << ", server errors " << window(windows_.serverErrorDays)
             << ", expired oauth codes/tokens collected, up to " << windows_.batch
             << " rows per table per pass";
    heartbeat_.start(kFirstTickSeconds, kPeriodSeconds, [this] { run(); });
  }

  RetentionReport run() {
    RetentionReport report;
    const bool ran = mutex_.underSweepLock([&] { report = store_.purge(windows_, clock_.nowMs()); });
    if (!ran) return RetentionReport{};
    if (report.rows() == 0) return report;
    LOG_INFO << "retention: removed " << report.events << " events, " << report.feedback
             << " feedback, " << report.serverErrors << " server errors, " << report.oauthCodes
             << " oauth codes, " << report.oauthTokens << " oauth tokens, " << report.oauthClients
             << " unattached oauth clients";
    return report;
  }

private:
  static constexpr double kFirstTickSeconds = 300;
  static constexpr double kPeriodSeconds = 3600;

  static std::string window(int days) {
    if (days <= 0) return "kept forever";
    return "kept " + std::to_string(days) + "d";
  }

  RetentionStore& store_;
  SweepMutex& mutex_;
  Clock& clock_;
  RetentionWindows windows_;
  // Last, so it destructs first — the rule Heartbeat asks of its callers.
  Heartbeat heartbeat_{"retention"};
};

}
