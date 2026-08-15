#include "products/roadmap/application/ReminderSweep.h"

#include <trantor/utils/Logger.h>

#include <exception>
#include <random>
#include <utility>

namespace wm {

namespace {
// A quarter hour. Small enough that a slot is served close to its local time, large enough that
// the sweep is a rounding error on the database.
constexpr double kTickSeconds = 900.0;
// The first tick's window past boot. Jittered so a crash-looping process cannot hammer the
// sweep, and early enough that a deploy during someone's slot still serves it.
constexpr int kFirstTickFloorSeconds = 30;
constexpr int kFirstTickJitterSeconds = 30;
}

ReminderSweep::ReminderSweep(ReminderRepository& reminders, ReminderMailSender& mail,
                             TokenGenerator& tokens, Clock& clock, MailArming arming,
                             std::string appBaseUrl)
    : MailSweep(reminders, tokens, std::move(arming)), reminders_(reminders), mail_(mail),
      clock_(clock), appBaseUrl_(std::move(appBaseUrl)), heartbeat_("reminder") {}

void ReminderSweep::start() {
  std::random_device entropy;
  const double firstTick = kFirstTickFloorSeconds + entropy() % kFirstTickJitterSeconds;
  heartbeat_.start(firstTick, kTickSeconds, [this] {
    const MailSweepReport report = run(clock_.nowMs(), false);
    if (report.due > 0)
      LOG_INFO << "reminders: swept " << report.due << " due, " << report.sent << " sent, "
               << report.held << " held, " << report.skipped << " skipped, " << report.failed
               << " failed, " << report.errors << " errored";
  });
  LOG_INFO << "reminders: heartbeat armed, first sweep in " << firstTick << "s ("
           << (arming().enabled ? "enabled" : "dark") << ", " << arming().allowlist.size()
           << " on the allowlist)";
}

void ReminderSweep::runAsync(std::uint64_t nowMs, bool dryRun,
                             std::function<void(MailSweepReport)> done) {
  heartbeat_.queue([this, nowMs, dryRun, done = std::move(done)] {
    // The caller is waiting on a promise it cannot fulfil itself, so `done` fires on every path —
    // an empty report reads as "nothing ran", which is exactly what happened.
    try {
      done(run(nowMs, dryRun));
    } catch (const std::exception& error) {
      LOG_ERROR << "reminder sweep failed: " << error.what();
      done(MailSweepReport{});
    } catch (...) {
      LOG_ERROR << "reminder sweep failed";
      done(MailSweepReport{});
    }
  });
}

std::vector<DueUser> ReminderSweep::dueNow(std::uint64_t nowMs, int limit) {
  return reminders_.dueNow(nowMs, limit);
}

ReminderDecision ReminderSweep::decideFor(const DueUser& due, std::uint64_t nowMs) {
  try {
    ReminderCandidate candidate;
    candidate.user = due.user;
    candidate.slotDate = due.slotDate;
    candidate.slotInstantMs = due.slotInstantMs;
    candidate.lastActiveAtMs = reminders_.lastActiveAtMs(due.user);
    candidate.accountCreatedAtMs = reminders_.accountCreatedAtMs(due.user);
    candidate.trees = reminders_.readinessFor(due.user);
    return decide(candidate, nowMs);
  } catch (const std::exception& error) {
    LOG_ERROR << "reminders: " << due.user.str() << " could not be read: " << error.what();
    return ReminderDecision{ReminderOutcome::skip, SkipReason::loadFailed, {}};
  } catch (...) {
    LOG_ERROR << "reminders: " << due.user.str() << " could not be read";
    return ReminderDecision{ReminderOutcome::skip, SkipReason::loadFailed, {}};
  }
}

SweepVerdict ReminderSweep::verdictOf(const ReminderDecision& decision) const {
  if (decision.outcome == ReminderOutcome::send) return SweepVerdict::send;
  if (decision.reason == SkipReason::loadFailed) return SweepVerdict::unreadable;
  return SweepVerdict::skip;
}

bool ReminderSweep::claim(const DueUser& due, const ReminderDecision& decision) {
  return reminders_.claimWeek(due.user, due.slotDate, decision);
}

void ReminderSweep::close(const DueUser& due, ClosedAs outcome) {
  const WeekOutcome week = outcome == ClosedAs::held        ? WeekOutcome::held
                           : outcome == ClosedAs::delivered ? WeekOutcome::delivered
                                                            : WeekOutcome::refused;
  reminders_.closeWeek(due.user, due.slotDate, week);
}

void ReminderSweep::send(const DueUser& due, const ReminderDecision& decision,
                         const std::string& pauseSecret, std::function<void(bool)> done) {
  const ReminderContent& content = decision.content;
  ReminderMail mail;
  mail.treeName = content.treeTitle;  // the sender sheds markup, exactly as it does for a fork link
  // The OWNER's own tree at #/app/:id — NOT the public /t/:id share page. A reminder goes to
  // the person whose tree it is, and dropping them on the read-only share view of their own
  // plan would be a strange door to open from "your steps are ready".
  mail.treeUrl = appBaseUrl_ + "/#/app/" + content.treeId.str();
  mail.settingsUrl = appBaseUrl_ + "/#/settings";  // the app is hash-routed; a bare /settings is a 404
  // The token rides in the FRAGMENT, so the secret never reaches OUR logs, and the page it lands
  // on pauses only from a button the reader presses — a bare GET must never pause anyone, because
  // corporate link scanners and Outlook prefetch every URL in an email.
  mail.pauseUrl = appBaseUrl_ + "/pause.html#t=" + pauseSecret;
  // The same secret, but the one-click machine door: a mail client POSTs this itself, so it cannot
  // ride a fragment (a fragment never reaches a server) — it goes in the query of a real endpoint,
  // registered POST-only so a scanner's GET can never unsubscribe anyone. Gmail and Yahoo require a
  // List-Unsubscribe one-click on bulk mail, so a reminder that lacks it lands in spam.
  mail.unsubscribeUrl = appBaseUrl_ + "/v1/reminders/unsubscribe?t=" + pauseSecret;
  mail.done = content.done;
  mail.total = content.total;
  mail.readyPhrase = readyPhrase(content.readyCount);
  mail.moreOnTree = remainderPhrase(content.readyCount);
  mail.moreReady = otherTreesPhrase(content.otherReadyTrees);
  // decide() never names more than kMaxSteps and the mail has exactly that many slots, so this
  // is a plain copy rather than a bound the two sides have to agree on separately.
  for (std::size_t slot = 0; slot < content.steps.size(); ++slot) {
    mail.steps[slot].label = content.steps[slot].label;
    mail.steps[slot].colorHex = nodeColorHex(content.steps[slot].color);
  }
  mail_.sendReminder(due.email, mail, std::move(done));
}

void ReminderSweep::storePause(const UserId& user, const std::string& digest) {
  reminders_.setPauseDigest(user, digest);
}

}
