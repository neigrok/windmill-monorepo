#include "platform/subscriptions/FeedFollower.h"

#include "platform/application/WorkerPool.h"

#include <trantor/utils/Logger.h>

#include <algorithm>
#include <exception>
#include <iterator>
#include <memory>
#include <utility>

namespace wm::subscriptions {

FeedFollower::FeedFollower(SubscriptionFeed& feed, EntitlementCopy& copy, FurtherConsumers further,
                           FailureReporter& reporter, FollowerTiming timing, Now now)
    : feed_(feed), copy_(copy), inPage_{copy}, beside_(std::move(further.beside)), timing_(timing),
      now_(std::move(now)), restores_(reporter, "subscription.follow.restored", std::chrono::minutes(5), now_),
      stalls_(reporter, "subscription.follow.stalled", std::chrono::minutes(5), now_), lastProgress_(now_()) {
  inPage_.insert(inPage_.end(), further.inPage.begin(), further.inPage.end());
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
  {
    std::lock_guard lock{mutex_};
    reading_ = ++readsBegun_;
  }
  FeedCursor from;
  try {
    from = copy_.cursor();
    const FeedPage page = feed_.page(from.seq, timing_.pageLimit);
    latestSeq_ = page.latestSeq;
    if (const auto cause = from.restoreIn(page)) return rebuild(from, *cause, observation);
    if (!page.entries.empty()) return apply(from, page.entries, from.past(page), false, observation);
    confirm(from.seq);
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

FollowStep FeedFollower::apply(const FeedCursor& from, const std::vector<FeedEntry>& entries, const FeedCursor& to,
                               bool rebuilding, WriteObservation& observation) {
  const std::unique_ptr<PageTxn> txn = copy_.begin(to, rebuilding);
  if (txn->cursor() != from) {
    observation.skip();
    return FollowStep::overtaken;
  }
  for (const FeedEntry& entry : entries) {
    for (FeedEntryConsumer& consumer : inPage_) consumer.consume(*txn, entry);
    for (FeedEntrySideConsumer& consumer : beside_) consumer.consume(*txn, entry);
  }
  txn->commit();
  observation.wrote();
  observation.finish(rebuilding ? "rebuilt" : "ok");
  lastProgress_ = now_();
  confirm(to.seq);
  return rebuilding ? FollowStep::rebuilt : FollowStep::applied;
}

FollowStep FeedFollower::rebuild(const FeedCursor& from, const std::string& cause, WriteObservation& observation) {
  LOG_WARN << "subscription follow: the ledger was restored (" << cause << "), rebuilding the copy from zero";
  {
    // An Issue of its own, apart from the read's: a rebuild that then fails reports that failure too.
    WriteContext own{freshWriteRequestId()};
    restores_.report("cause=" + cause);
  }

  // Read to the newest event the ledger holds: an empty page short of it is a feed that cannot be read, never a whole
  // ledger, or the copy would be replaced by a prefix of it.
  std::vector<FeedEntry> ledger;
  FeedCursor rebuilt;
  for (bool whole = false; !whole;) {
    FeedPage page = feed_.page(rebuilt.seq, timing_.pageLimit);
    rebuilt = rebuilt.past(page);
    latestSeq_ = page.latestSeq;
    whole = rebuilt.caughtUpWith(page);
    if (page.entries.empty() && !whole) throw FeedUnavailable("behind");
    std::move(page.entries.begin(), page.entries.end(), std::back_inserter(ledger));
  }
  return apply(from, ledger, rebuilt, true, observation);
}

bool FeedFollower::reach(Seq seq, std::chrono::milliseconds wait) {
  std::unique_lock lock{mutex_};
  const std::uint64_t asked = readsBegun_;
  const auto held = [&] { return confirmedRead_ > asked && confirmedSeq_ >= seq; };
  asked_ = true;
  wake_.notify_all();
  moved_.wait_for(lock, wait, [&] { return held() || stopping_; });
  return held();
}

void FeedFollower::confirm(Seq seq) {
  {
    std::lock_guard lock{mutex_};
    confirmedRead_ = reading_;
    confirmedSeq_ = seq;
  }
  moved_.notify_all();
}

// §10: a cursor still for `stallAfter` while the ledger has newer events, or the feed cannot be read, is reported.
void FeedFollower::watchForStall(FollowStep step, const FeedCursor& from, const std::string& answer) {
  if (now_() - lastProgress_ < timing_.stallAfter) return;
  const Seq behind = latestSeq_ && *latestSeq_ > from.seq ? *latestSeq_ - from.seq : 0;
  const std::string cause = step == FollowStep::unavailable ? "cause=unavailable answer=" + answer
                            : step == FollowStep::failed   ? "cause=failed behind=" + std::to_string(behind)
                                                           : "cause=behind behind=" + std::to_string(behind);
  // An Issue of its own, apart from the read's; the report carries no detail, so the line names the cause.
  WriteContext own{freshWriteRequestId()};
  if (stalls_.report(cause)) LOG_WARN << "subscription follow: the cursor has stalled (" << cause << ")";
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
        case FollowStep::rebuilt: return latestSeq_ && confirmedSeq_ >= *latestSeq_ ? timing_.poll : std::chrono::milliseconds{0};
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
