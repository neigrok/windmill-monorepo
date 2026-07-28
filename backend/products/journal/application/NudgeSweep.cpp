#include "products/journal/application/NudgeSweep.h"

#include <trantor/utils/Logger.h>

#include <chrono>
#include <exception>
#include <future>
#include <memory>
#include <utility>

namespace wm {

namespace {
// A quarter hour: close enough to a device's chosen instant, small enough to be a rounding error
// on the database.
constexpr double kTickSeconds = 900.0;
// The first tick's window past boot. A fixed offset inside the 30–60s band rather than a drawn
// jitter — a crash-looping process still cannot hammer the sweep, and the heartbeat stays a pure
// function of (now, database) with no entropy in the path.
constexpr double kFirstTickSeconds = 45.0;
// How long the sweep waits for the mailer's answer before recording the send unconfirmed —
// comfortably past the provider client's own timeout, so a real refusal is never lost to ours.
constexpr int kSendTimeoutSeconds = 30;
// The ceiling on one sweep, and so also the fleet's per-tick send rate. Named distinctly from
// roadmap's kSweepBatch: the composition root (main.cpp) includes both sweeps, so the two caps
// share a translation unit even though this one no longer pulls Reminders.h.
constexpr int kNudgeSweepBatch = 200;

// The fleet-wide work lock as a scope. Correctness rides on the committed claim, never on this —
// a lock already held simply means another process is doing exactly this work.
struct SweepLock {
  explicit SweepLock(NudgeRepository& nudges) : nudges(nudges), held(nudges.tryLockSweep()) {}
  ~SweepLock() {
    if (!held) return;
    // A destructor is noexcept and handing the lock back reaches the database — the thing most
    // likely to have just died. A lock left held is dropped by the server when the connection does.
    try {
      nudges.unlockSweep();
    } catch (...) {
      LOG_ERROR << "journal nudge: the sweep lock could not be handed back";
    }
  }

  NudgeRepository& nudges;
  bool held;
};
}

NudgeSweep::NudgeSweep(NudgeRepository& nudges, NudgeMailSender& mail, TokenGenerator& tokens,
                       Clock& clock, NudgeArming arming, std::string appBaseUrl)
    : nudges_(nudges), mail_(mail), tokens_(tokens), clock_(clock), arming_(std::move(arming)),
      appBaseUrl_(std::move(appBaseUrl)), ticker_("journal-nudge-ticker") {
  // The loop runs from construction, not from start(): the same idiom as the reminder ticker, so a
  // loop nobody armed still exists to be queued onto.
  ticker_.run();
}

void NudgeSweep::start() {
  ticker_.getLoop()->runAfter(kFirstTickSeconds, [this] {
    tick();
    ticker_.getLoop()->runEvery(kTickSeconds, [this] { tick(); });
  });
  LOG_INFO << "journal nudge: heartbeat armed, first sweep in " << kFirstTickSeconds << "s ("
           << (arming_.enabled ? "enabled" : "dark") << ", " << arming_.allowlist.size()
           << " on the allowlist)";
}

// The crash guard: whatever one sweep runs into, the heartbeat must survive to sweep again.
void NudgeSweep::tick() {
  try {
    const NudgeSweepReport report = run(clock_.nowMs(), false);
    if (report.sent > 0 || report.held > 0 || report.failed > 0)
      LOG_INFO << "journal nudge: swept " << report.sent << " sent, " << report.held << " held, "
               << report.skipped << " skipped, " << report.failed << " failed";
  } catch (const std::exception& error) {
    LOG_ERROR << "journal nudge sweep failed: " << error.what();
  } catch (...) {
    LOG_ERROR << "journal nudge sweep failed";
  }
}

NudgeSweepReport NudgeSweep::run(std::uint64_t nowMs, bool dryRun) {
  NudgeSweepReport report;
  SweepLock lock(nudges_);
  if (!lock.held) return report;  // another process is already doing exactly this work

  for (const NudgeDueUser& due : nudges_.dueNow(nowMs, kNudgeSweepBatch)) {
    const NudgeDecision decision = decide(candidateFor(due, nowMs));

    // A rehearsal decides everything and commits nothing. There is no separate wouldSend column, so
    // a would-be send is folded into `sent` and a skip into `skipped` — the picture a real run
    // would paint, without a single write.
    if (dryRun) {
      if (decision.outcome == NudgeOutcome::send) ++report.sent;
      else ++report.skipped;
      continue;
    }

    // The permission slip. Losing this race means another sweep owns the day; its pointer moved too,
    // so falling silent here is the whole of the correct response.
    if (!nudges_.claimDay(due.user, due.slotDay, decision)) continue;
    // Counted only once the day is ours: a skip that lost the race belongs to another sweep's row.
    if (decision.outcome == NudgeOutcome::skip) {
      ++report.skipped;
      continue;
    }
    // Armed at SEND time, never at decide time — so a dark launch still leaves an honest, claimed
    // day in the ledger, closed `held` so it can never be mistaken for a crash between claim and
    // send.
    if (!arming_.allows(due.user)) {
      nudges_.closeDay(due.user, due.slotDay, DayOutcome::held);
      ++report.held;
      continue;
    }

    // A fresh pause credential per mail, stored only once the mail carrying it actually left:
    // rotating first would kill a still-in-an-inbox pause link on behalf of a send that never went.
    const MintedToken pause = tokens_.mint();
    const bool delivered = deliver(due, pause.secret);
    if (delivered) nudges_.setPauseDigest(due.user, pause.digest);
    nudges_.closeDay(due.user, due.slotDay,
                     delivered ? DayOutcome::delivered : DayOutcome::refused);
    if (delivered) ++report.sent;
    else ++report.failed;
  }
  return report;
}

NudgeCandidate NudgeSweep::candidateFor(const NudgeDueUser& due, std::uint64_t nowMs) const {
  return NudgeCandidate{due.user, due.slotDay, due.slotInstantMs, nowMs,
                        nudges_.wroteToday(due.user, due.slotDay), due.pausedUntilMs > nowMs};
}

// The mailer is asynchronous and answers on its own loop; the sweep is synchronous on its own
// thread and the row it writes next must record what actually happened. So it waits — and a send
// that never answers is recorded as a failure, never as a success.
bool NudgeSweep::deliver(const NudgeDueUser& due, const std::string& pauseSecret) {
  JournalNudgeMail mail;
  // The hash-routed nudge panel; the pause page reached from a body link (a human GET); and the
  // RFC 8058 one-click endpoint a mail client POSTs (a bare endpoint, so its secret rides the
  // query, not a fragment).
  mail.settingsUrl = appBaseUrl_ + "/#/settings/nudges";
  mail.pauseUrl = appBaseUrl_ + "/journal/nudge/pause?t=" + pauseSecret;
  mail.unsubscribeUrl = appBaseUrl_ + "/v1/journal/nudge/unsubscribe?t=" + pauseSecret;

  auto settled = std::make_shared<std::promise<bool>>();
  std::future<bool> outcome = settled->get_future();
  mail_.sendJournalNudge(due.email, mail, [settled](bool ok) { settled->set_value(ok); });
  if (outcome.wait_for(std::chrono::seconds(kSendTimeoutSeconds)) != std::future_status::ready)
    return false;
  return outcome.get();
}

}
