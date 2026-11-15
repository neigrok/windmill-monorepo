#pragma once

#include "platform/subscriptions/Feed.h"

#include <functional>
#include <memory>
#include <optional>
#include <utility>
#include <vector>

namespace wm::subscriptions {

// The one transaction a page applies in, toward the cursor it brings the copy to. It holds the stored cursor from
// begin to commit, so no other follower moves it meanwhile, and commit moves the cursor with the page's rows.
class PageTxn {
public:
  PageTxn(FeedCursor target, bool rebuilding) : target_(std::move(target)), rebuilding_(rebuilding) {}
  virtual ~PageTxn() = default;

  virtual const FeedCursor& cursor() const = 0;  // where the copy stood as the page began

  // The page's rows and the cursor become durable together, then what waited on them runs, in the order it was asked.
  void commit() {
    persist();
    for (const std::function<void()>& then : afterCommit_) then();
  }

  // What may happen only once the page's rows are durable, as telling Amplitude of an event the page recorded. A page
  // that rolls back runs none of it. It must not throw, since the page has committed by then.
  void afterCommit(std::function<void()> then) { afterCommit_.push_back(std::move(then)); }

  const FeedCursor& target() const { return target_; }  // its epoch is the ledger's the page was read under
  bool rebuilding() const { return rebuilding_; }        // a rebuild from zero, whose copy began the page empty

  // Whether the backend still holds the account, read in the page's transaction, which then keeps it from an erasure
  // until the page commits, so nothing a consumer writes for it beside the page outlives the account unseen. The copy
  // writes no row for an account it does not hold, and funding funds none (§6.3).
  virtual bool accountStands(const UserId& account) const = 0;

protected:
  virtual void persist() = 0;  // the page's rows and the cursor, in one commit

private:
  const FeedCursor target_;
  const bool rebuilding_;
  std::vector<std::function<void()>> afterCommit_;
};

// What the backend does with each entry, in order: the copy first, then each further consumer (§6.1). A consumer that
// throws rolls the page back to be read again, and a rebuild reads every entry again: every consumer is idempotent.
// An entry whose event the contract does not name arrives with `knownType` false; only the copy applies it.
// This kind writes through the page's transaction.
struct FeedEntryConsumer {
  virtual ~FeedEntryConsumer() = default;
  virtual void consume(PageTxn& page, const FeedEntry& entry) = 0;
};

// The kind that writes in short transactions of its own before the page commits, as funding does: the AI ledger's
// lock must never be held for a whole page. It is handed the page's entries whole, in order, once every entry went
// through the page's own consumers, so it can act on what the page leaves rather than on each step of it. It reads the
// page, and cannot write through it.
struct FeedPageSideConsumer {
  virtual ~FeedPageSideConsumer() = default;
  virtual void consume(const PageTxn& page, const std::vector<FeedEntry>& entries) = 0;
};

// The copy as a request reads it: one account's entitlement as the feed last stated it, or none for an account the feed
// never named; its `accessUntil`s are the row's own, which access reads. Nothing here reaches the subscription service,
// so access answers alike while it is down (INV-10).
struct EntitlementReader {
  virtual ~EntitlementReader() = default;
  virtual std::optional<EntitlementResponse> find(const UserId& account) = 0;
};

// The backend's own copy of every entitlement and its cursor (§6.1); consuming an entry replaces the named account's row.
struct EntitlementCopy : FeedEntryConsumer, EntitlementReader {
  // A rebuild's copy is emptied within the transaction, so the old copy answers until it commits (INV-11).
  virtual std::unique_ptr<PageTxn> begin(const FeedCursor& target, bool rebuilding) = 0;
  virtual FeedCursor cursor() = 0;
};

}
