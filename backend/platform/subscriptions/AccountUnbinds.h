#pragma once

#include "platform/domain/Ids.h"

#include <algorithm>
#include <cstdint>
#include <optional>
#include <string>
#include <vector>

namespace wm::subscriptions {

// What the service's erasure door answered (subscriptions.md §5.2, §6.4). It is settled once the service took it, which
// a 204 says whether it unbound anything or had erased the account already, or once it never will, which a 404 says;
// otherwise it stays owed. `answer` is a bounded word (`204`, `404`, `timeout`, `unreachable`, `503`, …), never a body.
struct UnbindAnswer {
  bool settled = false;
  std::string answer;
};

// The subscription service's erasure door, DELETE /internal/v1/accounts/{accountId}: the account recorded as erased and
// everything it holds unbound. It never throws: an answer that is no answer stays owed.
struct AccountUnbinder {
  virtual ~AccountUnbinder() = default;
  virtual UnbindAnswer unbind(const UserId& account) = 0;
};

// How long an unbind still owed waits before it is attempted again, and how often it is reported while it stays owed.
struct UnbindPace {
  std::int64_t firstWaitMs = 60'000;       // the wait doubles from one minute after each attempt the service did not take
  std::int64_t longestWaitMs = 3'600'000;  // and never passes an hour
  std::int64_t reportEveryMs = 3'600'000;  // one report per owed account per hour
};

// One unbind an erasure owes the service (§6.4), keyed by the erased account: how many attempts the service did not
// take, when the next is due (none: at once), and when it was last reported.
struct OwedUnbind {
  UserId account;
  int attempts = 0;
  std::optional<std::int64_t> nextAttemptMs;
  std::optional<std::int64_t> reportedAtMs;

  // Whether an attempt at `nowMs` that the service did not take is reported: the first, then one a window.
  bool reportDue(std::int64_t nowMs, const UnbindPace& pace) const {
    return !reportedAtMs || nowMs - *reportedAtMs >= pace.reportEveryMs;
  }

  // What it is once that attempt left it owed: one attempt more, the next after a doubled wait, reported now if due.
  OwedUnbind afterAttempt(std::int64_t nowMs, const UnbindPace& pace) const {
    std::int64_t wait = pace.firstWaitMs;
    for (int doubled = 0; doubled < attempts && wait < pace.longestWaitMs; ++doubled) wait *= 2;
    return OwedUnbind{account, attempts + 1, nowMs + std::min(wait, pace.longestWaitMs),
                      reportDue(nowMs, pace) ? std::optional{nowMs} : reportedAtMs};
  }
};

// The unbinds the backend owes the service (§6.4): each recorded in the transaction that erased its account, and kept
// until the service took it.
struct OwedUnbinds {
  virtual ~OwedUnbinds() = default;
  // At most `limit` unbinds due at `nowMs`, the longest owed first.
  virtual std::vector<OwedUnbind> due(std::int64_t nowMs, int limit) = 0;
  // Still owed, as an attempt left it.
  virtual void keep(const OwedUnbind& owed) = 0;
  // The service took it, and the backend keeps nothing of the account.
  virtual void settle(const UserId& account) = 0;
};

}
