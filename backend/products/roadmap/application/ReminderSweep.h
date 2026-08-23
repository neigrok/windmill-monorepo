#pragma once

#include "platform/application/Heartbeat.h"
#include "platform/application/MailSweep.h"
#include "platform/domain/MailArming.h"
#include "platform/ports/Clock.h"
#include "platform/ports/TokenGenerator.h"
#include "products/roadmap/domain/Reminders.h"
#include "products/roadmap/ports/ReminderMailSender.h"
#include "products/roadmap/ports/ReminderRepository.h"

#include <cstdint>
#include <functional>
#include <string>
#include <vector>

namespace wm {

// The reminder engine's one action, and the heartbeat that drives it. The pipeline itself —
// DECIDE → CLAIM → SEND, the fleet lock, the arming gate, the pause credential, the counters — is
// platform/application/MailSweep.h; this class supplies what is roadmap's: who is due this week,
// the readiness decision, the weekly ledger, and the reminder mail.
//
// Every schedule fact lives in Postgres, so a sweep is a pure function of (now, database) and the
// ticker holds no schedule state at all. Do not put a schedule in the timer.
//
// The thread is the sweep's OWN event loop, never a drogon request loop: those threads serve HTTP
// and must not block on libpqxx, and a runEvery registered there would fire once per IO thread.
// Exceptions never escape it.
class ReminderSweep : public MailSweep<DueUser, ReminderDecision> {
public:
  ReminderSweep(ReminderRepository& reminders, ReminderMailSender& mail, TokenGenerator& tokens,
                Clock& clock, MailArming arming, std::string appBaseUrl);

  // Starts the heartbeat. The first tick is jittered a minute or so past boot so a crash loop
  // cannot hammer the database.
  void start();

  // The pass, queued onto the sweep's own loop and answered there, so no drogon IO thread parks on
  // a batch. Queuing also serialises an operator's sweep behind the heartbeat's rather than racing it.
  void runAsync(std::uint64_t nowMs, bool dryRun, std::function<void(MailSweepReport)> done);

private:
  std::string name() const override { return "reminders"; }
  int batch() const override { return kSweepBatch; }
  std::vector<DueUser> dueNow(std::uint64_t nowMs, int limit) override;
  // The load, guarded: a week nobody can read must be claimed anyway, or its owner keeps the oldest
  // pointer in the fleet, sorts first in every batch, and crowds everyone else out.
  ReminderDecision decideFor(const DueUser& due, std::uint64_t nowMs) override;
  SweepVerdict verdictOf(const ReminderDecision& decision) const override;
  bool claim(const DueUser& due, const ReminderDecision& decision) override;
  void close(const DueUser& due, ClosedAs outcome) override;
  void send(const DueUser& due, const ReminderDecision& decision, const std::string& pauseSecret,
            std::function<void(bool)> done) override;
  void storePause(const UserId& user, const std::string& digest) override;

  ReminderRepository& reminders_;
  ReminderMailSender& mail_;
  Clock& clock_;
  std::string appBaseUrl_;
  // Declared LAST so it is destroyed FIRST: its destructor quits the loop and joins the thread,
  // which must happen while the collaborators above are still alive.
  Heartbeat heartbeat_;
};

}
