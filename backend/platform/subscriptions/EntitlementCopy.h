#pragma once

#include "platform/subscriptions/Feed.h"

#include <memory>
#include <optional>
#include <utility>

namespace wm::subscriptions {

// The one transaction a page applies in, toward the cursor it brings the copy to. It holds the stored cursor from
// begin to commit, so no other follower moves it meanwhile, and commit moves the cursor with the page's rows.
class PageTxn {
public:
  PageTxn(FeedCursor target, bool rebuilding) : target_(std::move(target)), rebuilding_(rebuilding) {}
  virtual ~PageTxn() = default;

  virtual const FeedCursor& cursor() const = 0;  // where the copy stood as the page began
  virtual void commit() = 0;

  const FeedCursor& target() const { return target_; }  // its epoch is the ledger's the page was read under
  bool rebuilding() const { return rebuilding_; }        // a rebuild from zero, whose copy began the page empty

private:
  const FeedCursor target_;
  const bool rebuilding_;
};

// What the backend does with each entry, in order: the copy first, then each further consumer (§6.1). A consumer that
// throws rolls the page back to be read again, and a rebuild reads every entry again: every consumer is idempotent.
// This kind writes through the page's transaction.
struct FeedEntryConsumer {
  virtual ~FeedEntryConsumer() = default;
  virtual void consume(PageTxn& page, const FeedEntry& entry) = 0;
};

// The kind that writes in short transactions of its own before the page commits, as funding does: the AI ledger's
// lock must never be held for a whole page. It reads the page, and cannot write through it.
struct FeedEntrySideConsumer {
  virtual ~FeedEntrySideConsumer() = default;
  virtual void consume(const PageTxn& page, const FeedEntry& entry) = 0;
};

// The backend's own copy of every entitlement and its cursor (§6.1); consuming an entry replaces the named account's row.
struct EntitlementCopy : FeedEntryConsumer {
  // A rebuild's copy is emptied within the transaction, so the old copy answers until it commits (INV-11).
  virtual std::unique_ptr<PageTxn> begin(const FeedCursor& target, bool rebuilding) = 0;
  virtual FeedCursor cursor() = 0;
  virtual std::optional<EntitlementResponse> find(const UserId& account) = 0;
};

}
