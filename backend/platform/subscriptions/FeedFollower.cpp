#include "platform/subscriptions/FeedFollower.h"

#include "platform/application/WorkerPool.h"

#include <trantor/utils/Logger.h>

#include <exception>
#include <iterator>
#include <memory>
#include <utility>

namespace wm::subscriptions {

FeedFollower::FeedFollower(SubscriptionFeed& feed, EntitlementCopy& copy,
                           std::vector<std::reference_wrapper<FeedEntryConsumer>> furtherConsumers,
                           FailureReporter& reporter, FollowerTiming timing, Now now)
    : feed_(feed), copy_(copy), consumers_{copy}, timing_(timing), now_(std::move(now)),
      restores_(reporter, "subscription.follow.restored", std::chrono::minutes(5), now_),
      stalls_(reporter, "subscription.follow.stalled", std::chrono::minutes(5), now_), lastProgress_(now_()) {
  consumers_.insert(consumers_.end(), furtherConsumers.begin(), furtherConsumers.end());
}

void FeedFollower::start() {
  LOG_INFO << "subscriptions: following the feed into the entitlement copy, read again "
           << timing_.poll.count() << "ms after catching up";
  thread_ = std::thread([this] { run(); });
}

void FeedFollower::stop() {
  {
    std::lock_guard lock{mutex_};
    stopping_ = true;
  }
  wake_.notify_all();
  moved_.notify_all();
  if (thread_.joinable()) thread_.join();
}

FollowStep FeedFollower::follow() {
  WriteObservation observation{"subscription.follow", "platform", "background"};
  WriteContext context{observation};
  FeedCursor from;
  try {
    from = copy_.cursor();
    standsAt(from.seq);
    const FeedPage page = feed_.page(from.seq, timing_.pageLimit);
    latestSeq_ = page.latestSeq;
    if (const auto cause = from.restoreIn(page)) return rebuild(from, *cause, observation);
    if (!page.entries.empty()) return apply(from, page, observation);
    if (from.caughtUpWith(page)) {
      lastProgress_ = now_();
      observation.skip();
      return FollowStep::caughtUp;
    }
    observation.finish("behind");
    watchForStall(FollowStep::behind, from, "");
    return FollowStep::behind;
  } catch (const FeedUnavailable& unavailable) {
    LOG_WARN << "subscription follow: the feed is unavailable (" << unavailable.answer << ")";
    observation.finish("unavailable");
    watchForStall(FollowStep::unavailable, from, unavailable.answer);
    return FollowStep::unavailable;
  } catch (const std::exception& error) {
    observation.fail(error);
  } catch (...) {
    observation.failUnknown();
  }
  watchForStall(FollowStep::failed, from, "");
  return FollowStep::failed;
}

FollowStep FeedFollower::apply(const FeedCursor& from, const FeedPage& page, WriteObservation& observation) {
  const FeedCursor next = from.past(page);
  const std::unique_ptr<PageTxn> txn = copy_.begin();
  if (txn->cursor() != from) {
    observation.skip();
    return FollowStep::overtaken;
  }
  for (const FeedEntry& entry : page.entries)
    for (FeedEntryConsumer& consumer : consumers_) consumer.consume(*txn, entry);
  copy_.advance(*txn, next);
  txn->commit();
  observation.wrote();
  observation.finish();
  lastProgress_ = now_();
  standsAt(next.seq);
  return FollowStep::applied;
}

FollowStep FeedFollower::rebuild(const FeedCursor& from, const std::string& cause, WriteObservation& observation) {
  restores_.report("cause=" + cause);
  LOG_WARN << "subscription follow: the ledger was restored (" << cause << "), rebuilding the copy from zero";

  std::vector<FeedEntry> ledger;
  FeedCursor rebuilt;
  for (bool whole = false; !whole;) {
    FeedPage page = feed_.page(rebuilt.seq, timing_.pageLimit);
    rebuilt = rebuilt.past(page);
    latestSeq_ = page.latestSeq;
    whole = page.entries.empty() || rebuilt.caughtUpWith(page);
    std::move(page.entries.begin(), page.entries.end(), std::back_inserter(ledger));
  }

  const std::unique_ptr<PageTxn> txn = copy_.begin();
  if (txn->cursor() != from) {
    observation.skip();
    return FollowStep::overtaken;
  }
  copy_.clear(*txn);
  for (const FeedEntry& entry : ledger)
    for (FeedEntryConsumer& consumer : consumers_) consumer.consume(*txn, entry);
  copy_.advance(*txn, rebuilt);
  txn->commit();
  observation.wrote();
  observation.finish("rebuilt");
  lastProgress_ = now_();
  standsAt(rebuilt.seq);
  return FollowStep::rebuilt;
}

bool FeedFollower::reach(Seq seq, std::chrono::milliseconds wait) {
  std::unique_lock lock{mutex_};
  if (heldSeq_ >= seq) return true;
  asked_ = true;
  wake_.notify_all();
  moved_.wait_for(lock, wait, [&] { return heldSeq_ >= seq || stopping_; });
  return heldSeq_ >= seq;
}

void FeedFollower::standsAt(Seq seq) {
  {
    std::lock_guard lock{mutex_};
    heldSeq_ = seq;
  }
  moved_.notify_all();
}

// §10: a cursor that has not moved for `stallAfter` while the ledger reports newer events, or while the feed cannot
// be read at all, is reported once per window; the copy meanwhile answers as it stands (INV-10).
void FeedFollower::watchForStall(FollowStep step, const FeedCursor& from, const std::string& answer) {
  if (now_() - lastProgress_ < timing_.stallAfter) return;
  if (step == FollowStep::unavailable) {
    stalls_.report("cause=unavailable answer=" + answer);
    return;
  }
  const Seq behind = latestSeq_ && *latestSeq_ > from.seq ? *latestSeq_ - from.seq : 0;
  stalls_.report(std::string(step == FollowStep::failed ? "cause=failed" : "cause=behind") +
                 " behind=" + std::to_string(behind));
}

void FeedFollower::run() {
  BlockingThread::Mark blocking;
  while (!stopping_) {
    {
      std::lock_guard lock{mutex_};
      asked_ = false;
    }
    const FollowStep step = follow();
    std::unique_lock lock{mutex_};
    const auto pause = [&]() -> std::chrono::milliseconds {
      switch (step) {
        case FollowStep::applied:
        case FollowStep::rebuilt: return latestSeq_ && heldSeq_ >= *latestSeq_ ? timing_.poll : std::chrono::milliseconds{0};
        case FollowStep::overtaken: return std::chrono::milliseconds{0};
        case FollowStep::caughtUp: return timing_.poll;
        case FollowStep::behind:
        case FollowStep::unavailable:
        case FollowStep::failed: return timing_.retry;
      }
      return timing_.retry;
    }();
    wake_.wait_for(lock, pause, [this] { return stopping_ || asked_; });
  }
}

}
