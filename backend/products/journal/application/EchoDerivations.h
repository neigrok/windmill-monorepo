#pragma once

#include "platform/application/Heartbeat.h"
#include "platform/ports/Clock.h"
#include "products/journal/application/EchoSweep.h"
#include "products/journal/application/PageService.h"

#include <cstddef>
#include <cstdint>
#include <map>
#include <mutex>
#include <string>

namespace wm {

// When a saved page is derived, and how often it is allowed to be.
struct LiveDerivationRules {
  // Quiet time. Someone writing a paragraph saves every few seconds, and deriving on each would buy
  // the same page eight times and answer about a version already replaced.
  std::uint64_t quietMs = 8'000;

  // ...unless enough new text arrived to be worth answering about on its own — roughly a paragraph.
  std::size_t materialBytes = 400;

  // What one page may cost in one rolling day. Past it the page is not derived and not failed — it
  // is left owed, and the repair pass takes it.
  int perPageDaily = 4;
  std::uint64_t dailyWindowMs = 24ull * 60 * 60 * 1000;

  // What one account may hold in the queue at once. The queue is keyed by (user, day) and every
  // date is a valid page, so without this one account can own the single drain thread. Past it a
  // save is not queued at all; the repair pass owes that page either way.
  std::size_t pendingPerUser = 5;

  // ...and what one account may BUY in a rolling day, counted per USER rather than per page: the
  // per-page cap never bounded an account, because a flood of distinct days pays the embedder's CPU
  // on every one of them before `sweepAllowanceFor` meters the curator's dollars.
  int perUserDaily = 40;
};

// What one drain did. `deferred` is not an error — it is the cap handing work to the repair pass.
struct EchoLiveReport {
  int derived = 0;
  int failed = 0;
  // The vendor declined to judge the page. Counted apart from `failed` because a failure comes back
  // and this does not, and charged to the daily cap all the same.
  int refused = 0;
  int deferred = 0;
  int skippedOverBudget = 0;
  int alreadyDerived = 0;
  // Saves that never entered the queue because their account already held `pendingPerUser` pages.
  int queueFull = 0;
};

// The delivery path's scheduler: it turns saves into derivations. PageService tells it a page was
// saved, and seconds later the page is derived on this object's own thread.
//
// It is also the fairness seam, being the only place that sees every account's saves at once. One
// drain thread walks the queue, so whatever the queue holds is what everybody else waits behind:
// the two bounds in LiveDerivationRules cap what one account may hold and buy, and the drain deals
// round-robin across accounts rather than walking the queue as it lies.
//
// It must never derive on the request thread — drogon has one handler thread per core and a curator
// call is seconds long — so `pageSaved` does map bookkeeping under a short mutex and returns. And
// it must never make the writer wait: there is no pending state, no progress route and no spinner.
class EchoDerivations : public PageWatcher {
public:
  EchoDerivations(EchoSweep& sweep, Clock& clock, LiveDerivationRules rules);

  void start();

  // A page was saved. Coalescing lives here: the first save opens a pending entry and every save
  // after it pushes the entry's ready instant out again, unless the text has grown by
  // `materialBytes` since the entry opened, which makes it ready now.
  void pageSaved(const UserId& user, const LocalDate& day, std::size_t bodyBytes) override;

  // Derive everything that has gone quiet. Takes its own `now` so the policy is testable without a
  // thread; the heartbeat below is one caller and a test with a fake clock is another.
  EchoLiveReport drain(std::uint64_t nowMs);

private:
  // A page waiting for its writer to stop. `openedBytes` is the size at the save that opened this
  // entry — the size the last derivation saw — so the distance from it is genuinely new material.
  struct Pending {
    UserId user;
    LocalDate day;
    std::size_t openedBytes = 0;
    std::uint64_t readyAtMs = 0;
  };

  // One page's spend inside a rolling day. The window opens at the first derivation rather than at
  // midnight, so it never has to name a timezone.
  struct Spent {
    int derivations = 0;
    std::uint64_t windowStartMs = 0;
  };

  EchoSweep& sweep_;
  Clock& clock_;
  LiveDerivationRules rules_;
  std::mutex lock_;
  // Keyed "user|day" and therefore ORDERED BY USER: the entries one account holds are one
  // contiguous range.
  std::map<std::string, Pending> pending_;
  std::map<std::string, Spent> spent_;       // per page
  std::map<std::string, Spent> userSpent_;   // per account — the one the flood meets
  int queueFull_ = 0;
  Heartbeat heartbeat_;   // declared last: destructs first, before the deps a running drain holds
};

}
