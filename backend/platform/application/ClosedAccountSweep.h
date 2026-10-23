#pragma once

#include "platform/application/AuthService.h"
#include "platform/application/Heartbeat.h"

#include <trantor/utils/Logger.h>

namespace wm {

// Keeps the promise a close makes: once its 30-day grace is over, the account is deleted for good.
// A sign-in that meets a final close erases that account itself; this pass erases every other one.
// Its own class because it owns the heartbeat thread, which AuthService must never carry.
class ClosedAccountSweep {
public:
  explicit ClosedAccountSweep(AuthService& auth) : auth_(auth) {}

  // Armed a few minutes past boot, then hourly, like retention: a crash-looping process must not
  // erase on every restart.
  void start() {
    LOG_INFO << "closed accounts: erased once their grace is over, up to " << kAccountsPerPass
             << " accounts per pass";
    heartbeat_.start(kFirstTickSeconds, kPeriodSeconds, [this] { run(); });
  }

  void stop() { heartbeat_.stop(); }

  int run() {
    const int erased = auth_.eraseFinalCloses(kAccountsPerPass);
    if (erased > 0) LOG_INFO << "closed accounts: erased " << erased << " past their grace";
    return erased;
  }

private:
  static constexpr double kFirstTickSeconds = 300;
  static constexpr double kPeriodSeconds = 3600;
  static constexpr int kAccountsPerPass = 100;

  AuthService& auth_;
  // Last, so it destructs first — the rule Heartbeat asks of its callers.
  Heartbeat heartbeat_{"closed-accounts"};
};

}
