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

// Supplies the halves MailSweep drives: who is due, the readiness decision, the weekly ledger, and
// the reminder mail. A sweep is a pure function of (now, database) — never put a schedule in the
// timer. Runs on the sweep's own event loop, never a drogon request loop; exceptions never escape it.
class ReminderSweep : public MailSweep<DueUser, ReminderDecision> {
public:
  ReminderSweep(ReminderRepository& reminders, ReminderMailSender& mail, TokenGenerator& tokens,
                Clock& clock, MailArming arming, std::string appBaseUrl);

  // The first tick is jittered a minute or so past boot so a crash loop cannot hammer the database.
  void start();

  // Queued onto the sweep's own loop, so no drogon IO thread parks on a batch and an operator's
  // sweep serialises behind the heartbeat's rather than racing it.
  void runAsync(std::uint64_t nowMs, bool dryRun, std::function<void(MailSweepReport)> done);

private:
  std::string name() const override { return "reminders"; }
  int batch() const override { return kSweepBatch; }
  std::vector<DueUser> dueNow(std::uint64_t nowMs, int limit) override;
  // A week nobody can read must be claimed anyway, or its owner keeps the oldest pointer in the
  // fleet, sorts first in every batch, and crowds everyone else out.
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
