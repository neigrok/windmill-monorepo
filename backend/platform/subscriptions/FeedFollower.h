#pragma once

#include "platform/application/FailureWindow.h"
#include "platform/application/WriteObservation.h"
#include "platform/subscriptions/EntitlementCopy.h"

#include <atomic>
#include <chrono>
#include <condition_variable>
#include <functional>
#include <mutex>
#include <optional>
#include <string>
#include <thread>
#include <vector>

namespace wm::subscriptions {

// How the follower paces itself (§6.1): read again at most `poll` after catching up, `retry` after a read that made
// no progress, and report a cursor that has made none for `stallAfter`.
struct FollowerTiming {
  std::chrono::milliseconds poll{5'000};
  std::chrono::milliseconds retry{30'000};
  std::chrono::milliseconds stallAfter{60'000};
  int pageLimit = 500;
};

// What one read of the feed came to.
enum class FollowStep {
  applied,      // a page's entries went through every consumer and the cursor moved past them
  caughtUp,     // the copy already holds the newest event the ledger has
  behind,       // an empty page while the ledger reports newer events
  rebuilt,      // the ledger was restored, and the copy was rebuilt from zero under its epoch
  unavailable,  // the feed could not be read; the copy answers as it stands
  failed,       // a page could not be applied, and rolled back whole; it is read again
  overtaken,    // another follower moved the cursor while the page was read; nothing applied
};

// Follows the subscription service's feed into the backend's own copy of every entitlement (§6.1), on a thread of its
// own. Each page goes through the copy and then each further consumer, in the order given, inside one transaction
// that also moves the cursor. A restored ledger is read whole from zero first, then replaces the copy in one
// transaction, so the old copy answers until the rebuilt one does (INV-11).
class FeedFollower {
public:
  using Now = std::function<std::chrono::steady_clock::time_point()>;

  FeedFollower(SubscriptionFeed& feed, EntitlementCopy& copy,
               std::vector<std::reference_wrapper<FeedEntryConsumer>> furtherConsumers, FailureReporter& reporter,
               FollowerTiming timing = {}, Now now = [] { return std::chrono::steady_clock::now(); });
  ~FeedFollower() { stop(); }
  FeedFollower(const FeedFollower&) = delete;
  FeedFollower& operator=(const FeedFollower&) = delete;

  void start();
  void stop();

  // One read of the feed, applied: what the thread repeats, and what a test drives step by step.
  FollowStep follow();

  // Asks for a read now and waits at most `wait` for the copy to hold `seq`; true when it does. Blocks the caller, so
  // never call it from a request loop.
  bool reach(Seq seq, std::chrono::milliseconds wait);

private:
  FollowStep apply(const FeedCursor& from, const FeedPage& page, WriteObservation& observation);
  FollowStep rebuild(const FeedCursor& from, const std::string& cause, WriteObservation& observation);
  void standsAt(Seq seq);
  void watchForStall(FollowStep step, const FeedCursor& from, const std::string& answer);
  void run();

  SubscriptionFeed& feed_;
  EntitlementCopy& copy_;
  std::vector<std::reference_wrapper<FeedEntryConsumer>> consumers_;
  const FollowerTiming timing_;
  const Now now_;
  FailureWindow restores_;
  FailureWindow stalls_;

  std::chrono::steady_clock::time_point lastProgress_;
  std::optional<Seq> latestSeq_;

  std::mutex mutex_;
  std::condition_variable wake_;
  std::condition_variable moved_;
  Seq heldSeq_ = 0;
  bool asked_ = false;
  std::atomic<bool> stopping_{false};
  std::thread thread_;
};

}
