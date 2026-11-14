#pragma once

#include "platform/subscriptions/Feed.h"

#include <memory>
#include <optional>

namespace wm::subscriptions {

// The one transaction a page is applied in: every consumer's writes and the cursor commit together or not at all.
// It holds the stored cursor for its whole life, so no other follower moves it meanwhile.
class PageTxn {
public:
  virtual ~PageTxn() = default;
  virtual const FeedCursor& cursor() const = 0;
  virtual void commit() = 0;
};

// What the backend does with each feed entry, inside the page's transaction and in the order the follower was given:
// the copy first, then whatever later work an entry funds or records. A consumer that throws rolls the page back, and
// the page is read again; every consumer is idempotent, since a rebuild reads every entry again.
struct FeedEntryConsumer {
  virtual ~FeedEntryConsumer() = default;
  virtual void consume(PageTxn& txn, const FeedEntry& entry) = 0;
};

// The backend's own copy of every account's entitlement and the cursor it stands at (§6.1). It consumes each entry
// first: the named account's row becomes the entry's entitlement, both environments included.
struct EntitlementCopy : FeedEntryConsumer {
  virtual std::unique_ptr<PageTxn> begin() = 0;
  virtual FeedCursor cursor() = 0;
  virtual void advance(PageTxn& txn, const FeedCursor& cursor) = 0;
  // Every row goes: the start of a rebuild, which replaces the copy whole within its one transaction (INV-11).
  virtual void clear(PageTxn& txn) = 0;
  virtual std::optional<EntitlementResponse> find(const UserId& account) = 0;
};

}
