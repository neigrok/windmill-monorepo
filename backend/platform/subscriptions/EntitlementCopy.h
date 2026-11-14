#pragma once

#include "platform/subscriptions/Feed.h"

#include <memory>
#include <optional>

namespace wm::subscriptions {

// The one transaction a page applies in; it holds the stored cursor, so no other follower moves it meanwhile.
class PageTxn {
public:
  virtual ~PageTxn() = default;
  virtual const FeedCursor& cursor() const = 0;
  virtual void commit() = 0;
};

// What the backend does with each entry inside the page's transaction, in order: the copy first, then later work.
// A consumer that throws rolls the page back to be read again, and a rebuild reads every entry again: be idempotent.
struct FeedEntryConsumer {
  virtual ~FeedEntryConsumer() = default;
  virtual void consume(PageTxn& txn, const FeedEntry& entry) = 0;
};

// The backend's own copy of every entitlement and its cursor (§6.1); consuming an entry replaces the named account's row.
struct EntitlementCopy : FeedEntryConsumer {
  virtual std::unique_ptr<PageTxn> begin() = 0;
  virtual FeedCursor cursor() = 0;
  virtual void advance(PageTxn& txn, const FeedCursor& cursor) = 0;
  // Every row goes: the start of a rebuild, which replaces the copy whole within its one transaction (INV-11).
  virtual void clear(PageTxn& txn) = 0;
  virtual std::optional<EntitlementResponse> find(const UserId& account) = 0;
};

}
