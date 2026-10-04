#pragma once

#include "platform/domain/Ids.h"
#include "platform/domain/MailArming.h"
#include "platform/ports/SweepMutex.h"
#include "platform/ports/TokenGenerator.h"
#include "platform/application/WriteObservation.h"

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

// `ran` is false when another sweep held the fleet lock: nothing was looked at.
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

// `unreadable` means the facts could not be loaded: claimed like a skip, counted as an error.
enum class SweepVerdict { send, skip, unreadable };

// Exactly one is recorded for every claim that was a send.
enum class ClosedAs { held, delivered, refused };

// One pass over everyone whose slot has arrived. The write ordering is DECIDE → CLAIM → SEND and
// never any other: the committed claim is the permission slip to perform I/O, and a claimed row is
// never retried.
template <typename Due, typename Decision>
class MailSweep {
public:
  virtual ~MailSweep() = default;

  // `dryRun` rehearses every decision and claims nothing. Blocking: never call from a request
  // thread.
  MailSweepReport run(std::uint64_t nowMs, bool dryRun) {
    WriteObservation observation{operation_, product_, "background"};
    WriteContext context{observation};
    const auto writes = observation.writeCount();
    try {
      MailSweepReport report;
      report.ran = mutex_.underSweepLock([&] {
        for (const Due& due : dueNow(nowMs, batch())) {
          ++report.due;
          WriteObservation slot{operation_ + ".slot", product_, "background"};
          WriteContext slotContext{slot};
          const auto slotWrites = slot.writeCount();
          try {
            const Decision decision = decideFor(due, nowMs);
            const SweepVerdict verdict = verdictOf(decision);
            if (verdict == SweepVerdict::unreadable) ++report.errors;

            if (dryRun) {
              if (verdict == SweepVerdict::send) ++report.wouldSend;
              else ++report.skipped;
              if (verdict == SweepVerdict::unreadable) slot.finish("failed");
              else slot.skip();
              continue;
            }

            // Losing this race means another sweep owns the slot.
            if (!claim(due, decision)) {
              if (slot.writeCount() == slotWrites) slot.skip();
              else slot.finish("already_claimed");
              continue;
            }
            slot.wrote();
            ++report.claimed;
            if (verdict != SweepVerdict::send) {
              ++report.skipped;
              slot.finish(verdict == SweepVerdict::unreadable ? "failed" : "skipped");
              continue;
            }

            // Arming is checked at SEND time, never at decide time, so arming later cannot
            // double-mail a claimed slot.
            if (!arming_.allows(due.user)) {
              close(due, ClosedAs::held);
              ++report.held;
              slot.finish("held");
              continue;
            }

            // Store the fresh pause credential only once its mail left, or a failed send kills the
            // pause link in the last one.
            const MintedToken pause = tokens_.mint();
            const bool delivered = deliver(due, decision, pause.secret);
            if (delivered) storePause(due.user, pause.digest);
            close(due, delivered ? ClosedAs::delivered : ClosedAs::refused);
            if (delivered) ++report.sent;
            else ++report.failed;
            slot.finish(delivered ? "ok" : "provider_refused");
          } catch (const std::exception& error) {
            ++report.errors;
            slot.fail(error);
          } catch (...) {
            ++report.errors;
            slot.failUnknown();
          }
        }
      });
      if (report.errors > 0) observation.finish("failed");
      else if (observation.writeCount() == writes) observation.skip();
      else observation.finish();
      return report;
    } catch (const std::exception& error) {
      observation.fail(error);
      throw;
    } catch (...) {
      observation.failUnknown();
      throw;
    }
  }

  const MailArming& arming() const { return arming_; }

protected:
  MailSweep(SweepMutex& mutex, TokenGenerator& tokens, MailArming arming,
            std::string operation = "mail.sweep", std::string product = "platform")
      : mutex_(mutex), tokens_(tokens), arming_(std::move(arming)),
        operation_(std::move(operation)), product_(std::move(product)) {}

private:
  virtual int batch() const = 0;          // the ceiling on one pass, and so the fleet's send rate
  virtual std::vector<Due> dueNow(std::uint64_t nowMs, int limit) = 0;
  // May throw: costs this user this slot, counted in `errors`.
  virtual Decision decideFor(const Due& due, std::uint64_t nowMs) = 0;
  virtual SweepVerdict verdictOf(const Decision& decision) const = 0;
  virtual bool claim(const Due& due, const Decision& decision) = 0;
  virtual void close(const Due& due, ClosedAs outcome) = 0;
  // Build the mail and hand it to the product's mailer; `done` fires exactly once with the verdict.
  virtual void send(const Due& due, const Decision& decision, const std::string& pauseSecret,
                    std::function<void(bool)> done) = 0;
  virtual void storePause(const UserId& user, const std::string& digest) = 0;

  // Blocks until the mailer answers on its own loop; a send that never answers is a failure. Must
  // stay past the provider client's 10s timeout, or a real refusal is lost to this one.
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
  std::string operation_;
  std::string product_;
};

}
