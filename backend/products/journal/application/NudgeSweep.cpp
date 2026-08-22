#include "products/journal/application/NudgeSweep.h"

#include <trantor/utils/Logger.h>

#include <exception>
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
// The ceiling on one sweep, and so also the fleet's per-tick send rate.
constexpr int kNudgeSweepBatch = 200;
}

NudgeSweep::NudgeSweep(NudgeRepository& nudges, NudgeMailSender& mail, TokenGenerator& tokens,
                       Clock& clock, MailArming arming, std::string appBaseUrl)
    : MailSweep(nudges, tokens, std::move(arming)), nudges_(nudges), mail_(mail), clock_(clock),
      appBaseUrl_(std::move(appBaseUrl)), heartbeat_("journal-nudge") {}

void NudgeSweep::start() {
  heartbeat_.start(kFirstTickSeconds, kTickSeconds, [this] {
    const MailSweepReport report = run(clock_.nowMs(), false);
    if (report.sent > 0 || report.held > 0 || report.failed > 0 || report.errors > 0)
      LOG_INFO << "journal nudge: swept " << report.sent << " sent, " << report.held << " held, "
               << report.skipped << " skipped, " << report.failed << " failed, " << report.errors
               << " errored";
  });
  LOG_INFO << "journal nudge: heartbeat armed, first sweep in " << kFirstTickSeconds << "s ("
           << (arming().enabled ? "enabled" : "dark") << ", " << arming().allowlist.size()
           << " on the allowlist)";
}

void NudgeSweep::runAsync(std::uint64_t nowMs, bool dryRun,
                          std::function<void(MailSweepReport)> done) {
  heartbeat_.queue([this, nowMs, dryRun, done = std::move(done)] {
    // The caller is waiting on a promise it cannot fulfil itself, so `done` fires on every path —
    // an empty report reads as "nothing ran", which is exactly what happened.
    try {
      done(run(nowMs, dryRun));
    } catch (const std::exception& error) {
      LOG_ERROR << "journal nudge sweep failed: " << error.what();
      done(MailSweepReport{});
    } catch (...) {
      LOG_ERROR << "journal nudge sweep failed";
      done(MailSweepReport{});
    }
  });
}

int NudgeSweep::batch() const { return kNudgeSweepBatch; }

std::vector<NudgeDueUser> NudgeSweep::dueNow(std::uint64_t nowMs, int limit) {
  return nudges_.dueNow(nowMs, limit);
}

NudgeDecision NudgeSweep::decideFor(const NudgeDueUser& due, std::uint64_t nowMs) {
  return decide(NudgeCandidate{due.user, due.slotDay, due.slotInstantMs, nowMs,
                               nudges_.wroteToday(due.user, due.slotDay), due.pausedUntilMs > nowMs});
}

SweepVerdict NudgeSweep::verdictOf(const NudgeDecision& decision) const {
  return decision.outcome == NudgeOutcome::send ? SweepVerdict::send : SweepVerdict::skip;
}

bool NudgeSweep::claim(const NudgeDueUser& due, const NudgeDecision& decision) {
  return nudges_.claimDay(due.user, due.slotDay, decision);
}

void NudgeSweep::close(const NudgeDueUser& due, ClosedAs outcome) {
  const DayOutcome day = outcome == ClosedAs::held        ? DayOutcome::held
                         : outcome == ClosedAs::delivered ? DayOutcome::delivered
                                                          : DayOutcome::refused;
  nudges_.closeDay(due.user, due.slotDay, day);
}

void NudgeSweep::send(const NudgeDueUser& due, const NudgeDecision&, const std::string& pauseSecret,
                      std::function<void(bool)> done) {
  JournalNudgeMail mail;
  // The hash-routed nudge panel; the pause page reached from a body link (a human GET); and the
  // RFC 8058 one-click endpoint a mail client POSTs (a bare endpoint, so its secret rides the
  // query, not a fragment).
  mail.settingsUrl = appBaseUrl_ + "/#/settings/nudges";
  mail.pauseUrl = appBaseUrl_ + "/journal/nudge/pause?t=" + pauseSecret;
  mail.unsubscribeUrl = appBaseUrl_ + "/v1/journal/nudge/unsubscribe?t=" + pauseSecret;
  mail_.sendJournalNudge(due.email, mail, std::move(done));
}

void NudgeSweep::storePause(const UserId& user, const std::string& digest) {
  nudges_.setPauseDigest(user, digest);
}

}
