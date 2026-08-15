#pragma once

#include "platform/domain/Ids.h"
#include "platform/domain/MailArming.h"
#include "platform/ports/SweepMutex.h"
#include "platform/ports/TokenGenerator.h"

#include <trantor/utils/Logger.h>

#include <chrono>
#include <cstdint>
#include <exception>
#include <functional>
#include <future>
#include <memory>
#include <string>
#include <utility>
#include <vector>

namespace wm {

// What one pass did, and the only metric a mail sweep ships: the admin endpoints return it and the
// product's ledger answers everything else with a GROUP BY. `ran` is false when another sweep
// already held the fleet lock — nothing was looked at, which is not the same as nothing being due.
struct MailSweepReport {
  bool ran = false;
  int due = 0;        // slots that had arrived
  int claimed = 0;    // slots this sweep now owns
  int sent = 0;       // mails the provider accepted
  int failed = 0;     // mails the provider refused
  int held = 0;       // sends the arming gate withheld — in the ledger, never delivered
  int wouldSend = 0;  // rehearsal only: sends a real run would have made
  int skipped = 0;    // decisions that were not a send
  int errors = 0;     // users whose turn threw; the sweep carried on past each one
};

// What the pipeline concluded about one user's decision, as the base needs to read it. The product
// keeps its own decision type and its own reason vocabulary; this is the three-way split the
// skeleton acts on. `unreadable` is a decision the product stamped because the facts could not be
// loaded at all — it is claimed like a skip AND counted as an error, so a user whose load keeps
// failing does not keep the oldest pointer in the fleet and crowd everyone else out of the batch.
enum class SweepVerdict { send, skip, unreadable };

// How a claimed slot ended, as the base closes it. The product maps this onto its own ledger
// vocabulary (WeekOutcome, DayOutcome). Exactly one is recorded for every claim that was a send,
// which is what lets the ledger tell a slot we deliberately withheld from a slot whose process died
// between the claim and the mail — during a dark rollout EVERY row would otherwise look like the
// crash.
enum class ClosedAs { held, delivered, refused };

// The fleet-wide work lock as a scope. Correctness does not depend on it — the committed claim
// does — so a lock that is already held simply means someone else is doing this work.
struct SweepLock {
  SweepLock(SweepMutex& mutex, std::string name)
      : mutex(mutex), name(std::move(name)), held(mutex.tryLockSweep()) {}
  ~SweepLock() {
    if (!held) return;
    // A destructor is noexcept, and handing the lock back reaches the database — which is exactly
    // the thing most likely to have just died. Letting that throw would take the process with it;
    // a lock left held is released by the server the moment the connection drops anyway.
    try {
      mutex.unlockSweep();
    } catch (...) {
      LOG_ERROR << name << ": the sweep lock could not be handed back";
    }
  }

  SweepMutex& mutex;
  std::string name;
  bool held;
};

// The mail sweep: one pass of DECIDE → CLAIM → SEND over everyone whose slot has arrived, written
// once for every product that mails on a schedule. Roadmap's weekly reminder and journal's nightly
// nudge each wrote this skeleton out and the two had already drifted — one guarded a user's turn
// and one did not, one reported a rehearsal apart from a real run and one folded them together —
// so the second consumer earned the promotion. What varies per product is the handful of pure
// virtuals below: who is due, what to decide, how to claim and close its own ledger, and the mail
// itself. Everything that must not vary is here, in `run`.
//
// The write ordering is the correctness story and it is DECIDE → CLAIM → SEND, never any other:
// the committed claim is the permission slip to perform I/O. A crash between claim and send costs
// one person one mail; a retry of an unconfirmed send would mail somebody twice, and the two cases
// are observationally identical from the outside. So a claimed row is never retried. A lost mail
// costs nothing; a duplicate costs trust.
//
// The heartbeat that drives `run` is NOT here. It is the product's own member — declared LAST, so
// it is destroyed first (platform/application/Heartbeat.h) — because the tick and the pipeline are
// two things shared at two depths: journal's EchoSweep beats and derives but never mails, and a
// gate it must inherit and ignore is worse than none.
template <typename Due, typename Decision>
class MailSweep {
public:
  virtual ~MailSweep() = default;

