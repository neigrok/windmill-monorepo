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
// The trigger is DUMB on purpose: a dedicated thread ticking every quarter hour, holding no
// schedule state at all. Every schedule fact lives in Postgres, so a sweep is a pure function of
// (now, database) and a deploy restart loses nothing — the process comes up and, within one
// tick, asks the database who is due. Do not put a schedule in the timer.
//
// The thread is the sweep's OWN event loop, never a drogon request loop: those threads serve
// HTTP and must not block on libpqxx, and a runEvery registered there would fire once per IO
// thread. Exceptions never escape it — one malformed tree, one dead connection, one bad row must
// not cost the fleet its heartbeat.
class ReminderSweep : public MailSweep<DueUser, ReminderDecision> {
public:
  ReminderSweep(ReminderRepository& reminders, ReminderMailSender& mail, TokenGenerator& tokens,
                Clock& clock, MailArming arming, std::string appBaseUrl);

  // Starts the heartbeat. The first tick is jittered a minute or so past boot so a crash loop
  // cannot hammer the database, and because the thread carries no state there is nothing to
  // recover — every tick asks the same question from scratch.
  void start();

  // The pass, queued onto the sweep's own loop and answered there. The admin door uses this:
  // a drogon IO thread serves every other request in flight, and parking one on a sweep would
  // pin a quarter of the server's capacity for as long as the batch takes. Queuing also serialises
  // an operator's sweep behind the heartbeat's rather than racing it.
  void runAsync(std::uint64_t nowMs, bool dryRun, std::function<void(MailSweepReport)> done);

private:
  std::string name() const override { return "reminders"; }
  int batch() const override { return kSweepBatch; }
  std::vector<DueUser> dueNow(std::uint64_t nowMs, int limit) override;
  // The load, guarded. It is the only part of a turn that can throw and still leave something
  // worth recording: a week nobody can read must be claimed anyway, or its owner keeps the oldest
  // pointer in the fleet, sorts first in every batch, and eventually crowds everyone else out.
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
  // which must happen while the collaborators above are still alive — a pass in flight is holding
  // references to every one of them.
  Heartbeat heartbeat_;
};

}
