#pragma once

#include "platform/application/Heartbeat.h"
#include "platform/ports/Clock.h"
#include "platform/subscriptions/AccountUnbinds.h"

namespace wm::subscriptions {

// Repeats every unbind an erasure owes the subscription service until the service takes it (subscriptions.md §6.4), on
// a thread of its own: a pass as soon as an erasure commits, and one a minute. An unbind the service did not take waits
// a doubled time, and its account is reported at most once a window while it stays owed. Nothing names the account.
class UnbindSweep {
public:
  UnbindSweep(OwedUnbinds& owed, AccountUnbinder& service, Clock& clock, UnbindPace pace = {});

  // Armed a few seconds past boot, then every minute.
  void start();
  void stop() { heartbeat_.stop(); }

  // An erasure committed: a pass now, on the sweep's own thread rather than the erasing caller's.
  void soon();

  // Every unbind due attempted once, the longest owed first: what the heartbeat repeats and a test drives. A store that
  // fails ends the pass, and the next pass tries again.
  void pass();

private:
  // One `subscription.unbind` line under a request of its own; false when the store failed.
  bool attempt(const OwedUnbind& owed);

  static constexpr double kFirstTickSeconds = 10;
  static constexpr double kPeriodSeconds = 60;
  static constexpr int kPerPass = 20;

  OwedUnbinds& owed_;
  AccountUnbinder& service_;
  Clock& clock_;
  const UnbindPace pace_;
  // Last, so it destructs first — the rule Heartbeat asks of its callers.
  Heartbeat heartbeat_{"subscription-unbinds"};
};

}
