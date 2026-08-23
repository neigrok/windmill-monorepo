#include "products/journal/application/EchoDerivations.h"

#include <trantor/utils/Logger.h>

#include <algorithm>
#include <utility>
#include <vector>

namespace wm {

namespace {
// The ticker holds no schedule: it asks the pending map who has gone quiet, so a restart loses at
// most the pages mid-debounce, which the repair pass owes anyway.
constexpr double kDrainTickSeconds = 1.0;
constexpr double kDrainFirstTickSeconds = 1.0;

std::string pageKey(const UserId& user, const LocalDate& day) {
  return user.str() + "|" + day.iso();
}
}

EchoDerivations::EchoDerivations(EchoSweep& sweep, Clock& clock, LiveDerivationRules rules)
    : sweep_(sweep), clock_(clock), rules_(std::move(rules)), heartbeat_("journal-echo-live") {}

void EchoDerivations::start() {
  heartbeat_.start(kDrainFirstTickSeconds, kDrainTickSeconds, [this] {
    const EchoLiveReport report = drain(clock_.nowMs());
    if (report.derived > 0 || report.failed > 0 || report.refused > 0 || report.deferred > 0 ||
        report.queueFull > 0)
      LOG_INFO << "journal echo live: " << report.derived << " derived, " << report.failed
               << " failed, " << report.refused << " refused, " << report.deferred
               << " deferred to the repair pass, " << report.skippedOverBudget << " over AI budget, "
               << report.queueFull << " saves past the queue bound";
  });
  LOG_INFO << "journal echo: live derivations armed, quiet time " << rules_.quietMs << "ms";
}

void EchoDerivations::pageSaved(const UserId& user, const LocalDate& day, std::size_t bodyBytes) {
  const std::uint64_t nowMs = clock_.nowMs();
  const std::string key = pageKey(user, day);
  std::lock_guard<std::mutex> guard{lock_};

  auto entry = pending_.find(key);
  if (entry == pending_.end()) {
    // A NEW page for this account, so the queue bound is asked here and only here. The keys are
    // "user|day" in an ordered map, so an account's entries are one contiguous range.
    const std::string mine = user.str() + "|";
    std::size_t held = 0;
    for (auto it = pending_.lower_bound(mine);
         it != pending_.end() && it->first.compare(0, mine.size(), mine) == 0; ++it) {
      if (++held >= rules_.pendingPerUser) break;
    }
    if (held >= rules_.pendingPerUser) {
      // Not queued and not failed: the page's stamps never moved, so the repair pass still owes it.
      ++queueFull_;
      return;
    }
    pending_.emplace(key, Pending{user, day, bodyBytes, nowMs + rules_.quietMs});
    return;
  }

  // A page that has grown by a paragraph since this entry opened is worth answering about now: an
  // evening of steady writing never goes quiet, and a pure debounce would deliver nothing until the
  // writer stopped for the night.
  const std::size_t grew = bodyBytes > entry->second.openedBytes
                               ? bodyBytes - entry->second.openedBytes
                               : entry->second.openedBytes - bodyBytes;
  entry->second.readyAtMs = grew >= rules_.materialBytes ? nowMs : nowMs + rules_.quietMs;
}

EchoLiveReport EchoDerivations::drain(std::uint64_t nowMs) {
  EchoLiveReport report;

  std::vector<Pending> ready;
  {
    std::lock_guard<std::mutex> guard{lock_};
    for (auto entry = pending_.begin(); entry != pending_.end();) {
      if (entry->second.readyAtMs > nowMs) {
        ++entry;
        continue;
      }
      ready.push_back(entry->second);
      entry = pending_.erase(entry);
    }
    // A page nobody has touched for a day is a page whose cap has nothing left to say about it.
    for (auto entry = spent_.begin(); entry != spent_.end();) {
      if (nowMs - entry->second.windowStartMs >= rules_.dailyWindowMs) entry = spent_.erase(entry);
      else ++entry;
    }
    for (auto entry = userSpent_.begin(); entry != userSpent_.end();) {
      if (nowMs - entry->second.windowStartMs >= rules_.dailyWindowMs)
        entry = userSpent_.erase(entry);
      else ++entry;
    }
    report.queueFull = queueFull_;
    queueFull_ = 0;
  }

  // Round robin across accounts. `ready` comes out of the pending map in key order, which groups an
  // account's pages together, so draining it as it stands puts one account's flood in front of
  // everybody else. Dealt one page per account per round, everybody advances at the same rate.
  std::map<std::string, std::vector<Pending>> byUser;
  for (const Pending& page : ready) byUser[page.user.str()].push_back(page);
  std::vector<Pending> dealt;
  dealt.reserve(ready.size());
  for (std::size_t round = 0; dealt.size() < ready.size(); ++round)
    for (const auto& [user, pages] : byUser)
      if (round < pages.size()) dealt.push_back(pages[round]);

  // Derivation happens with NO lock held: it is seconds long, and a writer's next save has to be
  // able to open a pending entry while the previous one is still with the curator.
  for (const Pending& page : dealt) {
    const std::string key = pageKey(page.user, page.day);
    {
      std::lock_guard<std::mutex> guard{lock_};
      Spent& spent = spent_.try_emplace(key, Spent{0, nowMs}).first->second;
      Spent& mine = userSpent_.try_emplace(page.user.str(), Spent{0, nowMs}).first->second;
      // Two caps, one answer. The page cap stops an afternoon of editing buying the same page over
      // and over; the ACCOUNT cap is the one a flood of invented days meets, and the only one that
      // counts the embedder — the sweep's dollar budget meters the curator.
      if (spent.derivations >= rules_.perPageDaily || mine.derivations >= rules_.perUserDaily) {
        // Not derived and not failed: nothing is written, so the page's stamps do not move and the
        // repair pass still owes it.
        ++report.deferred;
        continue;
      }
    }

    const EchoSweepReport outcome = sweep_.derivePage(page.user, page.day);
    const int answered = outcome.pagesDerived + outcome.pagesFailed + outcome.pagesRefused;
    report.derived += outcome.pagesDerived;
    report.failed += outcome.pagesFailed;
    report.refused += outcome.pagesRefused;
    report.skippedOverBudget += outcome.usersOverAiBudget;
    if (answered == 0 && outcome.usersOverAiBudget == 0) ++report.alreadyDerived;

    // The cap counts what was BOUGHT. An over-budget skip and a page that turned out not to be due
    // both spent nothing. A refusal did not: it was thought about and paid for.
    if (answered == 0) continue;
    std::lock_guard<std::mutex> guard{lock_};
    ++spent_.try_emplace(key, Spent{0, nowMs}).first->second.derivations;
    ++userSpent_.try_emplace(page.user.str(), Spent{0, nowMs}).first->second.derivations;
  }
  return report;
}

}
