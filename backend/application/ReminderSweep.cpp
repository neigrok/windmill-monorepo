#include "application/ReminderSweep.h"

#include <trantor/utils/Logger.h>

#include <chrono>
#include <exception>
#include <future>
#include <memory>
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
// The mailer answers on its own loop; this is how long the sweep waits for that answer before
// calling the send unconfirmed. Comfortably past the provider client's own 10s timeout.
constexpr int kSendTimeoutSeconds = 30;

// The fleet-wide work lock as a scope. Correctness does not depend on it — the committed claim
// does — so a lock that is already held simply means someone else is doing this work.
struct SweepLock {
  explicit SweepLock(ReminderRepository& reminders)
      : reminders(reminders), held(reminders.tryLockSweep()) {}
  ~SweepLock() {
    if (!held) return;
    // A destructor is noexcept, and handing the lock back reaches the database — which is exactly
    // the thing most likely to have just died. Letting that throw would take the process with it;
    // a lock left held is released by the server the moment the connection drops anyway.
    try {
      reminders.unlockSweep();
    } catch (...) {
      LOG_ERROR << "reminders: the sweep lock could not be handed back";
    }
  }

  ReminderRepository& reminders;
  bool held;
};
}

ReminderSweep::ReminderSweep(ReminderRepository& reminders, EmailSender& email,
                             TokenGenerator& tokens, Clock& clock, ReminderArming arming,
                             std::string appBaseUrl)
    : reminders_(reminders), email_(email), tokens_(tokens), clock_(clock),
      arming_(std::move(arming)), appBaseUrl_(std::move(appBaseUrl)), ticker_("reminder-ticker") {
  // The loop runs from construction, not from start(): an admin sweep is queued onto it whether
  // or not the heartbeat was ever armed, and a loop nobody spun would swallow that work in
  // silence. Same idiom as the Resend sender's private loop.
  ticker_.run();
}

void ReminderSweep::start() {
  std::random_device entropy;
  const double firstTick = kFirstTickFloorSeconds + entropy() % kFirstTickJitterSeconds;
  ticker_.getLoop()->runAfter(firstTick, [this] {
    tick();
    ticker_.getLoop()->runEvery(kTickSeconds, [this] { tick(); });
  });
  LOG_INFO << "reminders: heartbeat armed, first sweep in " << firstTick << "s ("
           << (arming_.enabled ? "enabled" : "dark") << ", " << arming_.allowlist.size()
           << " on the allowlist)";
}

// The crash guard. Whatever a sweep runs into — a dropped connection, a tree nobody can parse —
// the heartbeat must survive to sweep again in fifteen minutes.
void ReminderSweep::tick() {
  try {
    const SweepReport report = run(clock_.nowMs(), false);
    if (report.due > 0)
      LOG_INFO << "reminders: swept " << report.due << " due, " << report.sent << " sent, "
               << report.held << " held, " << report.skipped << " skipped, " << report.failed
               << " failed, " << report.errors << " errored";
  } catch (const std::exception& error) {
    LOG_ERROR << "reminder sweep failed: " << error.what();
  } catch (...) {
    LOG_ERROR << "reminder sweep failed";
  }
}

SweepReport ReminderSweep::run(std::uint64_t nowMs, bool dryRun) {
  SweepReport report;
  SweepLock lock(reminders_);
  if (!lock.held) return report;  // another process is already doing exactly this work
  report.ran = true;

  for (const DueUser& due : reminders_.dueNow(nowMs, kSweepBatch)) {
    ++report.due;
    // One user's turn is one user's risk: an unreadable tree or a lost row costs that person
    // this week's reminder and nothing more. The sweep carries on down the list.
    try {
      const ReminderDecision decision = decideFor(due, nowMs);
      if (decision.reason == SkipReason::loadFailed) ++report.errors;

      // A rehearsal decides everything and commits nothing. It reports what WOULD have gone out
      // separately from what the arming gate withholds on a real run — two different facts that
      // shared one counter and told the operator neither.
      if (dryRun) {
        if (decision.outcome == ReminderOutcome::send) ++report.wouldSend;
        else ++report.skipped;
        continue;
      }

      // The permission slip. Losing this race means another sweep owns the week; its pointer
      // moved too, so falling silent here is the whole of the correct response.
      if (!reminders_.claimWeek(due.user, due.slotDate, decision)) continue;
      ++report.claimed;
      // Counted only once the week is ours: a skip that lost the race belongs to another sweep's
      // row, and reporting it here would name a decision the ledger never took.
      if (decision.outcome == ReminderOutcome::skip) {
        ++report.skipped;
        continue;
      }

      // Armed at SEND time, never at decide time — so a dark launch still leaves an honest week
      // in the ledger saying what we would have sent, and arming later cannot double-mail it. The
      // week is closed as `held` so that row can never be mistaken for a crash between claim and
      // send, which is what every row would look like for the whole of a dark rollout.
      if (!arming_.allows(due.user)) {
        reminders_.closeWeek(due.user, due.slotDate, WeekOutcome::held);
        ++report.held;
        continue;
      }

      // A fresh pause credential per mail, stored only once the mail carrying it actually left:
      // rotating first would kill last week's still-in-an-inbox pause link on behalf of a
      // replacement that never arrived.
      const MintedToken pause = tokens_.mint();
      const bool delivered = deliver(due.email, mailFor(decision.content, pause.secret));
      if (delivered) reminders_.setPauseDigest(due.user, pause.digest);
      reminders_.closeWeek(due.user, due.slotDate,
                           delivered ? WeekOutcome::delivered : WeekOutcome::refused);
      if (delivered) ++report.sent;
      else ++report.failed;
    } catch (const std::exception& error) {
      ++report.errors;
      LOG_ERROR << "reminders: " << due.user.str() << " skipped this week: " << error.what();
    } catch (...) {
      ++report.errors;
      LOG_ERROR << "reminders: " << due.user.str() << " skipped this week";
    }
  }
  return report;
}

void ReminderSweep::runAsync(std::uint64_t nowMs, bool dryRun,
                             std::function<void(SweepReport)> done) {
  ticker_.getLoop()->queueInLoop([this, nowMs, dryRun, done = std::move(done)] {
    // The caller is waiting on a promise it cannot fulfil itself, so `done` fires on every path —
    // an empty report reads as "nothing ran", which is exactly what happened.
    try {
      done(run(nowMs, dryRun));
    } catch (const std::exception& error) {
      LOG_ERROR << "reminder sweep failed: " << error.what();
      done(SweepReport{});
    } catch (...) {
      LOG_ERROR << "reminder sweep failed";
      done(SweepReport{});
    }
  });
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

ReminderMail ReminderSweep::mailFor(const ReminderContent& content,
                                    const std::string& pauseSecret) const {
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
  return mail;
}

// The mailer is asynchronous and answers on its own loop; the sweep is a synchronous pipeline on
// its own thread, and the row it writes next must record what actually happened. So it waits —
// and a send that never answers is recorded as a failure, never as a success.
bool ReminderSweep::deliver(const Email& to, const ReminderMail& mail) {
  auto settled = std::make_shared<std::promise<bool>>();
  std::future<bool> outcome = settled->get_future();
  email_.sendReminder(to, mail, [settled](bool ok) { settled->set_value(ok); });
  if (outcome.wait_for(std::chrono::seconds(kSendTimeoutSeconds)) != std::future_status::ready)
    return false;
  return outcome.get();
}

}
