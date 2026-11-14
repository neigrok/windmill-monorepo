#include "platform/subscriptions/PgEntitlementCopy.h"

#include "platform/adapters/json/JsonText.h"

#include <cstdint>
#include <stdexcept>
#include <utility>

namespace wm::subscriptions {

namespace {
// The schema seeds the cursor's one row; a null epoch is a copy that never read the feed.
constexpr const char* kCursorRow = "SELECT coalesce(epoch, ''), seq FROM subscription_feed_cursor";

FeedCursor cursorFrom(const pqxx::result& rows) {
  if (rows.size() != 1) throw std::logic_error("subscription_feed_cursor must hold its one row (db/schema.sql)");
  return FeedCursor{rows[0][0].as<std::string>(), static_cast<Seq>(rows[0][1].as<std::int64_t>())};
}

class PgPageTxn final : public PageTxn {
public:
  PgPageTxn(PgPool& pool, const FeedCursor& target, bool rebuilding)
      : PageTxn(target, rebuilding), lease_(pool), work_(*lease_),
        cursor_(cursorFrom(work_.exec(std::string(kCursorRow) + " FOR UPDATE"))) {
    if (rebuilding) work_.exec("DELETE FROM account_entitlements");
  }

  const FeedCursor& cursor() const override { return cursor_; }

  void commit() override {
    work_.exec("UPDATE subscription_feed_cursor SET epoch = $1, seq = $2",
               pqxx::params{target().epoch, static_cast<std::int64_t>(target().seq)});
    work_.commit();
  }

  pqxx::work& sql() { return work_; }

private:
  PgLease lease_;
  pqxx::work work_;  // declared after the lease, so it destructs first and can still roll back
  FeedCursor cursor_;
};
}

pqxx::work& sqlOf(PageTxn& txn) {
  auto* postgres = dynamic_cast<PgPageTxn*>(&txn);
  if (!postgres) throw std::logic_error("a page transaction that is not Postgres's reached a Postgres consumer");
  return postgres->sql();
}

PgEntitlementCopy::PgEntitlementCopy(std::shared_ptr<PgPool> pool) : pool_(std::move(pool)) {}

std::unique_ptr<PageTxn> PgEntitlementCopy::begin(const FeedCursor& target, bool rebuilding) {
  return std::make_unique<PgPageTxn>(*pool_, target, rebuilding);
}

FeedCursor PgEntitlementCopy::cursor() {
  PgLease lease{*pool_};
  pqxx::read_transaction txn{*lease};
  return cursorFrom(txn.exec(kCursorRow));
}

void PgEntitlementCopy::consume(PageTxn& page, const FeedEntry& entry) {
  if (!entry.entitlement) return;
  const EntitlementResponse& entitlement = *entry.entitlement;
  sqlOf(page).exec(
      "INSERT INTO account_entitlements "
      "(account_id, production_access_until, sandbox_access_until, entitlement, seq) "
      "SELECT $1::uuid, $2, $3, $4::json, $5 WHERE EXISTS (SELECT 1 FROM users WHERE id = $1::uuid) "
      "ON CONFLICT (account_id) DO UPDATE SET production_access_until = excluded.production_access_until, "
      "sandbox_access_until = excluded.sandbox_access_until, entitlement = excluded.entitlement, seq = excluded.seq "
      "WHERE account_entitlements.seq < excluded.seq",
      pqxx::params{entitlement.accountId.str(), entitlement.productionAccessUntil, entitlement.sandboxAccessUntil,
                   dump(entitlement.body), static_cast<std::int64_t>(entry.seq)});
}

std::optional<EntitlementResponse> PgEntitlementCopy::find(const UserId& account) {
  if (!isUuid(account.str())) return std::nullopt;
  PgLease lease{*pool_};
  pqxx::read_transaction txn{*lease};
  const pqxx::result rows = txn.exec("SELECT entitlement::text FROM account_entitlements WHERE account_id = $1::uuid",
                                     pqxx::params{account.str()});
  if (rows.empty()) return std::nullopt;
  std::optional<Json::Value> stored = parseWhole(rows[0][0].as<std::string>());
  if (!stored) throw std::runtime_error("account_entitlements holds an entitlement that is not JSON");
  return EntitlementResponse{std::move(*stored)};
}

}