  // One pass, top to bottom. `dryRun` rehearses the whole decision and claims nothing, which is
  // what makes a weekly feature iterable in an afternoon instead of seven days at a time. It is
  // a SLOW, blocking pipeline — up to a full batch of database round trips and provider calls —
  // so a request thread should reach it through the product's own loop (ReminderSweep::runAsync)
  // rather than inline; journal's admin door still calls it inline and pays for that.
  MailSweepReport run(std::uint64_t nowMs, bool dryRun) {
    MailSweepReport report;
    SweepLock lock(mutex_, name());
    if (!lock.held) return report;  // another process is already doing exactly this work
    report.ran = true;

    for (const Due& due : dueNow(nowMs, batch())) {
      ++report.due;
      // One user's turn is one user's risk: an unreadable tree or a lost row costs that person
      // this slot's mail and nothing more. The sweep carries on down the list.
      try {
        const Decision decision = decideFor(due, nowMs);
        const SweepVerdict verdict = verdictOf(decision);
        if (verdict == SweepVerdict::unreadable) ++report.errors;

        // A rehearsal decides everything and commits nothing. It reports what WOULD have gone out
        // separately from what the arming gate withholds on a real run — two different facts that
        // once shared one counter and told the operator neither.
        if (dryRun) {
          if (verdict == SweepVerdict::send) ++report.wouldSend;
          else ++report.skipped;
          continue;
        }

        // The permission slip. Losing this race means another sweep owns the slot; its pointer
        // moved too, so falling silent here is the whole of the correct response.
        if (!claim(due, decision)) continue;
        ++report.claimed;
        // Counted only once the slot is ours: a skip that lost the race belongs to another sweep's
        // row, and reporting it here would name a decision the ledger never took.
        if (verdict != SweepVerdict::send) {
          ++report.skipped;
          continue;
        }

        // Armed at SEND time, never at decide time — so a dark launch still leaves an honest slot
        // in the ledger saying what we would have sent, and arming later cannot double-mail it. The
        // slot is closed as `held` so that row can never be mistaken for a crash between claim and
        // send, which is what every row would look like for the whole of a dark rollout.
        if (!arming_.allows(due.user)) {
          close(due, ClosedAs::held);
          ++report.held;
          continue;
        }

        // A fresh pause credential per mail, stored only once the mail carrying it actually left:
        // rotating first would kill last time's still-in-an-inbox pause link on behalf of a
        // replacement that never arrived.
        const MintedToken pause = tokens_.mint();
        const bool delivered = deliver(due, decision, pause.secret);
        if (delivered) storePause(due.user, pause.digest);
        close(due, delivered ? ClosedAs::delivered : ClosedAs::refused);
        if (delivered) ++report.sent;
        else ++report.failed;
      } catch (const std::exception& error) {
        ++report.errors;
        LOG_ERROR << name() << ": " << due.user.str() << " skipped this slot: " << error.what();
      } catch (...) {
        ++report.errors;
        LOG_ERROR << name() << ": " << due.user.str() << " skipped this slot";
      }
    }
    return report;
  }

  // The dark-launch gate, whole. `enabled` is the FEATURE's state; `allows` is one person's —
  // two different questions, and answering the second with the first is how a settings page ends
  // up advertising a switch that can never reach the person who flips it.
  const MailArming& arming() const { return arming_; }

protected:
  MailSweep(SweepMutex& mutex, TokenGenerator& tokens, MailArming arming)
      : mutex_(mutex), tokens_(tokens), arming_(std::move(arming)) {}

private:
  // The pieces that vary, in the order the pipeline reaches them.
  virtual std::string name() const = 0;   // the log prefix: "reminders", "journal nudge"
  virtual int batch() const = 0;          // the ceiling on one pass, and so the fleet's send rate
  virtual std::vector<Due> dueNow(std::uint64_t nowMs, int limit) = 0;
  // May throw: a throw costs this user this slot and is counted in `errors`. A product whose ledger
  // wants the slot claimed anyway catches its own load and answers an `unreadable` decision.
  virtual Decision decideFor(const Due& due, std::uint64_t nowMs) = 0;
  virtual SweepVerdict verdictOf(const Decision& decision) const = 0;
  virtual bool claim(const Due& due, const Decision& decision) = 0;
  virtual void close(const Due& due, ClosedAs outcome) = 0;
  // Build the mail and hand it to the product's mailer; `done` fires exactly once with the verdict.
  virtual void send(const Due& due, const Decision& decision, const std::string& pauseSecret,
                    std::function<void(bool)> done) = 0;
  virtual void storePause(const UserId& user, const std::string& digest) = 0;

  // The mailer is asynchronous and answers on its own loop; the sweep is a synchronous pipeline on
  // its own thread, and the row it writes next must record what actually happened. So it waits —
  // and a send that never answers is recorded as a failure, never as a success. The wait is
  // comfortably past the provider client's own 10s timeout, so a real refusal is never lost to ours.
  static constexpr int kSendTimeoutSeconds = 30;
  bool deliver(const Due& due, const Decision& decision, const std::string& pauseSecret) {
    auto settled = std::make_shared<std::promise<bool>>();
    std::future<bool> outcome = settled->get_future();
    send(due, decision, pauseSecret, [settled](bool ok) { settled->set_value(ok); });
    if (outcome.wait_for(std::chrono::seconds(kSendTimeoutSeconds)) != std::future_status::ready)
      return false;
    return outcome.get();
  }

  SweepMutex& mutex_;
  TokenGenerator& tokens_;
  MailArming arming_;
};

}
