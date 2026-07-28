#pragma once

#include "platform/ports/Clock.h"
#include "products/roadmap/ports/ReminderMailSender.h"
#include "products/roadmap/ports/ReminderRepository.h"
#include "platform/ports/TokenGenerator.h"
#include "products/roadmap/domain/Reminders.h"

#include <trantor/net/EventLoopThread.h>

#include <cstdint>
#include <functional>
#include <string>

namespace wm {

// What one sweep did, and the only metric this wave ships: the admin endpoint returns it and
// the ledger answers everything else with a GROUP BY. `ran` is false when another sweep already
// held the fleet lock — nothing was looked at, which is not the same as nothing being due.
struct SweepReport {
  bool ran = false;
  int due = 0;        // slots that had arrived
  int claimed = 0;    // weeks this sweep now owns
  int sent = 0;       // mails the provider accepted
  int failed = 0;     // mails the provider refused
  int held = 0;       // sends the arming gate withheld — in the ledger, never delivered
  int wouldSend = 0;  // rehearsal only: sends a real run would have made
  int skipped = 0;    // decisions that were not a send
  int errors = 0;     // users whose turn threw; the sweep carried on past each one
};

// The reminder engine's one action, and the heartbeat that drives it.
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
//
// The write ordering is the correctness story and it is DECIDE → CLAIM → SEND, never any other:
// the committed claim is the permission slip to perform I/O. A crash between claim and send
// costs one person one reminder; a retry of an unconfirmed send would mail somebody twice, and
// the two cases are observationally identical from the outside. So a claimed row is never
// retried. A lost reminder costs nothing; a duplicate costs trust.
class ReminderSweep {
public:
  ReminderSweep(ReminderRepository& reminders, ReminderMailSender& mail, TokenGenerator& tokens,
                Clock& clock, ReminderArming arming, std::string appBaseUrl);

  // Starts the heartbeat. The first tick is jittered a minute or so past boot so a crash loop
  // cannot hammer the database, and because the thread carries no state there is nothing to
  // recover — every tick asks the same question from scratch.
  void start();

  // One pass, top to bottom. `dryRun` rehearses the whole decision and claims nothing, which is
  // what makes a weekly feature iterable in an afternoon instead of seven days at a time. It is
  // a SLOW, blocking pipeline — up to a full batch of database round trips and provider calls —
  // so anything holding a request thread must go through runAsync instead.
  SweepReport run(std::uint64_t nowMs, bool dryRun);

  // The same pass, queued onto the sweep's own loop and answered there. The admin door uses this:
  // a drogon IO thread serves every other request in flight, and parking one on a sweep would
  // pin a quarter of the server's capacity for as long as the batch takes. Queuing also serialises
  // an operator's sweep behind the heartbeat's rather than racing it.
  void runAsync(std::uint64_t nowMs, bool dryRun, std::function<void(SweepReport)> done);

  // The dark-launch gate, whole. `enabled` is the FEATURE's state; `allows` is one person's —
  // two different questions, and answering the second with the first is how a settings page ends
  // up advertising a switch that can never reach the person who flips it.
  const ReminderArming& arming() const { return arming_; }

private:
  void tick();
  // The load, guarded. It is the only part of a turn that can throw and still leave something
  // worth recording: a week nobody can read must be claimed anyway, or its owner keeps the oldest
  // pointer in the fleet, sorts first in every batch, and eventually crowds everyone else out.
  ReminderDecision decideFor(const DueUser& due, std::uint64_t nowMs);
  ReminderMail mailFor(const ReminderContent& content, const std::string& pauseSecret) const;
  bool deliver(const Email& to, const ReminderMail& mail);

  ReminderRepository& reminders_;
  ReminderMailSender& mail_;
  TokenGenerator& tokens_;
  Clock& clock_;
  ReminderArming arming_;
  std::string appBaseUrl_;
  // Declared LAST so it is destroyed FIRST: its destructor quits the loop and joins the thread,
  // which must happen while the collaborators above are still alive — a tick in flight is holding
  // references to every one of them.
  trantor::EventLoopThread ticker_;
};

}
