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

// `ran` is false when another sweep held the fleet lock: nothing was looked at, which is not the
// same as nothing being due.
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

// The three-way split the skeleton acts on; the product keeps its own decision type. `unreadable`
// means the facts could not be loaded: claimed like a skip, and counted as an error.
enum class SweepVerdict { send, skip, unreadable };

// Exactly one is recorded for every claim that was a send, so the ledger can tell a slot withheld
// on purpose from one whose process died between the claim and the mail.
enum class ClosedAs { held, delivered, refused };

// One pass of DECIDE → CLAIM → SEND over everyone whose slot has arrived. What varies per product
// is the pure virtuals below; everything that must not vary is in `run`.
//
// The write ordering is DECIDE → CLAIM → SEND and never any other: the committed claim is the
// permission slip to perform I/O, and a claimed row is never retried.
//
// The heartbeat that drives `run` is the product's own member, not this base's.
template <typename Due, typename Decision>
class MailSweep {
public:
  virtual ~MailSweep() = default;

  // `dryRun` rehearses every decision and claims nothing. Slow and blocking, so a request thread
  // must reach it through the product's own loop rather than inline.
  MailSweepReport run(std::uint64_t nowMs, bool dryRun) {
    MailSweepReport report;
    report.ran = mutex_.underSweepLock([&] {
      for (const Due& due : dueNow(nowMs, batch())) {
        ++report.due;
        // One user's turn is one user's risk; the sweep carries on down the list.
        try {
          const Decision decision = decideFor(due, nowMs);
          const SweepVerdict verdict = verdictOf(decision);
          if (verdict == SweepVerdict::unreadable) ++report.errors;

          // A rehearsal decides everything and commits nothing.
          if (dryRun) {
            if (verdict == SweepVerdict::send) ++report.wouldSend;
            else ++report.skipped;
            continue;
          }

          // The permission slip. Losing this race means another sweep owns the slot.
          if (!claim(due, decision)) continue;
          ++report.claimed;
          // Counted only once the slot is ours: a skip that lost the race is another sweep's row.
          if (verdict != SweepVerdict::send) {
            ++report.skipped;
            continue;
          }

          // Armed at SEND time, never at decide time, so the ledger keeps an honest slot and arming
          // later cannot double-mail it. Closed as `held` so the row is not read as a crash.
          if (!arming_.allows(due.user)) {
            close(due, ClosedAs::held);
            ++report.held;
            continue;
          }

          // Store the fresh pause credential only once its mail actually left, or a failed send
          // kills the pause link still sitting in the last one.
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
    });
    return report;
  }

  const MailArming& arming() const { return arming_; }

protected:
  MailSweep(SweepMutex& mutex, TokenGenerator& tokens, MailArming arming)
      : mutex_(mutex), tokens_(tokens), arming_(std::move(arming)) {}

private:
  virtual std::string name() const = 0;   // the log prefix: "reminders", "journal nudge"
  virtual int batch() const = 0;          // the ceiling on one pass, and so the fleet's send rate
  virtual std::vector<Due> dueNow(std::uint64_t nowMs, int limit) = 0;
  // May throw: a throw costs this user this slot and is counted in `errors`.
  virtual Decision decideFor(const Due& due, std::uint64_t nowMs) = 0;
  virtual SweepVerdict verdictOf(const Decision& decision) const = 0;
  virtual bool claim(const Due& due, const Decision& decision) = 0;
  virtual void close(const Due& due, ClosedAs outcome) = 0;
  // Build the mail and hand it to the product's mailer; `done` fires exactly once with the verdict.
  virtual void send(const Due& due, const Decision& decision, const std::string& pauseSecret,
                    std::function<void(bool)> done) = 0;
  virtual void storePause(const UserId& user, const std::string& digest) = 0;

  // The mailer answers on its own loop and the sweep must record what actually happened, so it
  // waits; a send that never answers is recorded as a failure. Past the provider client's own
  // 10s timeout, so a real refusal is never lost to this one.
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
