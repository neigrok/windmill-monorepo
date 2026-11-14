#pragma once

#include "platform/application/FailureWindow.h"
#include "platform/application/WriteObservation.h"
#include "platform/subscriptions/EntitlementCopy.h"

#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstdint>
#include <functional>
#include <mutex>
#include <optional>
#include <set>
#include <string>
#include <thread>
#include <vector>

namespace wm::subscriptions {

// The pace (§6.1): `poll` after catching up, `retry` after a read that made no progress, a stall after `stallAfter`.
struct FollowerTiming {
  std::chrono::milliseconds poll{5'000};
  std::chrono::milliseconds retry{30'000};
  std::chrono::milliseconds stallAfter{60'000};
  int pageLimit = 500;
};

// The consumers after the copy, run per entry in this order: those writing through the page's transaction, then those
// writing in short transactions of their own (§6.1). A later node adds its consumer here, and the follower is unchanged.
struct FurtherConsumers {
  std::vector<std::reference_wrapper<FeedEntryConsumer>> inPage;
  std::vector<std::reference_wrapper<FeedEntrySideConsumer>> beside;
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

// Follows the service's feed into the copy on a thread of its own (§6.1), each page applied in one transaction. A
// restored ledger is read whole from zero, then replaces the copy in one transaction: the old copy answers till then.
class FeedFollower {
public:
  using Now = std::function<std::chrono::steady_clock::time_point()>;

  FeedFollower(SubscriptionFeed& feed, EntitlementCopy& copy, FurtherConsumers further, FailureReporter& reporter,
               FollowerTiming timing = {}, Now now = [] { return std::chrono::steady_clock::now(); });
  ~FeedFollower() { stop(); }
  FeedFollower(const FeedFollower&) = delete;
  FeedFollower& operator=(const FeedFollower&) = delete;

  void start();
  void stop();

  // One read of the feed, applied: what the thread repeats, and what a test drives step by step.
  FollowStep follow();

  // Asks for a read now and waits at most `wait` for one that began after the call to leave the copy at or past `seq`
  // under the ledger's epoch; true when one did. Blocks the caller, so never call it from a request loop.
  bool reach(Seq seq, std::chrono::milliseconds wait);

private:
  // The page's one transaction toward `to`: every entry through every consumer in order, then the commit. Nothing
  // applies when another follower moved the cursor since `from` was read.
  FollowStep apply(const FeedCursor& from, const std::vector<FeedEntry>& entries, const FeedCursor& to, bool rebuilding,
                   WriteObservation& observation);
  FollowStep rebuild(const FeedCursor& from, const std::string& cause, WriteObservation& observation);
  // The read in progress saw the ledger's epoch and left the copy at `seq`.
  void confirm(Seq seq);
  // A word the contract does not name yet: one WARN line and one report per word per process, never a stop.
  void noticeUnknownWords(const FeedPage& page);
  void watchForStall(FollowStep step, const FeedCursor& from, const std::string& answer);
  void run();

  SubscriptionFeed& feed_;
  EntitlementCopy& copy_;
  std::vector<std::reference_wrapper<FeedEntryConsumer>> inPage_;
  std::vector<std::reference_wrapper<FeedEntrySideConsumer>> beside_;
  const FollowerTiming timing_;
  const Now now_;
  FailureReporter& reporter_;
  FailureWindow restores_;
  FailureWindow stalls_;

  std::chrono::steady_clock::time_point lastProgress_;
  std::optional<Seq> latestSeq_;
  std::set<std::string> unknownWordsSeen_;

  std::mutex mutex_;
  std::condition_variable wake_;
  std::condition_variable moved_;
  // Reads are numbered as they begin, so reach() counts only a read that began after it asked.
  std::uint64_t readsBegun_ = 0;
  std::uint64_t reading_ = 0;
  std::uint64_t confirmedRead_ = 0;
  Seq confirmedSeq_ = 0;
  bool asked_ = false;
  std::atomic<bool> stopping_{false};
  std::thread thread_;
};

}
