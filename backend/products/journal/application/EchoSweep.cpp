#include "products/journal/application/EchoSweep.h"

#include <trantor/utils/Logger.h>

#include <exception>
#include <optional>
#include <utility>
#include <vector>

namespace wm {

namespace {
// A nightly-ish cadence: the reading-across is a slow, once-a-day kindness, not a live feature, so
// the ticker fires every six hours and each pass looks a day back — an overnight gap between passes
// still re-reads every page that changed. Prefixed `echo` to stay journal-unique in namespace wm.
constexpr double kEchoTickSeconds = 6.0 * 60.0 * 60.0;
constexpr double kEchoFirstTickSeconds = 60.0;
constexpr std::uint64_t kEchoLookbackMs = 24ull * 60 * 60 * 1000;
}

EchoSweep::EchoSweep(EchoRepository& echoes, Embedder& embedder, Entitlements& entitlements,
                     Clock& clock, EchoRules rules)
    : echoes_(echoes), embedder_(embedder), entitlements_(entitlements), clock_(clock),
      rules_(std::move(rules)), ticker_("journal-echo-ticker") {
  // The loop runs from construction, same idiom as the reminder and nudge tickers: an operator pass
  // may be driven onto it before the heartbeat is ever armed, and a loop nobody spun would swallow it.
  ticker_.run();
}

void EchoSweep::start() {
  ticker_.getLoop()->runAfter(kEchoFirstTickSeconds, [this] {
    tick();
    ticker_.getLoop()->runEvery(kEchoTickSeconds, [this] { tick(); });
  });
  LOG_INFO << "journal echo: heartbeat armed, first sweep in " << kEchoFirstTickSeconds << "s ("
           << (embedder_.configured() ? "embedder configured" : "no embedder — dark") << ")";
}

// The crash guard: whatever one sweep runs into, the heartbeat must survive to sweep again.
void EchoSweep::tick() {
  try {
    const std::uint64_t now = clock_.nowMs();
    const EchoSweepReport report = run(now, now - kEchoLookbackMs);
    if (report.echoesFound > 0 || report.vectorsComputed > 0)
      LOG_INFO << "journal echo: swept " << report.usersScanned << " users, "
               << report.vectorsComputed << " vectors, " << report.echoesFound << " echoes, "
               << report.skippedNotSubscribed << " not subscribed";
  } catch (const std::exception& error) {
    LOG_ERROR << "journal echo sweep failed: " << error.what();
  } catch (...) {
    LOG_ERROR << "journal echo sweep failed";
  }
}

EchoSweepReport EchoSweep::run(std::uint64_t nowMs, std::uint64_t sinceMs) {
  (void)nowMs;   // the whole pass is scoped by sinceMs; nowMs rides the signature for a future window
  EchoSweepReport report;
  // A missing embedder is a quiet no-op, exactly like PlanComposer behind paste-import: the paid
  // pass simply does not run rather than erroring, and no user is ever scanned.
  if (!embedder_.configured()) return report;

  for (const EchoUser& due : echoes_.activeSince(sinceMs)) {
    ++report.usersScanned;
    const UserId& user = due.user;

    // The gate is "do we COMPUTE", not "do we show": a non-subscriber's echo table simply stays
    // empty, so the read endpoint returns absent rather than a locked state. Same entitlement seam
    // as the tending allowance and Talk — one Windmill One rule, asked once.
    if (!entitlements_.hasWindmillOne(user, due.email.value)) {
      ++report.skippedNotSubscribed;
      continue;
    }

    // Embed any page whose stored vector is missing or stale before reading across — the corpus is
    // only ever as good as the vectors in it.
    for (const PageText& page : echoes_.pagesNeedingVector(user)) {
      echoes_.saveVector(user, page.day, embedder_.embed(page.body), page.stampMs);
      ++report.vectorsComputed;
    }

    // Load the fresh corpus once, then ask the pure finder about each recently-changed day.
    const std::vector<EchoCandidate> corpus = echoes_.corpusOf(user);
    for (const LocalDate& triggerDay : echoes_.triggersSince(user, sinceMs)) {
      const EchoCandidate* trigger = nullptr;
      for (const EchoCandidate& candidate : corpus)
        if (candidate.day == triggerDay) {
          trigger = &candidate;
          break;
        }
      if (!trigger) continue;   // a day with no vector yet is read on the next pass, not this one

      const std::optional<EchoMatch> found = match(*trigger, corpus, rules_);
      if (found) {
        echoes_.saveEcho(user, triggerDay, *found);
        ++report.echoesFound;
      }
    }
  }
  return report;
}

}
