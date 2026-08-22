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
// LIMITed subquery. The limit is the point — a single unbounded DELETE over a year of telemetry
// would hold locks and bloat the very table this exists to keep small, so a pass takes a slice and
// the heartbeat comes back for the rest.
//
// The telemetry tables are aged by `ts`, which the database writes itself; the OAuth tables are
// aged by the expiry already IN the row, so the sweep only ever collects what the read paths have
// already stopped honouring. Nothing here reaches a product's tables.
class PgRetentionStore : public RetentionStore {
public:
  explicit PgRetentionStore(std::shared_ptr<PgPool> pool) : pool_(std::move(pool)) {}

  RetentionReport purge(const RetentionWindows& windows, UnixMs now) override {
    PgRetentionStore::Pass pass{*pool_, windows.batch};
    RetentionReport report;
    report.ran = true;
    // A window of zero or less is an operator saying "keep it all" — the table is skipped whole,
    // never swept with a window we invented for them.
    if (windows.eventDays > 0)
      report.events = pass.byAge("events", "id", windows.eventDays);
    if (windows.feedbackDays > 0)
      report.feedback = pass.byAge("feedback", "id", windows.feedbackDays);
    if (windows.serverErrorDays > 0)
      report.serverErrors = pass.byAge("server_errors", "id", windows.serverErrorDays);

    report.oauthCodes = pass.byExpiry("oauth_codes", "code_hash", "expires_ms", now);
    // Two deaths, whichever comes first. A live row dies at its refresh expiry — coalesced, because
    // a token minted before refresh_expires_ms existed carries a null there and its access expiry is
    // the whole of its life. A SPENT row (a rotation tombstone) is dead the instant it is stamped
    // and is kept only long enough to recognise reuse: aging it by the refresh lifetime instead
    // turned every rotation into a row held for thirty days, which at the request ceiling is
    // millions, and that is a growth path the retention wave would have introduced itself.
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
  // One lease for the whole pass: six statements on six tables is still one piece of work, and
  // borrowing a connection per table would let an IO thread's request slip between them.
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

    // A registered client that never completed an authorization, past its TTL. Anonymous
    // registration is open by design (RFC 7591) and this is what keeps that door from being a
    // place to leave rows: an honest client is attached to a grant within a minute, and one that
    // never came back is dead — an MCP host simply registers again on its next run.
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
