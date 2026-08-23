#pragma once

#include "platform/adapters/postgres/PgPool.h"
#include "platform/domain/OAuth.h"
#include "platform/ports/Retention.h"

#include <pqxx/pqxx>

#include <memory>
#include <string>
#include <utility>

namespace wm {

// Retention in Postgres: six bounded DELETEs, each naming the rows it takes by primary key from a
// LIMITed subquery, so a pass takes a slice and the heartbeat comes back for the rest.
class PgRetentionStore : public RetentionStore {
public:
  explicit PgRetentionStore(std::shared_ptr<PgPool> pool) : pool_(std::move(pool)) {}

  RetentionReport purge(const RetentionWindows& windows, UnixMs now) override {
    PgRetentionStore::Pass pass{*pool_, windows.batch};
    RetentionReport report;
    report.ran = true;
    // A window of zero or less means keep it all — the table is skipped whole.
    if (windows.eventDays > 0)
      report.events = pass.byAge("events", "id", windows.eventDays);
    if (windows.feedbackDays > 0)
      report.feedback = pass.byAge("feedback", "id", windows.feedbackDays);
    if (windows.serverErrorDays > 0)
      report.serverErrors = pass.byAge("server_errors", "id", windows.serverErrorDays);

    report.oauthCodes = pass.byExpiry("oauth_codes", "code_hash", "expires_ms", now);
    // Two deaths, whichever comes first. A live row dies at its refresh expiry — coalesced, because
    // a token with a null refresh_expires_ms has its access expiry as the whole of its life. A SPENT
    // row (a rotation tombstone) is dead when stamped, kept only long enough to recognise reuse.
    report.oauthTokens = pass.byExpiry(
        "oauth_tokens", "token_hash",
        "least(coalesce(refresh_expires_ms, expires_ms), "
        "coalesce(rotated_ms + " + std::to_string(OAuthPolicy::spentRefreshTombstoneMs) +
            ", coalesce(refresh_expires_ms, expires_ms)))",
        now);
    report.oauthClients = pass.unattachedClients(
        static_cast<int>(OAuthPolicy::unattachedClientTtlMs / (24ull * 60 * 60 * 1000)));
    return report;
  }

private:
  // One lease for the whole pass, so an IO thread's request cannot slip between the six statements.
  struct Pass {
    Pass(PgPool& pool, int batch) : lease(pool), batch(batch) {}

    int byAge(const std::string& table, const std::string& key, int days) {
      pqxx::work txn{*lease};
      const pqxx::result done = txn.exec_params(
          "DELETE FROM " + table + " WHERE " + key + " IN (SELECT " + key + " FROM " + table +
              " WHERE ts < now() - make_interval(days => $1) ORDER BY " + key + " LIMIT $2)",
          days, batch);
      txn.commit();
      return static_cast<int>(done.affected_rows());
    }

    int byExpiry(const std::string& table, const std::string& key, const std::string& expiry, UnixMs now) {
      pqxx::work txn{*lease};
      const pqxx::result done = txn.exec_params(
          "DELETE FROM " + table + " WHERE " + key + " IN (SELECT " + key + " FROM " + table +
              " WHERE " + expiry + " <= $1 LIMIT $2)",
          static_cast<long long>(now), batch);
      txn.commit();
      return static_cast<int>(done.affected_rows());
    }

    // A registered client that never completed an authorization, past its TTL.
    int unattachedClients(int days) {
      pqxx::work txn{*lease};
      const pqxx::result done = txn.exec_params(
          "DELETE FROM oauth_clients WHERE client_id IN ("
          "SELECT c.client_id FROM oauth_clients c WHERE c.created_at < now() - make_interval(days => $1) "
          "AND NOT EXISTS (SELECT 1 FROM oauth_grants g WHERE g.client_id = c.client_id) LIMIT $2)",
          days, batch);
      txn.commit();
      return static_cast<int>(done.affected_rows());
    }

    PgLease lease;
    int batch;
  };

  std::shared_ptr<PgPool> pool_;
};

}
