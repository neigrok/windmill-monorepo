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
  // Quiet time before a saved page is derived.
  std::uint64_t quietMs = 8'000;

  // ...unless this much new text arrived, which makes the page ready now.
  std::size_t materialBytes = 400;

  // What one page may cost in one rolling day. Past it the page is left owed for the repair pass.
  int perPageDaily = 4;
  std::uint64_t dailyWindowMs = 24ull * 60 * 60 * 1000;

  // What one account may hold in the queue at once. Past it a save is not queued at all; the repair
  // pass owes that page either way.
  std::size_t pendingPerUser = 5;

  // ...and what one account may buy in a rolling day, counted per user rather than per page.
  int perUserDaily = 40;
};

// `deferred` is not an error: it is the cap handing work to the repair pass.
struct EchoLiveReport {
  int derived = 0;
  int failed = 0;
  // The vendor declined to judge the page: it does not come back, and is charged to the daily cap.
  int refused = 0;
  int deferred = 0;
  int skippedOverBudget = 0;
  int alreadyDerived = 0;
  // Saves that never entered the queue because their account already held `pendingPerUser` pages.
  int queueFull = 0;
};

// Turns saves into derivations on its own thread. One drain thread walks the queue and deals
// round-robin across accounts; LiveDerivationRules caps what one account may hold and buy.
// `pageSaved` runs on a request thread: it does map bookkeeping under a short mutex and returns.
class EchoDerivations : public PageWatcher {
public:
  EchoDerivations(EchoSweep& sweep, Clock& clock, LiveDerivationRules rules);

  void start();

  // The first save opens a pending entry; every save after it pushes the ready instant out again,
  // unless the text has grown by `materialBytes` since the entry opened.
  void pageSaved(const UserId& user, const LocalDate& day, std::size_t bodyBytes) override;

  // Derive everything that has gone quiet, at the caller's `now`.
  EchoLiveReport drain(std::uint64_t nowMs);

private:
  // `openedBytes` is the size at the save that opened this entry, so the distance from it is new
  // material.
  struct Pending {
    UserId user;
    LocalDate day;
    std::size_t openedBytes = 0;
    std::uint64_t readyAtMs = 0;
  };

  // One page's spend inside a rolling day; the window opens at the first derivation, not midnight.
  struct Spent {
    int derivations = 0;
    std::uint64_t windowStartMs = 0;
  };

  EchoSweep& sweep_;
  Clock& clock_;
  LiveDerivationRules rules_;
  std::mutex lock_;
  // Keyed "user|day", so the entries one account holds are one contiguous range.
  std::map<std::string, Pending> pending_;
  std::map<std::string, Spent> spent_;       // per page
  std::map<std::string, Spent> userSpent_;   // per account
  int queueFull_ = 0;
  Heartbeat heartbeat_;   // declared last: destructs first, before the deps a running drain holds
};

}
