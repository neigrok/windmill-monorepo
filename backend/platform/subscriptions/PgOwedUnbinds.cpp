#include "platform/subscriptions/PgOwedUnbinds.h"

#include <utility>

namespace wm::subscriptions {

PgOwedUnbinds::PgOwedUnbinds(std::shared_ptr<PgPool> pool) : pool_(std::move(pool)) {}

std::vector<OwedUnbind> PgOwedUnbinds::due(std::int64_t nowMs, int limit) {
  PgLease lease{*pool_};
  pqxx::read_transaction txn{*lease};
  const pqxx::result rows = txn.exec(
      "SELECT account_id::text, owed_since_ms, attempts, next_attempt_ms, reported_at_ms FROM owed_subscription_unbinds "
      "WHERE next_attempt_ms IS NULL OR next_attempt_ms <= $1 ORDER BY owed_since_ms, account_id LIMIT $2",
      pqxx::params{nowMs, limit});
  std::vector<OwedUnbind> due;
  for (pqxx::result::size_type at = 0; at < rows.size(); ++at) {
    const auto instant = [&](int column) -> std::optional<std::int64_t> {
      if (rows[at][column].is_null()) return std::nullopt;
      return rows[at][column].as<std::int64_t>();
    };
    due.push_back(OwedUnbind{UserId{rows[at][0].as<std::string>()}, rows[at][1].as<std::int64_t>(),
                             rows[at][2].as<int>(), instant(3), instant(4)});
  }
  return due;
}

void PgOwedUnbinds::keep(const OwedUnbind& owed) {
  PgLease lease{*pool_};
  pqxx::work txn{*lease};
  txn.exec("UPDATE owed_subscription_unbinds SET attempts = $2, next_attempt_ms = $3, reported_at_ms = $4 "
           "WHERE account_id = $1::uuid",
           pqxx::params{owed.account.str(), owed.attempts, owed.nextAttemptMs, owed.reportedAtMs});
  txn.commit();
}

void PgOwedUnbinds::settle(const UserId& account) {
  PgLease lease{*pool_};
  pqxx::work txn{*lease};
  txn.exec("DELETE FROM owed_subscription_unbinds WHERE account_id = $1::uuid", pqxx::params{account.str()});
  txn.commit();
}

AccountErasure unbindOnErasure(std::function<void()> owed) {
  return AccountErasure{{}, [owed = std::move(owed)](const std::vector<std::string>&) {
                          if (owed) owed();
                        }};
}

}
