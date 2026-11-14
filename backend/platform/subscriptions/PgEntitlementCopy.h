#pragma once

#include "platform/adapters/postgres/PgPool.h"
#include "platform/subscriptions/EntitlementCopy.h"

#include <memory>
#include <optional>

namespace wm::subscriptions {

// The page's transaction on Postgres, for a consumer whose writes belong to the page: a process never mixes stores.
pqxx::work& sqlOf(PageTxn& txn);

// account_entitlements and subscription_feed_cursor (db/schema.sql). An entry never takes a row back to an older seq,
// so a replayed entry changes nothing. An entry naming an account this backend no longer holds, one erased before the
// service unbound it, writes no row; erasing an account takes its row with it.
class PgEntitlementCopy : public EntitlementCopy {
public:
  explicit PgEntitlementCopy(std::shared_ptr<PgPool> pool);

  std::unique_ptr<PageTxn> begin() override;
  FeedCursor cursor() override;
  void consume(PageTxn& txn, const FeedEntry& entry) override;
  void advance(PageTxn& txn, const FeedCursor& cursor) override;
  void clear(PageTxn& txn) override;
  std::optional<EntitlementResponse> find(const UserId& account) override;

private:
  std::shared_ptr<PgPool> pool_;
};

}
